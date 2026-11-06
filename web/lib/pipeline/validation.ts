import type {
  CompletionResult, CustomBlockDefinition, CustomAction, Message, ModelConnection, PipelineGraph, PipelineRequest, ReasoningEffort, StudioModel, ToolCall, ToolSpec,
} from "./types";
import { LIMITS, PipelineError } from "./limits";
import { isDelegationAuto } from "./delegation";
import { parseCustomEndpoint, parseEndpoint } from "./endpoint";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || text(value, max);
}

function optionalModelIds(value: unknown): value is string[] | undefined {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= LIMITS.models
    && value.every((id) => text(id, 128, 1)) && new Set(value).size === value.length;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

export function isVariableName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)
    && !["input", "value", "__proto__", "prototype", "constructor"].includes(value);
}

export function validateModels(value: unknown): asserts value is StudioModel[] {
  if (!Array.isArray(value) || value.length > LIMITS.models) throw new PipelineError("models");
  const ids = new Set<string>();
  for (const model of value) {
    if (!record(model) || !keys(model, ["id", "name", "model", "baseUrl", "contextWindow", "apiKey", "outputTokenField", "inputCostPerMillion", "outputCostPerMillion"])
      || !text(model.id, 128, 1) || ids.has(model.id)
      || !text(model.name, 128, 1) || !text(model.model, 256, 1) || !model.model.trim()
      || !text(model.baseUrl, 2048, 1)
      || !integer(model.contextWindow, LIMITS.minContextTokens, LIMITS.contextTokens)
      || !(model.outputTokenField === undefined || model.outputTokenField === "max_tokens" || model.outputTokenField === "max_completion_tokens")
      || !(model.inputCostPerMillion === undefined || finiteNonNegative(model.inputCostPerMillion) && model.inputCostPerMillion <= 1_000_000)
      || !(model.outputCostPerMillion === undefined || finiteNonNegative(model.outputCostPerMillion) && model.outputCostPerMillion <= 1_000_000)
      || !(model.apiKey === undefined || (text(model.apiKey, 4096) && /^[\x21-\x7e]*$/.test(model.apiKey)))) {
      throw new PipelineError("models");
    }
    parseEndpoint(model.baseUrl);
    ids.add(model.id);
  }
}

export function validateModelConnection(value: unknown): asserts value is ModelConnection {
  if (!record(value) || !keys(value, ["baseUrl", "apiKey"])
    || !text(value.baseUrl, 2048, 1)
    || !(value.apiKey === undefined || (text(value.apiKey, 4096) && /^[\x21-\x7e]*$/.test(value.apiKey)))) {
    throw new PipelineError("models");
  }
  parseEndpoint(value.baseUrl);
}

function validResponsePath(value: unknown): value is string {
  if (!text(value, 512, 1)) return false;
  const segments = value.split(".");
  return segments.length <= 32 && segments.every((segment) =>
    /^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*)$/.test(segment)
    && !["__proto__", "prototype", "constructor"].includes(segment));
}

// Transport and browser-controlled headers stay owned by the adapter. Authorization is
// included here because the credential belongs in the API key field, not in saved headers.
const transportHeaderNames = /^(?:host|connection|content-[\w-]*|transfer-encoding|accept(?:-encoding)?|cookie|set-cookie|proxy-[\w-]*|sec-[\w-]*)$/i;

export function isReservedHeaderName(name: string): boolean {
  return transportHeaderNames.test(name) || name.toLowerCase() === "authorization";
}

function validExtraHeaders(value: unknown): value is Record<string, string> {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > LIMITS.customHeaders) return false;
  const seen = new Set<string>();
  for (const [name, headerValue] of entries) {
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || isReservedHeaderName(name)) return false;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    if (typeof headerValue !== "string" || headerValue.length > LIMITS.customHeaderValueChars || !/^[\x20-\x7e]*$/.test(headerValue)) return false;
  }
  return true;
}

