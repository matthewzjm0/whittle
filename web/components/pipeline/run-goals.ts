import { summarizeRun } from "./run-stats";
import type { RunStats } from "./run-stats";

export type RunGoals = { maxCost: string; maxModelCalls: string };

export function assessRunGoals(run: RunStats) {
  if (!run.goals) return;
  const summary = summarizeRun(run);
  const checks = [
    { label: "Max cost (USD)", target: run.goals.maxCost, actual: summary.cost, integer: false },
    { label: "Max model calls", target: run.goals.maxModelCalls, actual: summary.modelCalls, integer: true },
  ].filter((check) => check.target.trim() !== "").map((check) => {
    const target = Number(check.target);
    const valid = Number.isFinite(target) && target >= 0 && (!check.integer || Number.isSafeInteger(target));
    return { ...check, pass: run.status === "complete" && valid && check.actual !== undefined ? check.actual <= target : undefined };
  });
  if (!checks.length) return;
  const score = checks.some((check) => check.pass === undefined) ? undefined : Math.round(100 * checks.filter((check) => check.pass).length / checks.length);
  const status = run.status !== "complete" ? "Not evaluated" : checks.some((check) => check.pass === false) ? "Fail" : score === undefined ? "Unknown" : "Pass";
  return { status, score, checks };
}
