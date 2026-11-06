import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Complete, CompletionResult, CustomHttp, CustomHttpRequest, Message, ModelChoice, ModelConnection, ReasoningEffort, ToolCall, ToolSpec } from "./types";
import { isLoopbackAddress, isPublicAddress, parseCustomEndpoint, parseEndpoint } from "./endpoint";
import { checkAbort, LIMITS, PipelineError, safeError } from "./limits";
import { renderTemplate } from "./runner";
import { assertContext, isReasoningEffort, isReservedHeaderName, validateCompletion, validateCustomBlocks, validateModelConnection, validateModels, validateToolSpecs } from "./validation";

type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;

/** OpenRouter accepts xhigh and max; other providers and models may reject either, especially non-standard max. */
export function reasoningPayload(hostname: string, effort?: ReasoningEffort): object {
  return effort === undefined ? {} : hostname === "openrouter.ai" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

export async function resolveEndpoint(
  url: URL,
  resolve: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const deliberateLoopback = host === "localhost" || isLoopbackAddress(host);
  let addresses: Address[];
  try {
    const family = isIP(host);
    addresses = family ? [{ address: host, family }] : await resolve(host);
  } catch {
    throw new PipelineError("dns", host);
  }
  if (!addresses.length || addresses.some(({ address, family }) => isIP(address) !== family
    || (deliberateLoopback ? !isLoopbackAddress(address) : !isPublicAddress(address)))) {
    throw new PipelineError("address");
  }
  if (deliberateLoopback) {
    // Local servers commonly bind only 127.0.0.1, while "localhost" resolves to ::1 first.
    const ipv4 = addresses.find(({ address }) => isLoopbackAddress(address) && !address.includes(":"));
    if (ipv4) return ipv4;
  }
  return addresses[0];
}

/** Keys live only in request memory; never persisted or logged. */
function toWireMessage(message: Message): object {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

function toWireTools(tools: ToolSpec[]): object[] {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

function parseWireToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry) => {
    const call = (entry ?? {}) as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    // Some OpenAI-compatible servers return arguments as an object instead of a JSON string.
    const args = call.function?.arguments;
    const argumentText = args !== null && typeof args === "object" ? JSON.stringify(args) : args;
    return { id: call.id, name: call.function?.name, arguments: argumentText } as ToolCall;
  });
}

