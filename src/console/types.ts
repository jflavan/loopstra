import type { AttentionItem } from "../attention";
import type { JudgesView } from "../commands/judges";
import type { LoopStatus } from "../heartbeat";

/*
 * What the console's server sends and its page reads. Only types and plain constants live here: the
 * page imports this file, so it must never pull in server code (type-only imports are erased).
 */

/** A board column: where a change is, or is heading next. */
export type Stage = "draft" | "design" | "plan" | "build" | "review" | "merge" | "verify" | "done" | "blocked" | "closed";

export interface ChangeSummary {
  slug: string; title: string; status: string; plain: string; priority: string; stage: Stage;
  /** When the change entered its status (best known), and how long ago in words ("2 h"). */
  since: string | null; inStatus: string | null;
  /** What its ended phases cost. */
  costUsd: number;
  /** Why it waits for other changes, in plain words, or null. */
  waiting: string | null;
  /** Its own note from intent.md. */
  note: string;
  /** A step of it is running now. */
  running: boolean;
}

export interface RunningPhase {
  slug: string; title: string; seq: number; name: string;
  /** The model the session runs on, from its first event; null until it has said. */
  model: string | null;
  started: string;
  /** What it is doing, in a few words: "Running bun test", "Editing src/parser.ts". */
  now: string;
  /** Its newest activity, oldest first: one entry per tool call, piece of text, or result. */
  strip: Array<"tool" | "text" | "result">;
}

export interface FinishedPhase {
  slug: string; seq: number; name: string; status: string; ended: string; durationMs: number; costUsd: number;
}

export interface LoopSection extends LoopStatus {
  /** When the next tick is due while the loop sleeps between ticks; null otherwise. */
  nextCheck: string | null;
}

export interface Totals { todayUsd: number; weekUsd: number; allUsd: number }

export interface Sections {
  loop: LoopSection;
  inbox: AttentionItem[];
  changes: ChangeSummary[];
  running: { now: RunningPhase[]; recent: FinishedPhase[] };
  totals: Totals;
}
export type SectionName = keyof Sections;
export const SECTION_NAMES: readonly SectionName[] = ["loop", "inbox", "changes", "running", "totals"];

export interface Meta {
  /** Whether this console has the orchestrator's chat. */
  chat: boolean;
  /** The rate a running session's cost is estimated at. */
  usdPerMinute: number;
  pollSeconds: number;
}

/** One trace event for Activity: in plain words (null when it only matters to an engineer), and as a technical line. */
export interface ActivityItem { id: number; slug: string; seq: number | null; ts: string; type: string; text: string | null; technical: string }

/** A message on /api/stream. */
export type StreamMessage =
  | { type: "snapshot"; meta: Meta; sections: Sections }
  | { type: "section"; name: SectionName; value: Sections[SectionName] }
  | { type: "event"; item: ActivityItem }
  /** The page came back too far behind to be sent every event it missed; its activity list has a hole. */
  | { type: "gap" };

export interface PhaseView {
  seq: number; name: string; kind: string; status: string; started: string; ended: string | null;
  /** Ended minus started; for a running phase, so far. */
  durationMs: number; costUsd: number; error: string | null;
  files: Array<{ name: string; url: string }>;
  /** Commands the session was not allowed to run (allow-rule text). */
  denied: string[];
}

export interface ChangeDetail extends ChangeSummary {
  dependsOn: string[];
  /** The change's own documents in intent/<slug>/, served read-only. */
  documents: Array<{ name: string; url: string }>;
  phases: PhaseView[];
  gates: Array<{ gate: string; check: string; result: string; evidence: string; ts: string }>;
}

export type TranscriptItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; tool: string; target: string; input: unknown }
  | { kind: "tool-result"; id: string; ok: boolean; output: string }
  | { kind: "edit"; id: string; tool: string; path: string; diff: string }
  | { kind: "todos"; items: Array<{ text: string; state: string }> }
  | { kind: "result"; ok: boolean; summary: string; costUsd: number | null };

/** A message on /api/sessions/<slug>/<seq>/stream. */
export type SessionMessage =
  | { type: "phase"; name: string; status: string; started: string; ended: string | null }
  | { type: "item"; item: TranscriptItem }
  | { type: "end" };

export interface DiffView {
  /** False when the change has no branch (not built yet, or merged and cleaned up). */
  exists: boolean;
  stat: string;
  patch: string;
  /** The patch was cut at the size limit. */
  cut: boolean;
}

export interface SpendView {
  totals: Totals;
  chatUsd: number;
  perChange: Array<{ slug: string; title: string; costUsd: number }>;
  perPhase: Array<{ name: string; costUsd: number; count: number }>;
  /** The last 48 hours, oldest first, one entry per hour (its start, ISO). */
  byHour: Array<{ hour: string; costUsd: number }>;
  judges: JudgesView | null;
}
