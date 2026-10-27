import { join } from "node:path";
import { isStatus, offers, questionChangedText, REQUEST_KINDS, retryOptions, sameQuestion, undoMatches, type RequestKind } from "../actions";
import { localUser } from "../chat/transports/shared";
import { DEFAULT_POLL_SECONDS, loadConfig, type Config } from "../config";
import { holdLoop, readLoopHold, releaseLoop } from "../heartbeat";
import { changeExists, humanGates, PRIORITIES, readIntent, SLUG, type Frontmatter, type Priority } from "../intents";
import { readQuestion } from "../questions";
import { cancelRequest, CONSOLE, requestState, submitRequest, type RequestBody } from "../requests";
import { Trace } from "../trace";
import { touchWake } from "../wake";
import type { Hub } from "./hub";
import { loopNow } from "./model";
import { CONFIG_REL, configVersion, settingPath, settingProblem, STALE_SETTINGS, type SettingValue } from "../settings";
import { decode, fromPage, json, jsonWrite, ownSite, plain, refuse } from "./routes";

/** The longest note a send back takes, and the longest hold reason. */
const MAX_NOTE = 4_000;
const MAX_REASON = 300;
/** Every request kind on a change: not chat's written intents, nor a change of a setting. */
type Kind = Exclude<RequestKind, "new" | "settings">;
const KINDS: readonly string[] = REQUEST_KINDS.filter((k) => k !== "new" && k !== "settings");

/**
 * The console's writes: requests for the loop (`/api/requests`, with GET and DELETE of one by id)
 * and the loop's pause (`/api/loop`). Null for any other path. Every write must come from the page
 * itself (its Origin), and a POST must be JSON (see jsonWrite): a page opened by another site cannot
 * send either (see "Safety of writes" in the spec). A page framed by another site could, which is
 * why the page itself refuses to draw when framed (src/ui/app.tsx).
 */
