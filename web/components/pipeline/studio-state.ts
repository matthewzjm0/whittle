import { defaultGraph, LIMITS, validateCustomBlocks } from "../../lib/pipeline";
import { validateGraphIssues, validateModels } from "../../lib/pipeline/validation";
import type { GraphValidationCode } from "../../lib/pipeline/validation";
import type { CustomBlockDefinition } from "@/lib/pipeline";
import type { Message, PipelineGraph, StudioModel, TokenUsage } from "../../lib/pipeline";

export type ChatMessage = Message & { id: string; createdAt: number; modelName?: string; usage?: TokenUsage };
export type Conversation = {
  id: string;
  title: string;
  modelId: string;
  pipelineId: string | null;
  system: string;
  historyLimit: number;
  messages: ChatMessage[];
};
export type SavedPipeline = { id: string; name: string; graph: PipelineGraph; input: string; saved?: boolean };
export type CustomBlock = CustomBlockDefinition;
export type StudioState = {
  version: 3;
  models: StudioModel[];
  customBlocks: CustomBlock[];
  pipelines: SavedPipeline[];
  activePipelineId: string;
  // Active editor values mirror the selected saved pipeline for convenience.
  graph: PipelineGraph;
  pipelineName: string;
  input: string;
  outputTokensMode: "auto" | "manual";
  maxOutputTokens: number;
  responseMode: "minimal" | "detailed";
  conversations: Conversation[];
  activeConversationId: string | null;
};
export const STORAGE_KEY = "pipeline-studio.v1";

export function isPipelineSaved(pipeline: SavedPipeline | undefined): boolean {
  return pipeline?.saved === true;
}

function withoutApiKey<T extends { apiKey?: string }>(value: T): Omit<T, "apiKey"> {
  const safe = { ...value };
  delete safe.apiKey;
  return safe;
}

export function initialState(): StudioState {
  const graph = defaultGraph();
  return { version: 3, models: [], customBlocks: [], pipelines: [{ id: "pipeline-default", name: "Untitled pipeline", graph, input: "" }], activePipelineId: "pipeline-default", graph, pipelineName: "Untitled pipeline", input: "", outputTokensMode: "auto", maxOutputTokens: 2048, responseMode: "minimal", conversations: [], activeConversationId: null };
}

export function newConversation(modelId = ""): Conversation {
  return { id: crypto.randomUUID(), title: "New conversation", modelId, pipelineId: null, system: "", historyLimit: 40, messages: [] };
}

export function newChatMessage(role: "user" | "assistant", content: string, modelName?: string, usage?: TokenUsage): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: Date.now(), ...(modelName ? { modelName } : {}), ...(usage ? { usage } : {}) };
}

export function chatContext(conversation: Conversation, messages = conversation.messages): Message[] {
  return [
    ...(conversation.system.trim() ? [{ role: "system" as const, content: conversation.system }] : []),
    ...messages.slice(-conversation.historyLimit).map(({ role, content }) => ({ role, content })),
  ];
}

