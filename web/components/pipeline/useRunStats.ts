"use client";

import { useRef, useState } from "react";
import type { CustomBlockDefinition, PipelineEvent, PipelineGraph } from "../../lib/pipeline/types";
import { createRunStats, finishRunStats, recordRunEvent } from "./run-stats";
import type { RunStats } from "./run-stats";
import type { RunGoals } from "./run-goals";

export function useRunStats() {
  const current = useRef<RunStats | undefined>(undefined);
  const [run, setRun] = useState<RunStats>();
  const [goals, setGoals] = useState<RunGoals>({ maxCost: "", maxModelCalls: "" });
  function publish(next: RunStats | undefined) { current.current = next; setRun(next); }
  return {
    run,
    goals, setGoals,
    begin(pipeline: { id: string; name: string; graph: PipelineGraph }, customBlocks: CustomBlockDefinition[]) {
      publish({ ...createRunStats(pipeline.id, pipeline.name, pipeline.graph.nodes, performance.now(), customBlocks), goals: { ...goals } });
    },
    record(event: PipelineEvent) {
      if (current.current) publish(recordRunEvent(current.current, event, performance.now()));
    },
    finish(status: "failed" | "stopped") {
      if (current.current) publish(finishRunStats(current.current, status, performance.now()));
    },
    clear() { publish(undefined); },
  };
}
