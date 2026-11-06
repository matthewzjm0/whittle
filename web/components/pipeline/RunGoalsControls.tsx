import { assessRunGoals } from "./run-goals";
import type { RunGoals } from "./run-goals";
import type { RunStats } from "./run-stats";
import s from "./run-summary.module.css";

export function RunGoalsControls({ value, onChange, disabled }: { value: RunGoals; onChange: (value: RunGoals) => void; disabled: boolean }) {
  return <fieldset className={s.goals} disabled={disabled}>
    <legend>Challenges (optional)</legend>
    <label>Max cost (USD)<input type="number" min="0" step="any" value={value.maxCost} onChange={(event) => onChange({ ...value, maxCost: event.target.value })} /></label>
    <label>Max model calls<input type="number" min="0" step="1" value={value.maxModelCalls} onChange={(event) => onChange({ ...value, maxModelCalls: event.target.value })} /></label>
    <small>Blank means no goal. Goals score the next completed run; they do not stop execution or cap billing. Unreported measurements cannot pass a goal.</small>
  </fieldset>;
}

export function GoalResult({ run }: { run: RunStats }) {
  const result = assessRunGoals(run);
  if (!result) return null;
  return <span title={result.checks.map((check) => `${check.label}: ${check.target} (${check.pass === undefined ? "Unknown" : check.pass ? "Pass" : "Fail"})`).join("; ")}>Goals: {result.status}; score {result.score === undefined ? "Unknown" : `${result.score}/100`} (budget goals only)</span>;
}
