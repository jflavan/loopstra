import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { loadConfig, type Config } from "../config";
import { agoText, heartbeatState, readHeartbeat, type LoopStatus } from "../heartbeat";
import { effectivePriority, orderQueue, plainStatus, scanRepo, type Intent, type Status, type Unreadable } from "../intents";
import { humanNote } from "../stages/shared";
import { Trace } from "../trace";

/** Files a phase can leave behind, in the order the dashboard lists them. */
const PHASE_FILES = ["prompt.md", "envelope.json", "raw.jsonl"] as const;

export interface PhaseView {
  seq: number; name: string; kind: string; status: string; started: string; ended: string | null;
  /** Ended minus started; for a running phase, so far. */
  durationMs: number; costUsd: number; error: string | null;
  files: Array<{ name: string; url: string }>;
}

export interface IntentView {
  slug: string; title: string; status: string; plain: string; priority: string; note: string; costUsd: number;
  /** When the intent entered its current status (best known), and how long ago in plain words. */
  since: string | null; inStatus: string | null;
  phases: PhaseView[];
  gates: Array<{ gate: string; check: string; result: string; evidence: string; ts: string }>;
}

export interface AttentionItem {
  kind: "health" | "config" | "blocked" | "unreadable" | "waiting";
  /** The change it is about; null for the repository as a whole. */
  slug: string | null;
  title: string;
  /** What a person should do or know, in plain words. */
  what: string;
}

export interface UiState {
  generatedAt: string;
  loop: LoopStatus;
  attention: AttentionItem[];
  totals: { todayUsd: number; weekUsd: number; allUsd: number };
  intents: IntentView[];
  unreadable: Array<Pick<Unreadable, "slug" | "problem">>;
  health: { result: string; ts: string; text: string } | null;
  signals: Array<{ name: string; ts: string; result: string; output: string }>;
  events: Array<{ id: number; slug: string; phase_seq: number | null; type: string; ts: string; payload: unknown }>;
  lastEventId: number;
}

/** Everything the dashboard shows, read from the intent files, the trace, and the heartbeat. */
export async function buildState(root: string, afterEventId: number, now: Date = new Date()): Promise<UiState> {
  let cfg: Config | null = null;
  let configProblem: string | null = null;
  try { cfg = await loadConfig(root); } catch (e) { configProblem = e instanceof Error ? e.message : String(e); }
  const scan = await scanRepo(root);
  const ordered = orderQueue(scan.intents);
  const trace = Trace.open(root);
  try {
    const intents = ordered.map((i) => intentView(root, trace, i, now));
    const hb = heartbeatState(readHeartbeat(root), cfg?.poll_seconds ?? 60, now);
    const loop: LoopStatus = hb.current
      ? { ...hb, current: { slug: hb.current.slug, phase: hb.current.phase ?? runningPhase(intents, hb.current.slug) } }
      : hb;
    const health = healthView(trace, now);
    const events = trace.recentEvents(afterEventId, 200).map((e) => ({ ...e, payload: parsePayload(e.payload) }));
    const lastEventId = events.length ? Math.max(...events.map((e) => e.id)) : afterEventId;
    return {
      generatedAt: now.toISOString(),
      loop,
      attention: attention(ordered, scan.unreadable, cfg, configProblem, health),
      totals: totals(intents, now),
      intents,
      unreadable: scan.unreadable.map((u) => ({ slug: u.slug, problem: u.problem })),
      health,
      signals: trace.signals(20),
      events,
      lastEventId,
    };
  } finally {
    trace.close();
  }
}

function intentView(root: string, trace: Trace, i: Intent, now: Date): IntentView {
  const fm = i.file.frontmatter;
  const phases: PhaseView[] = trace.phases(i.slug).map((p) => {
    const end = p.ended ? Date.parse(p.ended) : now.getTime();
    const dir = `${p.seq}-${p.name}`;
    const files = PHASE_FILES
      .filter((f) => existsSync(join(runsDir(root), i.slug, "phases", dir, f)))
      .map((f) => ({ name: f, url: `/files/${[i.slug, "phases", dir, f].map(encodeURIComponent).join("/")}` }));
    return {
      seq: p.seq, name: p.name, kind: p.kind, status: p.status, started: p.started, ended: p.ended,
      durationMs: Math.max(0, end - Date.parse(p.started)), costUsd: p.cost_usd ?? 0, error: p.error, files,
    };
  });
  const since = statusSince(trace, i);
  return {
    slug: i.slug, title: i.file.title || i.slug, status: fm.status, plain: plainStatus(fm.status),
    priority: effectivePriority(fm), note: fm.note, costUsd: phases.reduce((n, p) => n + p.costUsd, 0),
    since, inStatus: since ? agoText(now.getTime() - Date.parse(since)) : null,
    phases, gates: trace.gates(i.slug),
  };
}

/**
 * When the intent entered its status: the newest traced change into it, if that is the newest
 * traced change at all; otherwise (a person edited the status) when intent.md was last written.
 */
