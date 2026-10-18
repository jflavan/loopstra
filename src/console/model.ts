import { statSync } from "node:fs";
import { join } from "node:path";
import { offers, requestLabel, retryOptions } from "../actions";
import { attention, type AttentionItem } from "../attention";
import { CHAT_SLUG, startOfToday, USD_PER_MINUTE } from "../budget";
import { loadConfig, type Config } from "../config";
import { agoText, heartbeatState, readHeartbeat, readLoopHold, readPause, type Heartbeat, type LoopHold, type LoopStatus } from "../heartbeat";
import { effectivePriority, humanGates, orderQueue, plainStatus, scanRepo, waitNote, type HumanGates, type Intent, type Scan, type Status } from "../intents";
import { readQuestion } from "../questions";
import { pendingRequests, type Request } from "../requests";
import { sameFileHolds } from "../scheduler";
import { errorText } from "../shell";
import { nowText } from "../tools";
import type { EventRow, PhaseRow, Trace } from "../trace";
import { parsePayload } from "./describe";
import { steerable } from "./steerable";
import type { ChangeSummary, FinishedPhase, LoopSection, Meta, PendingRequest, RunningPhase, Sections, Stage, Totals } from "./types";

/** The board column of each status: where the change is, or is heading next. */
const STAGE: Record<Status, Stage> = {
  draft: "draft", accepted: "design", designing: "design", "spec-review": "design",
  "spec-approved": "plan", planning: "plan", "plan-review": "plan",
  "plan-approved": "build", building: "build", reviewing: "review",
  "merge-review": "merge", "merge-approved": "merge", merged: "verify", verifying: "verify",
  done: "done", blocked: "blocked", closed: "closed",
};

/** How many entries a running step's activity strip shows. */
const STRIP = 30;

export interface Model { meta: Meta; sections: Sections }

/** A `claude_event` row's payload: see `summarize` in src/phases.ts. */
interface Summary { type?: string; subtype?: string; items?: string[]; targets?: string[]; model?: string | null }

/**
 * Everything the console shows on every screen, from the intent files, the trace and the heartbeat.
 * `opts.scan` is the intent folder already read (the hub keeps one until a file there changes).
 * Each part is built on its own: one that fails becomes a problem in the inbox, and the rest still
 * go out.
 */
export async function buildModel(root: string, trace: Trace, now: Date = new Date(), opts: { chat?: boolean; scan?: Scan } = {}): Promise<Model> {
  let config: Config | { problem: string };
  try { config = await loadConfig(root); } catch (e) { config = { problem: errorText(e) }; }
  const cfg = "problem" in config ? null : config;
  const pollSeconds = cfg?.poll_seconds ?? 60;
  const problems: string[] = [];
  const safely = async <T>(what: string, fn: () => T | Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { problems.push(`${what}: ${errorText(e)}`); return fallback; }
  };

  // Read once and shared with the inbox: it is the costliest part of a rebuild.
  const scan = opts.scan ?? await safely("intent folder", () => scanRepo(root), { intents: [], unreadable: [] } as Scan);
  const ordered = orderQueue(scan.intents);
  const titles = new Map(ordered.map((i) => [i.slug, i.file.title || i.slug]));
  const live = loopNow(root, pollSeconds, now);
  const { beat, state: hb } = live;
  const runningNow = await safely("running steps", () => runningPhases(trace, runningRows(trace, live), titles), [] as RunningPhase[]);
  const busy = new Set(runningNow.map((p) => p.slug));
  const loop: LoopSection = {
    ...hb,
    working: hb.working.map((w) => ({ slug: w.slug, phase: runningNow.filter((p) => p.slug === w.slug).map((p) => p.name).join(" + ") || null })),
    nextCheck: nextCheck(hb.state === "running" && !hb.working.length ? beat?.lastTickAt : null, pollSeconds),
    held: live.held,
  };
  const human = humanGates(cfg);
  const holds = cfg ? await safely("same-file waits", () => sameFileHolds(cfg.speed.max_parallel_changes, ordered), new Map<string, string>()) : new Map<string, string>();
  const changes = await safely("changes", () => ordered.map((i) => changeSummary(root, trace, i, ordered, holds.get(i.slug), busy, now, human)), [] as ChangeSummary[]);
  const inbox = await safely("needs attention", () => attention(root, config, trace, now, scan), [] as AttentionItem[]);
  const recent = await safely("finished steps", () => recentPhases(trace), [] as FinishedPhase[]);
  const totals = await safely("costs", () => totalsOf(trace.allPhases(), now), { todayUsd: 0, weekUsd: 0, allUsd: 0 });
  const requests = await safely("waiting requests", () => pendingRequests(root).flatMap(pendingView), [] as PendingRequest[]);
  for (const what of problems) inbox.push({ kind: "config", label: "Console", slug: null, title: "Part of the console could not be read", what });
  return {
    meta: { chat: opts.chat ?? false, usdPerMinute: USD_PER_MINUTE, pollSeconds },
    sections: { loop, inbox, changes, running: { now: runningNow, recent }, totals, requests },
  };
}

