import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Module } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import ts from "typescript";
import {
  defaultGraph, estimateTokens, LIMITS, modelTokenCost, renderTemplate, resolveAutoModel, runPipeline, validateGraph,
} from "../lib/pipeline";
import type {
  Complete, CustomBlockDefinition, CustomHttp, Message, PipelineEvent, PipelineGraph, PipelineNode, StudioModel,
} from "../lib/pipeline";
import { parseCustomEndpoint, parseEndpoint, isPublicAddress } from "../lib/pipeline/endpoint";
import { handlePipelineRequest } from "../lib/pipeline/http";
import { PipelineError } from "../lib/pipeline/limits";
import { createComplete, createCustomHttp, discoverOpenAIModels, reasoningPayload, resolveEndpoint } from "../lib/pipeline/provider";
import { assertContext, validateCustomBlocks, validateGraphIssues, validateModels, validateRequest } from "../lib/pipeline/validation";
import { POST } from "../app/api/pipeline/route";
import { registerRunStatsTests } from "./run-stats-selftest";
import { registerBlueprintTests } from "./blueprints-selftest";
import { registerFileExportTests } from "./file-export-selftest";
import { registerOfficeExportTests } from "./office-export-selftest";
import { registerExportSpecTests } from "./export-spec-selftest";
import { registerZipExportTests } from "./zip-export-selftest";
import { registerLooseBlockTests } from "./loose-blocks-selftest";
import { registerResponseSettingsTests } from "./response-settings-selftest";
import { registerPipelineGeneratorTests } from "./pipeline-generator-selftest";
import { registerEstimateTests } from "./estimate-selftest";
import { registerToolCallingTests } from "./tool-calling-selftest";
import { registerToolsTests } from "./tools-selftest";
import { createDocxBlob, createPdfBlob, pdfReplacesCharacters } from "../components/pipeline/export-document";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [];
const test = (name: string, run: () => Promise<void> | void) => tests.push({ name, run });
registerRunStatsTests(test);
registerBlueprintTests(test);
registerFileExportTests(test);
registerOfficeExportTests(test);
registerExportSpecTests(test);
registerZipExportTests(test);
registerLooseBlockTests(test);
registerResponseSettingsTests(test);
registerPipelineGeneratorTests(test);
registerEstimateTests(test);
registerToolCallingTests(test);
registerToolsTests(test);

type TestChatMessage = Message & { id: string; createdAt: number; modelName?: string; usage?: import("../lib/pipeline").TokenUsage };
type TestConversation = {
  id: string; title: string; modelId: string; pipelineId: string | null; system: string; historyLimit: number; messages: TestChatMessage[];
};
type TestStudioState = {
  version: number; models: StudioModel[]; customBlocks: CustomBlockDefinition[];
  pipelines: Array<{ id: string; name: string; graph: PipelineGraph; input: string; saved?: boolean }>;
  activePipelineId: string; graph: PipelineGraph; pipelineName: string; input: string; outputTokensMode: "auto" | "manual"; maxOutputTokens: number; responseMode: "minimal" | "detailed";
  conversations: TestConversation[]; activeConversationId: string | null;
};
type StudioStateApi = {
  chatContext: (conversation: TestConversation, messages?: TestChatMessage[]) => Message[];
  formatPipelineChatInput: (messages: Message[]) => string;
  initialState: () => TestStudioState;
  isPipelineSaved: (pipeline: TestStudioState["pipelines"][number] | undefined) => boolean;
  newConversation: (modelId?: string) => TestConversation;
  restoreState: (raw: string) => TestStudioState;
  serializeState: (state: TestStudioState) => string;
};

// The pipeline test tsconfig intentionally omits Next's app path aliases.
const stateSourcePath = path.resolve(__dirname, "../../components/pipeline/studio-state.ts");
const stateModulePath = path.resolve(__dirname, "../components/pipeline/studio-state.js");
const stateSource = readFileSync(stateSourcePath, "utf8");
const stateJavascript = ts.transpileModule(stateSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText.split('require("@/lib/pipeline")').join('require("../../lib/pipeline")');
const stateModule = new Module(stateModulePath, module) as unknown as {
  filename: string; paths: string[]; exports: unknown; _compile(content: string, filename: string): void;
};
stateModule.filename = stateModulePath;
stateModule.paths = (Module as unknown as { _nodeModulePaths(directory: string): string[] })._nodeModulePaths(path.dirname(stateModulePath));
stateModule._compile(stateJavascript, stateModulePath);
const { chatContext, formatPipelineChatInput, initialState, isPipelineSaved, newConversation, restoreState, serializeState } =
  stateModule.exports as StudioStateApi;

const model: StudioModel = {
  id: "added-by-user", name: "My endpoint", model: "arbitrary-model-id",
  baseUrl: "https://api.example.com/v1", contextWindow: 8192,
};
const messages: Message[] = [
  { role: "system", content: "Be helpful." },
  { role: "user", content: "Remember blue." },
  { role: "assistant", content: "I will remember." },
  { role: "user", content: "What color?" },
];
const complete: Complete = async () => ({ text: "real result", usage: { input: 11, output: 3 } });
const node = (id: string, type: PipelineNode["type"], fields: Partial<PipelineNode> = {}): PipelineNode =>
  ({ id, type, x: 0, y: 0, label: id, ...fields });
const chain = (...nodes: PipelineNode[]): PipelineGraph => ({
  nodes,
  edges: nodes.slice(1).map((item, i) => ({ id: `e${i}`, from: nodes[i].id, to: item.id, port: "out" })),
});
const modelGraph = () => chain(node("s", "start"), node("m", "model", { modelId: model.id }), node("o", "output"));
const delegatedGraph = (fields: Partial<PipelineNode> = {}) => chain(
  node("s", "start"), node("d", "delegated", { modelId: model.id, workerModelIds: [model.id], maxWorkers: 3, ...fields }), node("o", "output"),
);
const customBlock = (id: string, action: CustomBlockDefinition["action"]): CustomBlockDefinition => ({ id, name: id, action });
const customGraph = (id: string) => chain(node("s", "start"), node("c", "custom", { customBlockId: id }), node("o", "output"));
async function collect(graph: PipelineGraph, adapter: Complete = complete, input = "seed", signal?: AbortSignal): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline({ graph, models: [model], input, maxOutputTokens: 64, complete: adapter, signal })) events.push(event);
  return events;
}
async function collectCustom(
  graph: PipelineGraph,
  customBlocks: CustomBlockDefinition[],
  options: { models?: StudioModel[]; complete?: Complete; customHttp?: CustomHttp; input?: string; signal?: AbortSignal } = {},
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline({
    graph, customBlocks, models: options.models ?? [model], input: options.input ?? "seed", maxOutputTokens: 64,
    complete: options.complete ?? complete, ...(options.customHttp ? { customHttp: options.customHttp } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) events.push(event);
  return events;
}
const last = (events: PipelineEvent[]) => events[events.length - 1];
function request(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("http://localhost:3000/api/pipeline", {
    method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body), signal,
  });
}
const chatBody = () => ({ mode: "chat", model, messages, maxOutputTokens: 64 });
const pipelineBody = (graph = modelGraph()) => ({ mode: "pipeline", graph, models: [model], input: "seed", maxOutputTokens: 64 });

test("default graph has no model defaults and passes input through", async () => {
  assert.deepEqual(validateGraph(defaultGraph(), []), []);
  assert.equal(defaultGraph().nodes.some((item) => item.type === "model"), false);
  const events = await collect(defaultGraph(), async () => { throw new Error("must not be called"); });
  assert.deepEqual(last(events), { type: "complete", output: "seed" });
});

test("studio starts without configured models or conversations", () => {
  const state = initialState();
  assert.deepEqual(state.models, []);
  assert.deepEqual(state.conversations, []);
  assert.equal(state.outputTokensMode, "auto");
  assert.equal(state.responseMode, "minimal");
  assert.equal("saved" in state.pipelines[0], false);
  assert.equal(isPipelineSaved(state.pipelines[0]), false);
  assert.equal(isPipelineSaved(undefined), false);
  assert.deepEqual(restoreState(serializeState(state)), state);
});

test("pipeline saved markers round-trip and invalid markers are rejected", () => {
  const state = initialState();
  state.pipelines[0].saved = true;
  state.pipelines.push({ ...state.pipelines[0], id: "unsaved", saved: false });
  const restored = restoreState(serializeState(state));
  assert.equal(restored.pipelines[0].saved, true);
  assert.equal(restored.pipelines[1].saved, false);
  assert.equal(isPipelineSaved(restored.pipelines[0]), true);
  assert.equal(isPipelineSaved(restored.pipelines[1]), false);
  for (const marker of [null, "true", 1, {}, []]) {
    const invalid = JSON.parse(serializeState(state));
    invalid.pipelines[0].saved = marker;
    assert.throws(() => restoreState(JSON.stringify(invalid)), /Invalid saved pipelines/);
  }
});

test("response settings persist and older version-three workspaces default to Auto Minimal", () => {
  const state = initialState();
  state.outputTokensMode = "manual";
  state.maxOutputTokens = 777;
  state.responseMode = "detailed";
  const restored = restoreState(serializeState(state));
  assert.equal(restored.outputTokensMode, "manual");
  assert.equal(restored.maxOutputTokens, 777);
  assert.equal(restored.responseMode, "detailed");
  const old = JSON.parse(serializeState(initialState()));
  delete old.outputTokensMode;
  delete old.responseMode;
  const migrated = restoreState(JSON.stringify(old));
  assert.equal(migrated.outputTokensMode, "auto");
  assert.equal(migrated.responseMode, "minimal");
});

test("multiple named pipelines round-trip and legacy v1 editor state migrates", () => {
  const state = initialState();
  const secondGraph = modelGraph();
  state.pipelines.push({ id: "pipe-two", name: "Review", graph: secondGraph, input: "default review input" });
  state.activePipelineId = "pipe-two";
  state.graph = secondGraph;
  state.pipelineName = "Review";
  state.input = "default review input";
  const conversation = newConversation(model.id);
  conversation.pipelineId = "pipe-two";
  state.conversations.push(conversation);
  state.activeConversationId = conversation.id;
  const restored = restoreState(serializeState(state));
  assert.equal(restored.pipelines.length, 2);
  assert.equal(restored.activePipelineId, "pipe-two");
  assert.equal(restored.pipelineName, "Review");
  assert.equal(restored.input, "default review input");
  assert.equal(restored.conversations[0].pipelineId, "pipe-two");

  const legacy = { ...initialState(), version: 1, pipelineName: "Old graph", graph: secondGraph, input: "legacy input" } as unknown as Record<string, unknown>;
  delete legacy.pipelines;
  delete legacy.activePipelineId;
  const migrated = restoreState(JSON.stringify(legacy));
  assert.equal(migrated.pipelines.length, 1);
  assert.equal(migrated.pipelineName, "Old graph");
  assert.equal(migrated.input, "legacy input");
  assert.deepEqual(migrated.graph, secondGraph);
  assert.equal("saved" in migrated.pipelines[0], false);
  assert.equal(isPipelineSaved(migrated.pipelines[0]), false);
  const legacyV2 = { ...initialState(), version: 2 };
  const restoredV2 = restoreState(JSON.stringify(legacyV2));
  assert.equal("saved" in restoredV2.pipelines[0], false);
  assert.equal(isPipelineSaved(restoredV2.pipelines[0]), false);
});

test("delegated block settings survive workspace export and restore", () => {
  const state = initialState();
  state.models = [model];
  state.graph = delegatedGraph({ validatorModelId: model.id });
  state.pipelines[0].graph = state.graph;
  const restored = restoreState(serializeState(state));
  assert.deepEqual(restored.graph, state.graph);
  assert.deepEqual(validateGraph(restored.graph, restored.models), []);
});

test("reasoning effort validates node types and survives workspace export and restore", () => {
  const block = customBlock("reasoning", { kind: "model", modelId: model.id, prompt: "Think." });
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const graph = chain(node("s", "start"), node("m", "model", { modelId: model.id, effort }),
      node("d", "delegated", { modelId: model.id, workerModelIds: [model.id], maxWorkers: 1, effort }),
      node("c", "custom", { customBlockId: block.id, effort }), node("o", "output"));
    const body = { ...pipelineBody(graph), customBlocks: [block] };
    assert.deepEqual(validateRequest(body), body);
    const state = initialState();
    state.models = [model];
    state.customBlocks = [block];
    state.graph = graph;
    state.pipelines[0].graph = graph;
    const restored = restoreState(serializeState(state));
    assert.deepEqual(restored.graph, graph);
    assert.deepEqual(restored.pipelines[0].graph, graph);
  }
  for (const effort of ["", "default", "LOW", "extreme", null, 1, {}]) {
    const graph = modelGraph();
    graph.nodes[1].effort = effort as never;
    assert.ok(validateGraph(graph, [model]).length);
    assert.throws(() => validateRequest(pipelineBody(graph)), PipelineError);
  }
  for (const type of ["start", "output", "condition", "variable"] as const) {
    const graph = defaultGraph();
    graph.nodes.push(node("draft", type, { effort: "high" }));
    assert.match(validateGraph(graph).join(" "), /Nodes must have valid bounded fields/);
  }
  const malformed = JSON.parse(serializeState(initialState()));
  malformed.pipelines[0].graph.nodes[0].effort = "high";
  assert.throws(() => restoreState(JSON.stringify(malformed)), /Invalid saved pipeline/);
});

