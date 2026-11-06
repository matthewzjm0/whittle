import { formatCost, formatDuration, summarizeRun } from "./run-stats";
import type { RunStats } from "./run-stats";
import { downloadRunStatsCsv } from "./run-stats-csv";
import { GoalResult } from "./RunGoalsControls";
import s from "./run-summary.module.css";

export function RunSummary({ run }: { run?: RunStats }) {
  if (!run || run.status === "running") return null;
  const summary = summarizeRun(run);
  return <section className={s.panel} aria-label="Last run summary">
    <details>
      <summary><strong>Last run: {run.name} ({run.status})</strong><span>Time: {formatDuration(summary.durationMs)}</span><span>Cost: {formatCost(summary.cost)}</span><span>Model calls: {summary.modelCalls ?? "Unknown"}</span><GoalResult run={run} /></summary>
      <p>Client-observed elapsed time, including network buffering. Repeated block executions are combined. Delegated call counts are not reported. Failed/stopped runs are partial; unreported billing may still apply.</p>
      <button type="button" className={s.exportButton} onClick={() => downloadRunStatsCsv(run)}>Export stats CSV</button><small> Numeric rows match the numbered blocks below. Blank cells mean Unknown; no prompts or outputs are included.</small>
      <div className={s.tableScroll}><table>
        <caption>Per-block breakdown</caption>
        <thead><tr><th scope="col">Block</th><th scope="col">Executions</th><th scope="col">Time</th><th scope="col">Cost</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Model calls</th></tr></thead>
        <tbody>{summary.blocks.map((block, index) => <tr key={block.id}><th scope="row">{index + 1}. {block.label}</th><td>{block.executions}</td><td>{formatDuration(block.durationMs)}</td><td>{formatCost(block.cost)}</td><td>{block.input ?? "Unknown"}</td><td>{block.output ?? "Unknown"}</td><td>{block.modelCalls ?? "Unknown"}</td></tr>)}</tbody>
      </table></div>
    </details>
  </section>;
}