function validateCustomAction(value: unknown): asserts value is CustomAction {
  if (!record(value) || typeof value.kind !== "string") throw new PipelineError("custom");
  if (value.kind === "model") {
    if (!keys(value, ["kind", "modelId", "prompt"]) || !text(value.modelId, 128, 1)
      || !text(value.prompt, LIMITS.templateChars)) throw new PipelineError("custom");
  } else if (value.kind === "template") {
    if (!keys(value, ["kind", "template"]) || !text(value.template, LIMITS.templateChars)) throw new PipelineError("custom");
  } else if (value.kind === "math") {
    if (!keys(value, ["kind", "operation", "operand"])
      || !["add", "subtract", "multiply", "divide"].includes(value.operation as string)
      || typeof value.operand !== "number" || !Number.isFinite(value.operand) || Math.abs(value.operand) > 1_000_000_000_000) {
      throw new PipelineError("custom");
    }
  } else if (value.kind === "http") {
    if (!keys(value, ["kind", "method", "url", "bodyTemplate", "responsePath", "authHeader", "authPrefix", "headers"])
      || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value.method as string)
      || !text(value.url, 2048, 1) || !optionalText(value.bodyTemplate, LIMITS.templateChars)
      || !(value.responsePath === undefined || validResponsePath(value.responsePath))
      || !validExtraHeaders(value.headers)
      || !(value.authHeader === undefined || (text(value.authHeader, 128, 1)
        && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.authHeader)
        && !transportHeaderNames.test(value.authHeader)))
      || !(value.authPrefix === undefined || (text(value.authPrefix, 128) && /^[\x20-\x7e]*$/.test(value.authPrefix)))) {
      throw new PipelineError("custom");
    }
    parseCustomEndpoint(value.url);
  } else if (value.kind === "cost") {
    if (!keys(value, ["kind"])) throw new PipelineError("custom");
  } else {
    throw new PipelineError("custom");
  }
}

export function validateCustomBlocks(value: unknown): asserts value is CustomBlockDefinition[] {
  if (!Array.isArray(value) || value.length > LIMITS.customBlocks) throw new PipelineError("custom");
  const ids = new Set<string>();
  for (const block of value) {
    if (!record(block) || !keys(block, ["id", "name", "action", "apiKey"])
      || !text(block.id, 128, 1) || ids.has(block.id)
      || !text(block.name, 128, 1) || !block.name.trim()
      || !(block.apiKey === undefined || (text(block.apiKey, 4096) && /^[\x21-\x7e]*$/.test(block.apiKey)))) {
      throw new PipelineError("custom");
    }
    validateCustomAction(block.action);
    if (block.apiKey !== undefined) {
      const action = block.action as CustomAction;
      if (action.kind !== "http") throw new PipelineError("custom");
      const authHeader = (action.authHeader ?? "Authorization").toLowerCase();
      if (action.headers && Object.keys(action.headers).some((name) => name.toLowerCase() === authHeader)) throw new PipelineError("custom");
    }
    ids.add(block.id);
  }
}

const toolNamePattern = /^[A-Za-z0-9_-]+$/;

/** Validates tool definitions offered to a model. Throws a generic "request" error on any problem. */
export function validateToolSpecs(value: unknown): asserts value is ToolSpec[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.tools) throw new PipelineError("request");
  const names = new Set<string>();
  for (const tool of value) {
    if (!record(tool) || !keys(tool, ["name", "description", "parameters"])
      || !text(tool.name, LIMITS.toolNameChars, 1) || !toolNamePattern.test(tool.name) || names.has(tool.name)
      || !text(tool.description, LIMITS.toolDescriptionChars) || !record(tool.parameters)) {
      throw new PipelineError("request");
    }
    let schema: string;
    try { schema = JSON.stringify(tool.parameters); } catch { throw new PipelineError("request"); }
    if (schema.length > LIMITS.toolSchemaChars) throw new PipelineError("request");
    names.add(tool.name);
  }
}

/** Model output is untrusted: bound count and sizes, but leave argument parsing to the tool executor. */
export function validateToolCalls(value: unknown, errorCode: "request" | "response" = "request"): asserts value is ToolCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.toolCallsPerReply) throw new PipelineError(errorCode);
  const ids = new Set<string>();
  for (const call of value) {
    if (!record(call) || !keys(call, ["id", "name", "arguments"])
      || !text(call.id, LIMITS.toolCallIdChars, 1) || ids.has(call.id)
      || !text(call.name, LIMITS.toolNameChars, 1) || !toolNamePattern.test(call.name)
      || !text(call.arguments, LIMITS.toolArgumentChars)) {
      throw new PipelineError(errorCode);
    }
    ids.add(call.id);
  }
}

/** Conservative UTF-8 estimate, including message framing; not a provider tokenizer. */
export function estimateTokens(messages: Message[]): number {
  const encoder = new TextEncoder();
  return 3 + messages.reduce((total, message) => {
    const calls = message.toolCalls?.length ? encoder.encode(JSON.stringify(message.toolCalls)).length : 0;
    return total + 6 + Math.ceil((encoder.encode(message.content).length + calls) / 3);
  }, 0);
}

