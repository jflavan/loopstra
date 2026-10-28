import type { AttentionItem } from "../attention";
import type { JudgesView } from "../commands/judges";
import type { LoopStatus } from "../heartbeat";
import type { ModelRef, StepGroup, StepKey } from "../models";
import type { SectionBullet, StandardForm, StandardsProblem } from "../standards";
import type { CheckOnMain } from "../standards-check";
import type { ChangeStandards } from "../standards-record";

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
  /** Why it waits, for its pull request (see prWait) or for other changes, in plain words, or null. */
  waiting: string | null;
  /** Its own note from intent.md. */
  note: string;
  /** Its note as shown: "" while its pull request's wait stands in for the note the merge gate left (see prWait). */
  shownNote: string;
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
  /** What the session ran as, from its `agent_setup` event; null when it ran with no setup. */
  agentSetup: AgentSetupView | null;
}

/** The agent setup a step ran with: names only, as the trace recorded them. */
export interface AgentSetupView {
  agent: string | null; subagents: string[]; teams: string[]; skills: string[]; tools: string[]; mcpTools: string[];
  /** Each team's members, by team name; empty for a step traced before members were recorded. */
  teamMembers: Record<string, string[]>;
  sources: "all" | "repo";
  /** Each inline subagent's and team member's model, by name. */
  models: Record<string, string>;
}

export interface ChangeDetail extends ChangeSummary {
  dependsOn: string[];
  /** The change's own documents in intent/<slug>/, served read-only. */
  documents: Array<{ name: string; url: string }>;
  phases: PhaseView[];
  gates: Array<{ gate: string; check: string; result: string; evidence: string; ts: string }>;
  /** What the change is held to; absent when the repository has no standards. */
  standards?: ChangeStandardsView;
}

/** One standard on main, as Settings › Standards shows it. `matches`: files on main its patterns match; null when it applies to every change. */
export interface StandardRow {
  name: string; path: string; title: string; scope: string; matches: number | null; needsPerson: boolean; check: string | null;
  rules: { label: string; text: string }[];
  /** Open changes it applies to now. */
  inProgress: string[];
  /** The file as committed, and its version (what a save names as the one the page read). */
  text: string; version: string;
}

export interface StandardsView { standards: StandardRow[]; problems: string[]; ignored: string[]; uncommitted: string[] }

/** A draft checked against main's other standards, with how many files each pattern matches. */
export interface DraftCheck {
  problems: StandardsProblem[];
  matches: { pattern: string; count: number; sample: string[] }[];
}

/** The answer of `POST /api/standards/check`: the draft both ways, so the page toggles form and Markdown through the server. */
export type DraftChecked = DraftCheck & { text: string; form: StandardForm | null };

/** A tool check tried on main (`POST /api/standards/try`). */
export type TriedCheck = CheckOnMain;

/** An exception a person approved at a change's spec or plan. `title` is the change's. */
export interface ExceptionRow { label: string; title: string; slug: string; reason: string; by: string; via: string; date: string; gate: "spec" | "plan" }

/** A standard added to a change or removed from it. */
export interface ScopeRow { name: string; slug: string; action: "added" | "removed"; note: string; by: string; via: string; date: string }

/** The change page's standards panel. */
export interface ChangeStandardsView {
  applying: {
    name: string; title: string; why: string;
    rules: { label: string; text: string; spec?: string; plan?: string; findings: string[]; result?: string }[];
    check?: string;
  }[];
  /** Exceptions asked for in the spec or plan that nobody has approved yet. */
  waiting: SectionBullet[];
  record: ChangeStandards;
}

export type TranscriptItem = (
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; tool: string; target: string; input: unknown }
  | { kind: "tool-result"; id: string; ok: boolean; output: string }
  | { kind: "edit"; id: string; tool: string; path: string; diff: string }
  | { kind: "todos"; items: Array<{ text: string; state: string }> }
  | { kind: "result"; ok: boolean; summary: string; costUsd: number | null }
  /** A person's message or redirect, as the session took it up (its echo). */
  | { kind: "message"; text: string; redirect: boolean }
  /** The prompt a subagent was handed: the first event of its work, not a person's message. */
  | { kind: "delegated"; text: string; parent: string }
) & {
  /**
   * The id of the subagent call (an `Agent` or `Task` tool row) whose work this row is, from the
   * event's `parent_tool_use_id`; absent on the session's own rows.
   */
  parent?: string;
};

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

