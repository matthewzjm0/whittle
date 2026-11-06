import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LIMITS, validateCustomBlocks } from "@/lib/pipeline";
import type { CustomBlockDefinition, StudioModel } from "@/lib/pipeline";
import { Field } from "./Field";
import s from "./studio.module.css";

type HttpAction = Extract<CustomBlockDefinition["action"], { kind: "http" }>;

function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n");
}

function parseHeaders(text: string): Record<string, string> | string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > LIMITS.customHeaders) return `Use at most ${LIMITS.customHeaders} additional headers.`;
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) return "Write each additional header as Name: Value.";
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (seen.has(name.toLowerCase())) return `The ${name} header is listed twice.`;
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  return headers;
}

/** Rebuilds the HTTP action so cleared optional fields are omitted rather than sent as empty strings. */
function httpAction(action: HttpAction, headers: Record<string, string>): HttpAction {
  const next: HttpAction = { kind: "http", method: action.method, url: action.url.trim() };
  if (action.bodyTemplate) next.bodyTemplate = action.bodyTemplate;
  if (action.responsePath) next.responsePath = action.responsePath;
  if (action.authHeader) next.authHeader = action.authHeader;
  if (action.authPrefix) next.authPrefix = action.authPrefix;
  if (Object.keys(headers).length) next.headers = headers;
  return next;
}