export function formatPipelineChatInput(messages: Message[]): string {
  return messages.filter((message) => message.role !== "system")
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content}`)
    .join("\n\n");
}

export function serializeState(state: StudioState): string {
  return JSON.stringify({
    ...state,
    version: 3,
    models: state.models.map(({ id, name, model, baseUrl, contextWindow, outputTokenField, inputCostPerMillion, outputCostPerMillion }) => ({
      id, name, model, baseUrl, contextWindow,
      ...(outputTokenField ? { outputTokenField } : {}),
      ...(inputCostPerMillion !== undefined ? { inputCostPerMillion } : {}),
      ...(outputCostPerMillion !== undefined ? { outputCostPerMillion } : {}),
    })),
    customBlocks: state.customBlocks.map(withoutApiKey),
  });
}

export function restoreState(raw: string): StudioState {
  const parsed = JSON.parse(raw) as Omit<StudioState, "version" | "customBlocks"> & { version: number; customBlocks?: unknown };
  if (![1, 2, 3].includes(parsed.version) || !Array.isArray(parsed.models) || !Array.isArray(parsed.conversations)) throw new Error("Unsupported saved workspace.");
  // Credentials are never restored, even if browser storage was manually modified.
  const models = parsed.models.map((rawModel) => {
    if (!rawModel || typeof rawModel !== "object") throw new Error("Invalid saved models.");
    const { id, name, model, baseUrl, contextWindow, outputTokenField, inputCostPerMillion, outputCostPerMillion } = rawModel;
    return {
      id, name, model, baseUrl, contextWindow,
      ...(outputTokenField ? { outputTokenField } : {}),
      ...(typeof inputCostPerMillion === "number" ? { inputCostPerMillion } : {}),
      ...(typeof outputCostPerMillion === "number" ? { outputCostPerMillion } : {}),
    };
  });
  validateModels(models);
  const rawCustomBlocks = parsed.customBlocks ?? [];
  if (!Array.isArray(rawCustomBlocks) || rawCustomBlocks.length > 64) throw new Error("Invalid custom blocks.");
  const customBlocks = rawCustomBlocks.map((rawBlock) => {
    if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) throw new Error("Invalid custom blocks.");
    const block = { ...(rawBlock as Record<string, unknown>) };
    delete block.apiKey;
    if (block.action && typeof block.action === "object" && !Array.isArray(block.action)) return block as unknown as CustomBlockDefinition;
    if (typeof block.modelId === "string" && typeof block.prompt === "string") {
      return { id: block.id, name: block.name, action: { kind: "model", modelId: block.modelId, prompt: block.prompt } } as CustomBlockDefinition;
    }
    throw new Error("Invalid custom blocks.");
  });
  validateCustomBlocks(customBlocks);
  const referencedModelIds = customBlocks.flatMap((block) => block.action.kind === "model" ? [block.action.modelId] : []);
  if (referencedModelIds.some((modelId) => !models.some((model) => model.id === modelId))) throw new Error("Invalid custom blocks.");
  const validGraph = (graph: PipelineGraph) => {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 64 || graph.edges.length > 128
    || !graph.nodes.every((n) => n && typeof n.id === "string" && ["start", "model", "delegated", "condition", "variable", "output", "custom"].includes(n.type)
      && typeof n.label === "string" && Number.isFinite(n.x) && Number.isFinite(n.y) && Math.abs(n.x) <= 100_000 && Math.abs(n.y) <= 100_000
       && [n.prompt, n.value, n.modelId, n.validatorModelId, n.variable, n.customBlockId].every((value) => value === undefined || typeof value === "string")
      && (n.workerModelIds === undefined || Array.isArray(n.workerModelIds) && n.workerModelIds.every((value) => typeof value === "string"))
      && (n.leaderPool === undefined || Array.isArray(n.leaderPool) && n.leaderPool.every((value) => typeof value === "string"))
      && (n.workerPool === undefined || Array.isArray(n.workerPool) && n.workerPool.every((value) => typeof value === "string"))
      && (n.leaderAuto === undefined || ["cheap", "value", "performance"].includes(n.leaderAuto))
      && (n.workerAuto === undefined || ["cheap", "value", "performance"].includes(n.workerAuto))
      && (n.maxWorkers === undefined || typeof n.maxWorkers === "number")
      && (n.condition === undefined || ["contains", "not-contains", "equals"].includes(n.condition)))
    || !graph.edges.every((e) => e && typeof e.id === "string" && typeof e.from === "string" && typeof e.to === "string" && ["out", "pass", "fail"].includes(e.port))) return false;
    return !((!graph.nodes.length && graph.edges.length) || (graph.nodes.length && validateGraphIssues(graph, models, customBlocks).some((issue) => !draftErrors.has(issue.code))));
  };
  const draftErrors = new Set<GraphValidationCode>([
    "start-count", "unfinished-path", "model-missing", "leader-missing", "leader-pool",
    "worker-missing", "worker-pool", "worker-limit", "condition-incomplete", "variable-incomplete",
  ]);
  const pipelines = parsed.version === 1
    ? [{ id: "pipeline-migrated", name: parsed.pipelineName || "Untitled pipeline", graph: parsed.graph, input: parsed.input || "" }]
    : parsed.pipelines;
  if (!Array.isArray(pipelines) || pipelines.length < 1 || pipelines.length > 100
    || !pipelines.every((pipeline) => pipeline && typeof pipeline.id === "string" && pipeline.id.length > 0 && pipeline.id.length <= 128
      && typeof pipeline.name === "string" && pipeline.name.length <= 100 && typeof pipeline.input === "string" && pipeline.input.length <= LIMITS.inputChars
      && (pipeline.saved === undefined || typeof pipeline.saved === "boolean") && validGraph(pipeline.graph))
    || new Set(pipelines.map((pipeline) => pipeline.id)).size !== pipelines.length) throw new Error("Invalid saved pipelines.");
  const activePipelineId = pipelines.some((pipeline) => pipeline.id === parsed.activePipelineId)
    ? parsed.activePipelineId : pipelines[0].id;
  const activePipeline = pipelines.find((pipeline) => pipeline.id === activePipelineId)!;
  const pipelineIds = new Set(pipelines.map((pipeline) => pipeline.id));
  const conversations = parsed.conversations.filter((c) => c && typeof c.id === "string" && typeof c.title === "string"
    && typeof c.modelId === "string" && (c.pipelineId === undefined || c.pipelineId === null || (typeof c.pipelineId === "string" && pipelineIds.has(c.pipelineId)))
    && typeof c.system === "string" && c.system.length <= LIMITS.templateChars
    && Number.isInteger(c.historyLimit) && c.historyLimit > 0 && c.historyLimit <= 200
    && Array.isArray(c.messages) && c.messages.every((m) => m && typeof m.id === "string" && typeof m.content === "string" && m.content.length <= LIMITS.textChars
      && ["user", "assistant"].includes(m.role) && typeof m.createdAt === "number" && Number.isFinite(m.createdAt)
      && (m.modelName === undefined || typeof m.modelName === "string")
      && (m.usage === undefined || (m.usage && Number.isSafeInteger(m.usage.input) && m.usage.input >= 0 && Number.isSafeInteger(m.usage.output) && m.usage.output >= 0)))).slice(0, 100);
  if (conversations.length !== parsed.conversations.length) throw new Error("Invalid saved conversations.");
  return {
    version: 3, models, customBlocks, pipelines, activePipelineId, graph: activePipeline.graph, conversations,
    pipelineName: activePipeline.name,
    input: activePipeline.input,
    outputTokensMode: parsed.outputTokensMode === "manual" ? "manual" : "auto",
    maxOutputTokens: Number.isInteger(parsed.maxOutputTokens) && parsed.maxOutputTokens > 0 && parsed.maxOutputTokens <= 32768 ? parsed.maxOutputTokens : 2048,
    responseMode: parsed.responseMode === "detailed" ? "detailed" : "minimal",
    activeConversationId: conversations.some((c) => c.id === parsed.activeConversationId) ? parsed.activeConversationId : conversations[0]?.id ?? null,
  };
}
