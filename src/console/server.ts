import { errorText } from "../shell";
import page from "../ui/index.html";
import type { DashboardTransport } from "../chat/transports/dashboard";
import { loadConfig, type Config } from "../config";
import { SLUG } from "../intents";
import { Trace } from "../trace";
import { eventsPage } from "./describe";
import { agentFilesAction, agentsView, SOURCE_IDLE_SECONDS, sourceItems } from "./agent-settings";
import { streamAgents } from "./agents";
import { changeDetail, spendView } from "./detail";
import { changeDiff } from "./diff";
import { settingsView } from "./settings";
import { resolveDocument, resolveRunFile } from "./files";
import { Hub, type Send } from "./hub";
import { decode, json, jsonWrite, NO_STORE, ownSite, plain, refuse } from "./routes";
import { streamSession } from "./session";
import { steerRoutes } from "./steer";
import { resumePoint } from "./transcript";
import { ANY_SLUG } from "./types";
import { writes } from "./writes";

/** Host names the console answers to: a page on another name that resolves here (DNS rebinding) gets nothing. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A file's text, which the browser must not read as anything else; read fresh every time (see NO_STORE). */
const PLAIN_TEXT = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...NO_STORE };
/** The largest body a write may carry: the longest message is 20,000 characters, so anything near this is not the page's. */
const MAX_BODY_BYTES = 1024 * 1024;

type Timeouts = { timeout(req: Request, seconds: number): void };

/**
 * How long a JSON route may stay silent before Bun drops it (its default is 10 s). The diff route lets
 * git take 30 s (DIFF_TIMEOUT_MS), so the limit must be above that or a slow diff is cut off by the
 * server and the page wrongly says the change has no branch.
 */
export const JSON_IDLE_SECONDS = 60;

/**
 * The console on 127.0.0.1. Bun bundles the page once at start and serves it and its chunks itself,
 * on the screens' paths (the page's router knows the same ones). They are the same static code for
 * everyone and never reach `fetch`, so only the data routes check the host. Its only writes are
 * `/api/chat` (when `chat` is given, see DashboardTransport), `/api/requests` and `/api/loop` (see
 * writes.ts), steering a running session (see steer.ts) and `/api/agents/files` (see
 * agent-settings.ts); each needs the page's own Origin (see jsonWrite in routes.ts).
 */
export function serveConsole(root: string, port = 4646, opts: { chat?: DashboardTransport; hub?: Hub } = {}): ReturnType<typeof Bun.serve> {
  const hub = opts.hub ?? new Hub(root, { chat: !!opts.chat });
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,
    // Bun drops the connection of a request whose body is bigger, before reading it into memory.
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: { "/": page, "/inbox": page, "/changes": page, "/activity": page, "/agents": page, "/spend": page, "/settings": page, "/c/*": page, "/s/*": page },
    async fetch(req, server) {
      const url = new URL(req.url);
      if (!LOCAL_HOSTS.has(url.hostname)) return plain("Forbidden", 403);
      if (url.pathname === "/api/chat" && opts.chat) return opts.chat.handle(req, url);
      const written = (await writes(root, hub, req, url)) ?? (await steerRoutes(root, hub, req, url)) ?? (await agentFiles(root, hub, req, url, server));
      if (written) return written;
      if (req.method !== "GET" && req.method !== "HEAD") return plain("Read only", 405);
      return (await read(root, hub, req, url, server)) ?? plain("Not found", 404);
    },
    // A route that fails says so in plain words; the stack stays on this machine's stderr, not on the page.
    error(e) {
      console.error(`loopstra ui: a request failed: ${errorText(e).replace(/\s+/g, " ")}`);
      return plain("Server error", 500);
    },
  });
}

/**
 * `/api/agents/files`: an operation on the repository's agents and skills, left for the loop as an
 * `agent-files` request. A fetch clones, so it may take as long as a clone may. Null for any other path.
 */
async function agentFiles(root: string, hub: Hub, req: Request, url: URL, server: Timeouts): Promise<Response | null> {
  if (url.pathname !== "/api/agents/files") return null;
  server.timeout(req, SOURCE_IDLE_SECONDS);
  return jsonWrite(req, url, async (body) => {
    const answer = await agentFilesAction(root, body);
    hub.poke();
    return answer;
  });
}

/**
 * The data routes: `/api/stream`, `/api/agents/stream`, `/api/agents` and `/api/agents/source`, `/api/changes/<slug>` and its `/diff`, `/api/sessions/<slug>/<seq>/stream`,
 * `/api/events`, `/api/spend`, `/api/settings`, run files under `/files/`, a change's documents under `/docs/`. Null: not found.
 * Exported so a test can pass a fake `Timeouts`.
 */
