import type { CustomBlockDefinition, Message, PipelineGraph } from "../../lib/pipeline/types";

export type ResponseMode = "minimal" | "detailed";
export type OutputTokensMode = "auto" | "manual";

export const AUTO_OUTPUT_TOKENS = { minimal: 512, detailed: 4096 } as const;

export function responseModeInstruction(mode: ResponseMode): string {
  return mode === "minimal"
    ? "Response detail: Minimal. Give only the essential answer in a few concise sentences or bullets. Omit background and examples unless needed; retain necessary caveats."
    : "Response detail: Detailed. Give a thorough, clearly structured answer with relevant context, examples, brief supporting rationale, and caveats. Avoid unsupported claims and repetition.";
}

function appendInstruction(prompt: string | undefined, instruction: string): string {
  return [prompt?.trim(), instruction].filter(Boolean).join("\n\n");
}

export function applyResponseModeToMessages(messages: Message[], mode: ResponseMode): Message[] {
  const result = [...messages];
  const systemIndex = result.findIndex((message) => message.role === "system");
  const instruction = responseModeInstruction(mode);
  if (systemIndex < 0) result.unshift({ role: "system", content: instruction });
  else result[systemIndex] = { ...result[systemIndex], content: appendInstruction(result[systemIndex].content, instruction) };
  return result;
}

export function applyResponseModeToGraph(graph: PipelineGraph, mode: ResponseMode): PipelineGraph {
  const instruction = responseModeInstruction(mode);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.type === "model" || node.type === "delegated"
      ? { ...node, prompt: appendInstruction(node.prompt, instruction) } : node),
  };
}

export function applyResponseModeToCustomBlocks(blocks: CustomBlockDefinition[], mode: ResponseMode): CustomBlockDefinition[] {
  const instruction = responseModeInstruction(mode);
  return blocks.map((block) => block.action.kind === "model"
    ? { ...block, action: { ...block.action, prompt: appendInstruction(block.action.prompt, instruction) } }
    : block);
}

export function resolveOutputTokens(mode: OutputTokensMode, manualTokens: number, responseMode: ResponseMode, inputTokens: number, contextWindow?: number): number {
  if (mode === "manual") return manualTokens;
  const target = AUTO_OUTPUT_TOKENS[responseMode];
  if (contextWindow === undefined) return target;
  return Math.max(1, Math.min(target, Math.floor(contextWindow - inputTokens)));
}