test("model and custom model nodes forward their own effort or undefined", async () => {
  const block = customBlock("reasoning", { kind: "model", modelId: model.id, prompt: "Think." });
  const graph = chain(node("s", "start"), node("m", "model", { modelId: model.id, effort: "xhigh" }),
    node("c", "custom", { customBlockId: block.id, effort: "max" }),
    node("default-model", "model", { modelId: model.id }), node("default-custom", "custom", { customBlockId: block.id }), node("o", "output"));
  const efforts: Array<PipelineNode["effort"]> = [];
  const events = await collectCustom(graph, [block], { complete: async (_model, _messages, _max, _signal, effort) => {
    efforts.push(effort);
    return { text: "answer" };
  } });
  assert.equal(last(events).type, "complete");
  assert.deepEqual(efforts, ["xhigh", "max", undefined, undefined]);
});

test("delegated effort reaches planner, retry, each worker, synthesis and validator", async () => {
  for (const effort of ["medium", "xhigh", "max", undefined] as const) {
    const calls: Array<[string, PipelineNode["effort"]]> = [];
    const events = await collectCustom(delegatedGraph({ maxWorkers: 2, effort }), [], {
      complete: async (_model, context, _max, _signal, forwarded) => {
        const prompt = context[0].content;
        const stage = prompt.includes("coordinator for a delegated AI block")
          ? (prompt.includes("previous plan did not match") ? "retry" : "planner")
          : prompt.includes("worker in a delegated AI pipeline") ? "worker"
            : prompt.includes("coordinator. Assemble") ? "synthesis" : "validator";
        calls.push([stage, forwarded]);
        if (stage === "planner") return { text: "invalid plan" };
        if (stage === "retry") return { text: JSON.stringify({ workers: [
          { role: "One", task: "First task", model: 1 }, { role: "Two", task: "Second task", model: 1 },
        ] }) };
        return { text: stage };
      },
    });
    assert.deepEqual(last(events), { type: "complete", output: "validator" });
    assert.deepEqual(calls, ["planner", "retry", "worker", "worker", "synthesis", "validator"].map((stage) => [stage, effort]));
  }
});

test("custom task blocks save reusable instructions and must reference a configured model", () => {
  const state = initialState();
  state.models = [model];
  state.customBlocks = [{ id: "research", name: "Research", action: {
    kind: "model", modelId: model.id, prompt: "Research the question and separate evidence from assumptions.",
  } }];
  const restored = restoreState(serializeState(state));
  assert.deepEqual(restored.customBlocks, state.customBlocks);
  const invalid = JSON.parse(serializeState(state));
  invalid.customBlocks[0].action.modelId = "missing-model";
  assert.throws(() => restoreState(JSON.stringify(invalid)), /Invalid custom blocks/);
});

test("saved workspaces and exports exclude credentials but retain settings and logs", () => {
  const state = initialState();
  state.models = [{ ...model, apiKey: "synthetic-private-key", outputTokenField: "max_completion_tokens" }];
  const conversation = newConversation(model.id);
  conversation.messages = [{ id: "one", role: "user", content: "hello", createdAt: 123 }];
  state.conversations = [conversation];
  state.activeConversationId = conversation.id;
  const raw = serializeState(state);
  assert.equal(raw.includes("synthetic-private-key"), false);
  const restored = restoreState(raw);
  assert.equal(restored.models[0].outputTokenField, "max_completion_tokens");
  assert.deepEqual(restored.conversations, state.conversations);
  const modified = JSON.parse(raw);
  modified.models[0].apiKey = "injected-key";
  assert.equal(restoreState(JSON.stringify(modified)).models[0].apiKey, undefined);
});

test("conversation context respects explicit recent-message setting and keeps full logs", () => {
  const conversation = newConversation(model.id);
  conversation.system = "Be concise.";
  conversation.historyLimit = 2;
  conversation.messages = messages.filter((m) => m.role !== "system").map((m, i) => ({ ...m, id: String(i), createdAt: 0 }));
  assert.deepEqual(chatContext(conversation), [{ role: "system", content: "Be concise." }, ...messages.slice(-2)]);
  assert.equal(formatPipelineChatInput(chatContext(conversation)), "Assistant:\nI will remember.\n\nUser:\nWhat color?");
  assert.equal(conversation.messages.length, 3);
});

test("restoration accepts unfinished drafts but rejects malformed node and usage fields", () => {
  const state = initialState();
  state.graph = { nodes: [node("draft", "condition")], edges: [] };
  state.pipelines[0].graph = state.graph;
  assert.deepEqual(restoreState(serializeState(state)).graph, state.graph);
  state.graph = { nodes: [], edges: [] };
  state.pipelines[0].graph = state.graph;
  assert.deepEqual(restoreState(serializeState(state)).graph, state.graph);
  const malformed = JSON.parse(serializeState(initialState()));
  malformed.pipelines[0].graph.nodes[0].value = {};
  assert.throws(() => restoreState(JSON.stringify(malformed)), /Invalid saved pipeline/);
  const invalidUsage = initialState();
  const conversation = newConversation();
  conversation.messages = [{ id: "bad", role: "assistant", content: "hello", createdAt: 0, usage: {} as never }];
  invalidUsage.conversations = [conversation];
  assert.throws(() => restoreState(serializeState(invalidUsage)), /Invalid saved conversations/);
});

test("graph validation exposes stable distinct codes without changing user-facing messages", () => {
  const graph = chain(node("s", "start"), node("m", "model"));
  graph.edges = [];
  const issues = validateGraphIssues(graph, []);
  assert.deepEqual(issues.map((issue) => issue.code), ["unfinished-path"]);
  assert.deepEqual(issues.map((issue) => issue.message), validateGraph(graph, []));
  const connected = chain(node("s", "start"), node("m", "model"));
  assert.deepEqual(validateGraphIssues(connected, []).map((issue) => issue.code), ["unfinished-path", "model-missing"]);
  const state = initialState();
  state.pipelines[0].graph = connected;
  assert.deepEqual(restoreState(serializeState(state)).graph, connected);
  connected.edges.push({ id: "cycle", from: "m", to: "m", port: "out" });
  assert.ok(validateGraphIssues(connected, []).some((issue) => issue.code === "cycle"));
  assert.throws(() => restoreState(serializeState(state)), /Invalid saved pipelines/);
});

test("model steps receive prior values and emit real usage, not estimated usage", async () => {
  const graph = chain(node("s", "start"), node("a", "model", { modelId: model.id, prompt: "Rewrite this." }),
    node("b", "model", { modelId: model.id }), node("o", "output"));
  let calls = 0;
  const events = await collect(graph, async (selected, context, max, signal) => {
    assert.equal(selected.id, model.id);
    assert.equal(max, 64);
    assert.equal(signal.aborted, false);
    if (calls++ === 0) {
      assert.deepEqual(context, [{ role: "system", content: "Rewrite this." }, { role: "user", content: "seed" }]);
      return { text: "first actual text", usage: { input: 17, output: 5 } };
    }
    assert.deepEqual(context, [{ role: "user", content: "first actual text" }]);
    return { text: "second actual text", usage: { input: 10, output: 4 } };
  });
  assert.equal(calls, 2);
  assert.deepEqual(last(events), { type: "complete", output: "second actual text", usage: { input: 27, output: 9 } });
  assert.equal(events.find((event) => event.nodeId === "a" && event.type === "node-complete")?.output, "first actual text");
  assert.deepEqual(events.filter((event) => event.type === "node-start").map((event) => event.nodeId), ["s", "a", "b", "o"]);
});

test("custom definitions and graph references are strict and only reachable blocks must be configured", () => {
  const definitions: CustomBlockDefinition[] = [
    customBlock("model-step", { kind: "model", modelId: model.id, prompt: "Explain progress." }),
    customBlock("template-step", { kind: "template", template: "{{value}}" }),
    customBlock("math-step", { kind: "math", operation: "add", operand: 5 }),
    customBlock("http-step", { kind: "http", method: "POST", url: "https://api.example.com/v1/slides",
      bodyTemplate: '{"title":"{{value}}"}', responsePath: "data.title", authHeader: "X-API-Key", authPrefix: "Token " }),
    customBlock("cost-step", { kind: "cost" }),
  ];
  validateCustomBlocks(definitions);
  assert.deepEqual(validateGraph(customGraph("model-step"), [model], definitions), []);
  assert.match(validateGraph(customGraph("missing"), [model], definitions).join(" "), /configured custom block/);
  assert.match(validateGraph(customGraph("model-step"), [], definitions).join(" "), /configured model/);
  const draft = defaultGraph();
  draft.nodes.push(node("draft-custom", "custom", { customBlockId: "not-configured" }));
  assert.deepEqual(validateGraph(draft, [], []), []);
  assert.throws(() => validateCustomBlocks([{ ...definitions[0], extra: true }]), PipelineError);
  assert.throws(() => validateCustomBlocks([customBlock("bad", { kind: "template", template: "ok", extra: true } as never)]), PipelineError);
  assert.throws(() => validateCustomBlocks([customBlock("bad", { kind: "http", method: "GET", url: "http://api.example.com" })]), PipelineError);
  assert.throws(() => validateCustomBlocks([customBlock("bad", { kind: "http", method: "GET", url: "https://api.example.com", authHeader: "Content-Length" })]), PipelineError);
  assert.throws(() => validateCustomBlocks([customBlock("bad", { kind: "http", method: "GET", url: "https://api.example.com", responsePath: "data.__proto__.x" })]), PipelineError);
  assert.throws(() => validateCustomBlocks([customBlock("bad", { kind: "math", operation: "add", operand: Infinity })]), PipelineError);
  assert.throws(() => validateCustomBlocks([{ ...definitions[0], apiKey: "not-for-a-model-action" }]), PipelineError);
});

test("pipeline requests validate customBlocks and reject malformed definitions", () => {
  const block = customBlock("format", { kind: "template", template: "{{value}}!" });
  const body = { ...pipelineBody(customGraph(block.id)), models: [], customBlocks: [block] };
  assert.deepEqual(validateRequest(body), body);
  assert.throws(() => validateRequest({ ...body, customBlocks: null }), PipelineError);
  assert.throws(() => validateRequest({ ...body, customBlocks: [{ ...block, action: { ...block.action, extra: true } }] }), PipelineError);
});

test("pipeline requests validate delegated coordinator and worker model assignments", () => {
  const body = { ...pipelineBody(delegatedGraph()), models: [model] };
  assert.deepEqual(validateRequest(body), body);
  assert.throws(() => validateRequest({ ...body, graph: delegatedGraph({ workerModelIds: ["missing"] }) }), PipelineError);
  assert.throws(() => validateRequest({ ...body, graph: delegatedGraph({ maxWorkers: 0 }) }), PipelineError);
});

