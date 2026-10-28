import { z } from "zod";
import { CHAT_SLUG } from "./budget";
import type { Config } from "./config";
import { CRASH_NOTE, TIMEOUT_NOTE } from "./context";
import { phaseKind } from "./console/steerable";
import { humanGates, REVIEW_GATE, type Status } from "./intents";
import { JUDGES, type JudgeName, type JudgeReport } from "./judges";
import { SESSION_LIMIT_NOTE } from "./phases";
import { TOO_MANY_NOTE } from "./questions";
import { CHECKS_KEPT_TIMING_OUT_NOTE, TESTS_KEPT_FAILING_NOTE, VERIFY_STILL_FAILED_NOTE } from "./stages/build";
import { PR_CHECKS_FAILED_NOTE, PR_CLOSED_NOTE, REVIEWS_USED_UP, UPDATE_FAILED_NOTE } from "./stages/merge";
import { riskySet } from "./risk";
import { REVIEW_STILL_FOUND_NOTE } from "./stages/review";
import { PR_CHECKS_NOTE } from "./stages/shared";
import { UNMET_NOTE } from "./stages/verify";
import { andList } from "./text";
import type { EventRow, GateRow, PhaseRow, StatusMove } from "./trace";

/*
 * `loopstra retro`: how the loop did over the last days, and what to change. Pure: it reads rows the
 * trace gave (see src/commands/retro.ts), the config and the judges' report, and writes nothing.
 */

/** Why a change blocked, as the note it blocked with tells. */
export type BlockKind = "timeout" | "crash" | "tests" | "review" | "verify" | "budget" | "conflicts" | "pr-checks" | "pr-closed" | "unmet" | "questions" | "other";

/**
 * The notes each kind of block is written from, in the order they are looked for. A failed session's
 * note (a timeout, a crash, the spending limit, too many questions) can follow a stage's own words ("The
 * finished change could not be checked. The assistant took too long..."), so those come first.
 */
const BLOCK_NOTES: ReadonlyArray<readonly [BlockKind, readonly string[]]> = [
  ["timeout", [TIMEOUT_NOTE]],
  ["crash", [CRASH_NOTE]],
  ["budget", [SESSION_LIMIT_NOTE]],
  ["questions", [TOO_MANY_NOTE]],
  ["tests", [TESTS_KEPT_FAILING_NOTE, CHECKS_KEPT_TIMING_OUT_NOTE]],
  ["review", [REVIEW_STILL_FOUND_NOTE, REVIEWS_USED_UP]],
  ["verify", [VERIFY_STILL_FAILED_NOTE]],
  ["conflicts", [UPDATE_FAILED_NOTE]],
  ["pr-checks", [PR_CHECKS_FAILED_NOTE]],
  ["pr-closed", [PR_CLOSED_NOTE]],
  ["unmet", [UNMET_NOTE]],
];

/** Every kind, in the order the report lists kinds with as many blocks. */
const KINDS: readonly BlockKind[] = [...BLOCK_NOTES.map(([k]) => k), "other"];

/** Each kind in words, for the report. */
const KIND_WORDS: Record<BlockKind, string> = {
  timeout: "Timed out", crash: "The assistant crashed", tests: "Tests kept failing", review: "The reviewer kept finding problems",
  verify: "The verifier found it did not work", budget: "Hit the spending limit", conflicts: "Merge conflicts",
  "pr-checks": "Checks on GitHub failed", "pr-closed": "The pull request was closed", unmet: "A Done when criterion was not met",
  questions: "Asked too many questions", other: "Other",
};

/** The kind of a block, by the note it was written with (blockNote adds how to retry; the note is found inside). */
export function blockKind(note: string): BlockKind {
  return BLOCK_NOTES.find(([, notes]) => notes.some((n) => note.includes(n)))?.[0] ?? "other";
}

