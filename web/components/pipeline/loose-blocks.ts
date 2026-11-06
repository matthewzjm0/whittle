import type { PipelineGraph, PipelineNode } from "../../lib/pipeline/types";

export function findLooseBlocks(graph: PipelineGraph): PipelineNode[] {
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
  return graph.nodes.filter((node) => node.type !== "start" && !reachable.has(node.id));
}

export function looseBlocksWarning(nodes: PipelineNode[]): string {
  const names = nodes.slice(0, 12).map((node) => `• ${node.label || node.type}`);
  if (nodes.length > names.length) names.push(`• and ${nodes.length - names.length} more`);
  return `These loose blocks are not reachable from Start and will not run:\n\n${names.join("\n")}\n\nRemove them or connect them to Start before running.`;
}