/** The Settings page: the named models and where each step runs, read from one text of loopstra/config.yaml. */
export interface SettingsView {
  /** configVersion of the file; null when it cannot be read. A settings request names it. */
  version: string | null;
  /** Why the config does not load; the page shows this instead of the pickers. */
  problem: string | null;
  /** `last`: the newest session on the named model: the name it was asked for then, and the model Claude Code reported. */
  models: Array<{ ref: ModelRef; name: string; last: { asked: string; ran: string | null; result: "ok" | "bad-model"; ts: string } | null }>;
  groups: Array<{
    group: StepGroup; model: ModelRef;
    /** Where the group's model is set: "stages.design.model" or "chat.model". */
    path: string;
    steps: Array<{
      key: StepKey; what: string;
      /** Null for the orchestrator, which is the group's own picker. */
      path: string | null;
      own: ModelRef | null; effective: ModelRef;
      /** The muted text: "follows build: default" for a step that follows a group, or "strong" for a fixed one. */
      byDefault: string;
    }>;
  }>;
}

/** The fields of a step's agent setup (agents.all, agents.steps.<step>), as the config names them. */
export const AGENT_FIELDS = ["agent", "subagents", "teams", "skills", "tools", "mcp_tools"] as const;
export type AgentField = (typeof AGENT_FIELDS)[number];

/** What a field holds: `agent` one name, the others a list. Only fields that are set are given. */
export type AgentFields = Partial<Record<AgentField, string | string[]>>;

/** One row of the Agents table: "all" (agents.all), then each step in STEPS order. */
export interface AgentStepRow {
  key: StepKey | "all";
  what: string;
  /** It may not change files (agents.all reaches read-only steps, so it is read-only too). */
  readOnly: boolean;
  /** A chat turn: it takes nothing from all steps, and anyone allowed to chat can steer its tools. */
  chat: boolean;
  /** Fix, reconcile and revise continue the build's session, so they run as the build's agent. */
  continuesBuild: boolean;
  /** What the row sets itself. */
  own: AgentFields;
  /** What agents.all gives it ({} for the "all" row and chat steps). */
  fromAll: AgentFields;
  /** Its stage's skills (stages.<stage>.skills). */
  fromStage: string[];
}

/** An agent or skill the steps can name, or that can be copied into the repository. */
export interface LibraryItemView {
  kind: "agent" | "skill";
  /** `plugin:name` for a plugin's. */
  name: string;
  description: string;
  from: "repo" | "personal" | "plugin";
  /** Who names it: `agents.all`, `agents.steps.review`, `team reviewers`, `stages.review` (a stage's skills). */
  usedBy: string[];
  /** fileVersion of the agent file, or of the skill's SKILL.md. */
  base: string;
  /** A repo agent named as Loopstra names one (lowercase letters, digits and dashes), which the page may edit. */
  editable: boolean;
  /** A repo agent's file, for the edit form. */
  text?: string;
}

/**
 * The Agents section of the Settings page, read from one text of loopstra/config.yaml. The library
 * lists this machine's and the plugins' items whatever `sources` says, so they can be copied into the
 * repository; the steps use them only with `sources: all`.
 */
export interface AgentsView {
  /** configVersion of the file; null when it cannot be read. A settings request names it. */
  version: string | null;
  /** Why the config does not load; the page shows this instead of the section. */
  problem: string | null;
  sources: "all" | "repo";
  steps: AgentStepRow[];
  teams: Array<{ name: string; members: string[]; way: string; usedBy: string[] }>;
  library: LibraryItemView[];
  /** What checking every name the steps use found: missing (fail), only on this machine or with keys left out (warn). */
  problems: Array<{ level: "fail" | "warn"; step: string; name: string; text: string }>;
  /** The agents Claude Code ships with: subagents or team members, never a step's own agent. */
  builtins: string[];
  /** How a team may work. */
  ways: string[];
}

/**
 * What the page asks of `/api/agents/files`: the server turns it into an `agent-files` request.
 * `copy` takes an item from this machine or a plugin (`from`); `fetch` clones `url` again and copies
 * the named items. Copy and fetch refuse a target the repository has unless `replace` is true; new
 * always refuses one (pick another name, or edit the agent).
 * `base` is the version the page read of the agent file or SKILL.md it changes (LibraryItemView.base,
 * or "absent" when the repository has none): an edit and a remove always name it, a replacement does
 * too (a fetch by item name). It is refused as stale when the file is no longer that version.
 */
export type AgentFilesOp =
  | ({ op: "copy"; kind: "agent" | "skill"; name: string; from: "personal" | "plugin" } & Replacing<string>)
  | ({ op: "fetch"; url: string; names: string[]; kind: "agent" | "skill" } & Replacing<Record<string, string>>)
  | { op: "new"; name: string; description: string; prompt: string; tools: string[]; model: string | null }
  | { op: "edit"; name: string; text: string; base: string }
  | { op: "remove"; kind: "agent" | "skill"; name: string; base: string };

/** An add that replaces what the repository has names the version it read; one that does not, none. */
type Replacing<B> = { replace?: false; base?: undefined } | { replace: true; base: B };

/** What `/api/agents/source` lists: the items a git repository or folder holds. */
export type SourceItems = { items: Array<{ kind: "agent" | "skill"; name: string; description: string }> } | { error: string };
