import { DEFAULT_DELEGATED_WORKERS, LIMITS } from "./limits";
import { reachableNodes } from "./reach";
import { resolveDelegatedModels } from "./delegation";
import type { CustomBlockDefinition, Message, PipelineGraph, StudioModel } from "./types";
import { estimateTokens } from "./validation";

// Mirrors the caps the runner applies to each delegated stage.
const DELEGATION_TEAM_OUTPUT_CAP = 8192;
const DELEGATION_PLANNER_OUTPUT_CAP = 2048;

export type RunEstimate = {
  /** Predicted model calls; delegated worker slots are counted at their configured ceiling. */
  calls: number;
  delegatedBlocks: number;
  workerCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of priced calls in USD. Undefined when no reachable call has token costs. */
  usd?: number;
  /** Distinct model names used by calls that have no token cost configured. */
  unpriced: string[];
};

type PricedCall = { model: StudioModel; inputTokens: number; outputTokens: number };

function promptMessages(prompt: string, input: string): Message[] {
  return prompt.trim()
    ? [{ role: "system", content: prompt }, { role: "user", content: input }]
    : [{ role: "user", content: input }];
}

function hasCost(model: StudioModel): boolean {
  return model.inputCostPerMillion !== undefined || model.outputCostPerMillion !== undefined;
}

function callCost(call: PricedCall): number {
  return call.inputTokens / 1_000_000 * (call.model.inputCostPerMillion ?? 0)
    + call.outputTokens / 1_000_000 * (call.model.outputCostPerMillion ?? 0);
}

/**
 * Rough pre-run cost estimate from the graph alone. Runtime worker counts, branch choices and the
 * actual response length are unknown before a run, so this is an order-of-magnitude figure, not a cap.
 */
export function estimateRunCost(
  graph: PipelineGraph,
  customBlocks: readonly CustomBlockDefinition[],
  models: readonly StudioModel[],
  input: string,
  maxOutputTokens: number,
): RunEstimate {
  const byId = new Map(models.map((model) => [model.id, model]));
  const outputReserve = Math.min(Math.max(1, Math.floor(maxOutputTokens)), LIMITS.outputTokens);
  const calls: PricedCall[] = [];
  let delegatedBlocks = 0;
  let workerCalls = 0;

  const add = (model: StudioModel | undefined, prompt: string, reserve: number) => {
    if (!model) return;
    calls.push({ model, inputTokens: estimateTokens(promptMessages(prompt, input)), outputTokens: Math.max(1, Math.min(reserve, LIMITS.outputTokens)) });
  };

  for (const node of reachableNodes(graph)) {
    if (node.type === "model") {
      add(node.modelId ? byId.get(node.modelId) : undefined, node.prompt ?? "", outputReserve);
      continue;
    }
    if (node.type === "custom") {
      const block = customBlocks.find((item) => item.id === node.customBlockId);
      if (block?.action.kind === "model") add(byId.get(block.action.modelId), block.action.prompt, outputReserve);
      continue;
    }
    if (node.type !== "delegated") continue;
    delegatedBlocks += 1;
    const { leader, workers, validator } = resolveDelegatedModels(node, models);
    const teamReserve = Math.min(outputReserve, DELEGATION_TEAM_OUTPUT_CAP);
    const slots = Math.min(node.maxWorkers ?? DEFAULT_DELEGATED_WORKERS, workers.length);
    const workerReserve = slots ? Math.max(1, Math.floor(DELEGATION_TEAM_OUTPUT_CAP / slots)) : 0;
    add(leader, node.prompt ?? "", Math.min(teamReserve, DELEGATION_PLANNER_OUTPUT_CAP));
    for (let index = 0; index < slots; index += 1) {
      add(workers[index] ?? leader, node.prompt ?? "", Math.min(teamReserve, workerReserve));
      workerCalls += 1;
    }
    add(leader, node.prompt ?? "", teamReserve);
    add(validator, node.prompt ?? "", teamReserve);
  }

  const inputTokens = calls.reduce((total, call) => total + call.inputTokens, 0);
  const outputTokens = calls.reduce((total, call) => total + call.outputTokens, 0);
  const priced = calls.filter((call) => hasCost(call.model));
  const usd = priced.length ? priced.reduce((total, call) => total + callCost(call), 0) : undefined;
  return {
    calls: calls.length,
    delegatedBlocks,
    workerCalls,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    usd,
    unpriced: [...new Set(calls.filter((call) => !hasCost(call.model)).map((call) => call.model.name))],
  };
}

/** One-line summary for the run dialog. Always marked approximate or partial. */
export function formatEstimate(estimate: RunEstimate): string {
  if (!estimate.calls) return "No model calls";
  if (estimate.usd === undefined) return "No token cost set";
  const amount = estimate.usd < 0.01 ? estimate.usd.toFixed(4) : estimate.usd.toFixed(2);
  return estimate.unpriced.length
    ? `~$${amount} + ${estimate.unpriced.length} unpriced ${estimate.unpriced.length === 1 ? "model" : "models"}`
    : `~$${amount}`;
}