/** The rows the report is built from. `moves` is every status move (a change merged now may have been accepted long ago); the rest are the window's. */
export interface RetroInput {
  days: number;
  now: Date;
  cfg: Config;
  moves: StatusMove[];
  gates: GateRow[];
  phases: PhaseRow[];
  /** `question` events. */
  questions: EventRow[];
  /** `request` events: an applied answer ends a question's wait. */
  requests: EventRow[];
  judges: JudgeReport;
}

/** One gate check over the window. People's own checks (see PERSON_CHECKS) are left out. */
interface GateLine { gate: string; check: string; runs: number; passed: number; changes: number; firstTime: number }

/** Waits at one review status a person decides, or for answers to questions (`at` is "question"); an open wait counts until now. */
interface Wait { at: Status | "question"; waits: number; open: number; medianMs: number }

/**
 * What the suggestions read (see suggestions). Everything here is over the window. A rule that needs
 * another fact adds it here and in buildRetro.
 */
export interface RetroFacts {
  /** Blocks, by kind (every kind present, 0 when none). */
  blocks: Record<BlockKind, number>;
  /** Changes that reached main. */
  merged: number;
  /** What the loop spent, chat left out, and over how many changes. */
  spentUsd: number;
  changesSpent: number;
  /** What the judges' sessions (spec-check, plan-challenge, review, and their cheaper judges) cost. */
  judgesUsd: number;
  /** The judges whose record has earned going first (judgeReport's `earned`). */
  judgesEarned: JudgeName[];
  gates: GateLine[];
  waits: Wait[];
}

/** One kind of block: how many, the changes (each with its count), and for other blocks each note's first sentence. */
interface BlockGroup { kind: BlockKind; count: number; slugs: Array<[string, number]>; notes: Array<{ slug: string; note: string }> }

/** One kind of step's spending. `changes`: how many changes ran it. */
interface KindSpend { kind: string; usd: number; changes: number }

/** The report: the facts, and what is only shown. */
export interface Retro extends RetroFacts {
  days: number;
  since: string;
  /** Nothing happened in the window (chat aside). */
  empty: boolean;
  reached: string[];
  finished: string[];
  blocked: string[];
  closed: string[];
  /** From accepted to merged, for the changes that reached main; null when none did. */
  toMerged: { changes: number; medianMs: number } | null;
  blockGroups: BlockGroup[];
  spending: { totalUsd: number; kinds: KindSpend[]; chatUsd: number };
  suggestions: string[];
}