export function createComplete(options: {
  resolve?: Resolver;
  timeoutMs?: number;
  allowLoopback?: boolean;
} = {}): Complete {
  const timeoutMs = Math.min(LIMITS.providerTimeoutMs, Math.max(1, options.timeoutMs ?? LIMITS.providerTimeoutMs));
  return async (model, messages, maxOutputTokens, signal, effort, tools) => {
    checkAbort(signal);
    if (effort !== undefined && !isReasoningEffort(effort)) throw new PipelineError("request");
    validateModels([model]);
    if (tools !== undefined) validateToolSpecs(tools);
    const toolTokens = tools ? Math.ceil(JSON.stringify(toWireTools(tools)).length / 3) : 0;
    assertContext(model, messages, maxOutputTokens, { allowToolMessages: true, extraInputTokens: toolTokens });
    const url = parseEndpoint(model.baseUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    const allowLoopback = options.allowLoopback ?? (process.env.PIPELINE_ALLOW_LOOPBACK === "true");
    if ((hostname === "localhost" || isLoopbackAddress(hostname)) && !allowLoopback) {
      throw new PipelineError("loopback");
    }
    const path = url.pathname.replace(/\/+$/, "");
    const endpointPath = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
    const payload = JSON.stringify({
      model: model.model, messages: messages.map(toWireMessage), [model.outputTokenField ?? "max_tokens"]: maxOutputTokens, stream: false,
      ...(tools ? { tools: toWireTools(tools), tool_choice: "auto" } : {}),
      ...reasoningPayload(hostname, effort),
    });
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new PipelineError(timedOut ? "timeout" : "cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const operation = async (): Promise<CompletionResult> => {
        const pinned = await resolveEndpoint(url, options.resolve);
        checkAbort(controller.signal);
        return new Promise<CompletionResult>((resolve, reject) => {
          const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
          const headers: Record<string, string> = {
            Host: url.host,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "Content-Length": String(Buffer.byteLength(payload)),
          };
          if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
          // Connect to the validated IP, not the hostname: a second DNS lookup could rebind.
          // Preserve Host and TLS SNI/certificate validation for the original endpoint.
          const request = transport({
            hostname: pinned.address,
            family: pinned.family,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: endpointPath,
            method: "POST",
            headers,
            agent: false,
            ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
            signal: controller.signal,
            maxHeaderSize: 16_384,
          }, (response) => {
            // Native HTTP never follows redirects, including redirects into local networks.
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new PipelineError("provider", `HTTP ${response.statusCode}`));
              response.destroy();
              return;
            }
            const declaredSize = Number(response.headers["content-length"]);
            if (declaredSize > LIMITS.providerBytes) {
              reject(new PipelineError("response", "oversized-response"));
              response.destroy();
              return;
            }
            if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
              reject(new PipelineError("response", "unsupported-encoding"));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > LIMITS.providerBytes) {
                reject(new PipelineError("response", "oversized-response"));
                response.destroy();
              } else {
                chunks.push(chunk);
              }
            });
            response.on("error", () => reject(new PipelineError("provider")));
            response.on("aborted", () => reject(new PipelineError("provider")));
            response.on("end", () => {
              try {
                checkAbort(controller.signal);
                let body: {
                  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
                  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } | null;
                };
                try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
                catch { throw new PipelineError("response", "invalid-json"); }
                const message = body?.choices?.[0]?.message;
                const toolCalls = tools ? parseWireToolCalls(message?.tool_calls) : undefined;
                // A reply that only requests tools may carry null or empty content.
                const text: unknown = toolCalls && (message?.content === null || message?.content === undefined) ? "" : message?.content;
                if (typeof text !== "string") throw new PipelineError("response", "missing-text");
                if (text.length > LIMITS.textChars) throw new PipelineError("response", "oversized-text");
                let completion = validateCompletion({ text, ...(toolCalls ? { toolCalls } : {}) });
                if (body?.usage !== undefined) {
                  const usage = {
                    input: body.usage?.prompt_tokens,
                    output: body.usage?.completion_tokens,
                    ...(body.usage?.cost === undefined ? {} : { cost: body.usage.cost }),
                  };
                  try { completion = validateCompletion({ text, ...(toolCalls ? { toolCalls } : {}), usage }); }
                  catch { /* Usage is optional; bad metadata must not discard a valid completion. */ }
                }
                resolve(completion);
              } catch (error) {
                reject(error instanceof PipelineError && error.code === "response"
                  ? error : new PipelineError("response", "invalid-completion"));
              }
            });
          });
          request.on("error", () => reject(new PipelineError("provider")));
          request.end(payload);
        });
      };
      const result = await Promise.race([operation(), aborted]);
      checkAbort(signal);
      return result;
    } catch (error) {
      if (signal.aborted) throw new PipelineError("cancelled");
      if (timedOut) throw new PipelineError("timeout");
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    }
  };
}