/** When the next tick is due, from the last one; null without one, or when it is not a time a file could be trusted for. */
function nextCheck(lastTickAt: string | null | undefined, pollSeconds: number): string | null {
  const last = lastTickAt ? Date.parse(lastTickAt) : NaN;
  return Number.isFinite(last) ? new Date(last + pollSeconds * 1000).toISOString() : null;
}

/**
 * One change as the board and the lists show it. `heldBy`: the change it waits for over the same
 * files. `human`: who sits on each gate, which decides whether Approve and Send back are offered.
 */
export function changeSummary(root: string, trace: Trace, i: Intent, all: Intent[], heldBy: string | undefined, busy: ReadonlySet<string>, now: Date, human: HumanGates): ChangeSummary {
  const fm = i.file.frontmatter;
  const since = statusSince(trace, i);
  return {
    slug: i.slug, title: i.file.title || i.slug, status: fm.status, plain: plainStatus(fm.status), priority: effectivePriority(fm),
    stage: STAGE[fm.status], since, inStatus: since ? agoText(now.getTime() - Date.parse(since)) : null,
    costUsd: endedCost(trace.phases(i.slug)), waiting: waitNote(i, all, heldBy) || null, note: fm.note, running: busy.has(i.slug),
    held: fm.hold.trim() || null, statedPriority: fm.priority ?? null,
    offers: offers(fm, human, fm.status === "blocked" ? retryOptions(trace, i.slug, fm.note) : []),
    question: openQuestion(root, i),
  };
}

/** The change's unanswered question, when intent.md says one is open and question.json has it. */
function openQuestion(root: string, i: Intent): ChangeSummary["question"] {
  if (!i.file.frontmatter.question.trim()) return null;
  const q = readQuestion(root, i.slug)?.open;
  if (!q || q.answer || typeof q.text !== "string") return null;
  return { text: q.text, why: typeof q.why === "string" ? q.why : "", options: Array.isArray(q.options) ? q.options.map(String) : [], phase: String(q.phase ?? "") };
}

/**
 * A waiting request as the page shows it, as a list of one, or none when the file is not one the
 * page can show (a request file can say anything): one bad file never hides the others.
 */
function pendingView(r: Request): PendingRequest[] {
  try {
    const slug = "slug" in r && typeof r.slug === "string" ? r.slug : null;
    if (r.kind === "new" && !Array.isArray(r.intents)) return [];
    const count = r.kind === "new" ? r.intents.length : 0;
    // An accept has no `expect`, which requestLabel does not read for it.
    const label = r.kind === "new" ? `Add ${count} written intent${count === 1 ? "" : "s"}` : requestLabel(r as Parameters<typeof requestLabel>[0]);
    return typeof label === "string" ? [{ id: r.id, kind: r.kind, slug, label, byName: r.byName, via: r.via, at: r.at }] : [];
  } catch {
    return [];
  }
}

/** What phases cost; a running one's budget hold is not spending. */
export function endedCost(phases: PhaseRow[]): number {
  return phases.reduce((n, p) => n + (p.status === "running" ? 0 : p.cost_usd ?? 0), 0);
}

/**
 * When the change entered its status: the newest traced change into it, if that is the newest traced
 * change at all; otherwise (a person edited the status) when intent.md was last written.
 */
function statusSince(trace: Trace, i: Intent): string | null {
  const last = trace.lastEvent(i.slug, "status_change");
  if (last && parsePayload(last.payload).to === i.file.frontmatter.status) return last.ts;
  try { return statSync(join(i.dir, "intent.md")).mtime.toISOString(); } catch { return null; }
}

