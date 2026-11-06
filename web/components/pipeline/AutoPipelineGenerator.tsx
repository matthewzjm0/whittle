"use client";

import { useState } from "react";
import { LIMITS } from "../../lib/pipeline";
import type { StudioModel } from "../../lib/pipeline/types";
import { PipelineGenerationError, parseGeneratedPipeline, pipelinePlanMessages, pipelinePlanOutputTokens, pipelinePlannerError } from "./pipeline-generator";
import type { GeneratedPipeline } from "./pipeline-generator";
import s from "./auto-pipeline-generator.module.css";

export function AutoPipelineGenerator({ models, disabled, onAddModel, onGeneratingChange, onCreate }: {
  models: StudioModel[];
  disabled: boolean;
  onAddModel: () => void;
  onGeneratingChange: (generating: boolean) => void;
  onCreate: (pipeline: GeneratedPipeline) => boolean;
}) {
  const [task, setTask] = useState("");
  const [orchestratorId, setOrchestratorId] = useState("");
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [parallelism, setParallelism] = useState(50);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function generate() {
    if (disabled || generating) return;
    const orchestrator = models.find((model) => model.id === orchestratorId);
    if (!orchestrator) { setError("Choose an orchestrator model first."); return; }
    if (!task.trim()) { setError("Enter the task for the new pipeline."); return; }
    const workers = models.filter((model) => workerIds.includes(model.id));
    let messages;
    let maxOutputTokens: number;
    try {
      messages = pipelinePlanMessages(task, orchestrator, workers, models, parallelism);
      maxOutputTokens = pipelinePlanOutputTokens(orchestrator, messages);
    } catch (caught) {
      setError(caught instanceof PipelineGenerationError ? caught.message : "The task could not be prepared for planning.");
      return;
    }
    setGenerating(true); onGeneratingChange(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "chat", model: orchestrator, messages, maxOutputTokens }),
      });
      const result = await response.json().catch(() => undefined);
      if (!response.ok) throw pipelinePlannerError(typeof result?.error === "string" ? result.error : undefined, response.status);
      if (!result || typeof result.text !== "string") throw new PipelineGenerationError("The planner returned no text. Try again.");
      const pipeline = parseGeneratedPipeline(result.text, task, orchestrator, workers, models, parallelism);
      if (!onCreate(pipeline)) throw new PipelineGenerationError("Models changed while the plan was being generated. Check the available models and try again.");
      setTask(""); setNotice(`Created "${pipeline.name}". Review its steps before running it.`);
    } catch (caught) {
      setError(caught instanceof PipelineGenerationError ? caught.message : "Pipeline generation failed. Check the selected model connection and try again.");
    } finally {
      setGenerating(false); onGeneratingChange(false);
    }
  }

  return <details className={s.generator}>
    <summary>Generate pipeline from task</summary>
    <p>The selected model designs a bounded pipeline. Choose an orchestrator and optional workers, then use the Series/Parallel slider to steer delegation. Review every generated step before running it; only selected models can be assigned.</p>
    {models.length === 0 ? <><p>Connect a model before generating a pipeline.</p><button type="button" onClick={onAddModel} disabled={disabled}>+ Add model</button></> : <fieldset disabled={disabled || generating}>
      <label>Task<textarea value={task} maxLength={LIMITS.inputChars} rows={4} placeholder="Describe the project and the result you want." onChange={(event) => setTask(event.target.value)} /></label>
      <label>Orchestrator<select value={orchestratorId} onChange={(event) => { const id = event.target.value; setOrchestratorId(id); setWorkerIds((previous) => previous.filter((workerId) => workerId !== id)); }}><option value="">Choose a model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <div className={s.workers}><span>Worker models (optional)</span>{models.filter((model) => model.id !== orchestratorId).map((model) => <label key={model.id}><input type="checkbox" checked={workerIds.includes(model.id)} onChange={(event) => setWorkerIds((previous) => event.target.checked ? [...previous, model.id] : previous.filter((id) => id !== model.id))} /><span>{model.name}</span></label>)}</div>
      <label className={s.speed}>Series <span>Parallel · {parallelism}%</span><input type="range" min={0} max={100} step={1} value={parallelism} aria-label="Pipeline parallelism preference" aria-valuetext={parallelism === 0 ? "Series only" : `${parallelism}% parallel preference`} onChange={(event) => setParallelism(Number(event.target.value))} /></label>
      <small>Planner output is capped at 4096 tokens and checked against the orchestrator&apos;s context. Auto/Manual settings apply when the generated pipeline runs.</small>
      <small>Higher parallel preference encourages delegated work and may use more model calls. Select worker models to enable delegation.</small>
      <button type="button" disabled={!task.trim() || !orchestratorId} onClick={() => void generate()}>{generating ? "Designing pipeline..." : "Generate new pipeline"}</button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </details>;
}
