import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { attention, healthView, type AttentionItem } from "../attention";
import { loadConfig, type Config } from "../config";
import { agoText, heartbeatState, readHeartbeat, readPause, type LoopStatus } from "../heartbeat";
import { ARTIFACTS, effectivePriority, intentRoot, orderQueue, plainStatus, scanRepo, shownNote, SLUG, type Intent, type Unreadable } from "../intents";
import { Trace } from "../trace";
import { errorText } from "../shell";

export type { AttentionItem } from "../attention";

/** Files a phase can leave behind, in the order the dashboard lists them. */
const PHASE_FILES = ["prompt.md", "envelope.json", "raw.jsonl"] as const;

export interface PhaseView {
  seq: number; name: string; kind: string; status: string; started: string; ended: string | null;
  /** Ended minus started; for a running phase, so far. */
  durationMs: number; costUsd: number; error: string | null;
  files: Array<{ name: string; url: string }>;
  /** Commands the session was not allowed to run (allow-rule text). */
  denied: string[];
}

export interface IntentView {
  slug: string; title: string; status: string; plain: string; priority: string; note: string; costUsd: number;
  /** When the intent entered its current status (best known), and how long ago in plain words. */
  since: string | null; inStatus: string | null;
  /** The change's own documents in intent/<slug>/ (intent.md, spec.md, ...), served read-only. */
  documents: Array<{ name: string; url: string }>;
  phases: PhaseView[];
  gates: Array<{ gate: string; check: string; result: string; evidence: string; ts: string }>;
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
  let config: Config | { problem: string };
  try { config = await loadConfig(root); } catch (e) { config = { problem: errorText(e) }; }
  const scan = await scanRepo(root);
  const ordered = orderQueue(scan.intents);
  const trace = Trace.open(root);
  try {
    const intents = ordered.map((i) => intentView(root, trace, i, ordered, now));
    const hb = heartbeatState(readHeartbeat(root), "problem" in config ? 60 : config.poll_seconds, now, { pause: readPause(root) });
    const loop: LoopStatus = hb.current
      ? { ...hb, current: { slug: hb.current.slug, phase: runningPhase(intents, hb.current.slug) } }
      : hb;
    const health = healthView(trace, now);
    const events = trace.recentEvents(afterEventId, 200).map((e) => ({ ...e, payload: parsePayload(e.payload) }));
    const lastEventId = events.length ? Math.max(...events.map((e) => e.id)) : afterEventId;
    return {
      generatedAt: now.toISOString(),
      loop,
      attention: await attention(root, config, trace, now),
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

function intentView(root: string, trace: Trace, i: Intent, all: Intent[], now: Date): IntentView {
  const fm = i.file.frontmatter;
  const denied = trace.deniedCommands(i.slug);
  const phases: PhaseView[] = trace.phases(i.slug).map((p) => {
    const end = p.ended ? Date.parse(p.ended) : now.getTime();
    const dir = `${p.seq}-${p.name}`;
    const files = PHASE_FILES
      .filter((f) => existsSync(join(runsDir(root), i.slug, "phases", dir, f)))
      .map((f) => ({ name: f, url: `/files/${[i.slug, "phases", dir, f].map(encodeURIComponent).join("/")}` }));
    return {
      seq: p.seq, name: p.name, kind: p.kind, status: p.status, started: p.started, ended: p.ended,
      durationMs: Math.max(0, end - Date.parse(p.started)), costUsd: p.cost_usd ?? 0, error: p.error, files,
      denied: denied.get(p.seq) ?? [],
    };
  });
  const since = statusSince(trace, i);
  const documents = ARTIFACTS.filter((a) => i.artifacts.has(a)).map((a) => ({ name: a, url: `/docs/${i.slug}/${a}` }));
  return {
    slug: i.slug, title: i.file.title || i.slug, status: fm.status, plain: plainStatus(fm.status),
    priority: effectivePriority(fm), note: shownNote(i, all), costUsd: phases.reduce((n, p) => n + p.costUsd, 0),
    since, inStatus: since ? agoText(now.getTime() - Date.parse(since)) : null,
    documents, phases, gates: trace.gates(i.slug),
  };
}

/**
 * When the intent entered its status: the newest traced change into it, if that is the newest
 * traced change at all; otherwise (a person edited the status) when intent.md was last written.
 */
function statusSince(trace: Trace, i: Intent): string | null {
  const last = trace.lastEvent(i.slug, "status_change");
  if (last && (parsePayload(last.payload) as { to?: string }).to === i.file.frontmatter.status) return last.ts;
  try { return statSync(join(i.dir, "intent.md")).mtime.toISOString(); } catch { return null; }
}

function runningPhase(intents: IntentView[], slug: string): string | null {
  const phases = intents.find((i) => i.slug === slug)?.phases ?? [];
  return [...phases].reverse().find((p) => p.status === "running")?.name ?? null;
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

/**
 * The real path of one of a change's own documents, `intent/<slug>/<name>`, or null. The slug must
 * be a valid change name and the name one of the documents Loopstra knows (intent.md, spec.md, ...);
 * the real path (after links) must stay inside the change's folder and be a regular file.
 */
export function resolveDocument(root: string, slug: string, name: string): string | null {
  if (!SLUG.test(slug) || !(ARTIFACTS as readonly string[]).includes(name)) return null;
  const dir = join(intentRoot(root), slug);
  try {
    const realDir = realpathSync(dir);
    const real = realpathSync(join(dir, name));
    if (!real.startsWith(realDir + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

const PLAIN_TEXT = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * The dashboard: `/` is the page, `/api/state?after=<event id>` its data, `/files/...` run files,
 * `/docs/<slug>/<name>` a change's own documents. Read-only.
 */
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
        return new Response(Bun.file(path), { headers: PLAIN_TEXT });
      }
      if (url.pathname.startsWith("/docs/")) {
        let parts: string[];
        try { parts = url.pathname.slice("/docs/".length).split("/").map(decodeURIComponent); } catch { return NOT_FOUND(); }
        const path = parts.length === 2 ? resolveDocument(root, parts[0]!, parts[1]!) : null;
        if (!path) return NOT_FOUND();
        return new Response(Bun.file(path), { headers: PLAIN_TEXT });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(page), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return NOT_FOUND();
    },
  });
}
