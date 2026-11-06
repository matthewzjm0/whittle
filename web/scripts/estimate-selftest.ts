import assert from "node:assert/strict";
import { estimateRunCost, estimateTokens, formatEstimate } from "../lib/pipeline";
import type { PipelineGraph, StudioModel } from "../lib/pipeline";

const model = (id: string, input?: number, output?: number): StudioModel => ({
  id, name: id, model: id, baseUrl: "https://models.test", contextWindow: 4096,
  ...(input === undefined ? {} : { inputCostPerMillion: input }),
  ...(output === undefined ? {} : { outputCostPerMillion: output }),
});

export function registerEstimateTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("run estimate prices only reachable model calls and reserves the output ceiling", () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: "start", type: "start", x: 0, y: 0, label: "Start" },
        { id: "step", type: "model", x: 1, y: 0, label: "Step", modelId: "priced", prompt: "Summarize" },
        { id: "orphan", type: "model", x: 2, y: 0, label: "Orphan", modelId: "priced", prompt: "Never runs" },
        { id: "output", type: "output", x: 3, y: 0, label: "Output" },
      ],
      edges: [
        { id: "a", from: "start", to: "step", port: "out" },
        { id: "b", from: "step", to: "output", port: "out" },
      ],
    };
    const estimate = estimateRunCost(graph, [], [model("priced", 1, 2)], "hello", 100);
    const expectedInput = estimateTokens([{ role: "system", content: "Summarize" }, { role: "user", content: "hello" }]);
    assert.equal(estimate.calls, 1);
    assert.equal(estimate.workerCalls, 0);
    assert.equal(estimate.inputTokens, expectedInput);
    assert.equal(estimate.outputTokens, 100);
    assert.equal(estimate.totalTokens, expectedInput + 100);
    assert.ok(Math.abs(estimate.usd! - (expectedInput / 1_000_000 + 100 / 1_000_000 * 2)) < 1e-12);
    assert.deepEqual(estimate.unpriced, []);
  });

  test("run estimate counts every branch edge and reports unpriced models", () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: "start", type: "start", x: 0, y: 0, label: "Start" },
        { id: "gate", type: "condition", x: 1, y: 0, label: "Gate", condition: "contains", value: "x" },
        { id: "pass", type: "model", x: 2, y: 0, label: "Pass", modelId: "free", prompt: "A" },
        { id: "fail", type: "model", x: 3, y: 0, label: "Fail", modelId: "free", prompt: "B" },
      ],
      edges: [
        { id: "a", from: "start", to: "gate", port: "out" },
        { id: "b", from: "gate", to: "pass", port: "pass" },
        { id: "c", from: "gate", to: "fail", port: "fail" },
      ],
    };
    const estimate = estimateRunCost(graph, [], [model("free")], "input", 64);
    assert.equal(estimate.calls, 2);
    assert.equal(estimate.usd, undefined);
    assert.deepEqual(estimate.unpriced, ["free"]);
    assert.equal(formatEstimate(estimate), "No token cost set");
  });

  test("delegated estimate bounds planner, workers, synthesis and validator calls", () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: "start", type: "start", x: 0, y: 0, label: "Start" },
        { id: "team", type: "delegated", x: 1, y: 0, label: "Team", modelId: "leader", workerModelIds: ["w1", "w2"], maxWorkers: 2, prompt: "Coordinate" },
      ],
      edges: [{ id: "a", from: "start", to: "team", port: "out" }],
    };
    const models = [model("leader", 1, 1), model("w1", 1, 1), model("w2", 1, 1)];
    const estimate = estimateRunCost(graph, [], models, "task", 100);
    assert.equal(estimate.delegatedBlocks, 1);
    assert.equal(estimate.workerCalls, 2);
    assert.equal(estimate.calls, 5);
    assert.equal(estimate.outputTokens, 500);
    assert.ok(Math.abs(estimate.usd! - (estimate.inputTokens + 500) / 1_000_000) < 1e-12);
    assert.deepEqual(estimate.unpriced, []);

    const capped = estimateRunCost(graph, [], models, "task", 32_768);
    assert.equal(capped.outputTokens, 2048 + 2 * 4096 + 8192 + 8192);
  });

  test("run estimate formatter marks partial and empty estimates", () => {
    const base = { calls: 1, delegatedBlocks: 0, workerCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unpriced: [] };
    assert.equal(formatEstimate({ ...base, usd: 0.1234 }), "~$0.12");
    assert.equal(formatEstimate({ ...base, usd: 0.0042 }), "~$0.0042");
    assert.equal(formatEstimate({ ...base, usd: 0.5, unpriced: ["x"] }), "~$0.50 + 1 unpriced model");
    assert.equal(formatEstimate({ ...base, calls: 0, usd: undefined }), "No model calls");
  });
}
