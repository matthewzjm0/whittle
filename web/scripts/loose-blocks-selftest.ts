import assert from "node:assert/strict";
import { findLooseBlocks, looseBlocksWarning } from "../components/pipeline/loose-blocks";
import type { PipelineGraph } from "../lib/pipeline/types";

export function registerLooseBlockTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("loose-block detection follows all branch edges and reports disconnected chains", () => {
    const graph: PipelineGraph = {
      nodes: [
        { id: "start", type: "start", x: 0, y: 0, label: "Start" },
        { id: "condition", type: "condition", x: 1, y: 0, label: "Gate" },
        { id: "pass", type: "model", x: 2, y: 0, label: "Pass model" },
        { id: "fail", type: "output", x: 3, y: 0, label: "Fail output" },
        { id: "loose", type: "variable", x: 4, y: 0, label: "Draft variable" },
        { id: "loose-child", type: "output", x: 5, y: 0, label: "Draft output" },
      ],
      edges: [
        { id: "a", from: "start", to: "condition", port: "out" },
        { id: "b", from: "condition", to: "pass", port: "pass" },
        { id: "c", from: "condition", to: "fail", port: "fail" },
        { id: "d", from: "loose", to: "loose-child", port: "out" },
      ],
    };
    assert.deepEqual(findLooseBlocks(graph).map((node) => node.id), ["loose", "loose-child"]);
    assert.deepEqual(findLooseBlocks({ ...graph, nodes: graph.nodes.slice(0, 4), edges: graph.edges.slice(0, 3) }), []);
    assert.match(looseBlocksWarning(findLooseBlocks(graph)), /Draft variable[\s\S]*Draft output[\s\S]*Remove them or connect them to Start/);
  });

  test("loose-block warning lists a bounded sample without deleting nodes", () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({ id: String(index), type: "variable" as const, x: 0, y: 0, label: `Loose ${index}` }));
    const before = structuredClone(nodes);
    const warning = looseBlocksWarning(nodes);
    assert.match(warning, /8 more/);
    assert.equal(warning.includes("Loose 19"), false);
    assert.deepEqual(nodes, before);
  });
}
