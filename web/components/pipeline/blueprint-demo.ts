import { runPipeline } from "../../lib/pipeline/runner";
import type { Complete, StudioModel } from "../../lib/pipeline/types";
import { instantiateBlueprint } from "./blueprints";
import type { Blueprint } from "./blueprints";
import { createRunStats, recordRunEvent } from "./run-stats";

// Isolated preview metadata: never registered, persisted, or sent to the API.
const demoModel: StudioModel = { id: "blueprint-demo", name: "Simulated demo", model: "simulated-demo", baseUrl: "https://demo.invalid/v1", contextWindow: 32768 };
const complete: Complete = async (_model, messages) => {
  return { text: `[Simulated response, not a factual model answer]\n${messages.at(-1)?.content.slice(0, 400) ?? ""}` };
};

export async function simulateBlueprint(blueprint: Blueprint) {
  const pipeline = instantiateBlueprint(blueprint, demoModel.id);
  let run = createRunStats(pipeline.id, `Simulated demo: ${pipeline.name}`, pipeline.graph.nodes, performance.now());
  let output = "";
  for await (const event of runPipeline({ graph: pipeline.graph, models: [demoModel], input: pipeline.input, maxOutputTokens: 1024, complete })) {
    run = recordRunEvent(run, event, performance.now());
    if (event.type === "error") throw new Error("Simulated preview failed.");
    if (event.type === "complete") output = event.output ?? "";
  }
  return { run, output };
}
