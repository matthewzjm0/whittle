import type { CustomBlockDefinition, PipelineEvent, PipelineNode, TokenUsage } from "../../lib/pipeline/types";
import type { RunGoals } from "./run-goals";

export type RunStatus = "running" | "complete" | "failed" | "stopped";
export type RunStats = {
  pipelineId: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  usage?: TokenUsage;
  goals?: RunGoals;
  nodes: Array<{ id: string; label: string; calls: "local" | "model" | "delegated" }>;
  executions: Array<{ nodeId: string; startedAt: number; endedAt?: number; status: RunStatus; usage?: TokenUsage }>;
};

export function createRunStats(pipelineId: string, name: string, nodes: PipelineNode[], now: number, customBlocks: CustomBlockDefinition[] = []): RunStats {
  return { pipelineId, name, startedAt: now, status: "running", nodes: nodes.map((node) => ({
    id: node.id, label: node.label,
    calls: node.type === "delegated" ? "delegated" : node.type === "model"
      || (node.type === "custom" && customBlocks.find((block) => block.id === node.customBlockId)?.action.kind === "model") ? "model" : "local",
  })), executions: [] };
}

function reportedUsage(usage?: TokenUsage): TokenUsage | undefined {
  return usage ? { input: usage.input, output: usage.output, ...(usage.cost === undefined ? {} : { cost: usage.cost }) } : undefined;
}

export function finishRunStats(run: RunStats, status: Exclude<RunStatus, "running">, now: number): RunStats {
  if (run.status !== "running") return run;
  return {
    ...run, status, endedAt: now,
    executions: run.executions.map((step) => step.endedAt === undefined ? { ...step, endedAt: now, status } : step),
  };
}

export function recordRunEvent(run: RunStats, event: PipelineEvent, now: number): RunStats {
  if (run.status !== "running") return run;
  if (event.type === "complete") return finishRunStats({ ...run, usage: reportedUsage(event.usage) }, "complete", now);
  if (event.type === "error") return finishRunStats(run, "failed", now);
  if (!event.nodeId) return run;
  if (event.type === "node-start") return { ...run, executions: [...run.executions, { nodeId: event.nodeId, startedAt: now, status: "running" }] };
  if (event.type === "node-complete") return {
    ...run,
    executions: run.executions.map((step) => step.nodeId === event.nodeId && step.endedAt === undefined
      ? { ...step, endedAt: now, status: "complete", usage: reportedUsage(event.usage) } : step),
  };
  return run;
}

export function blockTimings(run?: RunStats): Map<string, number> {
  const totals = new Map<string, number>();
  for (const step of run?.executions ?? []) {
    if (step.endedAt !== undefined) totals.set(step.nodeId, (totals.get(step.nodeId) ?? 0) + Math.max(0, step.endedAt - step.startedAt));
  }
  return totals;
}

export function slowestBlockId(run?: RunStats): string | undefined {
  if (!run || run.status === "running") return;
  let slowest: string | undefined;
  let longest = -1;
  for (const [id, duration] of blockTimings(run)) if (duration > longest) { slowest = id; longest = duration; }
  return slowest;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function summarizeRun(run: RunStats) {
  const timings = blockTimings(run);
  const blocks = run.nodes.flatMap((node) => {
    const steps = run.executions.filter((step) => step.nodeId === node.id);
    if (!steps.length) return [];
    const reported = (field: keyof TokenUsage) => {
      if (!steps.every((step) => step.status === "complete" && step.usage?.[field] !== undefined)) return;
      const total = steps.reduce((sum, step) => sum + step.usage![field]!, 0);
      return Number.isFinite(total) ? total : undefined;
    };
    return [{
      id: node.id, label: node.label, executions: steps.length, durationMs: timings.get(node.id) ?? 0,
      input: reported("input"), output: reported("output"), cost: reported("cost"),
      modelCalls: node.calls === "local" ? 0 : node.calls === "model" && steps.every((step) => step.status === "complete") ? steps.length : undefined,
    }];
  });
  return {
    durationMs: Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt),
    cost: run.status === "complete" ? run.usage?.cost : undefined,
    modelCalls: run.status === "complete" && blocks.every((block) => block.modelCalls !== undefined)
      ? blocks.reduce((sum, block) => sum + block.modelCalls!, 0) : undefined,
    blocks,
  };
}

export function formatCost(cost?: number): string {
  return cost === undefined ? "Unknown" : `$${cost.toFixed(6)}`;
}