export interface ContextOptions {
  /** Permit tool-role messages and assistant tool calls. Off at the HTTP boundary: the browser cannot inject them. */
  allowToolMessages?: boolean;
  /** Extra estimated input tokens, for example the serialized tool definitions. */
  extraInputTokens?: number;
}

export function assertContext(model: StudioModel, messages: Message[], maxOutputTokens: number, options: ContextOptions = {}): void {
  if (!integer(maxOutputTokens, 1, LIMITS.outputTokens)
    || !Array.isArray(messages) || !messages.length || messages.length > LIMITS.messages) {
    throw new PipelineError("request");
  }
  const allowTools = options.allowToolMessages === true;
  const roles = allowTools ? ["system", "user", "assistant", "tool"] : ["system", "user", "assistant"];
  const fields = allowTools ? ["role", "content", "toolCalls", "toolCallId"] : ["role", "content"];
  let size = 0;
  for (const message of messages) {
    if (!record(message) || !keys(message, fields)
      || !roles.includes(message.role as string)
      || !text(message.content, LIMITS.textChars)) throw new PipelineError("request");
    if (message.toolCalls !== undefined) {
      if (message.role !== "assistant") throw new PipelineError("request");
      validateToolCalls(message.toolCalls);
      size += (message.toolCalls as ToolCall[]).reduce((sum, call) => sum + call.arguments.length, 0);
    }
    if (message.role === "tool" ? !text(message.toolCallId, LIMITS.toolCallIdChars, 1) : message.toolCallId !== undefined) {
      throw new PipelineError("request");
    }
    size += message.content.length;
  }
  if (size > LIMITS.stateChars) throw new PipelineError("state");
  if (estimateTokens(messages) + (options.extraInputTokens ?? 0) + maxOutputTokens > model.contextWindow) throw new PipelineError("context");
}

export type GraphValidationCode =
  | "custom-config" | "graph-bounds" | "node-fields" | "template-size" | "edge-fields"
  | "edge-port" | "duplicate-edge" | "start-count" | "cycle" | "unfinished-path"
  | "model-missing" | "leader-missing" | "leader-pool" | "worker-missing" | "worker-pool"
  | "validator-missing" | "worker-limit" | "custom-missing" | "custom-model-missing"
  | "condition-incomplete" | "variable-incomplete";
export type GraphValidationIssue = { code: GraphValidationCode; message: string };

