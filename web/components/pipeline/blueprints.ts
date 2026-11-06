import type { PipelineGraph, PipelineNode } from "../../lib/pipeline/types";

export type Blueprint = {
  name: string;
  description: string;
  input: string;
  steps: Array<{ label: string; prompt: string }>;
};

export const BLUEPRINTS: Blueprint[] = [
  {
    name: "Summarizer", description: "Condense supplied text into key points.",
    input: "Summarize these meeting notes: The launch is planned for next month. Accessibility testing is unfinished. The team will review the remaining risks on Friday.",
    steps: [{ label: "Summarize", prompt: "Summarize the supplied text in five concise bullet points. Preserve important facts, dates, and uncertainty. Do not add unsupported facts." }],
  },
  {
    name: "Evidence fact-checker", description: "Audit claims against supplied sources, not the web.",
    input: "Claim: the new feature doubled retention. Supplied evidence: ten users tried it, but no retention measurement or control group was recorded.",
    steps: [
      { label: "Audit claims", prompt: "List the claims, supporting evidence, contradictions, and gaps in the supplied text. Use only supplied sources. Label unsupported claims as unverified; you have no web access." },
      { label: "Review verdicts", prompt: "Review the preceding evidence audit. Correct overconfident verdicts and return a clear claim/evidence/verdict checklist. Do not claim external verification." },
    ],
  },
  {
    name: "Draft and polish", description: "Draft a response, then edit it for clarity.",
    input: "Write a short project update explaining that the prototype is ready, testing is still in progress, and feedback is needed by Friday.",
    steps: [
      { label: "Draft", prompt: "Write a useful first draft for the supplied request. Avoid inventing facts." },
      { label: "Polish", prompt: "Edit the supplied draft for clarity, accuracy, and brevity. Preserve the original request: {{input}}. Return only the polished document." },
    ],
  },
  {
    name: "Research brief", description: "Analyze supplied material and produce a concise evidence brief.",
    input: "Assess this proposal using only the supplied facts: build an internal FAQ assistant; the source documents are incomplete; the budget and delivery date have not been agreed.",
    steps: [
      { label: "Analyze evidence", prompt: "Analyze only the supplied material. Separate confirmed evidence, assumptions, risks, and open questions. Do not claim web research or tools you were not given." },
      { label: "Research brief", prompt: "Turn the preceding analysis into a concise evidence brief with clear uncertainty and next questions. Do not add unsupported facts." },
    ],
  },
];

export function instantiateBlueprint(blueprint: Blueprint, modelId: string) {
  if (!modelId.trim()) throw new Error("Choose a model first.");
  const nodes: PipelineNode[] = [
    { id: crypto.randomUUID(), type: "start", label: "Start", x: 80, y: 160 },
    ...blueprint.steps.map((step, index): PipelineNode => ({
      id: crypto.randomUUID(), type: "model", label: step.label,
      x: 360 + index * 280, y: 160, modelId, prompt: step.prompt,
    })),
    { id: crypto.randomUUID(), type: "output", label: "Output", x: 360 + blueprint.steps.length * 280, y: 160 },
  ];
  const graph: PipelineGraph = { nodes, edges: nodes.slice(1).map((node, index) => ({ id: crypto.randomUUID(), from: nodes[index].id, to: node.id, port: "out" })) };
  return { id: crypto.randomUUID(), name: blueprint.name, input: blueprint.input, graph };
}
