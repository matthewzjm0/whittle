import { useEffect, useRef, useState } from "react";
import { LIMITS } from "@/lib/pipeline";
import type { ModelChoice, StudioModel } from "@/lib/pipeline";
import { parseEndpoint } from "@/lib/pipeline/endpoint";
import { Field } from "./Field";
import s from "./studio.module.css";

function isModelChoice(value: unknown): value is ModelChoice {
  return !!value && typeof value === "object" && "id" in value && "name" in value
    && typeof value.id === "string" && typeof value.name === "string"
    && (!("contextWindow" in value) || (typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0));
}

export function ModelDialog({ existing, configuredModels, onSave, onClose, onDelete }: { existing?: StudioModel; configuredModels: StudioModel[]; onSave: (model: StudioModel) => void; onClose: () => void; onDelete: (id: string) => void }) {
  const [form, setForm] = useState<StudioModel>(existing ?? { id: "", name: "", model: "", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 32768, apiKey: configuredModels.find((model) => model.baseUrl === "https://openrouter.ai/api/v1" && model.apiKey)?.apiKey ?? "" });
  const [provider, setProvider] = useState(existing?.baseUrl.includes("openrouter.ai") ? "openrouter"
    : existing?.baseUrl.includes("api.openai.com") ? "openai"
      : existing?.baseUrl.includes("api.deepseek.com") ? "deepseek" : existing ? "custom" : "openrouter");
  const [showKey, setShowKey] = useState(false);
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>([]);
  const [screen, setScreen] = useState<"connect" | "choose" | "manual">("connect");
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState(existing?.model ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inputCost, setInputCost] = useState(existing?.inputCostPerMillion !== undefined ? String(existing.inputCostPerMillion) : "");
  const [outputCost, setOutputCost] = useState(existing?.outputCostPerMillion !== undefined ? String(existing.outputCostPerMillion) : "");
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);

  function parseCost(raw: string, label: string): number | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`${label} token cost must be a number from 0 to 1,000,000.`);
    return value;
  }

  function keyForEndpoint(baseUrl: string): string {
    return configuredModels.find((model) => model.baseUrl === baseUrl && model.apiKey)?.apiKey ?? "";
  }

  function changeProvider(value: string) {
    setProvider(value);
    const baseUrl = value === "openrouter" ? "https://openrouter.ai/api/v1"
      : value === "openai" ? "https://api.openai.com/v1"
        : value === "deepseek" ? "https://api.deepseek.com" : "";
    setForm((previous) => ({ ...previous, baseUrl, apiKey: keyForEndpoint(baseUrl) }));
    setModelChoices([]);
    setError("");
  }

  async function loadModels() {
    setDiscovering(true);
    setError("");
    try {
      parseEndpoint(form.baseUrl.trim());
      if (form.apiKey && !/^[\x21-\x7e]*$/.test(form.apiKey)) throw new Error("The API key contains spaces or invalid characters.");
      const response = await fetch("/api/pipeline", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "models", connection: { baseUrl: form.baseUrl.trim(), ...(form.apiKey ? { apiKey: form.apiKey } : {}) } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load models from this endpoint.");
      const available: unknown = data.models;
      if (!Array.isArray(available) || !available.every(isModelChoice)) throw new Error("The provider returned an invalid model list.");
      const choices = available as ModelChoice[];
      setModelChoices(choices);
      if (choices.length) {
        setScreen("choose");
        setQuery("");
      } else {
        setScreen("manual");
        setError("The provider returned no model IDs. Enter one manually to continue.");
      }
    } catch (e) {
      setModelChoices([]);
      setScreen("manual");
      setError(`${e instanceof Error ? e.message : "Model discovery failed."} Enter the model ID manually to continue.`);
    } finally { setDiscovering(false); }
  }

  function saveSelection(choice: ModelChoice) {
    try {
      parseEndpoint(form.baseUrl.trim());
      if (form.apiKey && !/^[\x21-\x7e]*$/.test(form.apiKey)) throw new Error("The API key contains spaces or invalid characters.");
      if (!choice.id.trim()) throw new Error("Choose a model ID first.");
      const input = parseCost(inputCost, "Input");
      const output = parseCost(outputCost, "Output");
      onSave({
        id: existing?.id ?? crypto.randomUUID(),
        name: choice.name || choice.id,
        model: choice.id,
        baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
        contextWindow: choice.contextWindow ?? form.contextWindow ?? 32768,
        outputTokenField: form.outputTokenField ?? "max_tokens",
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(input !== undefined ? { inputCostPerMillion: input } : {}),
        ...(output !== undefined ? { outputCostPerMillion: output } : {}),
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Invalid model configuration."); }
  }
  const visibleModels = modelChoices.filter((choice) => `${choice.name} ${choice.id}`.toLowerCase().includes(query.toLowerCase()));
  return <dialog ref={dialogRef} className={s.modelDialog} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} aria-labelledby="model-dialog-title">
    {screen === "choose" ? <div className={s.modelPicker}>
      <div className={s.dialogHeading}><div><span className={s.eyebrow}>PROVIDER CONNECTED</span><h2 id="model-dialog-title">Choose a model</h2></div><button type="button" className={s.closeButton} onClick={onClose} aria-label="Close model picker">&times;</button></div>
      <p className={s.dialogIntro}>Select a model to add it to your workspace. Add another later using the same provider key.</p>
      <input autoFocus aria-label="Search available models" className={s.modelSearch} placeholder="Search model IDs..." value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={s.modelChoices} role="listbox" aria-label="Available models">
        {visibleModels.map((choice) => <button type="button" role="option" aria-selected="false" key={choice.id} className={s.modelChoice} onClick={() => saveSelection(choice)}>
          <span className={s.modelChoiceIcon}>AI</span><span className={s.modelChoiceText}><strong>{choice.name}</strong><small>{choice.id}{choice.contextWindow ? ` · ${choice.contextWindow.toLocaleString()} context` : ""}</small></span><span className={s.modelChoiceArrow}>Add</span>
        </button>)}
        {visibleModels.length === 0 && <p className={s.emptyNote}>No models match that search.</p>}
      </div>
      <div className={s.advancedModel}><details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>Advanced model settings</summary>
        <div className={s.advancedModelFields}>
          <Field label="Fallback context window"><input type="number" min={LIMITS.minContextTokens} max={LIMITS.contextTokens} step={1} value={form.contextWindow} onChange={(event) => setForm({ ...form, contextWindow: Number(event.target.value) })} /></Field>
          <Field label="Output token parameter"><select value={form.outputTokenField ?? "max_tokens"} onChange={(event) => setForm({ ...form, outputTokenField: event.target.value as StudioModel["outputTokenField"] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></Field>
          <Field label="Input cost (USD per 1M tokens)" hint="Used by existing saved Delegated blocks to rank models by token cost. Leave blank when unknown."><input type="number" min={0} max={1_000_000} step="any" value={inputCost} placeholder="0.15" onChange={(event) => setInputCost(event.target.value)} /></Field>
          <Field label="Output cost (USD per 1M tokens)"><input type="number" min={0} max={1_000_000} step="any" value={outputCost} placeholder="0.60" onChange={(event) => setOutputCost(event.target.value)} /></Field>
        </div>
      </details></div>
      <div className={s.pickerFooter}><button type="button" className={s.manualToggle} onClick={() => setScreen("manual")}>Enter a model ID manually</button><button type="button" className={s.ghostButton} onClick={() => setScreen("connect")}>Back</button></div>
    </div> : <form onSubmit={(event) => {
      event.preventDefault();
      if (screen !== "manual") return;
      const id = manualId.trim();
      if (!id) { setError("Enter a model ID."); return; }
      saveSelection({ id, name: id, ...(existing ? { contextWindow: existing.contextWindow } : {}) });
    }}>
      <div className={s.dialogHeading}><div><span className={s.eyebrow}>{screen === "manual" ? "MANUAL MODEL SETUP" : "CONNECT A PROVIDER"}</span><h2 id="model-dialog-title">{existing ? "Select a model" : "Add a model"}</h2></div><button type="button" className={s.closeButton} onClick={onClose} aria-label="Close model connection">&times;</button></div>
      <p className={s.dialogIntro}>Connect once, then choose from the available model list. Usage is billed to the provider account for this API key.</p>
      {screen === "connect" ? <>
        <Field label="Provider"><select value={provider} onChange={(event) => changeProvider(event.target.value)}><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="custom">OpenAI-compatible</option></select></Field>
        {provider === "custom" && <Field label="API base URL" hint="Use an OpenAI-compatible API root. HTTPS is required except for explicitly enabled loopback. Model IDs are fetched from GET /models."><input required type="url" value={form.baseUrl} maxLength={2048} placeholder="https://api.example.com/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value, apiKey: keyForEndpoint(e.target.value) })} /></Field>}
        <Field label="API key" hint="Held in memory only; it is not saved to this browser. Enter it again after a reload."><div className={s.keyInput}><input autoFocus={!existing} aria-label="API key" type={showKey ? "text" : "password"} value={form.apiKey ?? ""} maxLength={4096} autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /><button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Show"}</button></div></Field>
        <button type="button" className={s.discoverButton} aria-busy={discovering} disabled={discovering || !form.baseUrl.trim()} onClick={() => void loadModels()}>{discovering ? "Connecting..." : "Connect and load models"}</button>
        <button type="button" className={s.manualToggle} onClick={() => setScreen("manual")}>Enter a model ID manually</button>
      </> : <>
        <Field label="API base URL"><input required type="url" value={form.baseUrl} maxLength={2048} placeholder="https://api.example.com/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Field>
        <Field label="API key"><div className={s.keyInput}><input aria-label="API key" type={showKey ? "text" : "password"} value={form.apiKey ?? ""} maxLength={4096} autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /><button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Show"}</button></div></Field>
        <Field label="Model ID"><input autoFocus required value={manualId} maxLength={256} placeholder="Exact model identifier" onChange={(e) => setManualId(e.target.value)} /></Field>
        <div className={s.advancedModel}><details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}><summary>Advanced model settings</summary>
          <div className={s.advancedModelFields}>
            <Field label="Context window"><input type="number" min={LIMITS.minContextTokens} max={LIMITS.contextTokens} step={1} value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: Number(e.target.value) })} /></Field>
            <Field label="Output token parameter"><select value={form.outputTokenField ?? "max_tokens"} onChange={(e) => setForm({ ...form, outputTokenField: e.target.value as StudioModel["outputTokenField"] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></Field>
            <Field label="Input cost (USD per 1M tokens)" hint="Used by existing saved Delegated blocks to rank models by token cost. Leave blank when unknown."><input type="number" min={0} max={1_000_000} step="any" value={inputCost} placeholder="0.15" onChange={(e) => setInputCost(e.target.value)} /></Field>
            <Field label="Output cost (USD per 1M tokens)"><input type="number" min={0} max={1_000_000} step="any" value={outputCost} placeholder="0.60" onChange={(e) => setOutputCost(e.target.value)} /></Field>
          </div>
        </details></div>
      </>}
      {error && <p className={s.formError} role="alert">{error}</p>}
      <div className={s.dialogActions}>{existing && <button type="button" className={s.dangerButton} onClick={() => onDelete(existing.id)}>Remove model</button>}{screen === "manual" && <button type="button" className={s.ghostButton} onClick={() => setScreen("connect")}>Back</button>}<button type="button" className={s.ghostButton} onClick={onClose}>Cancel</button>{screen === "manual" && <button className={s.primaryButton}>Add model</button>}</div>
    </form>}
  </dialog>;
}