/** Structural checks apply to every node; unfinished disconnected drafts are allowed. */
export function validateGraphIssues(graph: unknown, models?: StudioModel[], customBlocks?: CustomBlockDefinition[]): GraphValidationIssue[] {
  const errors: GraphValidationIssue[] = [];
  if (customBlocks !== undefined) {
    try { validateCustomBlocks(customBlocks); }
    catch { return [{ code: "custom-config", message: "Custom block configuration is invalid." }]; }
  }
  if (!record(graph) || !keys(graph, ["nodes", "edges"])
    || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || !graph.nodes.length || graph.nodes.length > LIMITS.nodes || graph.edges.length > LIMITS.edges) {
    return [{ code: "graph-bounds", message: "Graph must have 1-64 nodes and at most 128 edges." }];
  }
  const ids = new Set<string>();
  let templateSize = 0;
  for (const node of graph.nodes) {
    if (!record(node) || !keys(node, ["id", "type", "x", "y", "label", "modelId", "effort", "workerModelIds", "leaderAuto", "leaderPool", "workerAuto", "workerPool", "validatorModelId", "maxWorkers", "customBlockId", "prompt", "condition", "value", "variable"])
      || !text(node.id, 128, 1) || ids.has(node.id)
      || !["start", "model", "delegated", "custom", "condition", "variable", "output"].includes(node.type as string)
      || typeof node.x !== "number" || !Number.isFinite(node.x) || Math.abs(node.x) > 100_000
      || typeof node.y !== "number" || !Number.isFinite(node.y) || Math.abs(node.y) > 100_000
      || !text(node.label, 256)
      || !optionalText(node.modelId, 128) || !optionalText(node.customBlockId, 128) || !optionalText(node.prompt, LIMITS.templateChars)
      || !(node.effort === undefined || isReasoningEffort(node.effort) && (node.type === "model" || node.type === "delegated" || node.type === "custom"))
       || !optionalModelIds(node.workerModelIds) || !optionalModelIds(node.leaderPool) || !optionalModelIds(node.workerPool)
       || !optionalText(node.validatorModelId, 128)
      || !(node.leaderAuto === undefined || isDelegationAuto(node.leaderAuto))
      || !(node.workerAuto === undefined || isDelegationAuto(node.workerAuto))
      || !(node.leaderAuto === undefined || node.modelId === undefined)
      || !(node.workerAuto === undefined || node.workerModelIds === undefined)
      || !(node.maxWorkers === undefined || integer(node.maxWorkers, 1, LIMITS.delegatedWorkers))
       || (node.type !== "delegated" && (node.workerModelIds !== undefined || node.leaderAuto !== undefined || node.leaderPool !== undefined
         || node.validatorModelId !== undefined
         || node.workerAuto !== undefined || node.workerPool !== undefined || node.maxWorkers !== undefined))
      || !optionalText(node.value, LIMITS.templateChars) || !optionalText(node.variable, 64)
      || !(node.condition === undefined || ["contains", "not-contains", "equals"].includes(node.condition as string))) {
      return [{ code: "node-fields", message: "Nodes must have valid bounded fields and unique IDs." }];
    }
    ids.add(node.id);
    templateSize += (node.prompt?.length ?? 0) + (node.value?.length ?? 0);
  }
  if (templateSize > LIMITS.stateChars) return [{ code: "template-size", message: "Combined graph templates exceed the size limit." }];
  const typed = graph as unknown as PipelineGraph;
  const nodes = new Map(typed.nodes.map((node) => [node.id, node]));
  const edges = new Map<string, Map<string, string[]>>();
  const edgeIds = new Set<string>();
  for (const edge of typed.edges) {
    if (!record(edge) || !keys(edge, ["id", "from", "to", "port"])
      || !text(edge.id, 128, 1) || edgeIds.has(edge.id)
      || !text(edge.from, 128, 1) || !text(edge.to, 128, 1)
      || !nodes.has(edge.from) || !nodes.has(edge.to) || !["out", "pass", "fail"].includes(edge.port)) {
      return [{ code: "edge-fields", message: "Edges must have valid endpoints, ports and unique IDs." }];
    }
    edgeIds.add(edge.id);
    const source = nodes.get(edge.from)!;
    const target = nodes.get(edge.to)!;
    if (source.type === "output" || target.type === "start"
      || (source.type === "condition" ? edge.port === "out" : edge.port !== "out")) {
      errors.push({ code: "edge-port", message: "Edge port is incompatible with its node, or connects into Start / out of Output." });
    }
    const ports = edges.get(edge.from) ?? new Map<string, string[]>();
    const targets = ports.get(edge.port) ?? [];
    if (targets.includes(edge.to)) errors.push({ code: "duplicate-edge", message: "Duplicate connections are not allowed." });
    else targets.push(edge.to);
    ports.set(edge.port, targets);
    edges.set(edge.from, ports);
  }
  const starts = typed.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) errors.push({ code: "start-count", message: "Graph must contain exactly one Start." });
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) { errors.push({ code: "cycle", message: "Graph must not contain cycles." }); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const targets of edges.get(id)?.values() ?? []) for (const to of targets) visit(to);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  const reachable = new Set<string>();
  function reach(id: string): void {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const targets of edges.get(id)?.values() ?? []) for (const to of targets) reach(to);
  }
  if (starts.length === 1) reach(starts[0].id);
  const modelIds = models === undefined ? undefined : new Set(models.map((model) => model.id));
  const customBlockMap = customBlocks === undefined ? undefined : new Map(customBlocks.map((block) => [block.id, block]));
  for (const id of reachable) {
    const node = nodes.get(id)!;
    const ports = edges.get(id);
    if (node.type !== "output" && (node.type === "condition"
      ? !ports?.has("pass") || !ports?.has("fail") : !ports?.has("out"))) {
      errors.push({ code: "unfinished-path", message: "Every reachable path must terminate at Output; Condition needs pass and fail edges." });
    }
    if (node.type === "model" && (!node.modelId || (modelIds && !modelIds.has(node.modelId)))) {
      errors.push({ code: "model-missing", message: "Every reachable Model must reference a configured model." });
    }
    if (node.type === "delegated") {
      if (node.leaderAuto === undefined) {
        if (!node.modelId || (modelIds && !modelIds.has(node.modelId))) {
          errors.push({ code: "leader-missing", message: "Every reachable Delegated block must reference a configured coordinator model." });
        }
      } else if (!node.leaderPool?.length || (modelIds && node.leaderPool.some((modelId) => !modelIds.has(modelId)))) {
        errors.push({ code: "leader-pool", message: "Every reachable Delegated block with an auto leader needs at least one configured leader candidate." });
      }
      if (node.workerAuto === undefined) {
        if (!node.workerModelIds?.length || (modelIds && node.workerModelIds.some((modelId) => !modelIds.has(modelId)))) {
          errors.push({ code: "worker-missing", message: "Every reachable Delegated block must allow at least one configured worker model." });
        }
      } else if (!node.workerPool?.length || (modelIds && node.workerPool.some((modelId) => !modelIds.has(modelId)))) {
        errors.push({ code: "worker-pool", message: "Every reachable Delegated block with auto workers needs at least one configured worker candidate." });
      }
      if (node.validatorModelId !== undefined && modelIds && !modelIds.has(node.validatorModelId)) {
        errors.push({ code: "validator-missing", message: "Every configured Delegated validator must reference a configured model." });
      }
      if (!integer(node.maxWorkers, 1, LIMITS.delegatedWorkers)) {
        errors.push({ code: "worker-limit", message: `Every reachable Delegated block needs a worker limit from 1 to ${LIMITS.delegatedWorkers}.` });
      }
    }
    if (node.type === "custom") {
      const definition = node.customBlockId ? customBlockMap?.get(node.customBlockId) : undefined;
      if (!definition) {
        errors.push({ code: "custom-missing", message: "Every reachable Custom node must reference a configured custom block." });
      } else if (definition.action.kind === "model"
        && (!definition.action.modelId || (modelIds && !modelIds.has(definition.action.modelId)))) {
        errors.push({ code: "custom-model-missing", message: "Every reachable custom model action must reference a configured model." });
      }
    }
    if (node.type === "condition" && (node.condition === undefined || node.value === undefined)) {
      errors.push({ code: "condition-incomplete", message: "Reachable Condition needs an operator and literal comparison value." });
    }
    if (node.type === "variable" && !isVariableName(node.variable)) {
      errors.push({ code: "variable-incomplete", message: "Reachable Variable needs a non-reserved identifier." });
    }
  }
  return [...new Map(errors.map((issue) => [issue.code, issue])).values()];
}

