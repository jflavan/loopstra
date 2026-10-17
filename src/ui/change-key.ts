import type { ChangeSummary, PhaseView } from "../console/types";

/**
 * What a change page reads its detail again for. The summary's `inStatus` ("12s", "3 min") is rebuilt
 * with every server update and would make the page reload and flash all the time, so the key names
 * only the fields that carry a real change.
 */
export function detailKey(s: ChangeSummary | null | undefined, runningSeqs: string): string {
  if (!s) return `|${runningSeqs}`;
  return JSON.stringify([s.status, s.since, s.costUsd, s.running, s.waiting, s.note, s.priority, runningSeqs]);
}

/** The diff changes when the branch does, which is when the status moves or a step starts or ends. */
export function codeKey(s: ChangeSummary | null | undefined, runningSeqs: string): string {
  return `${s?.status ?? ""}|${runningSeqs}`;
}

/** When a timeline bar ends: a running step now, a finished one when it ended, and a step with no end time (a crash) after its own duration. */
export function barEnd(p: Pick<PhaseView, "started" | "ended" | "status" | "durationMs">, nowMs: number): number {
  if (p.ended) return Date.parse(p.ended);
  return p.status === "running" ? nowMs : Date.parse(p.started) + p.durationMs;
}
