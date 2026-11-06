import type { DelegationAuto, PipelineNode, StudioModel } from "./types";

export const AUTO_STRATEGIES: readonly DelegationAuto[] = ["cheap", "value", "performance"];

export const AUTO_STRATEGY_LABELS: Record<DelegationAuto, string> = {
  cheap: "cheapest",
  value: "cost effective",
  performance: "strongest",
};

export function isDelegationAuto(value: unknown): value is DelegationAuto {
  return value === "cheap" || value === "value" || value === "performance";
}

/** Combined USD cost per 1M input plus 1M output tokens; undefined when the model has no cost data. */
export function modelTokenCost(model: StudioModel): number | undefined {
  if (model.inputCostPerMillion === undefined && model.outputCostPerMillion === undefined) return undefined;
  return (model.inputCostPerMillion ?? 0) + (model.outputCostPerMillion ?? 0);
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function formatTokenCost(model: StudioModel): string {
  const parts: string[] = [];
  if (model.inputCostPerMillion !== undefined) parts.push(`$${formatAmount(model.inputCostPerMillion)} in`);
  if (model.outputCostPerMillion !== undefined) parts.push(`$${formatAmount(model.outputCostPerMillion)} out`);
  return parts.length ? `${parts.join(" / ")} per 1M tokens` : "No token cost set";
}

/**
 * Ranks the chosen candidate pool purely by token cost and returns the model for the strategy.
 * Priced candidates are considered first; models without cost data are only used when the pool
 * has no priced candidates, and then the pool order is kept. Ties keep the pool order.
 */
export function resolveAutoModel(pool: readonly string[], models: readonly StudioModel[], strategy: DelegationAuto): StudioModel | undefined {
  const byId = new Map(models.map((model) => [model.id, model]));
  const candidates = pool.map((id) => byId.get(id)).filter((model): model is StudioModel => model !== undefined);
  if (!candidates.length) return undefined;
  const priced = candidates
    .filter((model) => modelTokenCost(model) !== undefined)
    .sort((a, b) => modelTokenCost(a)! - modelTokenCost(b)!);
  const ranked = priced.length ? priced : candidates;
  const index = strategy === "cheap" ? 0
    : strategy === "performance" ? ranked.length - 1
      : Math.floor((ranked.length - 1) / 2);
  return ranked[index];
}

export function resolveDelegatedModels(node: PipelineNode, models: readonly StudioModel[]): { leader?: StudioModel; workers: StudioModel[]; validator?: StudioModel } {
  const byId = new Map(models.map((model) => [model.id, model]));
  const leader = node.leaderAuto !== undefined
    ? resolveAutoModel(node.leaderPool ?? [], models, node.leaderAuto)
    : node.modelId === undefined ? undefined : byId.get(node.modelId);
  const workers = node.workerAuto !== undefined
    ? [resolveAutoModel(node.workerPool ?? [], models, node.workerAuto)].filter((model): model is StudioModel => model !== undefined)
    : (node.workerModelIds ?? []).map((id) => byId.get(id)).filter((model): model is StudioModel => model !== undefined);
  const validator = node.validatorModelId === undefined ? leader : byId.get(node.validatorModelId);
  return { leader, workers, validator };
}