export async function read(root: string, hub: Hub, req: Request, url: URL, server: Timeouts): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/stream") {
    // The browser sends Last-Event-ID only when it reconnects by itself; a page opening a new stream
    // (after the browser gave up, or after a silence) names the newest event it saw in ?after= instead.
    const last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0);
    return sse(server, req, async (send) => {
      const off = await hub.connect(send, Number.isFinite(last) && last > 0 ? last : 0);
      return () => void off();
    });
  }
  if (path === "/api/agents/stream") return sse(server, req, (send) => streamAgents(root, hub, send));
  if (path === "/api/agents") {
    server.timeout(req, JSON_IDLE_SECONDS);
    return json(await agentsView(root));
  }
  if (path === "/api/agents/source") {
    // It clones: only the page's own GET may start one (a HEAD, or another site's link or image, may not).
    if (req.method !== "GET") return plain("Method not allowed", 405);
    if (!ownSite(req, url)) return plain("Forbidden", 403);
    const source = url.searchParams.get("url")?.trim();
    if (!source) return refuse("Say which git repository or folder to look in.", 400);
    server.timeout(req, SOURCE_IDLE_SECONDS);
    const listed = await sourceItems(source);
    return "error" in listed ? refuse(listed.error) : json(listed);
  }
  const change = path.match(/^\/api\/changes\/([^/]+)(\/diff)?$/);
  if (change) {
    const slug = decode(change[1]!);
    if (!slug || !SLUG.test(slug)) return null;
    server.timeout(req, JSON_IDLE_SECONDS);
    if (change[2]) return json(await changeDiff(root, (await config(root))?.main_branch ?? "main", slug));
    const d = await withTrace(root, (t) => changeDetail(root, t, slug));
    return d ? json(d) : null;
  }
  const session = path.match(/^\/api\/sessions\/([^/]+)\/(\d+)\/stream$/);
  if (session) {
    const slug = decode(session[1]!);
    const seq = Number(session[2]);
    if (!slug || !ANY_SLUG.test(slug)) return null;
    if (!(await withTrace(root, (t) => t.phase(slug, seq) !== null))) return null;
    // A frame id names a row ("123.4" is a row inside the line that starts at byte 123); the stream goes on from its line.
    const from = resumePoint(req.headers.get("last-event-id") ?? url.searchParams.get("from"));
    return sse(server, req, (send, close) => streamSession(root, slug, seq, from, send, close) ?? (close(), () => {}));
  }
  if (path === "/api/events") {
    server.timeout(req, JSON_IDLE_SECONDS);
    const slug = url.searchParams.get("slug") || undefined;
    if (slug && !ANY_SLUG.test(slug)) return json({ error: "slug" }, 400);
    const before = Number(url.searchParams.get("before") ?? 0);
    return json(await withTrace(root, (t) => eventsPage(t, Number.isFinite(before) && before > 0 ? before : 0, slug, url.searchParams.get("technical") === "1")));
  }
  if (path === "/api/spend") {
    server.timeout(req, JSON_IDLE_SECONDS);
    const cfg = await config(root);
    return json(await withTrace(root, (t) => spendView(root, t, cfg)));
  }
  if (path === "/api/settings") return json(await withTrace(root, (t) => settingsView(root, t)));
  if (path.startsWith("/files/")) {
    const rel = decode(path.slice("/files/".length));
    const file = rel ? resolveRunFile(root, rel) : null;
    return file ? new Response(Bun.file(file), { headers: PLAIN_TEXT }) : null;
  }
  if (path.startsWith("/docs/")) {
    const parts = path.slice("/docs/".length).split("/").map(decode);
    const file = parts.length === 2 && parts[0] && parts[1] ? resolveDocument(root, parts[0], parts[1]) : null;
    return file ? new Response(Bun.file(file), { headers: PLAIN_TEXT }) : null;
  }
  return null;
}

const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "x-content-type-options": "nosniff", ...NO_STORE };

/**
 * An SSE response. `start` gets a writer and a closer and gives back the function that stops it,
 * which runs once, when the page goes away. The request's idle limit is lifted, since a quiet
 * stream is still alive. A HEAD gets the headers alone: no stream is opened for it, so it leaves
 * no page connected.
 */
function sse(server: Timeouts, req: Request, start: (send: Send, close: () => void) => (() => void) | Promise<() => void>): Response {
  if (req.method === "HEAD") return new Response(null, { headers: SSE_HEADERS });
  server.timeout(req, 0);
  let stop: (() => void) | null = null;
  let gone = false;
  const end = () => {
    if (gone) return;
    gone = true;
    stop?.();
  };
  const stream = new ReadableStream<string>({
    async start(controller) {
      const send: Send = (text) => {
        if (gone) return false;
        try { controller.enqueue(text); return true; } catch { return false; }
      };
      const close = () => { try { controller.close(); } catch { /* already closed */ } };
      stop = await start(send, close);
      if (gone) stop();
    },
    cancel: end,
  });
  req.signal.addEventListener("abort", end);
  return new Response(stream, { headers: SSE_HEADERS });
}

async function config(root: string): Promise<Config | null> {
  try { return await loadConfig(root); } catch { return null; }
}

async function withTrace<T>(root: string, fn: (t: Trace) => T | Promise<T>): Promise<T> {
  const trace = Trace.open(root);
  try { return await fn(trace); } finally { trace.close(); }
}