/** The window's first moment: `days` before `now`, as an ISO time. */
export function windowStart(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Rows that are not an automatic check that passes or fails: what a person did, and merge/risk, which
 * says whether a person decides (its `waiting` is a risky change waiting for one, not a failure).
 */
const PERSON_CHECKS: ReadonlySet<string> = new Set(["done/human", "merge/pr-approved", "merge/risk"]);

/** The gates in the order a change meets them. */
const GATE_ORDER = ["spec", "plan", "review", "merge", "done"];

/** The review statuses in the order a change meets them; their waits are listed so. */
const WAIT_ORDER: ReadonlyArray<Status | "question"> = ["spec-review", "plan-review", "merge-review", "verifying", "question"];

/** How many kinds of step the spending lists. */
const TOP_KINDS = 5;

/** A request event's payload, as far as an answer's is read. */
const RequestPayload = z.object({ kind: z.string(), result: z.string() });

function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Each slug once, in the order first seen. */
const unique = (slugs: readonly string[]): string[] => [...new Set(slugs)];

/** Builds the report over the window from the trace's rows. */
export function buildRetro(input: RetroInput): Retro {
  const since = windowStart(input.now, input.days);
  const nowIso = input.now.toISOString();
  // A move to the same status only rewrote the note.
  const moves = input.moves.filter((m) => m.slug !== CHAT_SLUG && m.from !== m.to);
  const inWindow = moves.filter((m) => m.ts >= since);
  const to = (status: string) => unique(inWindow.filter((m) => m.to === status).map((m) => m.slug));
  const gates = input.gates.filter((g) => g.ts >= since && g.slug !== CHAT_SLUG);
  const phases = input.phases.filter((p) => p.started >= since && p.status !== "running");
  const questions = input.questions.filter((q) => q.ts >= since && q.slug !== CHAT_SLUG);
  const reached = to("merged");

  const blockMoves = inWindow.filter((m) => m.to === "blocked");
  const blocks = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<BlockKind, number>;
  for (const m of blockMoves) blocks[blockKind(m.note)]++;

  const spending = spend(phases);
  const judging = phases.filter((p) => p.slug !== CHAT_SLUG && (JUDGES as readonly string[]).includes(phaseKind(p.name)));
  const facts: RetroFacts = {
    blocks,
    merged: reached.length,
    spentUsd: spending.totalUsd,
    changesSpent: new Set(phases.filter((p) => p.slug !== CHAT_SLUG).map((p) => p.slug)).size,
    judgesUsd: judging.reduce((a, p) => a + p.cost_usd, 0),
    judgesEarned: input.judges.judges.filter((j) => j.earned).map((j) => j.judge),
    gates: gateLines(gates),
    waits: waits(moves, since, nowIso, questions, input.requests),
  };
  return {
    ...facts,
    days: input.days,
    since,
    empty: !inWindow.length && !gates.length && !phases.some((p) => p.slug !== CHAT_SLUG) && !questions.length,
    reached,
    finished: to("done"),
    blocked: unique(blockMoves.map((m) => m.slug)),
    closed: to("closed"),
    toMerged: toMerged(moves, reached, since),
    blockGroups: blockGroups(blockMoves),
    spending: { ...spending, kinds: spending.kinds.slice(0, TOP_KINDS) },
    suggestions: suggestions(facts, input.cfg),
  };
}

/**
 * From accepted to merged, for each change that reached main in the window: from its move to accepted,
 * or, for a change written as accepted, its first move (out of accepted).
 */
function toMerged(moves: readonly StatusMove[], reached: readonly string[], since: string): Retro["toMerged"] {
  const spans: number[] = [];
  for (const slug of reached) {
    const mine = moves.filter((m) => m.slug === slug);
    const merged = mine.find((m) => m.to === "merged" && m.ts >= since);
    const start = mine.find((m) => m.to === "accepted") ?? mine.find((m) => m.from !== "draft");
    if (merged && start && start.ts <= merged.ts) spans.push(Date.parse(merged.ts) - Date.parse(start.ts));
  }
  return spans.length ? { changes: spans.length, medianMs: median(spans) } : null;
}

/** The first sentence of a note: what happened, without the advice after it. */
function firstSentence(note: string): string {
  return /^.*?[.!?](?=\s|$)/.exec(note.trim())?.[0] ?? note.trim();
}

function blockGroups(blockMoves: readonly StatusMove[]): BlockGroup[] {
  const groups = new Map<BlockKind, BlockGroup>();
  for (const m of blockMoves) {
    const kind = blockKind(m.note);
    const g = groups.get(kind) ?? { kind, count: 0, slugs: [], notes: [] };
    groups.set(kind, g);
    g.count++;
    const seen = g.slugs.find(([s]) => s === m.slug);
    if (seen) seen[1]++;
    else g.slugs.push([m.slug, 1]);
    const note = firstSentence(m.note);
    if (kind === "other" && !g.notes.some((n) => n.slug === m.slug && n.note === note)) g.notes.push({ slug: m.slug, note });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

function gateLines(gates: readonly GateRow[]): GateLine[] {
  const lines = new Map<string, GateLine & { seen: Set<string> }>();
  for (const g of gates) {
    const key = `${g.gate}/${g.check}`;
    if (PERSON_CHECKS.has(key)) continue;
    const line = lines.get(key) ?? { gate: g.gate, check: g.check, runs: 0, passed: 0, changes: 0, firstTime: 0, seen: new Set<string>() };
    lines.set(key, line);
    line.runs++;
    if (g.result === "pass") line.passed++;
    if (!line.seen.has(g.slug)) {
      line.seen.add(g.slug);
      line.changes++;
      if (g.result === "pass") line.firstTime++;
    }
  }
  const order = (gate: string) => { const i = GATE_ORDER.indexOf(gate); return i < 0 ? GATE_ORDER.length : i; };
  return [...lines.values()].sort((a, b) => order(a.gate) - order(b.gate)).map(({ seen: _, ...line }) => line);
}

/** The window's ended phases' cost: the loop's in all and by kind of step (biggest first), and chat's. */
function spend(phases: readonly PhaseRow[]): { totalUsd: number; kinds: KindSpend[]; chatUsd: number } {
  const kinds = new Map<string, { usd: number; slugs: Set<string> }>();
  let totalUsd = 0;
  let chatUsd = 0;
  for (const p of phases) {
    if (p.slug === CHAT_SLUG) { chatUsd += p.cost_usd; continue; }
    totalUsd += p.cost_usd;
    const kind = phaseKind(p.name);
    const k = kinds.get(kind) ?? { usd: 0, slugs: new Set<string>() };
    kinds.set(kind, k);
    k.usd += p.cost_usd;
    k.slugs.add(p.slug);
  }
  const listed = [...kinds.entries()].filter(([, k]) => k.usd > 0).map(([kind, k]) => ({ kind, usd: k.usd, changes: k.slugs.size }));
  return { totalUsd, kinds: listed.sort((a, b) => b.usd - a.usd), chatUsd };
}

/**
 * Waits in the window. At a review status: from a move to it (in the window) to the change's next move
 * to another status. merge-review waits for a person unless its note says it waits for GitHub's checks
 * (nobody on the gate); the other review statuses are only entered when a person decides. For a
 * question: from the question to an applied answer, or to the change's next status move.
 */
function waits(moves: readonly StatusMove[], since: string, now: string, questions: readonly EventRow[], requests: readonly EventRow[]): Wait[] {
  const spans = new Map<Status | "question", { ms: number[]; open: number }>();
  const add = (at: Status | "question", start: string, end: string | undefined) => {
    const w = spans.get(at) ?? { ms: [], open: 0 };
    spans.set(at, w);
    w.ms.push(Date.parse(end ?? now) - Date.parse(start));
    if (end === undefined) w.open++;
  };
  // Each move's next move of the same change, found in one pass from the newest.
  const next: (string | undefined)[] = [];
  const later = new Map<string, string>();
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i]!;
    next[i] = later.get(m.slug);
    later.set(m.slug, m.ts);
  }
  moves.forEach((m, i) => {
    if (m.ts < since || !(m.to in REVIEW_GATE)) return;
    if (m.to === "merge-review" && m.note === PR_CHECKS_NOTE) return;
    add(m.to as Status, m.ts, next[i]);
  });
  const answers = requests.filter((r) => {
    let raw: unknown;
    try { raw = JSON.parse(r.payload); } catch { return false; }
    const p = RequestPayload.safeParse(raw);
    return p.success && p.data.kind === "answer" && p.data.result === "applied";
  });
  for (const q of questions) {
    const ends = [...answers.filter((a) => a.slug === q.slug), ...moves.filter((m) => m.slug === q.slug)].map((e) => e.ts).filter((ts) => ts > q.ts).sort();
    add("question", q.ts, ends[0]);
  }
  return WAIT_ORDER.flatMap((at) => {
    const w = spans.get(at);
    return w ? [{ at, waits: w.ms.length, open: w.open, medianMs: median(w.ms) }] : [];
  });
}

/** Suggestion thresholds. */
const JUDGING_SHARE = 0.3;
const JUDGING_CHANGES = 5;
const FIX_LOOP_BLOCKS = 2;
const TIMEOUT_BLOCKS = 2;
const TIMEOUT_GROWTH = 1.5;
const REVIEW_BLOCKS = 2;
const BUDGET_BLOCKS = 1;
const LONG_WAIT_MS = DAY_MS;
const QUIET_GATE_RUNS = 5;
const RISKY_MERGES = 1;
const UNMET_BLOCKS = 1;

const money = (usd: number) => `$${usd.toFixed(2)}`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What to change, from the facts: each one sentence with its evidence and the setting. Empty when no
 * rule applies. Thresholds are the constants above.
 */
export function suggestions(f: RetroFacts, cfg: Config): string[] {
  const out: string[] = [];
  const setting = cfg.speed.cheap_judges;
  if (setting === "shadow" && f.judgesEarned.length) {
    const n = f.judgesEarned.length;
    out.push(`The cheaper ${andList(f.judgesEarned)} judge${n === 1 ? " has" : "s have"} earned going first (see loopstra judges): set speed.cheap_judges to first to spend less on judging.`);
  }
  if (setting === "off" && f.spentUsd > 0 && f.judgesUsd / f.spentUsd >= JUDGING_SHARE && f.changesSpent >= JUDGING_CHANGES) {
    out.push(`Judging cost ${money(f.judgesUsd)} of the ${money(f.spentUsd)} spent (${Math.round((f.judgesUsd / f.spentUsd) * 100)}%) over ${f.changesSpent} changes: set speed.cheap_judges to shadow to measure whether a cheaper model judges as well.`);
  }
  if (f.blocks.tests >= FIX_LOOP_BLOCKS) {
    const loops = cfg.stages.build.max_fix_loops;
    out.push(`${count(f.blocks.tests, "block")} came from tests that kept failing: raise stages.build.max_fix_loops from ${loops} to ${loops + 1}, or write smaller changes.`);
  }
  if (f.blocks.timeout >= TIMEOUT_BLOCKS) {
    const minutes = cfg.claude.timeout_minutes;
    out.push(`${count(f.blocks.timeout, "step")} timed out: raise claude.timeout_minutes from ${minutes} to ${Math.ceil((minutes * TIMEOUT_GROWTH) / 5) * 5}, or write smaller changes.`);
  }
  if (f.blocks.review >= REVIEW_BLOCKS) {
    const rounds = cfg.stages.review.max_rounds;
    out.push(`${count(f.blocks.review, "block")} came from a reviewer that kept finding problems: raise stages.review.max_rounds from ${rounds} to ${rounds + 1}.`);
  }
  if (f.blocks.budget >= BUDGET_BLOCKS) {
    const limit = cfg.claude.max_budget_usd;
    out.push(`${count(f.blocks.budget, "step")} hit the session spending limit${limit === undefined ? "" : ` of ${money(limit)}`}: raise claude.max_budget_usd with loopstra setup budgets.`);
  }
  const human = humanGates(cfg);
  for (const w of f.waits) {
    const gate = w.at === "question" ? undefined : REVIEW_GATE[w.at];
    if (!gate || human[gate] === "none" || w.medianMs <= LONG_WAIT_MS) continue;
    const checks = f.gates.filter((g) => g.gate === gate);
    const runs = checks.reduce((a, g) => a + g.runs, 0);
    if (runs < QUIET_GATE_RUNS || checks.some((g) => g.passed < g.runs)) continue;
    out.push(`Changes waited ${duration(w.medianMs)} at the median in ${w.at}, and the ${gate} gate's automatic checks passed all ${runs} times: the person on it may not be needed (gates.${gate}.human: none).`);
  }
  if (cfg.gates.merge.human === "none" && !riskySet(cfg) && f.merged >= RISKY_MERGES) {
    out.push(`${count(f.merged, "change")} merged with nobody looking, and no file is set to need a person: set gates.merge.risky.paths (loopstra setup github suggests some) so changes to CI, dependencies or migrations wait for a person.`);
  }
  if (!cfg.stages.build.acceptance_tests && f.blocks.unmet >= UNMET_BLOCKS) {
    out.push(`${count(f.blocks.unmet, "change")} merged without meeting a Done when criterion: set stages.build.acceptance_tests to true, so tests written from Done when hold each build to it.`);
  }
  return out;
}

/** A length of time in words: minutes under an hour, hours under two days, then days. */
function duration(ms: number): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  if (ms < HOUR_MS) return count(Math.max(1, Math.round(ms / 60_000)), "min", "min");
  if (ms < 2 * DAY_MS) return count(round(ms / HOUR_MS), "hour");
  return count(round(ms / DAY_MS), "day");
}

