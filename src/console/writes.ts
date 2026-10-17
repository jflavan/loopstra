import { existsSync } from "node:fs";
import { join } from "node:path";
import { offers, retryOptions, undoMatches } from "../actions";
import { localUser } from "../chat/transports/shared";
import { loadConfig, type Config } from "../config";
import { holdLoop, readLoopHold, releaseLoop } from "../heartbeat";
import { humanGates, PRIORITIES, readIntent, SLUG, STATUSES, type Frontmatter, type Priority, type Status } from "../intents";
import { cancelRequest, CONSOLE, requestState, submitRequest, type RequestBody } from "../requests";
import { Trace } from "../trace";
import { touchWake } from "../wake";
import type { Hub } from "./hub";
import { loopNow } from "./model";

/** The longest note a send back takes, and the longest hold reason. */
const MAX_NOTE = 4_000;
const MAX_REASON = 300;
const KINDS = ["approve", "send-back", "retry", "accept", "close", "priority", "hold", "release", "undo"] as const;
type Kind = (typeof KINDS)[number];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (error: string, status = 409) => json({ error }, status);

/**
 * The console's writes: requests for the loop (`/api/requests`, with GET and DELETE of one by id)
 * and the loop's pause (`/api/loop`). Null for any other path. Every write must come from the page
 * itself (its Origin), and a POST must be JSON: a page framed or opened by another site cannot send
 * either (see "Safety of writes" in the spec).
 */
