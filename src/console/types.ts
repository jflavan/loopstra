import type { AttentionItem } from "../attention";
import type { JudgesView } from "../commands/judges";
import type { LoopStatus } from "../heartbeat";

/*
 * What the console's server sends and its page reads. Only types, plain constants and small pure
 * functions live here: the page imports this file, so it must never pull in server code (type-only
 * imports are erased).
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
  /** Why it is held (the hold line), or null. */
  held: string | null;
  /** The priority line as written, or null when there is none (`priority` then reads normal). */
  statedPriority: string | null;
  /** What a person can do to it now (see src/actions.ts). */
  offers: Offer[];
  /** The question an agent asked and a person has not answered yet (see src/questions.ts), or null. `at`: when it was asked, which an answer to it names. */
  question: { text: string; why: string; options: string[]; phase: string; at: string } | null;
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
  /** A person may message or redirect it (a work session; any session may be stopped). */
  steerable: boolean;
}

export interface FinishedPhase {
  slug: string; seq: number; name: string; status: string; ended: string; durationMs: number; costUsd: number;
}

export interface LoopSection extends LoopStatus {
  /** When the next tick is due while the loop sleeps between ticks; null otherwise. */
  nextCheck: string | null;
  /** A person's pause of the loop (see readLoopHold), or null. */
  held: { by: string; at: string } | null;
}

/** A request the loop has not finished: shown beside its change ("Waiting for the loop: Approve the plan"). */
export interface PendingRequest { id: string; kind: string; slug: string | null; label: string; byName: string; via: string; at: string }

export interface Totals { todayUsd: number; weekUsd: number; allUsd: number }

export interface Sections {
  loop: LoopSection;
  inbox: AttentionItem[];
  changes: ChangeSummary[];
  running: { now: RunningPhase[]; recent: FinishedPhase[] };
  totals: Totals;
  requests: PendingRequest[];
}

/**
 * A change's name, or one of the trace's own (_chat, _loop, _signals): what the server's session and
 * activity routes accept and the page's router matches, so a path one takes the other takes too.
 */
export const ANY_SLUG = /^_?[a-z0-9][a-z0-9-]*$/;

export type SectionName = keyof Sections;
export const SECTION_NAMES: readonly SectionName[] = ["loop", "inbox", "changes", "running", "totals", "requests"];

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
  | { kind: "result"; ok: boolean; summary: string; costUsd: number | null }
  /** A person's message or redirect, as the session took it up (its echo). */
  | { kind: "message"; text: string; redirect: boolean };

/**
 * A message on /api/sessions/<slug>/<seq>/stream. The id of an `item` frame names that row (see
 * frameId); its number before the dot is where a stream resumes.
 */
export type SessionMessage =
  | { type: "phase"; name: string; status: string; started: string; ended: string | null }
  | { type: "item"; item: TranscriptItem }
  | { type: "end" };

/**
 * A session row's frame id: a line's last row has the line's end alone ("200"), any other the line's
 * start and its index in the line ("100.1"), see TranscriptReader.read. Built only here and read
 * only by parseFrameId, so the server and the page agree on every id.
 */
export function frameId(at: number, k?: number): string {
  return k === undefined ? String(at) : `${at}.${k}`;
}

/**
 * A frame id read back (see frameId): its number before any dot (`at`), and whether it names a
 * line's last row (`last`, no dot). Null for anything else ("12x", "1e3", " 7", a number too big to
 * be exact), which neither the server nor the page takes for a place in the transcript.
 */
export function parseFrameId(id: string): { at: number; last: boolean } | null {
  const m = /^(\d+)(\.\d+)?$/.exec(id);
  if (!m) return null;
  const at = Number(m[1]);
  return Number.isSafeInteger(at) ? { at, last: m[2] === undefined } : null;
}

/** A running session's key on the Agents screen. */
export const agentKey = (slug: string, seq: number): string => `${slug}:${seq}`;

/**
 * A message on /api/agents/stream: `open` when it starts following a running session, then that
 * session's own messages (see SessionMessage) with its key. `sync`, sent once after the first look,
 * names every session it follows, so a page that reconnected can tell which of its tiles ended
 * while it was away.
 */
export type AgentMessage =
  | { type: "open"; agent: RunningPhase }
  | { type: "sync"; keys: string[] }
  | (SessionMessage & { key: string });

export interface DiffView {
  /** False when the change has no branch (not built yet, or merged and cleaned up), or main cannot be found. */
  exists: boolean;
  stat: string;
  patch: string;
  /** The patch was cut at the size limit (or, empty, was too big for git to produce in time). */
  cut: boolean;
  /** Set when git could not produce the diff: "The diff could not be read: <what git said>". Stat and patch are then empty. */
  problem?: string;
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

/** What a person can do to a change from the console or chat. */
export type ActionKind = "approve" | "send-back" | "retry" | "accept" | "close" | "priority" | "hold" | "release" | "answer";

/** One action a change offers now: its kind, its button's words, and the status it leads to (when it sets one). */
export interface Offer { kind: ActionKind; label: string; to?: string; confirm?: boolean }

/** The priorities, in order (the same list as src/intents.ts; the page cannot import that file). */
export const PRIORITY_NAMES = ["urgent", "high", "normal", "low"] as const;
