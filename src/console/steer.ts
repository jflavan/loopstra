import { existsSync } from "node:fs";
import { join } from "node:path";
import { localUser } from "../chat/transports/shared";
import { loadConfig } from "../config";
import { readIntent, SLUG } from "../intents";
import { sendToSession, writeChangeStop, type InboxMessage } from "../inbox";
import { CONSOLE, submitRequest } from "../requests";
import { Trace, type PhaseRow } from "../trace";
import type { Hub } from "./hub";
import { loopNow, runningRows } from "./model";
import { steerable } from "./steerable";
import { fromPage, isJson } from "./writes";

/** The longest message or redirect a person may send a session. */
const MAX_TEXT = 4_000;
/** Where a person steers from, in words, for the inbox and the hold. */
const VIA = "the dashboard";
/** The hold a stop leaves, so the change does not start again at once. */
const STOP_REASON = "Stopped from the dashboard";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const refuse = (error: string, status = 409) => json({ error }, status);

/**
 * The console's steering writes (null for any other path):
 * - `POST /api/sessions/<slug>/<seq>/message` with `{ kind: "message" | "redirect" | "stop", text }`:
 *   leaves it in the running session's inbox (see src/inbox.ts); a stop also leaves the change's stop
 *   (see writeChangeStop) and a hold request.
 * - `POST /api/changes/<slug>/stop`: a stop for every running session of the change, the change's stop, and one hold.
 * Each needs the page's own Origin and a JSON body, as the other writes (see writes.ts).
 */
export async function steerRoutes(root: string, hub: Hub, req: Request, url: URL): Promise<Response | null> {
  const session = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(\d+)\/message$/);
  const change = url.pathname.match(/^\/api\/changes\/([^/]+)\/stop$/);
  if (!session && !change) return null;
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!fromPage(req, url)) return new Response("Forbidden", { status: 403 });
  if (!isJson(req.headers.get("content-type"))) return new Response("Expected JSON", { status: 415 });
  let body: unknown;
  try { body = await req.json(); } catch { return refuse("The request was not JSON.", 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse("The request was not an object.", 400);
  const slug = decode((session ?? change)![1]!);
  if (!SLUG.test(slug) || !existsSync(join(root, "intent", slug, "intent.md"))) return refuse(`There is no change called ${slug}.`, 404);
  const answer = session ? await toSession(root, slug, Number(session[2]), body as Record<string, unknown>) : await stopChange(root, slug);
  hub.poke();
  return answer;
}

/** A message, redirect or stop for one running session. */
async function toSession(root: string, slug: string, seq: number, body: Record<string, unknown>): Promise<Response> {
  const kind = body.kind;
  if (kind !== "message" && kind !== "redirect" && kind !== "stop") return refuse("Say message, redirect or stop.", 400);
  const text = kind === "stop" ? "" : typeof body.text === "string" ? body.text.trim() : "";
  if (kind !== "stop" && (!text || text.length > MAX_TEXT)) return refuse(`Say what to tell the session (at most ${MAX_TEXT} characters).`, 400);
  const row = (await running(root, slug)).find((p) => p.seq === seq);
  if (!row) return refuse("That session is not running.");
  if (kind !== "stop" && !steerable(row.name)) return refuse("Checks cannot be messaged. Approve or send back instead.");
  const sent = send(root, slug, seq, kind, text);
  if (kind === "stop") {
    // The change's stop too: a stop that crosses into the next phase (design to design-retry) still lands.
    writeChangeStop(root, slug, localUser());
    await hold(root, slug);
  }
  return json({ id: sent.id }, 202);
}

/** A stop for every running session of the change, and one hold. */
async function stopChange(root: string, slug: string): Promise<Response> {
  const rows = await running(root, slug);
  if (!rows.length) return refuse(`Nothing of ${slug} is running.`);
  for (const p of rows) send(root, slug, p.seq, "stop", "");
  // Code phases read no inbox: the change's stop ends the step at its next phase.
  writeChangeStop(root, slug, localUser());
  await hold(root, slug);
  return json({ stopped: rows.length }, 202);
}

function send(root: string, slug: string, seq: number, kind: InboxMessage["kind"], text: string): InboxMessage {
  return sendToSession(root, slug, { seq, kind, text, by: localUser(), via: VIA });
}

/**
 * The change's phases running now, by the board's rule (see runningRows): started since the current
 * tick of a live loop that says it works on the change.
 */
async function running(root: string, slug: string): Promise<PhaseRow[]> {
  let pollSeconds = 60;
  try { pollSeconds = (await loadConfig(root)).poll_seconds; } catch { /* the default, as the model reads it */ }
  const trace = Trace.open(root, () => {});
  try {
    return runningRows(trace, loopNow(root, pollSeconds, new Date())).get(slug) ?? [];
  } finally {
    trace.close();
  }
}

/**
 * Leaves a hold request with the stop, so the change does not start again on the next tick; none when
 * it is held already (the loop would refuse a second one). A change whose intent.md cannot be read
 * gets none: the stop alone still ends its sessions.
 */
async function hold(root: string, slug: string): Promise<void> {
  let fm;
  try { fm = (await readIntent(root, slug)).file.frontmatter; } catch { return; }
  if (fm.hold.trim()) return;
  const user = localUser();
  submitRequest(root, { kind: "hold", slug, expect: fm.status, reason: STOP_REASON, by: user, byName: user, via: VIA, transport: CONSOLE, thread: "" });
}

/** A path part as text; one that cannot be decoded is no change name. */
function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return ""; }
}
