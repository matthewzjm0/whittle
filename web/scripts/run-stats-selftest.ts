import assert from "node:assert/strict";
import { blockTimings, createRunStats, finishRunStats, formatCost, recordRunEvent, slowestBlockId, summarizeRun } from "../components/pipeline/run-stats";
import type { CustomBlockDefinition, PipelineNode } from "../lib/pipeline/types";
import { runStatsCsv } from "../components/pipeline/run-stats-csv";
import { assessRunGoals } from "../components/pipeline/run-goals";

export function registerRunStatsTests(test: (name: string, run: () => void) => void) {
  test("block timings accumulate repeated executions and highlight only a finished run", () => {
    let run = createRunStats("pipeline", "Test", [], 0);
    run = recordRunEvent(run, { type: "node-start", nodeId: "a" }, 10);
    run = recordRunEvent(run, { type: "node-complete", nodeId: "a", branchId: "1.1" }, 30);
    run = recordRunEvent(run, { type: "node-start", nodeId: "b" }, 30);
    run = recordRunEvent(run, { type: "node-complete", nodeId: "b" }, 60);
    run = recordRunEvent(run, { type: "node-start", nodeId: "a" }, 60);
    run = recordRunEvent(run, { type: "node-complete", nodeId: "a", branchId: "1.2" }, 80);
    assert.equal(slowestBlockId(run), undefined);
    run = recordRunEvent(run, { type: "complete" }, 90);
    assert.equal(blockTimings(run).get("a"), 40);
    assert.equal(slowestBlockId(run), "a");
    assert.equal(run.endedAt, 90);
  });

  test("stop closes unfinished timings once and ignores buffered completion events", () => {
    let run = recordRunEvent(createRunStats("pipeline", "Test", [], 0), { type: "node-start", nodeId: "a" }, 10);
    run = finishRunStats(run, "stopped", 40);
    assert.strictEqual(finishRunStats(run, "failed", 90), run);
    assert.strictEqual(recordRunEvent(run, { type: "node-complete", nodeId: "a" }, 100), run);
    assert.equal(blockTimings(run).get("a"), 30);
    assert.equal(run.executions[0].status, "stopped");
  });

  test("an error after node-complete does not re-time the completed execution", () => {
    let run = recordRunEvent(createRunStats("pipeline", "Test", [], 0), { type: "node-start", nodeId: "a" }, 5);
    run = recordRunEvent(run, { type: "node-complete", nodeId: "a" }, 15);
    run = recordRunEvent(run, { type: "error", nodeId: "a" }, 30);
    assert.equal(run.status, "failed");
    assert.equal(run.executions[0].status, "complete");
    assert.equal(blockTimings(run).get("a"), 10);
  });

  const node: PipelineNode = { id: "model", label: "Model", type: "model", x: 0, y: 0, prompt: "private instructions" };
  test("run summary uses reported costs once and counts repeated ordinary model calls", () => {
    let run = createRunStats("pipeline", "Test", [node], 0);
    for (const time of [10, 30]) {
      run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, time);
      run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, usage: { input: 10, output: 5, cost: 0.01 } }, time + 10);
    }
    run = recordRunEvent(run, { type: "complete", usage: { input: 20, output: 10, cost: 0.02 } }, 50);
    const summary = summarizeRun(run);
    assert.equal(summary.durationMs, 50);
    assert.equal(summary.cost, 0.02);
    assert.equal(summary.modelCalls, 2);
    assert.equal(summary.blocks[0].input, 20);
    assert.equal(summary.blocks[0].cost, 0.02);
    assert.equal(JSON.stringify(run).includes("private instructions"), false);
  });

  test("unreported cost is Unknown while reported zero remains zero", () => {
    let run = recordRunEvent(createRunStats("pipeline", "Test", [node], 0), { type: "node-start", nodeId: node.id }, 0);
    run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, output: "private output", usage: { input: 0, output: 0, cost: 0 } }, 1);
    run = recordRunEvent(run, { type: "complete", usage: { input: 0, output: 0, cost: 0 } }, 2);
    assert.equal(formatCost(summarizeRun(run).cost), "$0.000000");
    assert.equal(formatCost(summarizeRun({ ...run, usage: undefined }).cost), "Unknown");
    assert.equal(JSON.stringify(run).includes("private output"), false);
  });

  test("delegated call counts stay unknown rather than using the worker cap or output text", () => {
    let run = createRunStats("pipeline", "Test", [{ ...node, type: "delegated", maxWorkers: 8 }], 0);
    run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, 0);
    run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, output: "3 workers", usage: { input: 100, output: 20 } }, 10);
    run = recordRunEvent(run, { type: "complete", usage: { input: 100, output: 20 } }, 11);
    assert.equal(summarizeRun(run).modelCalls, undefined);
    assert.equal(summarizeRun(run).cost, undefined);
  });

  test("partial run totals and missing per-block usage stay unknown", () => {
    let run = createRunStats("pipeline", "Test", [node], 0);
    run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, 0);
    run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, usage: { input: 1, output: 2, cost: 0.1 } }, 10);
    run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, 11);
    run = finishRunStats(run, "failed", 20);
    assert.equal(summarizeRun(run).modelCalls, undefined);
    assert.equal(summarizeRun(run).blocks[0].cost, undefined);
    assert.equal(summarizeRun(run).blocks[0].input, undefined);
  });

  test("custom model calls are classified without retaining their credentials", () => {
    const custom: CustomBlockDefinition = { id: "custom", name: "Test", apiKey: "synthetic-private-key", action: { kind: "model", modelId: "model", prompt: "private prompt" } };
    let run = createRunStats("pipeline", "Test", [{ ...node, type: "custom", customBlockId: custom.id }], 0, [custom]);
    run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, 0);
    run = recordRunEvent(run, { type: "node-complete", nodeId: node.id }, 1);
    run = recordRunEvent(run, { type: "complete" }, 2);
    assert.equal(summarizeRun(run).modelCalls, 1);
    assert.equal(JSON.stringify(run).includes("synthetic-private-key"), false);
    assert.equal(JSON.stringify(run).includes("private prompt"), false);
  });

  test("stats CSV contains only fixed headers and numeric cells, never user text", () => {
    const privateNode = { ...node, id: "private-id", label: "=HYPERLINK(\"private-endpoint\")" };
    let run = createRunStats("private-pipeline-id", "private-title", [privateNode], 0);
    run = recordRunEvent(run, { type: "node-start", nodeId: privateNode.id }, 1);
    run = recordRunEvent(run, { type: "node-complete", nodeId: privateNode.id, output: "private-output", usage: { input: 10, output: 4, cost: 0 } }, 11);
    run = recordRunEvent(run, { type: "complete" }, 12);
    const csv = runStatsCsv(run);
    assert.equal(csv.includes("private"), false);
    assert.equal(csv.includes("HYPERLINK"), false);
    assert.equal(csv.split("\r\n")[1], "1,1,10,0,10,4,1");
  });

  test("stats CSV leaves unknown and non-finite measurements blank", () => {
    let run = createRunStats("pipeline", "Test", [node], 0);
    run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, 1);
    run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, usage: { input: Infinity, output: -1, cost: NaN } }, 2);
    run = recordRunEvent(run, { type: "complete" }, 3);
    assert.equal(runStatsCsv(run).split("\r\n")[1], "1,1,1,,,,1");
    const partial = finishRunStats(recordRunEvent(createRunStats("pipeline", "Test", [node], 0), { type: "node-start", nodeId: node.id }, 0), "stopped", 2);
    assert.equal(runStatsCsv(partial).split("\r\n")[1], "1,1,2,,,,");
  });

  test("overflowing reported block totals are Unknown in the table and blank in CSV", () => {
    let run = createRunStats("pipeline", "Test", [node], 0);
    for (const time of [0, 2]) {
      run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, time);
      run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, usage: { input: 1, output: 1, cost: 1e308 } }, time + 1);
    }
    run = recordRunEvent(run, { type: "complete" }, 4);
    assert.equal(formatCost(summarizeRun(run).blocks[0].cost), "Unknown");
    assert.equal(runStatsCsv(run).split("\r\n")[1], "1,2,2,,2,2,2");
  });

  test("errors before a node or during an unfinished node produce stable partial timings", () => {
    const initial = createRunStats("pipeline", "Test", [node], 0);
    const beforeStart = recordRunEvent(initial, { type: "error" }, 3);
    assert.equal(beforeStart.status, "failed");
    assert.equal(beforeStart.executions.length, 0);
    assert.equal(summarizeRun(beforeStart).durationMs, 3);
    let active = recordRunEvent(initial, { type: "node-start", nodeId: node.id }, 10);
    active = recordRunEvent(active, { type: "error", nodeId: node.id }, 40);
    assert.equal(blockTimings(active).get(node.id), 30);
    assert.equal(active.executions[0].status, "failed");
    assert.strictEqual(finishRunStats(active, "failed", 90), active);
  });

  test("challenge scores count satisfied budget goals without changing run measurements", () => {
    let run = createRunStats("pipeline", "Test", [node], 0);
    run = recordRunEvent(run, { type: "node-start", nodeId: node.id }, 0);
    run = recordRunEvent(run, { type: "node-complete", nodeId: node.id, usage: { input: 1, output: 1, cost: 0.03 } }, 1);
    run = recordRunEvent(run, { type: "complete", usage: { input: 1, output: 1, cost: 0.03 } }, 2);
    assert.equal(assessRunGoals(run), undefined);
    const passed = assessRunGoals({ ...run, goals: { maxCost: "0.05", maxModelCalls: "1" } });
    assert.equal(passed?.status, "Pass");
    assert.equal(passed?.score, 100);
    const failed = assessRunGoals({ ...run, goals: { maxCost: "0.01", maxModelCalls: "1" } });
    assert.equal(failed?.status, "Fail");
    assert.equal(failed?.score, 50);
    assert.equal(run.usage?.cost, 0.03);
  });

  test("unknown costs or delegated call counts cannot pass a challenge", () => {
    const run = recordRunEvent(createRunStats("pipeline", "Test", [], 0), { type: "complete" }, 1);
    const result = assessRunGoals({ ...run, goals: { maxCost: "10", maxModelCalls: "" } });
    assert.equal(result?.status, "Unknown");
    assert.equal(result?.score, undefined);
    let delegated = createRunStats("pipeline", "Test", [{ ...node, type: "delegated" }], 0);
    delegated = recordRunEvent(delegated, { type: "node-start", nodeId: node.id }, 0);
    delegated = recordRunEvent(delegated, { type: "node-complete", nodeId: node.id }, 1);
    delegated = recordRunEvent(delegated, { type: "complete" }, 2);
    assert.equal(assessRunGoals({ ...delegated, goals: { maxCost: "", maxModelCalls: "10" } })?.status, "Unknown");
  });

  test("partial or invalid challenges are not awarded a passing score", () => {
    const run = finishRunStats(createRunStats("pipeline", "Test", [], 0), "stopped", 1);
    assert.equal(assessRunGoals({ ...run, goals: { maxCost: "", maxModelCalls: "5" } })?.status, "Not evaluated");
    const completed = recordRunEvent(createRunStats("pipeline", "Test", [], 0), { type: "complete" }, 1);
    assert.equal(assessRunGoals({ ...completed, goals: { maxCost: "", maxModelCalls: "1.5" } })?.score, undefined);
    assert.equal(assessRunGoals({ ...completed, goals: { maxCost: "", maxModelCalls: "0" } })?.score, 100);
  });
}
