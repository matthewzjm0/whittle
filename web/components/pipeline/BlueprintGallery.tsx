"use client";

import { useState } from "react";
import type { StudioModel } from "../../lib/pipeline/types";
import { BLUEPRINTS, instantiateBlueprint } from "./blueprints";
import type { Blueprint } from "./blueprints";
import { simulateBlueprint } from "./blueprint-demo";
import { RunSummary } from "./RunSummary";
import s from "./blueprints.module.css";

export function BlueprintGallery({ models, disabled, onCreate }: {
  models: StudioModel[];
  disabled: boolean;
  onCreate: (pipeline: ReturnType<typeof instantiateBlueprint>) => void;
}) {
  const [modelId, setModelId] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof simulateBlueprint>>>();
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  async function simulate(blueprint: Blueprint) {
    setPreviewing(true); setError(""); setPreview(undefined);
    try { setPreview(await simulateBlueprint(blueprint)); }
    catch { setError("Unable to run this simulated preview."); }
    finally { setPreviewing(false); }
  }
  return <details className={s.gallery}>
    <summary>Starter blueprints</summary>
    <p>Choose a model explicitly to create a new pipeline, or preview with the offline simulated demo model. Existing pipelines are kept.</p>
    <fieldset disabled={disabled || previewing}>
      <label>Model for new pipeline<select value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">Choose a model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      {BLUEPRINTS.map((blueprint) => <div key={blueprint.name} className={s.card}>
        <strong>{blueprint.name}</strong><p>{blueprint.description}</p>
        <button type="button" disabled={!models.some((model) => model.id === modelId)} onClick={() => onCreate(instantiateBlueprint(blueprint, modelId))}>Use blueprint</button>
        <button type="button" onClick={() => void simulate(blueprint)}>Simulated preview</button>
      </div>)}
    </fieldset>
    {previewing && <p role="status">Running simulated preview...</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <div><p>Simulated only: no provider calls, reported usage, billing, or saved demo model.</p><pre className={s.preview}>{preview.output}</pre><RunSummary run={preview.run} /></div>}
  </details>;
}