/** Discover a provider's model IDs via its OpenAI-compatible GET /models route. */
export async function discoverOpenAIModels(
  connection: ModelConnection,
  signal: AbortSignal,
  options: { resolve?: Resolver; timeoutMs?: number; allowLoopback?: boolean } = {},
): Promise<ModelChoice[]> {
  checkAbort(signal);
  validateModelConnection(connection);
  const url = parseEndpoint(connection.baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const allowLoopback = options.allowLoopback ?? (process.env.PIPELINE_ALLOW_LOOPBACK === "true");
  if ((hostname === "localhost" || isLoopbackAddress(hostname)) && !allowLoopback) throw new PipelineError("loopback");
  const basePath = url.pathname.replace(/\/+$/, "");
  const endpointPath = basePath.endsWith("/models") ? basePath : `${basePath}/models`;
  const timeoutMs = Math.min(LIMITS.providerTimeoutMs, Math.max(1, options.timeoutMs ?? LIMITS.providerTimeoutMs));
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let rejectAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new PipelineError(timedOut ? "timeout" : "cancelled"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const operation = async (): Promise<ModelChoice[]> => {
      const pinned = await resolveEndpoint(url, options.resolve);
      checkAbort(controller.signal);
      return new Promise<ModelChoice[]>((resolve, reject) => {
        const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
        const headers: Record<string, string> = { Host: url.host, Accept: "application/json", "Accept-Encoding": "identity" };
        if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
        const request = transport({
          hostname: pinned.address,
          family: pinned.family,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: endpointPath,
          method: "GET",
          headers,
          agent: false,
          ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
          signal: controller.signal,
          maxHeaderSize: 16_384,
        }, (response) => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new PipelineError("provider", `HTTP ${response.statusCode}`)); response.destroy(); return;
          }
          const declaredSize = Number(response.headers["content-length"]);
          if (declaredSize > LIMITS.providerBytes
            || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
            reject(new PipelineError("response")); response.destroy(); return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > LIMITS.providerBytes) { reject(new PipelineError("response")); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on("error", () => reject(new PipelineError("provider")));
          response.on("aborted", () => reject(new PipelineError("provider")));
          response.on("end", () => {
            try {
              checkAbort(controller.signal);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!Array.isArray(body?.data) || body.data.length > LIMITS.modelChoices) throw new PipelineError("response");
              const choices: ModelChoice[] = [];
              const ids = new Set<string>();
              for (const item of body.data) {
                if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256 || /[\x00-\x1f\x7f]/.test(item.id)) continue;
                const id = item.id.trim();
                if (ids.has(id)) continue;
                const name = typeof item.name === "string" && item.name.trim() && item.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(item.name)
                  ? item.name.trim() : id;
                ids.add(id);
                const choice: ModelChoice = { id, name };
                if (Number.isSafeInteger(item.context_length) && item.context_length > 0
                  && item.context_length <= LIMITS.contextTokens) choice.contextWindow = item.context_length;
                choices.push(choice);
              }
              resolve(choices);
            } catch (error) { reject(error instanceof PipelineError ? error : new PipelineError("response")); }
          });
        });
        request.on("error", () => reject(new PipelineError("provider")));
        request.end();
      });
    };
    const models = await Promise.race([operation(), aborted]);
    checkAbort(signal);
    return models;
  } catch (error) {
    if (signal.aborted) throw new PipelineError("cancelled");
    if (timedOut) throw new PipelineError("timeout");
    throw safeError(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export const completeOpenAI: Complete = createComplete();

function customResponseText(body: unknown, responsePath?: string): string {
  let selected: unknown = body;
  if (responsePath !== undefined) {
    selected = body;
    for (const segment of responsePath.split(".")) {
      if (["__proto__", "prototype", "constructor"].includes(segment)
        || selected === null || typeof selected !== "object"
        || !Object.prototype.hasOwnProperty.call(selected, segment)) {
        throw new PipelineError("customResponse");
      }
      selected = (selected as Record<string, unknown>)[segment];
    }
    if (selected === undefined) throw new PipelineError("customResponse");
  } else if (body !== null && typeof body === "object" && !Array.isArray(body)
    && typeof (body as Record<string, unknown>).text === "string") {
    selected = (body as Record<string, unknown>).text;
  }
  const text = typeof selected === "string" ? selected : JSON.stringify(selected);
  if (typeof text !== "string" || text.length > LIMITS.textChars) throw new PipelineError("customResponse");
  return text;
}

/** Executes only the endpoint explicitly configured on a custom HTTP action. */
export function createCustomHttp(options: {
  resolve?: Resolver;
  timeoutMs?: number;
  allowLoopback?: boolean;
} = {}): CustomHttp {
  const timeoutMs = Math.min(LIMITS.providerTimeoutMs, Math.max(1, options.timeoutMs ?? LIMITS.providerTimeoutMs));
  return async ({ definition, input, value, variables, signal }: CustomHttpRequest) => {
    checkAbort(signal);
    validateCustomBlocks([definition]);
    if (definition.action.kind !== "http") throw new PipelineError("custom");
    const action = definition.action;
    const url = parseCustomEndpoint(action.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    const allowLoopback = options.allowLoopback ?? (process.env.PIPELINE_ALLOW_LOOPBACK === "true");
    if ((hostname === "localhost" || isLoopbackAddress(hostname)) && !allowLoopback) throw new PipelineError("loopback");
    let payload: string | undefined;
    if (action.bodyTemplate !== undefined) {
      const rendered = renderTemplate(action.bodyTemplate, input, value, variables);
      try { payload = JSON.stringify(JSON.parse(rendered)); }
      catch { throw new PipelineError("custom"); }
      if (Buffer.byteLength(payload) > LIMITS.providerBytes) throw new PipelineError("custom");
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new PipelineError(timedOut ? "timeout" : "cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const operation = async (): Promise<string> => {
        let pinned: Address;
        try { pinned = await resolveEndpoint(url, options.resolve); }
        catch (error) {
          if (error instanceof PipelineError && error.code === "dns") throw new PipelineError("customDns");
          throw error;
        }
        checkAbort(controller.signal);
        return new Promise<string>((resolve, reject) => {
          const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
          const headers: Record<string, string> = {
            Host: url.host,
            Accept: "application/json",
            "Accept-Encoding": "identity",
            "Content-Type": "application/json",
          };
          // Configured headers are validation-allowlisted; re-check so a bypassed
          // definition can never replace transport or credential headers.
          for (const [name, headerValue] of Object.entries(action.headers ?? {})) {
            if (!isReservedHeaderName(name)) headers[name] = headerValue;
          }
          if (payload !== undefined) headers["Content-Length"] = String(Buffer.byteLength(payload));
          if (definition.apiKey) {
            const authHeader = action.authHeader ?? "Authorization";
            const defaultPrefix = authHeader.toLowerCase() === "authorization" ? "Bearer " : "";
            headers[authHeader] = `${action.authPrefix ?? defaultPrefix}${definition.apiKey}`;
          }
          const request = transport({
            hostname: pinned.address,
            family: pinned.family,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: action.method,
            headers,
            agent: false,
            ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
            signal: controller.signal,
            maxHeaderSize: 16_384,
          }, (response) => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new PipelineError("customProvider"));
              response.destroy();
              return;
            }
            const declaredSize = Number(response.headers["content-length"]);
            if (declaredSize > LIMITS.providerBytes
              || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
              reject(new PipelineError("customResponse"));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > LIMITS.providerBytes) {
                reject(new PipelineError("customResponse"));
                response.destroy();
              } else chunks.push(chunk);
            });
            response.on("error", () => reject(new PipelineError("customProvider")));
            response.on("aborted", () => reject(new PipelineError("customProvider")));
            response.on("end", () => {
              try {
                checkAbort(controller.signal);
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                resolve(customResponseText(body, action.responsePath));
              } catch (error) {
                reject(error instanceof PipelineError ? error : new PipelineError("customResponse"));
              }
            });
          });
          request.on("error", () => reject(new PipelineError("customProvider")));
          request.end(payload);
        });
      };
      const result = await Promise.race([operation(), aborted]);
      checkAbort(signal);
      return result;
    } catch (error) {
      if (signal.aborted) throw new PipelineError("cancelled");
      if (timedOut) throw new PipelineError("customTimeout");
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    }
  };
}

export const executeCustomHttp: CustomHttp = createCustomHttp();