export async function writes(root: string, hub: Hub, req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const one = path.match(/^\/api\/requests\/([^/]+)$/);
  if (path !== "/api/requests" && path !== "/api/loop" && !one) return null;
  if (one) {
    // Only GET reads a result, which reading removes: a HEAD would take it with no body to carry it,
    // and so would another site's <img src> (ids are predictable), which carries no Origin: ownSite
    // tells the page's own read from it.
    if (req.method === "GET") {
      if (!ownSite(req, url)) return plain("Forbidden", 403);
      const s = requestState(root, decode(one[1]!));
      return s ? json(s.state === "pending" ? { state: "pending" } : { state: "done", ok: s.ok, text: s.text, status: s.status }) : json({ error: "unknown request" }, 404);
    }
    if (req.method !== "DELETE") return plain("Method not allowed", 405);
    if (!fromPage(req, url)) return plain("Forbidden", 403);
    const cancelled = cancelRequest(root, decode(one[1]!));
    hub.poke();
    return json({ cancelled }, cancelled ? 200 : 409);
  }
  return jsonWrite(req, url, async (fields) => {
    const answer = path === "/api/loop" ? loop(root, fields) : await action(root, fields);
    hub.poke();
    return answer;
  });
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

/** The body as a request, or why it is not one (a 400). */
function parse(body: Record<string, unknown>): RequestBody | string {
  const kind = str(body.kind);
  if (kind === "settings") {
    const path = str(body.path);
    const p = path === null ? null : settingPath(path);
    if (!p) return "That is not a setting the console can change.";
    const list = Array.isArray(body.value) && body.value.length <= 64 && body.value.every((v) => typeof v === "string");
    const value: SettingValue | undefined = body.value === null ? null : list ? (body.value as string[]) : (str(body.value) ?? undefined);
    if (value === undefined) return "Say what to set it to (a word, or a list of words), or null to remove it.";
    const problem = settingProblem(p, value);
    if (problem) return problem;
    const version = str(body.version);
    if (version === null) return "Say which version of the settings the page read.";
    return { kind: "settings", path: path!, value, version };
  }
  const slug = str(body.slug);
  if (!kind || !KINDS.includes(kind)) return "Unknown action.";
  if (!slug || !SLUG.test(slug)) return "Unknown change.";
  const k = kind as Kind;
  if (k === "accept") return { kind: k, slug };
  // An answer names no status: it lands whatever the status. It names the question the person saw, when the page sent it.
  if (k === "answer") {
    const text = str(body.text)?.trim() ?? "";
    if (!text || text.length > MAX_NOTE) return `Say your answer (at most ${MAX_NOTE} characters).`;
    if (body.question === undefined) return { kind: k, slug, text };
    const question = str(body.question);
    return question ? { kind: k, slug, text, question } : "Say which question you answer.";
  }
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
    // null: no stated priority, as an undo puts back on a change that had none.
    case "priority": return body.priority === null || (typeof body.priority === "string" && (PRIORITIES as readonly string[]).includes(body.priority)) ? { kind: k, slug, expect, priority: body.priority as Priority | null } : "Unknown priority.";
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
function allowed(root: string, r: Exclude<RequestBody, { kind: "new" | "settings" }>, fm: Frontmatter, cfg: Config | null): boolean {
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
  if (r.kind === "settings") return settingsAction(root, r);
  if (!changeExists(root, r.slug)) return refuse(`There is no change called ${r.slug}.`, 404);
  let cfg: Config | null = null;
  try { cfg = await loadConfig(root); } catch { /* nobody on any gate, as the model reads it too */ }
  let fm: Frontmatter;
  try { fm = (await readIntent(root, r.slug)).file.frontmatter; } catch { return refuse(`${r.slug}'s intent.md cannot be read.`); }
  const status = fm.status;
  const expect = r.kind === "accept" ? "draft" : r.kind === "answer" ? status : r.expect;
  // Priority, hold, release and an answer land on any open change, whatever its status now (see apply.ts).
  const fieldOnly = r.kind === "priority" || r.kind === "hold" || r.kind === "release" || r.kind === "answer";
  if (!fieldOnly && status !== expect) return refuse(`${r.slug} is ${status} now, not ${expect}. The page shows it as it is now.`);
  if (!allowed(root, r, fm, cfg)) return refuse(r.kind === "undo" ? "That cannot be undone now." : `That is not something ${r.slug} can do now.`);
  // An answer to a question that is no longer the one waiting (the loop checks again when it applies it).
  if (r.kind === "answer" && !sameQuestion(r.question, readQuestion(root, r.slug)?.open?.at)) return refuse(questionChangedText(r.slug));
  const user = localUser();
  const sent = submitRequest(root, { ...r, by: user, byName: user, via: "the dashboard", transport: CONSOLE, thread: "" });
  return json({ id: sent.id, loop: loopNow(root, cfg?.poll_seconds ?? DEFAULT_POLL_SECONDS, new Date()).state.state }, 202);
}

/**
 * Checks the settings request against the file as it is now (the loop checks again when it applies it:
 * only the loop changes the file), then leaves it for the loop.
 */
async function settingsAction(root: string, r: Extract<RequestBody, { kind: "settings" }>): Promise<Response> {
  let text: string;
  try { text = await Bun.file(join(root, CONFIG_REL)).text(); } catch { return refuse(`${CONFIG_REL} cannot be read.`); }
  if (configVersion(text) !== r.version) return refuse(STALE_SETTINGS);
  let cfg: Config | null = null;
  try { cfg = await loadConfig(root); } catch { /* the loop says why it cannot apply it */ }
  const user = localUser();
  const sent = submitRequest(root, { ...r, by: user, byName: user, via: "the dashboard", transport: CONSOLE, thread: "" });
  return json({ id: sent.id, loop: loopNow(root, cfg?.poll_seconds ?? DEFAULT_POLL_SECONDS, new Date()).state.state }, 202);
}
