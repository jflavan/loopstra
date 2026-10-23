import type { ChangeSummary, PhaseView } from "../console/types";

/**
 * What a change page reads its detail again for. The summary's `inStatus` ("12s", "3 min") is rebuilt
 * with every server update and would make the page reload and flash all the time, so the key names
 * only the fields that carry a real change.
 */
export function detailKey(s: ChangeSummary | null | undefined, runningSeqs: string): string {
  if (!s) return `|${runningSeqs}`;
  return JSON.stringify([s.status, s.since, s.costUsd, s.running, s.waiting, s.note, s.shownNote, s.priority, s.held, runningSeqs]);
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

/** The least a bar is wide, in percent, so a step over in a moment still shows. */
const SLIVER = 0.4;

/**
 * Where each step's bar sits on the timeline, in percent of it: `left` from the first start, `width`
 * at least a sliver. A step whose times cannot be read gets a sliver at the left and does not set
 * the scale, so the other bars are still drawn (never at NaN%).
 */
export function barGeometry(phases: Array<Pick<PhaseView, "started" | "ended" | "status" | "durationMs">>, nowMs: number): Array<{ left: number; width: number }> {
  const starts = phases.map((p) => Date.parse(p.started));
  const ends = phases.map((p) => barEnd(p, nowMs));
  const known = [...starts, ...ends].filter(Number.isFinite);
  const start = Math.min(...known);
  const span = Math.max(1, Math.max(...known) - start);
  return phases.map((_, k) => {
    const s = starts[k]!;
    const e = ends[k]!;
    if (!Number.isFinite(s)) return { left: 0, width: SLIVER };
    const left = ((s - start) / span) * 100;
    const width = Number.isFinite(e) ? Math.min(100 - left, Math.max(SLIVER, ((e - s) / span) * 100)) : SLIVER;
    return { left, width };
  });
}