export function validateGraph(graph: unknown, models?: StudioModel[], customBlocks?: CustomBlockDefinition[]): string[] {
  return validateGraphIssues(graph, models, customBlocks).map((issue) => issue.message);
}

export function validateRequest(value: unknown): PipelineRequest {
  if (!record(value)) throw new PipelineError("request");
  if (value.mode === "models") {
    if (!keys(value, ["mode", "connection"])) throw new PipelineError("request");
    validateModelConnection(value.connection);
  } else if (value.mode === "chat") {
    if (!integer(value.maxOutputTokens, 1, LIMITS.outputTokens)) throw new PipelineError("request");
    if (!keys(value, ["mode", "model", "messages", "maxOutputTokens"])) throw new PipelineError("request");
    validateModels([value.model]);
    assertContext(value.model as StudioModel, value.messages as Message[], value.maxOutputTokens);
  } else if (value.mode === "pipeline") {
    if (!integer(value.maxOutputTokens, 1, LIMITS.outputTokens)
      || !keys(value, ["mode", "graph", "models", "input", "maxOutputTokens", "customBlocks"])
      || !text(value.input, LIMITS.inputChars)) throw new PipelineError("request");
    validateModels(value.models);
    const customBlocks = value.customBlocks === undefined ? [] : value.customBlocks;
    validateCustomBlocks(customBlocks);
    if (validateGraph(value.graph, value.models, customBlocks).length) throw new PipelineError("graph");
  } else {
    throw new PipelineError("request");
  }
  return value as unknown as PipelineRequest;
}

export function validateCompletion(value: unknown): CompletionResult {
  if (!record(value) || !text(value.text, LIMITS.textChars)) throw new PipelineError("response");
  let toolCalls: ToolCall[] | undefined;
  if (value.toolCalls !== undefined) {
    validateToolCalls(value.toolCalls, "response");
    toolCalls = (value.toolCalls as ToolCall[]).map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  }
  const base = { text: value.text, ...(toolCalls ? { toolCalls } : {}) };
  if (value.usage !== undefined) {
    if (!record(value.usage)
      || !integer(value.usage.input, 0, 10_000_000) || !integer(value.usage.output, 0, 10_000_000)
      || !(value.usage.cost === undefined || finiteNonNegative(value.usage.cost))) {
      throw new PipelineError("response");
    }
    return { ...base, usage: {
      input: value.usage.input, output: value.usage.output,
      ...(value.usage.cost === undefined ? {} : { cost: value.usage.cost }),
    } };
  }
  return base;
}