test("custom model actions use progress instructions, prior values and provider-reported usage", async () => {
  const block = customBlock("progress", { kind: "model", modelId: model.id, prompt: "Explain progress for {{phase}}." });
  const costBlock = customBlock("cost", { kind: "cost" });
  const graph = chain(node("s", "start"), node("v", "variable", { variable: "phase", value: "Working on {{input}}" }),
    node("c", "custom", { customBlockId: block.id }), node("check-cost", "custom", { customBlockId: costBlock.id }), node("o", "output"));
  let calls = 0;
  const events = await collectCustom(graph, [block, costBlock], {
    models: [model],
    complete: async (selected, context) => {
      calls++;
      assert.equal(selected.id, model.id);
      assert.deepEqual(context, [
        { role: "system", content: "Explain progress for Working on seed." },
        { role: "user", content: "Working on seed" },
      ]);
      return { text: "Explained", usage: { input: 2_000, output: 1_000 } };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(last(events), {
    type: "complete", output: "Unknown (one or more model calls have no cost data)", usage: { input: 2_000, output: 1_000 },
  });
  assert.deepEqual(events.find((event) => event.type === "node-complete" && event.nodeId === "c")?.usage,
    { input: 2_000, output: 1_000 });
});

test("delegated block creates concise worker deliverables and returns the validator-reviewed draft", async () => {
  const workerModel: StudioModel = { ...model, id: "worker-model", name: "Fast worker", model: "fast-model" };
  const validatorModel: StudioModel = { ...model, id: "validator-model", name: "Code validator", model: "validator-model" };
  const models = [model, workerModel, validatorModel];
  const graph = delegatedGraph({ workerModelIds: [workerModel.id, model.id], validatorModelId: validatorModel.id, maxWorkers: 8 });
  assert.deepEqual(validateGraph(graph, models), []);
  let activeWorkers = 0;
  let maxActiveWorkers = 0;
  let calls = 0;
  const events = await collectCustom(graph, [], {
    models,
    input: "Compare the options and recommend one.",
    complete: async (selected, context, maxTokens, signal) => {
      calls++;
      assert.equal(signal.aborted, false);
      if (context[0].content.includes("You are the coordinator for a delegated AI block.")) {
        assert.equal(selected.id, model.id);
        assert.equal(maxTokens, 64);
        assert.equal(context[1].content, "Compare the options and recommend one.");
        assert.match(context[0].content, /Create between 1 and 8 workers/);
        assert.match(context[0].content, /use fewer workers when that keeps each deliverable complete/);
        assert.match(context[0].content, /Fast worker/);
        return { text: JSON.stringify({ workers: [
          { role: "Evidence finder", task: "Find the strongest supporting evidence.", model: 1 },
          { role: "Risk reviewer", task: "Identify the main trade-offs and risks.", model: 2 },
          { role: "Technical reviewer", task: "Check the technical constraints.", model: 1 },
          { role: "Decision analyst", task: "Compare the options and recommend criteria.", model: 2 },
        ] }), usage: { input: 10, output: 2, cost: 0.01 } };
      }
      if (context[0].content.includes("You are a worker in a delegated AI pipeline.")) {
        const role = context[0].content.match(/Role: ([^\r\n]+)/)?.[1];
        assert.ok(role);
        assert.equal(selected.id, ["Evidence finder", "Technical reviewer"].includes(role) ? workerModel.id : model.id);
        assert.equal(maxTokens, 64);
        assert.match(context[0].content, /Return only the complete assigned deliverable/);
        assert.match(context[0].content, /Omit explanations and progress reports/);
        activeWorkers++;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWorkers--;
        return {
          text: `${role} report.`,
          usage: { input: 2, output: 1, cost: 0.02 },
        };
      }
      if (context[0].content.includes("You are the coordinator. Assemble")) {
        assert.equal(selected.id, model.id);
        assert.equal(maxTokens, 64);
        const report = JSON.parse(context[1].content) as { workers: Array<{ role: string; result: string }> };
        assert.equal(report.workers.length, 4);
        assert.deepEqual(report.workers.map((worker) => worker.role), ["Evidence finder", "Risk reviewer", "Technical reviewer", "Decision analyst"]);
        return { text: "Complete draft for the requested deliverable.", usage: { input: 4, output: 2, cost: 0.04 } };
      }
      assert.equal(selected.id, validatorModel.id);
      assert.equal(maxTokens, 64);
      assert.match(context[0].content, /You are the validator and finalizer/);
      assert.match(context[0].content, /no code execution tools/);
      const review = JSON.parse(context[1].content) as { task: string; draft: string };
      assert.equal(review.task, "Compare the options and recommend one.");
      assert.equal(review.draft, "Complete draft for the requested deliverable.");
      return { text: "Status: PASS\nFindings: None.\nFinal deliverable: Reviewed result.", usage: { input: 6, output: 4, cost: 0.05 } };
    },
  });
  assert.equal(calls, 7);
  assert.equal(maxActiveWorkers, 4);
  const block = events.find((event) => event.type === "node-complete" && event.nodeId === "d");
  assert.equal(block?.output, "Status: PASS\nFindings: None.\nFinal deliverable: Reviewed result.");
  assert.deepEqual(block?.usage, { input: 28, output: 12, cost: 0.18 });
  assert.deepEqual(last(events), { type: "complete", output: block?.output, usage: { input: 28, output: 12, cost: 0.18 } });
});

test("delegated planner retries one invalid plan within the model-call budget", async () => {
  let calls = 0;
  const events = await collectCustom(delegatedGraph({ maxWorkers: 1 }), [], {
    complete: async (_selected, context) => {
      calls++;
      if (context[0].content.includes("You are the coordinator for a delegated AI block.")) {
        if (calls === 1) return { text: "That was not JSON.", usage: { input: 1, output: 1 } };
        assert.match(context[0].content, /previous plan did not match this schema/);
        return { text: JSON.stringify({ workers: [{ role: "Builder", task: "Build the requested result.", model: 1 }] }), usage: { input: 1, output: 1 } };
      }
      if (context[0].content.includes("You are a worker in a delegated AI pipeline.")) return { text: "Complete worker result.", usage: { input: 1, output: 1 } };
      if (context[0].content.includes("You are the coordinator. Assemble")) return { text: "Complete draft.", usage: { input: 1, output: 1 } };
      assert.match(context[0].content, /You are the validator and finalizer/);
      return { text: "Reviewed final result.", usage: { input: 1, output: 1 } };
    },
  });
  assert.equal(calls, 5);
  assert.deepEqual(last(events), { type: "complete", output: "Reviewed final result.", usage: { input: 5, output: 5 } });
});

test("delegated completion errors identify the failing stage without exposing upstream details", async () => {
  let calls = 0;
  const events = await collectCustom(delegatedGraph({ maxWorkers: 1 }), [], {
    complete: async (_selected, context) => {
      calls++;
      if (context[0].content.includes("You are the coordinator for a delegated AI block.")) {
        return { text: JSON.stringify({ workers: [{ role: "Builder", task: "Build the result.", model: 1 }] }) };
      }
      if (context[0].content.includes("You are a worker in a delegated AI pipeline.")) {
        throw new PipelineError("response", "private upstream detail");
      }
      throw new Error("Unexpected call");
    },
  });
  assert.equal(calls, 2);
  assert.equal(last(events).error, "Model endpoint returned an invalid or oversized completion (worker-1).");
  assert.equal(last(events).error?.includes("private upstream detail"), false);
});

test("delegated blocks reject missing worker models and coordinator plans outside the allowlist", async () => {
  assert.match(validateGraph(delegatedGraph({ workerModelIds: [] }), [model]).join(" "), /at least one configured worker model/);
  assert.match(validateGraph(delegatedGraph({ workerModelIds: ["missing"] }), [model]).join(" "), /at least one configured worker model/);
  assert.match(validateGraph(delegatedGraph({ validatorModelId: "missing" }), [model]).join(" "), /validator must reference a configured model/);
  assert.ok(validateGraph(delegatedGraph({ maxWorkers: LIMITS.delegatedWorkers + 1 }), [model]).length);
  let calls = 0;
  const events = await collectCustom(delegatedGraph(), [], {
    complete: async () => {
      calls++;
      return { text: JSON.stringify({ workers: [{ role: "Unallowed", task: "Use a different model.", model: 2 }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(last(events).error, "The coordinator returned an invalid worker plan after one retry.");
});

test("auto model ranking uses token cost for cheapest, cost effective and strongest picks", () => {
  const free: StudioModel = { ...model, id: "free", name: "Free", inputCostPerMillion: 0, outputCostPerMillion: 0 };
  const cheap: StudioModel = { ...model, id: "cheap", name: "Cheap", inputCostPerMillion: 0.5, outputCostPerMillion: 1 };
  const mid: StudioModel = { ...model, id: "mid", name: "Mid", inputCostPerMillion: 2, outputCostPerMillion: 4 };
  const strong: StudioModel = { ...model, id: "strong", name: "Strong", inputCostPerMillion: 10, outputCostPerMillion: 30 };
  const unknown: StudioModel = { ...model, id: "unknown", name: "Unknown" };
  const models = [unknown, strong, cheap, mid, free];
  const pool = ["unknown", "strong", "cheap", "mid", "free"];
  assert.equal(modelTokenCost(free), 0);
  assert.equal(modelTokenCost(cheap), 1.5);
  assert.equal(modelTokenCost(strong), 40);
  assert.equal(modelTokenCost(unknown), undefined);
  assert.equal(resolveAutoModel(pool, models, "cheap")!.id, "free");
  assert.equal(resolveAutoModel(pool, models, "value")!.id, "cheap");
  assert.equal(resolveAutoModel(pool, models, "performance")!.id, "strong");
  // models without cost data are only used when no candidate has a cost
  assert.equal(resolveAutoModel(["unknown", "strong"], models, "cheap")!.id, "strong");
  assert.equal(resolveAutoModel(["unknown"], models, "performance")!.id, "unknown");
  const raw: StudioModel[] = [unknown, { ...model, id: "other", name: "Other", model: "other-model" }];
  assert.equal(resolveAutoModel(["unknown", "other"], raw, "cheap")!.id, "unknown");
  assert.equal(resolveAutoModel(["unknown", "other"], raw, "performance")!.id, "other");
  assert.equal(resolveAutoModel(["other"], raw, "value")!.id, "other");
  assert.equal(resolveAutoModel([], models, "cheap"), undefined);
  assert.equal(resolveAutoModel(["missing"], models, "cheap"), undefined);
});

test("delegated auto modes resolve leader and worker models by token cost at run time", async () => {
  const cheap: StudioModel = { ...model, id: "cheap-model", name: "Cheap", model: "cheap-model-id", inputCostPerMillion: 0.5, outputCostPerMillion: 1 };
  const strong: StudioModel = { ...model, id: "strong-model", name: "Strong", model: "strong-model-id", inputCostPerMillion: 10, outputCostPerMillion: 30 };
  const graph = chain(node("s", "start"), node("d", "delegated", {
    leaderAuto: "performance", leaderPool: [cheap.id, strong.id],
    workerAuto: "cheap", workerPool: [cheap.id, strong.id],
    maxWorkers: 2,
  }), node("o", "output"));
  assert.deepEqual(validateGraph(graph, [cheap, strong]), []);
  const calls: string[] = [];
  let strongCalls = 0;
  const events = await collectCustom(graph, [], {
    models: [cheap, strong],
    complete: async (selected) => {
      calls.push(selected.id);
      if (selected.id === strong.id) {
        strongCalls++;
        return strongCalls === 1
          ? { text: JSON.stringify({ workers: [{ role: "Analyst", task: "Analyze the input.", model: 1 }] }), usage: { input: 5, output: 5 } }
          : { text: "Strong synthesis.", usage: { input: 5, output: 5 } };
      }
      assert.equal(selected.id, cheap.id);
      return { text: "Cheap worker report.", usage: { input: 5, output: 5 } };
    },
  });
  assert.deepEqual(calls, [strong.id, cheap.id, strong.id, strong.id]);
  const block = events.find((event) => event.type === "node-complete" && event.nodeId === "d");
  assert.equal(block?.output, "Strong synthesis.");
  assert.deepEqual(block?.usage, { input: 20, output: 20 });
});

test("delegated worker requests share an output-token budget and team review calls are capped", async () => {
  const validatorModel: StudioModel = { ...model, id: "validator-model", name: "Validator", contextWindow: 100_000 };
  const workerModel: StudioModel = { ...model, id: "worker-model", name: "Worker", contextWindow: 100_000 };
  const coordinator: StudioModel = { ...model, contextWindow: 100_000 };
  const graph = delegatedGraph({ workerModelIds: [workerModel.id], validatorModelId: validatorModel.id, maxWorkers: 2 });
  const calls: Array<{ id: string; tokens: number; role: string }> = [];
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline({
    graph, models: [coordinator, workerModel, validatorModel], input: "Generate a small game.", maxOutputTokens: 32_768,
    complete: async (selected, context, tokens) => {
      const role = context[0].content.includes("coordinator for a delegated AI block") ? "planner"
        : context[0].content.includes("worker in a delegated AI pipeline") ? "worker"
          : context[0].content.includes("coordinator. Assemble") ? "synthesis" : "validator";
      calls.push({ id: selected.id, tokens, role });
      if (role === "planner") return { text: JSON.stringify({ workers: [
        { role: "Stage one", task: "Build the first stage.", model: 1 },
        { role: "Stage two", task: "Build the second stage.", model: 1 },
      ] }) };
      if (role === "validator") return { text: "Reviewed final deliverable." };
      return { text: role === "synthesis" ? "Complete draft." : "Complete assigned code." };
    },
  })) events.push(event);
  assert.deepEqual(calls.map(({ role, tokens }) => [role, tokens]), [
    ["planner", 2048], ["worker", 4096], ["worker", 4096], ["synthesis", 8192], ["validator", 8192],
  ]);
  assert.equal(last(events).output, "Reviewed final deliverable.");
});

test("delegated auto selections validate strategies, candidate pools and specific-model exclusivity", () => {
  const autoDelegated = (fields: Partial<PipelineNode>) => chain(
    node("s", "start"), node("d", "delegated", { maxWorkers: 3, ...fields }), node("o", "output"),
  );
  const leaderAuto = autoDelegated({ leaderAuto: "performance", leaderPool: [model.id], workerModelIds: [model.id] });
  assert.deepEqual(validateGraph(leaderAuto, [model]), []);
  const workerAuto = autoDelegated({ modelId: model.id, workerAuto: "value", workerPool: [model.id] });
  assert.deepEqual(validateGraph(workerAuto, [model]), []);
  const both = autoDelegated({ leaderAuto: "performance", leaderPool: [model.id], workerAuto: "cheap", workerPool: [model.id] });
  assert.deepEqual(validateRequest(pipelineBody(both)), pipelineBody(both));
  const strict = /Nodes must have valid bounded fields and unique IDs\./;
  assert.match(validateGraph(autoDelegated({ leaderAuto: "cheap", leaderPool: [model.id], modelId: model.id }), [model]).join(" "), strict);
  assert.match(validateGraph(autoDelegated({ modelId: model.id, workerAuto: "cheap", workerPool: [model.id], workerModelIds: [model.id] }), [model]).join(" "), strict);
  assert.match(validateGraph(autoDelegated({ leaderAuto: "fast", leaderPool: [model.id], workerModelIds: [model.id] } as unknown as Partial<PipelineNode>), [model]).join(" "), strict);
  assert.match(validateGraph(chain(node("s", "start"), node("m", "model", { modelId: model.id, leaderAuto: "cheap" }), node("o", "output")), [model]).join(" "), strict);
  const leaderCandidate = /auto leader needs at least one configured leader candidate/;
  assert.match(validateGraph(autoDelegated({ leaderAuto: "cheap", leaderPool: [], workerModelIds: [model.id] }), [model]).join(" "), leaderCandidate);
  assert.match(validateGraph(autoDelegated({ leaderAuto: "cheap", leaderPool: ["missing"], workerModelIds: [model.id] }), [model]).join(" "), leaderCandidate);
  assert.match(validateGraph(autoDelegated({ modelId: model.id, workerAuto: "cheap", workerPool: ["missing"] }), [model]).join(" "), /auto workers needs at least one configured worker candidate/);
  assert.match(validateGraph(chain(
    node("s", "start"), node("m", "model", { modelId: model.id, validatorModelId: model.id }), node("o", "output"),
  ), [model]).join(" "), strict);
  assert.throws(() => validateRequest(pipelineBody(autoDelegated({ leaderAuto: "cheap", leaderPool: ["missing"], workerModelIds: [model.id] }))), PipelineError);
});

test("model token costs are validated and survive export and restore", () => {
  validateModels([{ ...model, inputCostPerMillion: 0.5, outputCostPerMillion: 1.25 }]);
  assert.throws(() => validateModels([{ ...model, inputCostPerMillion: -1 }]), PipelineError);
  assert.throws(() => validateModels([{ ...model, outputCostPerMillion: Number.NaN }]), PipelineError);
  assert.throws(() => validateModels([{ ...model, inputCostPerMillion: 2_000_000 }]), PipelineError);
  const state = initialState();
  state.models.push({ ...model, inputCostPerMillion: 0.5, outputCostPerMillion: 1.25 });
  const graph = chain(node("s", "start"), node("d", "delegated", {
    leaderAuto: "value", leaderPool: [model.id], workerAuto: "cheap", workerPool: [model.id], maxWorkers: 2,
  }), node("o", "output"));
  state.graph = graph;
  state.pipelines[0].graph = graph;
  const restored = restoreState(serializeState(state));
  assert.equal(restored.models[0].inputCostPerMillion, 0.5);
  assert.equal(restored.models[0].outputCostPerMillion, 1.25);
  const restoredNode = restored.graph.nodes[1];
  assert.equal(restoredNode.leaderAuto, "value");
  assert.deepEqual(restoredNode.leaderPool, [model.id]);
  assert.equal(restoredNode.workerAuto, "cheap");
  assert.deepEqual(restoredNode.workerPool, [model.id]);
});

test("template and arithmetic custom actions do not call a model; division by zero is rejected", async () => {
  let calls = 0;
  const neverComplete: Complete = async () => { calls++; throw new Error("model must not run"); };
  const template = customBlock("template", { kind: "template", template: "{{value}} + 5 = {{input}}" });
  const formatted = await collectCustom(customGraph(template.id), [template], {
    models: [], input: "10", complete: neverComplete,
  });
  assert.equal(last(formatted).output, "10 + 5 = 10");
  const add = customBlock("add-five", { kind: "math", operation: "add", operand: 5 });
  const arithmetic = await collectCustom(customGraph(add.id), [add], { models: [], input: "10", complete: neverComplete });
  assert.equal(last(arithmetic).output, "15");
  const divide = customBlock("divide-zero", { kind: "math", operation: "divide", operand: 0 });
  const rejected = await collectCustom(customGraph(divide.id), [divide], { models: [], input: "10", complete: neverComplete });
  assert.match(last(rejected).error!, /non-zero divisor/);
  assert.equal(calls, 0);
});

test("cost actions accumulate provider-reported costs and mark missing costs unknown", async () => {
  const cost = customBlock("cost", { kind: "cost" });
  const graph = chain(node("s", "start"), node("a", "model", { modelId: model.id }),
    node("c1", "custom", { customBlockId: cost.id }), node("b", "model", { modelId: model.id }),
    node("c2", "custom", { customBlockId: cost.id }), node("o", "output"));
  let calls = 0;
  const events = await collectCustom(graph, [cost], {
    complete: async (_, context) => {
      if (calls++ === 0) return { text: "first", usage: { input: 10, output: 20, cost: 0.01 } };
      assert.deepEqual(context, [{ role: "user", content: "0.01 USD" }]);
      return { text: "done", usage: { input: 500, output: 250, cost: 0.002 } };
    },
  });
  assert.equal(events.find((event) => event.type === "node-complete" && event.nodeId === "c1")?.output, "0.01 USD");
  assert.equal(events.find((event) => event.type === "node-complete" && event.nodeId === "c2")?.output, "0.012 USD");
  const completed = last(events);
  assert.equal(completed.type, "complete");
  assert.equal(completed.usage?.input, 510);
  assert.equal(completed.usage?.output, 270);
  assert.ok(Math.abs(completed.usage!.cost! - 0.012) < 1e-12);

  const unknown = await collectCustom(chain(node("s", "start"), node("m", "model", { modelId: model.id }),
    node("c", "custom", { customBlockId: cost.id }), node("o", "output")), [cost], {
    complete: async () => ({ text: "answer", usage: { input: 4, output: 2 } }),
  });
  assert.match(unknown.find((event) => event.type === "node-complete" && event.nodeId === "c")!.output!, /Unknown/);
  assert.deepEqual(last(unknown).usage, { input: 4, output: 2 });
});

function branchGraph(operator: PipelineNode["condition"], value: string): PipelineGraph {
  return {
    nodes: [node("s", "start"), node("c", "condition", { condition: operator, value }),
      node("p", "variable", { variable: "branch", value: "passed" }),
      node("f", "variable", { variable: "branch", value: "failed" }), node("o", "output")],
    edges: [
      { id: "fail-first", from: "c", to: "f", port: "fail" },
      { id: "po", from: "p", to: "o", port: "out" },
      { id: "fo", from: "f", to: "o", port: "out" },
      { id: "sc", from: "s", to: "c", port: "out" },
      { id: "pass-last", from: "c", to: "p", port: "pass" },
    ],
  };
}

test("condition ports select one path independently of edge order; merge is allowed", async () => {
  const graph = branchGraph("contains", "ee");
  assert.deepEqual(validateGraph(graph, [model]), []);
  const events = await collect(graph);
  assert.equal(last(events).output, "passed");
  assert.deepEqual(events.filter((event) => event.type === "node-start").map((event) => event.nodeId), ["s", "c", "p", "o"]);
  assert.equal(last(await collect({ ...graph, edges: [...graph.edges].reverse() })).output, "passed");
  assert.equal(last(await collect(graph, complete, "no match")).output, "failed");
});

test("contains, not-contains and equals are case-sensitive literal text checks", async () => {
  assert.equal(last(await collect(branchGraph("not-contains", "other"))).output, "passed");
  assert.equal(last(await collect(branchGraph("not-contains", "ee"))).output, "failed");
  assert.equal(last(await collect(branchGraph("equals", "seed"))).output, "passed");
  assert.equal(last(await collect(branchGraph("equals", "Seed"))).output, "failed");
  assert.equal(last(await collect(branchGraph("contains", "s.*"))).output, "failed");
  assert.equal(last(await collect(branchGraph("contains", "{{input}}"))).output, "failed");
});

test("variables capture or assign templates and model prompts can reference them", async () => {
  const graph = chain(node("s", "start"), node("v", "variable", { variable: "saved" }),
    node("assign", "variable", { variable: "joined", value: "{{input}}/{{ value }}/{{saved}}" }),
    node("m", "model", { modelId: model.id, prompt: "Use {{joined}} and {{saved}}" }),
    node("o", "output", { prompt: "{{input}}:{{saved}}:{{value}}" }));
  const events = await collect(graph, async (_, context) => {
    assert.equal(context[0].content, "Use seed/seed/seed and seed");
    assert.equal(context[1].content, "seed/seed/seed");
    return { text: "answer" };
  });
  assert.equal(last(events).output, "seed:seed:answer");
  assert.equal(last(events).usage, undefined);
});

test("template values are substituted once, and normal JSON braces remain literal", () => {
  assert.equal(renderTemplate('{{value}} {"x":1}', "input", "{{unknown}}", new Map()), '{{unknown}} {"x":1}');
  assert.equal(renderTemplate("{{input}} {{value}} {{foo}}", "a", "b", new Map([["foo", "c"]])), "a b c");
  for (const template of ["{{missing}}", "{{constructor}}", "{{value", "value}}", "{{a.b}}", "{{}}", "{{{value}}}"]) {
    assert.throws(() => renderTemplate(template, "a", "b", new Map()), PipelineError);
  }
});

test("unknown variables fail only the selected runtime path, without invoking a provider", async () => {
  const graph = modelGraph();
  graph.nodes[1].prompt = "{{unknown}}";
  const events = await collect(graph, async () => { throw new Error("provider should not run"); });
  assert.equal(last(events).type, "error");
  assert.match(last(events).error!, /unknown variable/);
});

test("prototype-polluting and reserved variable names are rejected", () => {
  for (const variable of ["__proto__", "constructor", "prototype", "input", "value", "a.b", ""]) {
    assert.ok(validateGraph(chain(node("s", "start"), node("v", "variable", { variable }), node("o", "output"))).length);
  }
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("malformed graphs fail closed, including cycles in disconnected drafts", async () => {
  const invalid: unknown[] = [null, {}, { nodes: [], edges: [] }, { nodes: [null], edges: [] },
    { nodes: defaultGraph().nodes, edges: [null] }];
  for (const graph of invalid) assert.ok(validateGraph(graph).length);
  const cases: PipelineGraph[] = [
    chain(node("o", "output")),
    chain(node("s", "start"), node("s2", "start"), node("o", "output")),
    chain(node("s", "start"), node("s", "output")),
    chain(node("s", "start"), node("m", "model", { modelId: "missing" }), node("o", "output")),
    chain(node("s", "start"), node("dead", "variable", { variable: "x" })),
  ];
  const cycle = defaultGraph();
  cycle.nodes.push(node("a", "variable"), node("b", "variable"));
  cycle.edges.push({ id: "ab", from: "a", to: "b", port: "out" }, { id: "ba", from: "b", to: "a", port: "out" });
  cases.push(cycle);
  for (const graph of cases) {
    assert.ok(validateGraph(graph, [model]).length);
    assert.equal(last(await collect(graph)).type, "error");
  }
});

test("one output port may fan out, but invalid ports, duplicate connections, incoming Start and outgoing Output are rejected", () => {
  const edits: Array<(graph: PipelineGraph) => void> = [
    (g) => { g.edges[0].port = "pass"; },
    (g) => { g.edges[0].to = "absent"; },
    (g) => { g.edges.push({ ...g.edges[0] }); },
    (g) => { g.edges.push({ ...g.edges[0], id: "other" }); },
    (g) => { g.edges.push({ id: "back", from: "output", to: "start", port: "out" }); },
  ];
  for (const edit of edits) { const graph = defaultGraph(); edit(graph); assert.ok(validateGraph(graph).length); }
  const branch = branchGraph("equals", "seed");
  branch.edges = branch.edges.filter((edge) => edge.port !== "fail");
  assert.ok(validateGraph(branch).length);
});

test("fan-out runs shared upstream work once, executes each branch, and collects named outputs", async () => {
  const graph: PipelineGraph = {
    nodes: [
      node("s", "start"), node("shared", "model", { modelId: model.id, prompt: "shared step" }),
      node("left", "model", { modelId: model.id, prompt: "left step" }),
      node("right", "model", { modelId: model.id, prompt: "right step" }),
      node("left-output", "output", { label: "Left result" }), node("right-output", "output", { label: "Right result" }),
    ],
    edges: [
      { id: "start-shared", from: "s", to: "shared", port: "out" },
      { id: "shared-left", from: "shared", to: "left", port: "out" },
      { id: "shared-right", from: "shared", to: "right", port: "out" },
      { id: "left-output", from: "left", to: "left-output", port: "out" },
      { id: "right-output", from: "right", to: "right-output", port: "out" },
    ],
  };
  assert.deepEqual(validateGraph(graph, [model]), []);
  let calls = 0;
  const events = await collect(graph, async (_, context) => {
    calls++;
    if (context[0].content === "shared step") {
      assert.equal(context[1].content, "seed");
      return { text: "shared result", usage: { input: 1, output: 1, cost: 0.001 } };
    }
    if (context[0].content === "left step") {
      assert.equal(context[1].content, "shared result");
      return { text: "left result", usage: { input: 1, output: 1, cost: 0.001 } };
    }
    assert.equal(context[0].content, "right step");
    assert.equal(context[1].content, "shared result");
    return { text: "right result", usage: { input: 1, output: 1, cost: 0.001 } };
  });
  assert.equal(calls, 3);
  assert.equal(events.find((event) => event.type === "node-complete" && event.nodeId === "left")?.branchId, "1.1");
  assert.equal(events.find((event) => event.type === "node-complete" && event.nodeId === "right")?.branchId, "1.2");
  assert.deepEqual(last(events), {
    type: "complete",
    output: "Branch 1.1 (Left result):\nleft result\n\nBranch 1.2 (Right result):\nright result",
    usage: { input: 3, output: 3, cost: 0.003 },
  });
});

test("fan-out execution is bounded against explosive graph paths", async () => {
  const layers = Array.from({ length: 10 }, (_, layer) => [
    node(`v${layer}a`, "variable", { variable: "branch", value: "{{value}}" }),
    node(`v${layer}b`, "variable", { variable: "branch", value: "{{value}}" }),
  ]);
  const nodes = [node("s", "start"), ...layers.flat(), node("o", "output")];
  const edges: PipelineGraph["edges"] = [
    { id: "start-a", from: "s", to: layers[0][0].id, port: "out" },
    { id: "start-b", from: "s", to: layers[0][1].id, port: "out" },
  ];
  for (let layer = 0; layer < layers.length - 1; layer++) {
    for (const source of layers[layer]) for (const target of layers[layer + 1]) {
      edges.push({ id: `${source.id}-${target.id}`, from: source.id, to: target.id, port: "out" });
    }
  }
  for (const source of layers.at(-1)!) edges.push({ id: `${source.id}-output`, from: source.id, to: "o", port: "out" });
  const graph = { nodes, edges };
  assert.deepEqual(validateGraph(graph), []);
  const events = await collect(graph, async () => { throw new Error("No model calls expected"); });
  assert.match(last(events).error!, /branching exceeded the per-run execution/);
});

test("disconnected unfinished drafts are allowed but reachable models must be configured", () => {
  const graph = defaultGraph();
  graph.nodes.push(node("draft-model", "model"), node("draft-condition", "condition"), node("draft-variable", "variable"));
  assert.deepEqual(validateGraph(graph, []), []);
  const missing = modelGraph();
  assert.ok(validateGraph(missing, []).length);
});

test("numeric, text, model and graph bounds are strict", () => {
  for (const maxOutputTokens of [0, -1, 1.5, LIMITS.outputTokens + 1, "64"]) {
    assert.throws(() => validateRequest({ ...chatBody(), maxOutputTokens }), PipelineError);
  }
  for (const contextWindow of [0, 255, LIMITS.contextTokens + 1, 8192.5, "8192"]) {
    assert.throws(() => validateRequest({ ...chatBody(), model: { ...model, contextWindow } }), PipelineError);
  }
  assert.throws(() => validateRequest({ ...chatBody(), extra: true }), PipelineError);
  assert.throws(() => validateRequest({ ...chatBody(), model: { ...model, extra: true } }), PipelineError);
  assert.throws(() => validateRequest({ ...chatBody(), model: { ...model, apiKey: "unsafe\nheader" } }), PipelineError);
  assert.throws(() => validateRequest({ ...chatBody(), messages: [{ role: "tool", content: "x" }] }), PipelineError);
  assert.throws(() => validateRequest({ ...chatBody(), messages: [{ role: "user", content: "x", extra: 1 }] }), PipelineError);
  assert.throws(() => validateRequest({ ...chatBody(), messages: [] }), PipelineError);
  assert.throws(() => validateRequest({ ...chatBody(), messages: Array(LIMITS.messages + 1).fill(messages[0]) }), PipelineError);
  assert.throws(() => validateRequest({ ...pipelineBody(), input: "x".repeat(LIMITS.inputChars + 1) }), PipelineError);
  assert.throws(() => validateRequest({ ...pipelineBody(), models: [model, model] }), PipelineError);
  assert.throws(() => validateRequest({ ...pipelineBody(), models: Array(LIMITS.models + 1).fill(model) }), PipelineError);
  validateModels([{ ...model, inputCostPerMillion: 1.25, outputCostPerMillion: 2.5 }]);
  assert.throws(() => validateRequest({ ...chatBody(), model: { ...model, extraRate: 1.25 } }), PipelineError);
  const graph = defaultGraph();
  graph.nodes[0].x = Infinity;
  assert.ok(validateGraph(graph).length);
  graph.nodes[0].x = 0;
  graph.nodes[0].prompt = "x".repeat(LIMITS.templateChars + 1);
  assert.ok(validateGraph(graph).length);
  assert.ok(validateGraph({ nodes: Array(LIMITS.nodes + 1).fill(node("s", "start")), edges: [] }).length);
  assert.ok(validateGraph({ nodes: defaultGraph().nodes, edges: Array(LIMITS.edges + 1).fill(defaultGraph().edges[0]) }).length);
});

test("model output-token field accepts only the two supported parameter names", () => {
  for (const outputTokenField of [undefined, "max_tokens", "max_completion_tokens"] as const) {
    const selected = { ...model, outputTokenField };
    validateModels([selected]);
    assert.deepEqual(validateRequest({ ...chatBody(), model: selected }), { ...chatBody(), model: selected });
    assert.deepEqual(validateRequest({ ...pipelineBody(), models: [selected] }), { ...pipelineBody(), models: [selected] });
  }
  for (const outputTokenField of [null, "", "max_output_tokens", "constructor", "__proto__", 64, true]) {
    assert.throws(() => validateModels([{ ...model, outputTokenField }]), PipelineError);
    assert.throws(() => validateRequest({ ...chatBody(), model: { ...model, outputTokenField } }), PipelineError);
  }
  assert.throws(() => validateRequest({ ...chatBody(), model: { ...model, allowLoopback: true } }), PipelineError);
});

test("UTF-8 context estimate includes all messages and output reservation; never truncates", () => {
  const context: Message[] = [{ role: "system", content: "s".repeat(700) }, { role: "user", content: "unicode \u4e2d\u6587" }];
  const estimated = estimateTokens(context);
  assert.equal(estimated, 3 + 6 + Math.ceil(700 / 3) + 6 + Math.ceil(new TextEncoder().encode(context[1].content).length / 3));
  assertContext({ ...model, contextWindow: estimated + 64 }, context, 64);
  assert.throws(() => assertContext({ ...model, contextWindow: estimated + 63 }, context, 64), PipelineError);
  assert.equal(context[0].content.length, 700);
});

test("model instruction context overflow fails before completing", async () => {
  const graph = modelGraph();
  graph.nodes[1].prompt = "instruction".repeat(2400);
  let called = false;
  const events = await collect(graph, async () => { called = true; return { text: "bad" }; });
  assert.equal(called, false);
  assert.match(last(events).error!, /context window/);
});

test("template expansion and aggregate variable state are bounded", async () => {
  assert.throws(() => renderTemplate("{{value}}".repeat(3), "", "x".repeat(65_536), new Map()), PipelineError);
  const graph = chain(node("s", "start"), node("a", "variable", { variable: "a" }),
    node("b", "variable", { variable: "b" }), node("c", "variable", { variable: "c" }), node("o", "output"));
  assert.match(last(await collect(graph, complete, "x".repeat(LIMITS.inputChars))).error!, /size limit/);
  assert.equal(last(await collect(modelGraph(), async () => ({ text: "x".repeat(LIMITS.textChars + 1) }))).type, "error");
});

test("provider failure is sanitized and never emits fake success", async () => {
  const events = await collect(modelGraph(), async () => { throw new Error("synthetic-key and upstream secret body"); });
  assert.equal(last(events).type, "error");
  assert.equal(last(events).error, "Model request failed.");
  assert.equal(events.some((event) => event.type === "complete"), false);
});

test("aggregate usage is omitted rather than underreported when a step lacks counts", async () => {
  const graph = chain(node("s", "start"), node("a", "model", { modelId: model.id }),
    node("b", "model", { modelId: model.id }), node("o", "output"));
  let calls = 0;
  const events = await collect(graph, async () => calls++ === 0
    ? { text: "first", usage: { input: 11, output: 3 } } : { text: "second" });
  assert.equal(last(events).usage, undefined);
  assert.deepEqual(events.find((event) => event.nodeId === "a" && event.type === "node-complete")?.usage, { input: 11, output: 3 });
});

test("abort before start and between nodes prevents work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  const events = await collect(modelGraph(), complete, "seed", controller.signal);
  assert.deepEqual(events, [{ type: "error", error: "Request cancelled." }]);
  const next = new AbortController();
  let called = false;
  const iterator = runPipeline({ ...pipelineBody(), complete: async () => { called = true; return { text: "bad" }; }, signal: next.signal });
  assert.equal((await iterator.next()).value?.type, "node-start");
  next.abort();
  assert.equal((await iterator.next()).value?.type, "error");
  assert.equal(called, false);
});

test("abort during await is checked after completion and signal reaches adapter", async () => {
  const controller = new AbortController();
  const events = await collect(modelGraph(), async (_, __, ___, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { text: "must not be emitted", usage: { input: 10, output: 3 } };
  }, "seed", controller.signal);
  assert.equal(last(events).error, "Request cancelled.");
  assert.equal(events.some((event) => event.output === "must not be emitted"), false);
});

test("endpoints allow only HTTPS public hosts and intentional HTTP loopback", () => {
  for (const url of ["https://api.example.com/v1", "https://8.8.8.8/v1", "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1", "http://127.1/v1", "http://[::1]:11434/v1"]) assert.ok(parseEndpoint(url));
  for (const url of ["http://api.example.com/v1", "https://user:pass@api.example.com", "https://@api.example.com",
    "https://api.example.com?key=x", "https://api.example.com?", "https://api.example.com#x", "https://api.example.com#",
    "file:///etc/passwd", "ftp://api.example.com", "https://10.0.0.1", "https://169.254.169.254",
    "https://192.168.1.1", "https://100.100.100.200", "https://[fe80::1]", "https://[fc00::1]",
    "https://[::ffff:10.0.0.1]", "https://0.0.0.0", "https://0xc0a80101", "https://2130706433?x",
    "https://224.0.0.1", "https://example.com\\@127.0.0.1", " https://api.example.com"]) {
    assert.throws(() => parseEndpoint(url), PipelineError);
  }
});

test("custom HTTP endpoints allow fixed HTTPS queries and intentional loopback only", () => {
  assert.equal(parseCustomEndpoint("https://api.example.com/v1/presentation?api-version=1").search, "?api-version=1");
  for (const url of ["http://api.example.com/v1", "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1#fragment", "https://10.0.0.1/v1", "https://169.254.169.254/latest/meta-data",
    "https://api.example.com/v1?api_key=embedded-secret",
    "https://api.example.com\\@127.0.0.1"]) {
    assert.throws(() => parseCustomEndpoint(url), PipelineError);
  }
  assert.equal(parseCustomEndpoint("http://127.0.0.1:3000/api").hostname, "127.0.0.1");
  assert.equal(parseCustomEndpoint("https://[::1]/api").hostname, "[::1]");
});

test("special-purpose IPv4/IPv6 ranges are blocked", () => {
  for (const address of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.1.1",
    "100.64.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "::ffff:808:808", "fe80::1", "fc00::1",
    "2001:db8::1", "2001::1", "2002:808:808::1", "3fff::1"]) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("every DNS result is checked; public domains cannot resolve to loopback or private networks", async () => {
  const url = parseEndpoint("https://api.example.com/v1");
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(resolveEndpoint(url, async () => [{ address, family: address.includes(":") ? 6 : 4 }]), PipelineError);
  }
  await assert.rejects(resolveEndpoint(url, async () => [{ address: "8.8.8.8", family: 4 }, { address: "192.168.0.1", family: 4 }]), PipelineError);
  await assert.rejects(resolveEndpoint(url, async () => []), PipelineError);
  await assert.rejects(resolveEndpoint(url, async () => { throw new Error("private DNS error"); }), { message: "Unable to resolve the model endpoint (api.example.com)." });
  await assert.rejects(resolveEndpoint(parseEndpoint("http://localhost/v1"), async () => [{ address: "8.8.8.8", family: 4 }]), PipelineError);
  assert.deepEqual(await resolveEndpoint(url, async () => [{ address: "8.8.8.8", family: 4 }]), { address: "8.8.8.8", family: 4 });
  assert.deepEqual(
    await resolveEndpoint(parseEndpoint("http://localhost:11434/v1"), async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }]),
    { address: "127.0.0.1", family: 4 },
  );
});

test("loopback is disabled by default before DNS or HTTP, for both HTTP and HTTPS", async () => {
  const original = process.env.PIPELINE_ALLOW_LOOPBACK;
  delete process.env.PIPELINE_ALLOW_LOOPBACK;
  let lookups = 0;
  const adapter = createComplete({ resolve: async () => { lookups++; throw new Error("must not resolve"); } });
  try {
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      if (flag === undefined) delete process.env.PIPELINE_ALLOW_LOOPBACK;
      else process.env.PIPELINE_ALLOW_LOOPBACK = flag;
      for (const baseUrl of ["http://localhost:11434/v1", "https://localhost./v1", "http://127.0.0.1/v1",
        "https://127.1/v1", "http://[::1]/v1", "https://[::1]/v1"]) {
        await assert.rejects(adapter({ ...model, baseUrl }, messages, 64, new AbortController().signal), {
          code: "loopback", status: 403,
          message: "Loopback endpoints are disabled. Enable PIPELINE_ALLOW_LOOPBACK only on a trusted local server.",
        });
      }
    }
    assert.equal(lookups, 0);
  } finally {
    if (original === undefined) delete process.env.PIPELINE_ALLOW_LOOPBACK;
    else process.env.PIPELINE_ALLOW_LOOPBACK = original;
  }
});

test("server loopback flag is read at request time and explicit denial overrides it", async () => {
  const original = process.env.PIPELINE_ALLOW_LOOPBACK;
  delete process.env.PIPELINE_ALLOW_LOOPBACK;
  let lookups = 0;
  const resolve = async () => { lookups++; throw new Error("offline DNS fixture"); };
  const adapter = createComplete({ resolve });
  const selected = { ...model, baseUrl: "http://localhost:11434/v1" };
  const signal = new AbortController().signal;
  try {
    await assert.rejects(adapter(selected, messages, 64, signal), { code: "loopback" });
    process.env.PIPELINE_ALLOW_LOOPBACK = "true";
    await assert.rejects(adapter(selected, messages, 64, signal), { code: "dns" });
    assert.equal(lookups, 1);
    await assert.rejects(createComplete({ allowLoopback: false, resolve })(selected, messages, 64, signal), { code: "loopback" });
    assert.equal(lookups, 1);
    delete process.env.PIPELINE_ALLOW_LOOPBACK;
    await assert.rejects(adapter(selected, messages, 64, signal), { code: "loopback" });
    assert.equal(lookups, 1);
  } finally {
    if (original === undefined) delete process.env.PIPELINE_ALLOW_LOOPBACK;
    else process.env.PIPELINE_ALLOW_LOOPBACK = original;
  }
});

test("localhost app requests still reach cloud providers and no-model echo with loopback disabled", async () => {
  const original = process.env.PIPELINE_ALLOW_LOOPBACK;
  delete process.env.PIPELINE_ALLOW_LOOPBACK;
  try {
    let lookups = 0;
    const adapter = createComplete({ resolve: async () => { lookups++; throw new Error("offline cloud DNS fixture"); } });
    const cloud = await handlePipelineRequest(request(chatBody()), adapter);
    assert.equal(lookups, 1);
    assert.equal(cloud.status, 502);
    assert.deepEqual(await cloud.json(), { error: "Unable to resolve the model endpoint (api.example.com)." });
    const echo = await POST(request({ ...pipelineBody(defaultGraph()), models: [] }));
    assert.equal(echo.status, 200);
    const events: PipelineEvent[] = (await echo.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(last(events), { type: "complete", output: "seed" });
    const disabled = await POST(request({ ...chatBody(), model: { ...model, baseUrl: "http://localhost:11434/v1" } }));
    assert.equal(disabled.status, 403);
    assert.deepEqual(await disabled.json(), {
      error: "Loopback endpoints are disabled. Enable PIPELINE_ALLOW_LOOPBACK only on a trusted local server.",
    });
  } finally {
    if (original === undefined) delete process.env.PIPELINE_ALLOW_LOOPBACK;
    else process.env.PIPELINE_ALLOW_LOOPBACK = original;
  }
});

test("same-origin JSON POST is mandatory; cross-site localhost actions do not invoke completion", async () => {
  let called = false;
  const adapter: Complete = async () => { called = true; return { text: "bad" }; };
  const headerCases: Record<string, string>[] = [{ Origin: "https://attacker.example" }, { Origin: "null" }, { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }];
  for (const headers of headerCases) {
    assert.equal((await handlePipelineRequest(request(chatBody(), headers), adapter)).status, 403);
  }
  assert.equal((await handlePipelineRequest(request(chatBody(), { "Content-Type": "text/plain" }), adapter)).status, 415);
  assert.equal(called, false);
});

test("same-origin validation uses the original Host when Next canonicalizes the request URL", async () => {
  const headers = { Origin: "http://127.0.0.1:3000", Host: "127.0.0.1:3000", "Sec-Fetch-Site": "same-origin" };
  assert.equal((await handlePipelineRequest(request(chatBody(), headers), complete)).status, 200);
  assert.equal((await handlePipelineRequest(request(chatBody(), { ...headers, Origin: "http://attacker.example:3000" }), complete)).status, 403);
  assert.equal((await handlePipelineRequest(request(chatBody(), { ...headers, Origin: "http://127.0.0.1:3000/path" }), complete)).status, 403);
});

test("chat API passes the full conversation unchanged and returns actual text and usage", async () => {
  const response = await handlePipelineRequest(request(chatBody()), async (selected, history, max, signal) => {
    assert.deepEqual(selected, model);
    assert.deepEqual(history, messages);
    assert.equal(max, 64);
    assert.equal(signal.aborted, false);
    return { text: "blue", usage: { input: 42, output: 1 } };
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await response.json(), { text: "blue", usage: { input: 42, output: 1 } });
});

test("chat completion serialization strips unexpected adapter properties", async () => {
  const response = await handlePipelineRequest(request(chatBody()), async () => ({
    text: "answer", usage: { input: 2, output: 1, internal: "synthetic-key" }, apiKey: "synthetic-key",
  }));
  assert.deepEqual(await response.json(), { text: "answer", usage: { input: 2, output: 1 } });
});

test("model discovery API returns available IDs but never echoes the submitted API key", async () => {
  const response = await handlePipelineRequest(request({ mode: "models", connection: { baseUrl: model.baseUrl, apiKey: "synthetic-discovery-key" } }), complete,
    async (connection, signal) => {
      assert.equal(connection.baseUrl, model.baseUrl);
      assert.equal(connection.apiKey, "synthetic-discovery-key");
      assert.equal(signal.aborted, false);
      return [{ id: "research-model", name: "Research Model" }];
    });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: [{ id: "research-model", name: "Research Model" }] });
});

test("model discovery request rejects malformed connections and cross-origin callers", async () => {
  const crossOrigin = await handlePipelineRequest(request({ mode: "models", connection: { baseUrl: "https://api.example.com/v1" } }, { Origin: "https://attacker.example" }), complete);
  assert.equal(crossOrigin.status, 403);
  const invalid = await handlePipelineRequest(request({ mode: "models", connection: { baseUrl: "http://10.0.0.1/v1", apiKey: "secret" } }), complete);
  assert.equal(invalid.status, 400);
});

test("API rejects invalid JSON, large bodies, unconfigured models and context overflow", async () => {
  const oversized = new Request("http://localhost:3000/api/pipeline", {
    method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: "x".repeat(LIMITS.requestBytes + 1),
  });
  assert.equal((await handlePipelineRequest(oversized, complete)).status, 400);
  const broken = new Request("http://localhost:3000/api/pipeline", {
    method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: "{",
  });
  assert.equal((await handlePipelineRequest(broken, complete)).status, 400);
  assert.equal((await handlePipelineRequest(request(chatBody(), { "Content-Length": String(LIMITS.requestBytes + 1) }), complete)).status, 400);
  assert.equal((await handlePipelineRequest(request({ ...pipelineBody(), models: [] }), complete)).status, 400);
  assert.equal((await handlePipelineRequest(request({ ...chatBody(), model: { ...model, contextWindow: 256 },
    messages: [{ role: "user", content: "x".repeat(1000) }] }), complete)).status, 400);
  const safe = await handlePipelineRequest(request(chatBody()), async () => { throw new Error("synthetic-key/upstream-body"); });
  assert.equal(safe.status, 502);
  assert.deepEqual(await safe.json(), { error: "Model request failed." });
});

test("pipeline API streams valid NDJSON and sanitized failure events", async () => {
  const response = await handlePipelineRequest(request(pipelineBody()), complete);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  const events: PipelineEvent[] = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(last(events), { type: "complete", output: "real result", usage: { input: 11, output: 3 } });
  const failed = await handlePipelineRequest(request(pipelineBody()), async () => { throw new Error("secret upstream body"); });
  const text = await failed.text();
  assert.match(text, /Model request failed/);
  assert.equal(text.includes("secret upstream"), false);
  assert.equal(text.includes('"type":"complete"'), false);
});

test("request cancellation is forwarded for chat and checked after adapter await", async () => {
  const controller = new AbortController();
  const response = await handlePipelineRequest(request(chatBody(), {}, controller.signal), async (_, __, ___, signal) => {
    controller.abort(new Error("secret abort detail"));
    assert.equal(signal.aborted, true);
    return { text: "should not return" };
  });
  assert.equal(response.status, 499);
  assert.deepEqual(await response.json(), { error: "Request cancelled." });
});

test("pipeline request cancellation is forwarded to the active model", async () => {
  const controller = new AbortController();
  const response = await handlePipelineRequest(request(pipelineBody(), {}, controller.signal), async (_, __, ___, signal) => {
    controller.abort();
    assert.equal(signal.aborted, true);
    return { text: "must not emit" };
  });
  const events: PipelineEvent[] = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(last(events).error, "Request cancelled.");
  assert.equal(events.some((event) => event.type === "complete"), false);
});

test("cancelling an NDJSON reader aborts the in-flight completion", async () => {
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  let sawAbort = false;
  const response = await handlePipelineRequest(request(pipelineBody()), async (_, __, ___, signal) => {
    started();
    return new Promise((_, reject) => signal.addEventListener("abort", () => {
      sawAbort = true;
      reject(new Error("synthetic-key"));
    }, { once: true }));
  });
  const reader = response.body!.getReader();
  for (let i = 0; i < 3; i++) await reader.read();
  await inFlight;
  await reader.cancel();
  assert.equal(sawAbort, true);
});

test("actual route is independently importable without Next or Jarvis test shims", async () => {
  assert.equal((await POST(request(chatBody(), { Origin: "https://attacker.example" }))).status, 403);
});

async function providerTests(): Promise<void> {
  const captured: Array<{ url?: string; host?: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (incoming.method === "GET" && incoming.url?.endsWith("/models")) {
      captured.push({ url: incoming.url, host: incoming.headers.host, authorization: incoming.headers.authorization, body: undefined });
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ data: [
        { id: "research-v1", name: "Research V1", context_length: 128_000,
          pricing: { prompt: "0.000002", completion: "0.000006" } },
        { id: "research-v1", name: "Duplicate" },
        { id: "synthesis-v2", context_length: LIMITS.contextTokens + 1, pricing: { prompt: "", completion: "Infinity" } },
        { id: "\u0000bad" },
      ] }));
      return;
    }
    captured.push({ url: incoming.url, host: incoming.headers.host, authorization: incoming.headers.authorization, body });
    if (incoming.url?.startsWith("/redirect")) {
      outgoing.writeHead(307, { Location: "http://169.254.169.254/metadata" });
      outgoing.end("private upstream body synthetic-key");
    } else if (incoming.url?.startsWith("/error")) {
      outgoing.writeHead(401);
      outgoing.end("private upstream body synthetic-key");
    } else if (incoming.url?.startsWith("/bad")) {
      outgoing.end(JSON.stringify({ choices: [{ message: { content: 7 } }] }));
    } else if (incoming.url?.startsWith("/chunked-large")) {
      outgoing.writeHead(200);
      outgoing.write(" ".repeat(LIMITS.providerBytes));
      outgoing.end(" {}");
    } else if (incoming.url?.startsWith("/invalid-json")) {
      outgoing.end("upstream secret body synthetic-key");
    } else if (incoming.url?.startsWith("/invalid-usage")) {
      outgoing.end(JSON.stringify({ choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: "2", completion_tokens: -1 } }));
    } else if (incoming.url?.startsWith("/oversized-text")) {
      outgoing.end(JSON.stringify({ choices: [{ message: { content: "x".repeat(LIMITS.textChars + 1) } }] }));
    } else if (incoming.url?.startsWith("/compressed")) {
      outgoing.setHeader("Content-Encoding", "gzip");
      outgoing.end("{}");
    } else if (incoming.url?.startsWith("/cost")) {
      outgoing.end(JSON.stringify({ choices: [{ message: { content: "priced answer" } }],
        usage: { prompt_tokens: 41, completion_tokens: 6, cost: 0.0042 } }));
    } else if (incoming.url?.startsWith("/large")) {
      outgoing.writeHead(200, { "Content-Length": LIMITS.providerBytes + 1 });
      outgoing.end();
    } else if (incoming.url?.startsWith("/slow")) {
      const timer = setTimeout(() => outgoing.end(JSON.stringify({ choices: [{ message: { content: "too late" } }] })), 300);
      outgoing.on("close", () => clearTimeout(timer));
    } else {
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ choices: [{ message: { content: "actual loopback completion" } }],
        usage: { prompt_tokens: 41, completion_tokens: 6 } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const localModel = (path = "", host = "127.0.0.1"): StudioModel => ({
    ...model, baseUrl: `http://${host}:${port}${path}/v1`, apiKey: "synthetic-key",
  });
  const signal = new AbortController().signal;
  try {
    await runTest("direct OpenAI-compatible adapter sends user model, all context and transient key", async () => {
      const result = await createComplete({ allowLoopback: true })(localModel(), messages, 64, signal);
      assert.deepEqual(result, { text: "actual loopback completion", usage: { input: 41, output: 6 } });
      const record = captured[captured.length - 1];
      assert.equal(record.url, "/v1/chat/completions");
      assert.equal(record.authorization, "Bearer synthetic-key");
      assert.deepEqual(record.body, { model: model.model, messages, max_tokens: 64, stream: false });
      assert.equal(JSON.stringify(record.body).includes("synthetic-key"), false);
      const keyless = localModel();
      delete keyless.apiKey;
      await createComplete({ allowLoopback: true })(keyless, messages, 64, signal);
      assert.equal(captured[captured.length - 1].authorization, undefined);
    });
    await runTest("OpenAI-compatible usage preserves actual API-reported USD cost", async () => {
      const result = await createComplete({ allowLoopback: true })(localModel("/cost"), messages, 64, signal);
      assert.deepEqual(result, { text: "priced answer", usage: { input: 41, output: 6, cost: 0.0042 } });
    });
    await runTest("provider serializes only the selected output-token field", async () => {
      for (const outputTokenField of ["max_tokens", "max_completion_tokens"] as const) {
        await createComplete({ allowLoopback: true })({ ...localModel(), outputTokenField }, messages, 64, signal);
        assert.deepEqual(captured[captured.length - 1].body, {
          model: model.model, messages, [outputTokenField]: 64, stream: false,
        });
      }
    });
    await runTest("OpenAI-compatible provider sends reasoning effort only when specified", async () => {
      const adapter = createComplete({ allowLoopback: true });
      for (const effort of ["low", "medium", "high", "xhigh", "max", undefined] as const) {
        await adapter(localModel(), messages, 64, signal, effort);
        assert.deepEqual(captured[captured.length - 1].body, {
          model: model.model, messages, max_tokens: 64, stream: false,
          ...(effort === undefined ? {} : { reasoning_effort: effort }),
        });
      }
      const count = captured.length;
      await assert.rejects(adapter(localModel(), messages, 64, signal, "default" as never), PipelineError);
      assert.equal(captured.length, count);
    });
    await runTest("OpenRouter uses nested reasoning effort without converting levels", () => {
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
        assert.deepEqual(reasoningPayload("openrouter.ai", effort), { reasoning: { effort } });
        assert.deepEqual(reasoningPayload("api.openai.com", effort), { reasoning_effort: effort });
      }
      assert.deepEqual(reasoningPayload("openrouter.ai"), {});
    });
    await runTest("validated DNS is pinned once while original Host is preserved", async () => {
      let lookups = 0;
      const adapter = createComplete({ allowLoopback: true, resolve: async () => {
        lookups++;
        return [{ address: lookups === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
      } });
      await adapter(localModel("", "localhost"), messages, 64, signal);
      assert.equal(lookups, 1);
      assert.equal(captured[captured.length - 1].host, `localhost:${port}`);
    });
    await runTest("DNS-resolved private endpoints are rejected before sending keys", async () => {
      const count = captured.length;
      await assert.rejects(createComplete({ allowLoopback: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] })(model, messages, 64, signal), /blocked or unsafe/);
      assert.equal(captured.length, count);
    });
    await runTest("provider redirects and upstream failures are sanitized, not followed", async () => {
      for (const path of ["/redirect", "/error"]) {
        await assert.rejects(createComplete({ allowLoopback: true })(localModel(path), messages, 64, signal), { message: /^Model request failed \(HTTP \d{3}\)\.$/ });
      }
    });
    await runTest("invalid and oversized upstream completion responses are classified without exposing their bodies", async () => {
      for (const [path, reason] of [
        ["/bad", "missing-text"], ["/large", "oversized-response"], ["/chunked-large", "oversized-response"],
        ["/invalid-json", "invalid-json"], ["/oversized-text", "oversized-text"], ["/compressed", "unsupported-encoding"],
      ]) {
        await assert.rejects(createComplete({ allowLoopback: true })(localModel(path), messages, 64, signal), {
          message: `Model endpoint returned an invalid or oversized completion (${reason}).`,
        });
      }
    });
    await runTest("malformed optional usage metadata does not discard a valid completion", async () => {
      assert.deepEqual(await createComplete({ allowLoopback: true })(localModel("/invalid-usage"), messages, 64, signal), { text: "answer" });
    });
    await runTest("provider timeout bounds both HTTP and unresolved DNS", async () => {
      await assert.rejects(createComplete({ allowLoopback: true, timeoutMs: 15 })(localModel("/slow"), messages, 64, signal), { message: "Model request timed out." });
      await assert.rejects(createComplete({ timeoutMs: 15, resolve: () => new Promise(() => {}) })(model, messages, 64, signal), { message: "Model request timed out." });
    });
    await runTest("provider cancellation aborts in-flight HTTP without exposing abort reasons", async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("private reason")), 15);
      try {
        await assert.rejects(createComplete({ allowLoopback: true })(localModel("/slow"), messages, 64, controller.signal), { message: "Request cancelled." });
      } finally { clearTimeout(timer); }
    });
    await runTest("complete endpoint paths do not get chat/completions appended twice", async () => {
      const selected = localModel();
      selected.baseUrl += "/chat/completions";
      await createComplete({ allowLoopback: true })(selected, messages, 64, signal);
      assert.equal(captured[captured.length - 1].url, "/v1/chat/completions");
    });
    await runTest("model discovery uses pinned OpenAI-compatible /models and sanitizes model IDs", async () => {
      const selected = localModel();
      const discovered = await discoverOpenAIModels({ baseUrl: selected.baseUrl, apiKey: selected.apiKey }, signal, { allowLoopback: true });
      assert.deepEqual(discovered, [
        { id: "research-v1", name: "Research V1", contextWindow: 128_000 },
        { id: "synthesis-v2", name: "synthesis-v2" },
      ]);
      assert.equal(captured[captured.length - 1].url, "/v1/models");
      assert.equal(captured[captured.length - 1].authorization, "Bearer synthetic-key");
    });
    await runTest("model discovery is loopback-disabled unless the trusted server opts in", async () => {
      const count = captured.length;
      await assert.rejects(discoverOpenAIModels({ baseUrl: localModel().baseUrl, apiKey: "synthetic-key" }, signal, { allowLoopback: false }), { message: "Loopback endpoints are disabled. Enable PIPELINE_ALLOW_LOOPBACK only on a trusted local server." });
      assert.equal(captured.length, count);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function customHttpTests(): Promise<void> {
  const captured: Array<{
    method?: string; url?: string; host?: string; authorization?: string; customKey?: string; notionVersion?: string; body: unknown;
  }> = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    captured.push({
      method: incoming.method, url: incoming.url, host: incoming.headers.host,
      authorization: incoming.headers.authorization, customKey: incoming.headers["x-api-key"] as string | undefined,
      notionVersion: incoming.headers["notion-version"] as string | undefined, body,
    });
    if (incoming.url?.startsWith("/redirect")) {
      outgoing.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      outgoing.end("synthetic-custom-secret");
    } else if (incoming.url?.startsWith("/error")) {
      outgoing.writeHead(500);
      outgoing.end("upstream body synthetic-custom-secret");
    } else if (incoming.url?.startsWith("/large")) {
      outgoing.writeHead(200, { "Content-Length": LIMITS.providerBytes + 1 });
      outgoing.end();
    } else if (incoming.url?.startsWith("/chunked-large")) {
      outgoing.writeHead(200);
      outgoing.write("x".repeat(LIMITS.providerBytes));
      outgoing.end("x");
    } else if (incoming.url?.startsWith("/slow")) {
      const timer = setTimeout(() => outgoing.end(JSON.stringify({ text: "too late" })), 300);
      outgoing.on("close", () => clearTimeout(timer));
    } else if (incoming.url?.startsWith("/extract")) {
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ data: { result: { text: "slide-created" } } }));
    } else {
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify({ text: "fixture text" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = (path: string, host = "127.0.0.1") => `http://${host}:${port}${path}`;
  const signal = new AbortController().signal;
  const input = (definition: CustomBlockDefinition, signalArg = signal) => ({
    definition, input: "seed", value: "current", variables: new Map([["saved", "remembered"]]), signal: signalArg,
  });
  const execute = createCustomHttp({ allowLoopback: true });
  try {
    await runTest("custom HTTP templates JSON, pins the endpoint and extracts a safe response path", async () => {
      const secret = "synthetic-custom-secret";
      const definition: CustomBlockDefinition = {
        id: "external-create", name: "Create slide", apiKey: secret,
        action: {
          kind: "http", method: "POST", url: url("/extract?api-version=1"),
          bodyTemplate: '{"title":"{{value}}","source":"{{input}}","saved":"{{saved}}"}',
          responsePath: "data.result.text", authHeader: "X-API-Key", authPrefix: "Token ",
        },
      };
      const result = await execute(input(definition));
      assert.equal(result, "slide-created");
      const record = captured[captured.length - 1];
      assert.equal(record.method, "POST");
      assert.equal(record.url, "/extract?api-version=1");
      assert.equal(record.customKey, `Token ${secret}`);
      assert.equal(record.authorization, undefined);
      assert.deepEqual(record.body, { title: "current", source: "seed", saved: "remembered" });
      assert.equal(result.includes(secret), false);
    });

    await runTest("custom HTTP defaults to a text field and uses only its configured credential header", async () => {
      const definition = customBlock("text-api", {
        kind: "http", method: "GET", url: url("/text"), responsePath: "text",
      });
      assert.equal(await execute(input(definition)), "fixture text");
      const record = captured[captured.length - 1];
      assert.equal(record.authorization, undefined);
      assert.equal(record.customKey, undefined);
    });

    await runTest("custom HTTP sends configured static headers beside the credential header", async () => {
      const secret = "synthetic-custom-secret";
      const definition: CustomBlockDefinition = {
        id: "notion-page", name: "Create Notion page", apiKey: secret,
        action: {
          kind: "http", method: "POST", url: url("/notion"),
          bodyTemplate: '{"text":"{{value}}"}', headers: { "Notion-Version": "2026-03-11" },
        },
      };
      await execute(input(definition));
      const record = captured[captured.length - 1];
      assert.equal(record.notionVersion, "2026-03-11");
      assert.equal(record.authorization, `Bearer ${secret}`);
      assert.equal(record.host, `127.0.0.1:${port}`);
      assert.deepEqual(record.body, { text: "current" });
    });

    await runTest("static headers reject reserved names, duplicates, controls and credential collisions", () => {
      const base = { kind: "http" as const, method: "GET" as const, url: "https://api.notion.com/v1/pages" };
      const block = (action: CustomBlockDefinition["action"], apiKey?: string): CustomBlockDefinition =>
        ({ id: "headers", name: "Headers", action, ...(apiKey ? { apiKey } : {}) });
      const reserved: Array<Record<string, string>> = [
        { Host: "example.com" },
        { "Content-Type": "text/plain" },
        { Authorization: "Bearer hardcoded" },
        { "Notion-Version": "2026-03-11", "notion-version": "2026-03-11" },
        { "Notion-Version": "2026-03-11\r\nX-Injected: 1" },
        { "Bad Name": "value" },
      ];
      for (const headers of reserved) assert.throws(() => validateCustomBlocks([block({ ...base, headers })]), PipelineError);
      assert.throws(() => validateCustomBlocks([block({ ...base, authHeader: "X-Api-Key", headers: { "X-Api-Key": "static" } }, "synthetic-key")]), PipelineError);
      assert.throws(() => validateCustomBlocks([block({ kind: "template", template: "x", headers: { A: "b" } } as unknown as CustomBlockDefinition["action"])]), PipelineError);
      validateCustomBlocks([block({ ...base, headers: { "Notion-Version": "2026-03-11" } })]);
      validateCustomBlocks([block({ ...base, authHeader: "X-Api-Key", headers: { "Notion-Version": "2026-03-11" } }, "synthetic-key")]);
      // Empty optional fields must be omitted, not sent as empty strings.
      assert.throws(() => validateCustomBlocks([block({ ...base, responsePath: "" })]), PipelineError);
    });

    await runTest("custom API failures and upstream secrets are sanitized", async () => {
      const definition: CustomBlockDefinition = {
        ...customBlock("private-error", { kind: "http", method: "GET", url: url("/error") }),
        apiKey: "synthetic-custom-secret",
      };
      let error: unknown;
      try { await execute(input(definition)); } catch (caught) { error = caught; }
      assert.equal((error as Error).message, "Custom API request failed.");
      assert.equal((error as Error).message.includes("synthetic-custom-secret"), false);
    });

    await runTest("custom API rejects redirects, declared oversize and streamed oversize responses", async () => {
      for (const path of ["/redirect", "/large", "/chunked-large"]) {
        const definition = customBlock(`reject-${path}`, { kind: "http", method: "GET", url: url(path) });
        let error: unknown;
        try { await execute(input(definition)); } catch (caught) { error = caught; }
        assert.ok(error instanceof PipelineError);
        assert.match((error as Error).message, path === "/redirect" ? /Custom API request failed/ : /invalid or oversized response/);
        assert.equal((error as Error).message.includes("synthetic-custom-secret"), false);
      }
      assert.equal(captured.filter((record) => record.url?.startsWith("/redirect")).length, 1);
    });

    await runTest("custom API blocks private DNS results and performs only one pinned DNS lookup", async () => {
      const secretDefinition: CustomBlockDefinition = {
        ...customBlock("unsafe-dns", { kind: "http", method: "GET", url: "https://api.example.com/v1" }),
        apiKey: "synthetic-custom-secret",
      };
      const sentBefore = captured.length;
      await assert.rejects(createCustomHttp({ resolve: async () => [{ address: "10.0.0.1", family: 4 }] })(input(secretDefinition)),
        { message: "Endpoint resolves to a blocked or unsafe address." });
      assert.equal(captured.length, sentBefore);

      let lookups = 0;
      const local = customBlock("pinned-local", { kind: "http", method: "GET", url: url("/text", "localhost") });
      const result = await createCustomHttp({ allowLoopback: true, resolve: async () => {
        lookups++;
        return [{ address: lookups === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
      } })(input(local));
      assert.equal(result, "fixture text");
      assert.equal(lookups, 1);
      assert.equal(captured[captured.length - 1].host, `localhost:${port}`);
    });

    await runTest("custom API loopback opt-in, timeout and cancellation are enforced", async () => {
      let lookedUp = false;
      const loopback = customBlock("slow-loopback", { kind: "http", method: "GET", url: url("/slow", "localhost") });
      await assert.rejects(createCustomHttp({ resolve: async () => { lookedUp = true; return []; } })(input(loopback)),
        { message: "Loopback endpoints are disabled. Enable PIPELINE_ALLOW_LOOPBACK only on a trusted local server." });
      assert.equal(lookedUp, false);
      const slow = customBlock("slow", { kind: "http", method: "GET", url: url("/slow") });
      await assert.rejects(createCustomHttp({ allowLoopback: true, timeoutMs: 15 })(input(slow)), { message: "Custom API request timed out." });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("private abort reason")), 15);
      try {
        await assert.rejects(execute(input(slow, controller.signal)), { message: "Request cancelled." });
      } finally { clearTimeout(timer); }
    });

    await runTest("pipeline API passes custom definitions into the default secure HTTP adapter", async () => {
      const secret = "transient-route-secret";
      const definition: CustomBlockDefinition = {
        ...customBlock("route-http", { kind: "http", method: "GET", url: url("/text"), responsePath: "text" }),
        apiKey: secret,
      };
      const previous = process.env.PIPELINE_ALLOW_LOOPBACK;
      process.env.PIPELINE_ALLOW_LOOPBACK = "true";
      try {
        const response = await POST(request({
          ...pipelineBody(customGraph(definition.id)), models: [], customBlocks: [definition],
        }));
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.match(body, /fixture text/);
        assert.equal(body.includes(secret), false);
      } finally {
        if (previous === undefined) delete process.env.PIPELINE_ALLOW_LOOPBACK;
        else process.env.PIPELINE_ALLOW_LOOPBACK = previous;
      }
      assert.equal(captured[captured.length - 1].authorization, `Bearer ${secret}`);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("output exports build valid PDF and DOCX files from the final text", async () => {
  const sample = "# Title\n\n- one\n- two\n\n1. step\n\n```ts\nconst x = 1;\n```\n\nUnicode: 中文";
  const pdf = Buffer.from(await (await createPdfBlob(sample)).arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.includes(Buffer.from("%%EOF")));
  const docx = Buffer.from(await (await createDocxBlob(sample)).arrayBuffer());
  assert.equal(docx.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(docx.includes(Buffer.from("word/document.xml")));
});

test("PDF export flags characters outside the built-in font encoding", () => {
  assert.equal(pdfReplacesCharacters("Plain ASCII, café, “quoted” — dash."), false);
  assert.equal(pdfReplacesCharacters("中文"), true);
});

let passed = 0;
async function runTest(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

async function main(): Promise<void> {
  for (const { name, run } of tests) await runTest(name, run);
  await providerTests();
  await customHttpTests();
  console.log(`Pipeline selftest: ${passed} passed (offline, loopback fixture only).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : "Pipeline selftest failed.");
  process.exitCode = 1;
});
