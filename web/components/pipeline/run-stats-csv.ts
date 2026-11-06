import { summarizeRun } from "./run-stats";
import type { RunStats } from "./run-stats";

export function runStatsCsv(run: RunStats): string {
  const header = "block_number,executions,elapsed_ms,reported_cost_usd,input_tokens,output_tokens,model_calls";
  const cell = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "";
  const rows = run.status === "running" ? [] : summarizeRun(run).blocks.map((block, index) =>
    [index + 1, block.executions, block.durationMs, block.cost, block.input, block.output, block.modelCalls].map(cell).join(","));
  return [header, ...rows].join("\r\n") + "\r\n";
}

export function downloadRunStatsCsv(run: RunStats): void {
  const url = URL.createObjectURL(new Blob([runStatsCsv(run)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "pipeline-run-stats.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