function statusSince(trace: Trace, i: Intent): string | null {
  const changes = trace.events(i.slug, 0, 100_000).filter((e) => e.type === "status_change");
  const last = changes[changes.length - 1];
  if (last && (parsePayload(last.payload) as { to?: string }).to === i.file.frontmatter.status) return last.ts;
  try { return statSync(join(i.dir, "intent.md")).mtime.toISOString(); } catch { return null; }
}

function runningPhase(intents: IntentView[], slug: string): string | null {
  const phases = intents.find((i) => i.slug === slug)?.phases ?? [];
  return [...phases].reverse().find((p) => p.status === "running")?.name ?? null;
}

function healthView(trace: Trace, now: Date): UiState["health"] {
  const newest = trace.lastSignal("main_health");
  if (!newest) return null;
  const red = trace.lastSignal("main_health", { excludeErrors: true })?.result === "fail";
  const when = `${agoText(now.getTime() - Date.parse(newest.ts))} ago`;
  const text = newest.result === "pass" ? `The tests on main pass (checked ${when}).`
    : red ? `The tests on main are failing (checked ${when}).`
    : `The last check of main could not run (${when}). An engineer can find the details in the trace.`;
  return { result: red ? "fail" : newest.result, ts: newest.ts, text };
}

/** Review statuses and the gate that decides whether a person is on them. */
const REVIEW: Partial<Record<Status, { gate: "spec" | "plan" | "merge" | "done"; artifact: string; approved: Status }>> = {
  "spec-review": { gate: "spec", artifact: "spec.md", approved: "spec-approved" },
  "plan-review": { gate: "plan", artifact: "plan.md", approved: "plan-approved" },
  "merge-review": { gate: "merge", artifact: "review.md", approved: "merge-approved" },
  verifying: { gate: "done", artifact: "outcome.md", approved: "done" },
};

function attention(intents: Intent[], unreadable: Unreadable[], cfg: Config | null, configProblem: string | null, health: UiState["health"]): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (health && health.result !== "pass") items.push({ kind: "health", slug: null, title: "Main branch", what: health.text });
  if (configProblem) items.push({ kind: "config", slug: null, title: "Loopstra settings", what: configProblem });
  for (const i of intents) {
    const fm = i.file.frontmatter;
    const title = i.file.title || i.slug;
    if (fm.status === "blocked") {
      items.push({ kind: "blocked", slug: i.slug, title, what: fm.note || "Stopped and needs a person. Read intent.md, then set the status line to continue." });
    }
  }
  for (const u of unreadable) items.push({ kind: "unreadable", slug: u.slug, title: u.slug, what: u.problem });
  for (const i of intents) {
    const fm = i.file.frontmatter;
    const title = i.file.title || i.slug;
    if (fm.status === "draft") {
      items.push({ kind: "waiting", slug: i.slug, title, what: fm.note || "A draft. When it says what you want, change the status line to accepted. To drop it, set it to closed." });
      continue;
    }
    const review = REVIEW[fm.status];
    const surface = review && cfg ? cfg.gates[review.gate].human : "none";
    if (review && surface !== "none") items.push({ kind: "waiting", slug: i.slug, title, what: fm.note || humanNote(review.artifact, review.approved, surface) });
  }
  return items;
}

function totals(intents: IntentView[], now: Date): UiState["totals"] {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // The week starts on Monday, local time.
  const week = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  let todayUsd = 0, weekUsd = 0, allUsd = 0;
  for (const p of intents.flatMap((i) => i.phases)) {
    const t = Date.parse(p.started);
    allUsd += p.costUsd;
    if (t >= week.getTime()) weekUsd += p.costUsd;
    if (t >= day.getTime()) todayUsd += p.costUsd;
  }
  return { todayUsd, weekUsd, allUsd };
}

function parsePayload(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function runsDir(root: string): string {
  return join(root, ".loopstra", "runs");
}

/**
 * The real path of a file under `.loopstra/runs/`, or null. `rel` is the part of the URL after
 * `/files/`, already decoded. Refuses `..`, absolute and drive paths, stream names, anything that
 * is not a regular file, and anything whose real path (after links) leaves the runs directory.
 */
export function resolveRunFile(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.includes(":") || isAbsolute(rel) || /^[\\/]/.test(rel)) return null;
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) return null;
  const base = runsDir(root);
  if (!existsSync(base)) return null;
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(resolve(base, ...parts));
    if (!real.startsWith(realBase + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The dashboard: `/` is the page, `/api/state?after=<event id>` its data, `/files/...` run files, read-only. */
export function serveUi(root: string, port = 4646): ReturnType<typeof Bun.serve> {
  const page = join(import.meta.dir, "..", "ui", "index.html");
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Read only", { status: 405 });
      const url = new URL(req.url);
      if (url.pathname === "/api/state") {
        const after = Number(url.searchParams.get("after") ?? 0);
        return Response.json(await buildState(root, Number.isFinite(after) && after > 0 ? after : 0));
      }
      if (url.pathname.startsWith("/files/")) {
        let rel: string;
        try { rel = decodeURIComponent(url.pathname.slice("/files/".length)); } catch { return NOT_FOUND(); }
        const path = resolveRunFile(root, rel);
        if (!path) return NOT_FOUND();
        return new Response(Bun.file(path), { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(page), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return NOT_FOUND();
    },
  });
}