export function CustomBlockDialog({ existing, models, onSave, onClose, onDelete }: { existing?: CustomBlockDefinition; models: StudioModel[]; onSave: (block: CustomBlockDefinition) => void; onClose: () => void; onDelete: (id: string) => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [action, setAction] = useState<CustomBlockDefinition["action"]>(existing?.action ?? { kind: "model", modelId: models[0]?.id ?? "", prompt: "" });
  const [headersText, setHeadersText] = useState(existing?.action?.kind === "http" ? formatHeaders(existing.action.headers) : "");
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);

  function changeKind(kind: CustomBlockDefinition["action"]["kind"]) {
    switch (kind) {
      case "model": setAction({ kind, modelId: models[0]?.id ?? "", prompt: "" }); break;
      case "template": setAction({ kind, template: "{{value}}" }); break;
      case "math": setAction({ kind, operation: "add", operand: 0 }); break;
      case "http": setAction({ kind, method: "GET", url: "", bodyTemplate: "", responsePath: "", authHeader: "Authorization", authPrefix: "Bearer " }); setHeadersText(""); break;
      case "cost": setAction({ kind }); break;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!name.trim()) { setError("Enter a name for this custom block."); return; }
    if (action.kind === "model" && (!models.some((model) => model.id === action.modelId) || !action.prompt.trim())) {
      setError("Choose a configured model and enter its instructions."); return;
    }
    if (action.kind === "template" && action.template.length > LIMITS.templateChars) {
      setError("The text template is too long."); return;
    }
    if (action.kind === "math" && !Number.isFinite(action.operand)) {
      setError("Enter a valid numeric operand."); return;
    }
    let finalAction = action;
    if (action.kind === "http") {
      try {
        const url = new URL(action.url);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch { setError("Enter a complete HTTP or HTTPS URL."); return; }
      if (action.bodyTemplate && action.bodyTemplate.length > LIMITS.templateChars) { setError("The JSON body template is too long."); return; }
      const headers = parseHeaders(headersText);
      if (typeof headers === "string") { setError(headers); return; }
      finalAction = httpAction(action, headers);
      if (apiKey && !/^[\x21-\x7e]*$/.test(apiKey)) { setError("The API key contains spaces or invalid characters."); return; }
    }
    const block: CustomBlockDefinition = { id: existing?.id ?? crypto.randomUUID(), name: name.trim(), action: finalAction,
      ...(finalAction.kind === "http" && apiKey ? { apiKey } : {}),
    };
    try { validateCustomBlocks([block]); }
    catch { setError("Check the action fields. HTTP URLs, response paths, headers, and API keys must use supported formats."); return; }
    onSave(block);
  }

  return <dialog ref={dialogRef} className={s.modelDialog} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-labelledby="custom-block-dialog-title">
    <form onSubmit={submit}>
      <div className={s.dialogHeading}><div><span className={s.eyebrow}>REUSABLE WORKFLOW STEP</span><h2 id="custom-block-dialog-title">{existing ? "Edit custom block" : "Create a custom block"}</h2></div><button type="button" className={s.closeButton} onClick={onClose} aria-label="Close custom block settings">&times;</button></div>
      <p className={s.dialogIntro}>Build a reusable step using a model, a text template, numeric math, an explicit HTTP API call, or accumulated model cost.</p>
      <Field label="Block name"><input autoFocus required value={name} maxLength={100} placeholder="Research or Format response" onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Action"><select value={action.kind} onChange={(event) => changeKind(event.target.value as CustomBlockDefinition["action"]["kind"])}>
        <option value="model">Model step</option><option value="template">Text / template</option><option value="math">Number operation</option><option value="http">HTTP API</option><option value="cost">Cost so far</option>
      </select></Field>
      {action.kind === "model" && <>
        <Field label="Model"><select required value={action.modelId} onChange={(event) => setAction({ ...action, modelId: event.target.value })}><option value="">Choose a model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.model})</option>)}</select></Field>
        <Field label="Instructions" hint="Sent to this model as system instructions. Refer to {{input}}, {{value}}, or a named variable."><textarea required rows={7} maxLength={LIMITS.templateChars} value={action.prompt} placeholder="Research the question carefully. Separate verified details from assumptions and remaining uncertainty." onChange={(event) => setAction({ ...action, prompt: event.target.value })} /></Field>
        <p className={s.dialogHint}>This named Model step is the only custom action that calls a model. Prompt-only model steps do not automatically browse or search the web. For research, configure a model with those capabilities or use an HTTP block to call an explicit research API.</p>
      </>}
      {action.kind === "template" && <Field label="Text template" hint="Rendered with the incoming value and named variables. No model is called."><textarea required rows={7} maxLength={LIMITS.templateChars} value={action.template} placeholder="Result: {{value}}" onChange={(event) => setAction({ ...action, template: event.target.value })} /></Field>}
      {action.kind === "math" && <>
        <Field label="Operation"><select value={action.operation} onChange={(event) => setAction({ ...action, operation: event.target.value as typeof action.operation })}><option value="add">Add</option><option value="subtract">Subtract</option><option value="multiply">Multiply</option><option value="divide">Divide</option></select></Field>
        <Field label="Operand" hint="Applied to the numeric incoming value. Division by zero is rejected by the runner."><input required type="number" step="any" value={action.operand} onChange={(event) => setAction({ ...action, operand: Number(event.target.value) })} /></Field>
      </>}
      {action.kind === "http" && <>
        <p className={s.dialogHint}>HTTP blocks make an explicit API call to the URL below. They do not execute arbitrary code or invoke a model.</p>
        <Field label="Method"><select value={action.method} onChange={(event) => setAction({ ...action, method: event.target.value as typeof action.method })}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></Field>
        <Field label="Request URL"><input required type="url" value={action.url} maxLength={2048} placeholder="https://api.example.com/v1/search" onChange={(event) => setAction({ ...action, url: event.target.value })} /></Field>
        <Field label="JSON body template (optional)" hint="Used with methods that accept a body. The rendered request body must be valid JSON."><textarea rows={5} maxLength={LIMITS.templateChars} value={action.bodyTemplate ?? ""} placeholder={'{\n  "query": "{{value}}"\n}'} onChange={(event) => setAction({ ...action, bodyTemplate: event.target.value })} /></Field>
        <Field label="Response path (optional)" hint="Dot-separated path to the response value, for example data.results. Leave blank for the full response."><input value={action.responsePath ?? ""} maxLength={512} placeholder="data.results" onChange={(event) => setAction({ ...action, responsePath: event.target.value })} /></Field>
        <Field label="Auth header name (optional)"><input value={action.authHeader ?? ""} maxLength={128} placeholder="Authorization" onChange={(event) => setAction({ ...action, authHeader: event.target.value })} /></Field>
        <Field label="Auth header prefix (optional)" hint="For example, Bearer followed by a space."><input value={action.authPrefix ?? ""} maxLength={128} placeholder="Bearer " onChange={(event) => setAction({ ...action, authPrefix: event.target.value })} /></Field>
        <Field label="Additional request headers (optional)" hint="One Name: Value per line, for APIs that require a fixed header. Notion needs Notion-Version: 2026-03-11. These are saved with the block, so never put a secret here; use the API key field for credentials."><textarea rows={3} value={headersText} placeholder={"Notion-Version: 2026-03-11"} onChange={(event) => setHeadersText(event.target.value)} /></Field>
        <Field label="API key" hint="Password stored in memory only; never saved or exported. After a page reload, edit this block and re-enter the key."><input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={4096} onChange={(event) => setApiKey(event.target.value)} /></Field>
      </>}
      {action.kind === "cost" && <p className={s.dialogHint}>Uses exact per-call USD cost when the provider reports it. If any model step omits cost, this outputs Unknown. It does not query your account balance.</p>}
      {error && <p className={s.formError} role="alert">{error}</p>}
      <div className={s.dialogActions}>{existing && <button type="button" className={s.dangerButton} onClick={() => onDelete(existing.id)}>Remove block</button>}<button type="button" className={s.ghostButton} onClick={onClose}>Cancel</button><button className={s.primaryButton}>{existing ? "Save changes" : "Create block"}</button></div>
    </form>
  </dialog>;
}
