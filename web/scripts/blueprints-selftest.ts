import assert from "node:assert/strict";
import { BLUEPRINTS, instantiateBlueprint } from "../components/pipeline/blueprints";
import { simulateBlueprint } from "../components/pipeline/blueprint-demo";
import { validateGraph } from "../lib/pipeline/validation";
import type { StudioModel } from "../lib/pipeline/types";

export function registerBlueprintTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("all starter blueprints bind only the explicitly chosen model and validate", () => {
    const model: StudioModel = { id: "user-chosen-model", name: "User model", model: "anything", baseUrl: "https://api.example.com/v1", contextWindow: 32768, apiKey: "synthetic-private-key" };
    assert.ok(BLUEPRINTS.length >= 3 && BLUEPRINTS.length <= 5);
    for (const blueprint of BLUEPRINTS) {
      assert.throws(() => instantiateBlueprint(blueprint, ""), /Choose a model/);
      const pipeline = instantiateBlueprint(blueprint, model.id);
      assert.deepEqual(validateGraph(pipeline.graph, [model]), []);
      assert.equal(pipeline.graph.nodes.some((node) => node.type === "delegated"), false);
      for (const node of pipeline.graph.nodes.filter((node) => node.type === "model" || node.type === "delegated")) assert.equal(node.modelId, model.id);
      for (const node of pipeline.graph.nodes.filter((node) => node.type === "delegated")) assert.deepEqual(node.workerModelIds, [model.id]);
      assert.equal(JSON.stringify(pipeline).includes("synthetic-private-key"), false);
      const other = instantiateBlueprint(blueprint, model.id);
      assert.notEqual(other.id, pipeline.id);
      assert.notStrictEqual(other.graph, pipeline.graph);
      assert.ok(other.graph.nodes.every((node) => !pipeline.graph.nodes.some((previous) => previous.id === node.id)));
    }
  });

  test("every starter runs an isolated simulated preview without network or fabricated usage", async () => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("No network allowed in a demo."); };
    try {
      for (const blueprint of BLUEPRINTS) {
        const preview = await simulateBlueprint(blueprint);
        assert.equal(preview.run.status, "complete");
        assert.match(preview.run.name, /^Simulated demo:/);
        assert.match(preview.output, /Simulated response/);
        assert.equal(preview.run.usage, undefined);
      }
      assert.equal(networkCalls, 0);
    } finally { globalThis.fetch = originalFetch; }
  });
}
