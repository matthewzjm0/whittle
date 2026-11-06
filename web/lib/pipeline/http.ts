import type { Complete, CustomHttp, ModelChoice, ModelConnection } from "./types";
import { completeOpenAI, discoverOpenAIModels, executeCustomHttp } from "./provider";
import { checkAbort, LIMITS, PipelineError, safeError } from "./limits";
import { runPipeline } from "./runner";
import { validateCompletion, validateRequest } from "./validation";

export function validateSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const url = new URL(request.url);
  // Next may canonicalize request.url to localhost. Host retains the browser's authority.
  const authority = request.headers.get("host") ?? url.host;
  let originMatches = false;
  try {
    const parsed = new URL(origin ?? "");
    originMatches = parsed.origin === origin && parsed.host === authority && parsed.protocol === url.protocol;
  } catch { /* Missing or malformed Origin is rejected below. */ }
  if (request.method !== "POST" || !originMatches || (site !== null && site !== "same-origin")) {
    throw new PipelineError("origin");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new PipelineError("media");
  }
}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.requestBytes)) {
    throw new PipelineError("request");
  }
  if (!request.body) throw new PipelineError("request");
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      checkAbort(request.signal);
      const chunk = await reader.read();
      checkAbort(request.signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMITS.requestBytes) {
        cancel();
        throw new PipelineError("request");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new PipelineError("request"); }
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function handlePipelineRequest(
  request: Request,
  complete: Complete = completeOpenAI,
  discover: (connection: ModelConnection, signal: AbortSignal) => Promise<ModelChoice[]> = discoverOpenAIModels,
  customHttp: CustomHttp = executeCustomHttp,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  try {
    validateSameOrigin(request);
    checkAbort(request.signal);
    const body = validateRequest(await readBody(request));
    if (body.mode === "models") {
      const models = await discover(body.connection, request.signal);
      checkAbort(request.signal);
      return Response.json({ models }, { headers });
    }
    if (body.mode === "chat") {
      const result = await complete(body.model, body.messages, body.maxOutputTokens, request.signal);
      checkAbort(request.signal);
      return Response.json(validateCompletion(result), { headers });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const iterator = runPipeline({ ...body, complete, customHttp, signal: controller.signal });
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const event = await iterator.next();
          if (cancelled) return;
          if (event.done) {
            request.signal.removeEventListener("abort", abort);
            output.close();
          } else {
            output.enqueue(encoder.encode(`${JSON.stringify(event.value)}\n`));
          }
        } catch (error) {
          if (!cancelled) {
            output.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error: safeError(error).message })}\n`));
            output.close();
          }
          request.signal.removeEventListener("abort", abort);
        }
      },
      async cancel() {
        cancelled = true;
        abort();
        request.signal.removeEventListener("abort", abort);
        await iterator.return(undefined);
      },
    });
    return new Response(stream, {
      headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    const safe = safeError(request.signal.aborted ? new PipelineError("cancelled") : error);
    return Response.json({ error: safe.message }, { status: safe.status, headers });
  }
}
