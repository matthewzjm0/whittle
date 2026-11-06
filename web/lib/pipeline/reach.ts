import { resolveDelegatedModels } from "./delegation";
import type { CustomBlockDefinition, PipelineGraph, PipelineNode, StudioModel } from "./types";

/** Blocks reachable from Start, following every outgoing edge regardless of branch condition. */
export function reachableNodes(graph: PipelineGraph): PipelineNode[] {
  const start = graph.nodes.find((node) => node.type === "start");
  if (!start) return [];
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  const reachable = new Set<string>();
  const pending = [start.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  return graph.nodes.filter((node) => reachable.has(node.id));
}

export type ModelCall = { node: PipelineNode; modelId: string; prompt: string; role: string };

/** Model calls the UI can predict from the graph. Delegated workers are listed per configured model, not per runtime plan. */
export function reachableModelCalls(graph: PipelineGraph, customBlocks: readonly CustomBlockDefinition[], models: readonly StudioModel[]): ModelCall[] {
  return reachableNodes(graph).flatMap((node) => {
    if (node.type === "model" && node.modelId) return [{ node, modelId: node.modelId, prompt: node.prompt ?? "", role: "Model step" }];
    if (node.type === "custom") {
      const definition = customBlocks.find((block) => block.id === node.customBlockId);
      if (definition?.action.kind === "model") return [{ node, modelId: definition.action.modelId, prompt: definition.action.prompt, role: "Custom model step" }];
    }
    if (node.type === "delegated") {
      const { leader, workers, validator } = resolveDelegatedModels(node, models);
      return [
        ...(leader ? [{ node, modelId: leader.id, prompt: node.prompt ?? "", role: "Coordinator" }] : []),
        ...[...new Set(workers.map((model) => model.id))].map((modelId) => ({ node, modelId, prompt: node.prompt ?? "", role: "Worker model" })),
        ...(validator ? [{ node, modelId: validator.id, prompt: "Static review and correction of the coordinator draft; code is not executed.", role: "Validator" }] : []),
      ];
    }
    return [];
  });
}