/** The loop's heartbeat and the state it shows, read the same way for every screen. */
export function loopNow(root: string, pollSeconds: number, now: Date): { beat: Heartbeat | null; state: LoopStatus; held: LoopHold | null } {
  const beat = readHeartbeat(root);
  const held = readLoopHold(root);
  return { beat, state: heartbeatState(beat, pollSeconds, now, { pause: readPause(root), hold: held }), held };
}

/**
 * The phases running now, per change, for the board and a change's page alike: of the changes a
 * live heartbeat says the loop is working on (none without one), the phases started since its
 * current tick began. A row a killed process left running is not current.
 */
export function runningRows(trace: Trace, loop: { beat: Heartbeat | null; state: LoopStatus }): Map<string, PhaseRow[]> {
  const since = loop.beat?.lastTickAt ?? null;
  const out = new Map<string, PhaseRow[]>();
  for (const { slug } of loop.state.working) {
    const rows = trace.phases(slug).filter((p) => p.status === "running" && !(since && p.started < since));
    if (rows.length) out.set(slug, rows);
  }
  return out;
}

/** The running phases as cards, in the order the heartbeat names their changes. */
function runningPhases(trace: Trace, running: ReadonlyMap<string, PhaseRow[]>, titles: ReadonlyMap<string, string>): RunningPhase[] {
  const out: RunningPhase[] = [];
  for (const [slug, rows] of running) {
    for (const p of rows) {
      const events = trace.phaseEvents(slug, p.seq, STRIP * 2).filter((e) => e.type === "claude_event").map((e) => parsePayload(e.payload) as Summary);
      out.push({
        slug, title: titles.get(slug) ?? slug, seq: p.seq, name: p.name, started: p.started,
        model: modelOf(trace.firstEvent(slug, p.seq, "claude_event")),
        now: p.kind === "agent" ? nowLine(events) : `Running ${p.name}`,
        strip: stripOf(events),
        steerable: steerable(p.name),
      });
    }
  }
  return out;
}

function modelOf(e: EventRow | null): string | null {
  const s = (e ? parsePayload(e.payload) : {}) as Summary;
  return s.type === "system" && s.subtype === "init" && typeof s.model === "string" ? s.model : null;
}

/** What a session is doing, from its newest summaries: its last tool call or line of text. */
export function nowLine(events: Summary[]): string {
  for (let k = events.length - 1; k >= 0; k--) {
    const s = events[k]!;
    if (s.type === "result") return "Finishing";
    if (s.type !== "assistant" || !s.items?.length) continue;
    for (let j = s.items.length - 1; j >= 0; j--) {
      const item = s.items[j]!;
      if (item.startsWith("tool:")) return nowText(item.slice(5), s.targets?.[j] ?? "");
      if (item.startsWith("text:")) {
        const text = item.slice(5).split(/\r?\n/)[0]!.trim();
        if (text) return text;
      }
    }
    return "Thinking";
  }
  return "Starting";
}

/** A session's newest activity, one entry per tool call, piece of text, or result. */
export function stripOf(events: Summary[]): RunningPhase["strip"] {
  const out: RunningPhase["strip"] = [];
  for (const s of events) {
    if (s.type === "result") out.push("result");
    else if (s.type === "assistant") {
      for (const item of s.items ?? []) {
        if (item.startsWith("tool:")) out.push("tool");
        else if (item.startsWith("text:")) out.push("text");
      }
    }
  }
  return out.slice(-STRIP);
}

/** The five newest finished steps of any change; chat's turns are left out. */
function recentPhases(trace: Trace): FinishedPhase[] {
  return trace.recentPhases(20).filter((p) => p.slug !== CHAT_SLUG).slice(0, 5).map((p) => ({
    slug: p.slug, seq: p.seq, name: p.name, status: p.status, ended: p.ended!,
    durationMs: Math.max(0, Date.parse(p.ended!) - Date.parse(p.started)), costUsd: p.cost_usd ?? 0,
  }));
}

/** What was spent today, this week (from Monday, local time) and in all, chat included. */
export function totalsOf(phases: PhaseRow[], now: Date): Totals {
  const day = new Date(startOfToday(now));
  const week = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  let todayUsd = 0, weekUsd = 0, allUsd = 0;
  for (const p of phases) {
    const cost = p.status === "running" ? 0 : p.cost_usd ?? 0;
    const t = Date.parse(p.started);
    allUsd += cost;
    if (t >= week.getTime()) weekUsd += cost;
    if (t >= day.getTime()) todayUsd += cost;
  }
  return { todayUsd, weekUsd, allUsd };
}