export async function writes(root: string, hub: Hub, req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const one = path.match(/^\/api\/requests\/([^/]+)$/);
  if (path !== "/api/requests" && path !== "/api/loop" && !one) return null;
  // Only GET reads a result, which reading removes: a HEAD would take it with no body to carry it.
  if (one && req.method === "HEAD") return new Response("Method not allowed", { status: 405 });
  if (one && req.method === "GET") {
    const s = requestState(root, decode(one[1]!));
    return s ? json(s.state === "pending" ? { state: "pending" } : { state: "done", ok: s.ok, text: s.text, status: s.status }) : json({ error: "unknown request" }, 404);
  }
  if (req.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
  if (one && req.method === "DELETE") {
    const cancelled = cancelRequest(root, decode(one[1]!));
    hub.poke();
    return json({ cancelled }, cancelled ? 200 : 409);
  }
  if (req.method !== "POST" || one) return new Response("Method not allowed", { status: 405 });
  if (!isJson(req.headers.get("content-type"))) return new Response("Expected JSON", { status: 415 });
  let body: unknown;
  try { body = await req.json(); } catch { return refuse("The request was not JSON.", 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse("The request was not an object.", 400);
  const fields = body as Record<string, unknown>;
  const answer = path === "/api/loop" ? loop(root, fields) : await action(root, fields);
  hub.poke();
  return answer;
}

/** True when a content type's MIME essence (before any parameters) is JSON. */
function isJson(ct: string | null): boolean {
  return ((ct ?? "").split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

/** A path part as text; one that cannot be decoded is no request id (requestState and cancelRequest say so). */
function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return ""; }
}

function loop(root: string, body: Record<string, unknown>): Response {
  if (body.action === "pause") return json({ held: readLoopHold(root) ?? holdLoop(root, localUser()) });
  if (body.action === "resume") {
    releaseLoop(root);
    touchWake(root);
    return json({ held: null });
  }
  return refuse("Say pause or resume.", 400);
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const isStatus = (v: unknown): v is Status => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

/** The body as a request, or why it is not one (a 400). */
function parse(body: Record<string, unknown>): RequestBody | string {
  const kind = str(body.kind);
  const slug = str(body.slug);
  if (!kind || !(KINDS as readonly string[]).includes(kind)) return "Unknown action.";
  if (!slug || !SLUG.test(slug)) return "Unknown change.";
  const k = kind as Kind;
  if (k === "accept") return { kind: k, slug };
  const expect = body.expect;
  if (!isStatus(expect)) return "Say which status the change was at.";
  switch (k) {
    case "approve": return { kind: k, slug, expect };
    case "close": return { kind: k, slug, expect };
    case "release": return { kind: k, slug, expect };
    case "send-back": {
      const note = str(body.note)?.trim() ?? "";
      if (!note || note.length > MAX_NOTE) return `Say what should change (at most ${MAX_NOTE} characters).`;
      return { kind: k, slug, expect, note };
    }
    // Well formed from any status; one not blocked is refused below as not offered (a 409, not a 400).
    case "retry": return isStatus(body.to) ? { kind: k, slug, expect: expect as "blocked", to: body.to } : "Say which status to retry from.";
    case "undo": return isStatus(body.to) && typeof body.note === "string" && body.note.length <= MAX_NOTE ? { kind: k, slug, expect, to: body.to, note: body.note } : "Say which status to go back to.";
    case "priority": return typeof body.priority === "string" && (PRIORITIES as readonly string[]).includes(body.priority) ? { kind: k, slug, expect, priority: body.priority as Priority } : "Unknown priority.";
    case "hold": {
      const reason = str(body.reason)?.trim() ?? "";
      return reason.length <= MAX_REASON ? { kind: k, slug, expect, reason } : `A reason is at most ${MAX_REASON} characters.`;
    }
  }
}

/**
 * True when the change offers the action now (see offers), or, for an undo, when it takes back the
 * step that happened last (see undoMatches). Reads the trace, which it opens and closes.
 */
function allowed(root: string, r: Exclude<RequestBody, { kind: "new" }>, fm: Frontmatter, cfg: Config | null): boolean {
  const trace = Trace.open(root, () => {});
  try {
    if (r.kind === "undo") return undoMatches(trace, r.slug, r.expect, r.to);
    const offered = offers(fm, humanGates(cfg), fm.status === "blocked" ? retryOptions(trace, r.slug, fm.note) : []);
    return offered.some((o) => o.kind === r.kind && (r.kind !== "retry" || o.to === r.to));
  } finally {
    trace.close();
  }
}

/**
 * Checks the action against the change as it is now (the loop checks again when it applies it),
 * then leaves it for the loop. The answer says whether the loop is running, so the page can say
 * "applies when the loop starts".
 */
async function action(root: string, body: Record<string, unknown>): Promise<Response> {
  const r = parse(body);
  if (typeof r === "string") return refuse(r, 400);
  if (r.kind === "new") return refuse("Unknown action.", 400);
  if (!existsSync(join(root, "intent", r.slug, "intent.md"))) return refuse(`There is no change called ${r.slug}.`, 404);
  let cfg: Config | null = null;
  try { cfg = await loadConfig(root); } catch { /* nobody on any gate, as the model reads it too */ }
  let fm: Frontmatter;
  try { fm = (await readIntent(root, r.slug)).file.frontmatter; } catch { return refuse(`${r.slug}'s intent.md cannot be read.`); }
  const expect = r.kind === "accept" ? "draft" : r.expect;
  const status = fm.status;
  // Priority, hold and release land on any open change, whatever its status now (see apply.ts).
  const fieldOnly = r.kind === "priority" || r.kind === "hold" || r.kind === "release";
  if (!fieldOnly && status !== expect) return refuse(`${r.slug} is ${status} now, not ${expect}. The page shows it as it is now.`);
  if (!allowed(root, r, fm, cfg)) return refuse(r.kind === "undo" ? "That cannot be undone now." : `That is not something ${r.slug} can do now.`);
  const user = localUser();
  const sent = submitRequest(root, { ...r, by: user, byName: user, via: "the dashboard", transport: CONSOLE, thread: "" });
  return json({ id: sent.id, loop: loopNow(root, cfg?.poll_seconds ?? 60, new Date()).state.state }, 202);
}