/** Up to five changes, then how many more. */
function names(slugs: readonly string[]): string {
  const shown = slugs.slice(0, 5);
  return andList(slugs.length > shown.length ? [...shown, `${slugs.length - shown.length} more`] : shown);
}

/** "add-numbers", "add-numbers twice", "add-numbers 3 times". */
function times([slug, n]: [string, number]): string {
  return n === 1 ? slug : n === 2 ? `${slug} twice` : `${slug} ${n} times`;
}

/** A gate check in words: the check alone when it already names its gate ("spec-check"), else both ("review findings"). */
function checkName(g: GateLine): string {
  return g.check.startsWith(g.gate) ? g.check : `${g.gate} ${g.check}`;
}

/** "Oct 20": a day in local time. */
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The report as plain text. */
export function retroText(r: Retro): string {
  const span = r.days === 1 ? "last day" : `last ${r.days} days`;
  const tail = ["", "Suggestions", ...(r.suggestions.length ? r.suggestions : ["No suggestions: nothing in the trace points at a setting to change."]).map((s) => `- ${s}`)];
  if (r.empty) return [`Nothing happened in the ${span}.`, ...tail].join("\n") + "\n";
  const listed = (label: string, slugs: readonly string[]) => `- ${label}: ${slugs.length}${slugs.length ? ` (${names(slugs)})` : ""}.`;
  const lines = [
    `The ${span} (since ${day(r.since)}).`,
    "", "What happened",
    listed("Reached main", r.reached), listed("Finished", r.finished), listed("Blocked", r.blocked), listed("Closed", r.closed),
    ...(r.toMerged ? [`- From accepted to merged: ${duration(r.toMerged.medianMs)} at the median, over ${count(r.toMerged.changes, "change")}.`] : []),
    "", "Where changes blocked",
    ...(r.blockGroups.length ? r.blockGroups.flatMap((g) => [
      `- ${KIND_WORDS[g.kind]}: ${g.count} (${names(g.slugs.map(times))}).`,
      ...g.notes.slice(0, 5).map((n) => `  - ${n.slug}: ${n.note}`),
    ]) : ["- Nothing blocked."]),
    "", "Gates",
    ...(r.gates.length ? r.gates.map((g) => `- ${checkName(g)}: ran ${count(g.runs, "time")}; ${g.firstTime} of ${count(g.changes, "change")} passed the first time.`) : ["- No automatic checks ran."]),
    "", "Spending",
    ...spendingLines(r),
    "", "Waiting for people",
    ...(r.waits.length ? r.waits.map((w) => `- ${w.at === "question" ? "Questions" : w.at}: ${count(w.waits, "wait")}, ${duration(w.medianMs)} at the median${w.open ? ` (${w.open} still waiting)` : ""}.`) : ["- Nobody was waited for."]),
    ...tail,
  ];
  return lines.join("\n") + "\n";
}

function spendingLines(r: Retro): string[] {
  const { totalUsd, kinds, chatUsd } = r.spending;
  const chat = chatUsd > 0 ? [`- Chat: ${money(chatUsd)}, not counted above.`] : [];
  if (totalUsd <= 0) return [...(chat.length ? [] : ["- Nothing was spent."]), ...chat];
  return [
    `- ${money(totalUsd)} in all, over ${count(r.changesSpent, "change")} (${money(totalUsd / r.changesSpent)} a change).`,
    ...kinds.map((k) => `- ${k.kind}: ${money(k.usd)} (${Math.round((k.usd / totalUsd) * 100)}%), ${money(k.usd / k.changes)} a change.`),
    ...chat,
  ];
}
