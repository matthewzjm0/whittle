import assert from "node:assert/strict";
import {
  applyResponseModeToCustomBlocks, applyResponseModeToGraph, applyResponseModeToMessages,
  resolveOutputTokens, responseModeInstruction,
} from "../components/pipeline/response-settings";
import type { PipelineGraph } from "../lib/pipeline/types";

export function registerResponseSettingsTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("Auto output reservations follow response detail and clamp to estimated free context", () => {
    assert.equal(resolveOutputTokens("auto", 2048, "minimal", 100), 512);
    assert.equal(resolveOutputTokens("auto", 2048, "detailed", 100), 4096);
    assert.equal(resolveOutputTokens("auto", 2048, "detailed", 7800, 8192), 392);
    assert.equal(resolveOutputTokens("auto", 2048, "minimal", 8192, 8192), 1);
    assert.equal(resolveOutputTokens("manual", 777, "detailed", 100, 8192), 777);
  });

  test("Minimal and Detailed modes add distinct model instructions without mutating user prompts", () => {
    const messages = [{ role: "system" as const, content: "Existing instruction" }, { role: "user" as const, content: "Question" }];
    const minimal = applyResponseModeToMessages(messages, "minimal");
    const detailed = applyResponseModeToMessages(messages, "detailed");
    assert.match(minimal[0].content, /Response detail: Minimal/);
    assert.match(detailed[0].content, /Response detail: Detailed/);
    assert.equal(messages[0].content, "Existing instruction");
    assert.equal(minimal[1].content, "Question");
    assert.notEqual(responseModeInstruction("minimal"), responseModeInstruction("detailed"));
    assert.match(applyResponseModeToMessages([{ role: "user", content: "Question" }], "minimal")[0].content, /Response detail: Minimal/);
  });

  test("Response mode applies to model, delegated and custom-model prompts only", () => {
    const graph: PipelineGraph = { nodes: [
      { id: "model", type: "model", x: 0, y: 0, label: "Model", prompt: "Original" },
      { id: "team", type: "delegated", x: 0, y: 0, label: "Saved team", prompt: "Team instruction" },
      { id: "output", type: "output", x: 0, y: 0, label: "Output" },
    ], edges: [] };
    const updated = applyResponseModeToGraph(graph, "detailed");
    assert.match(updated.nodes[0].prompt!, /Response detail: Detailed/);
    assert.match(updated.nodes[1].prompt!, /Response detail: Detailed/);
    assert.equal(updated.nodes[2].prompt, undefined);
    assert.equal(graph.nodes[0].prompt, "Original");
    const blocks = [
      { id: "model", name: "M", action: { kind: "model" as const, modelId: "m", prompt: "Original" }, apiKey: "private-key" },
      { id: "text", name: "T", action: { kind: "template" as const, template: "{{value}}" } },
    ];
    const updatedBlocks = applyResponseModeToCustomBlocks(blocks, "minimal");
    assert.match(updatedBlocks[0].action.kind === "model" ? updatedBlocks[0].action.prompt : "", /Response detail: Minimal/);
    assert.deepEqual(updatedBlocks[1], blocks[1]);
    assert.equal(blocks[0].action.kind === "model" ? blocks[0].action.prompt : "", "Original");
    assert.equal(updatedBlocks[0].apiKey, "private-key");
  });
}
