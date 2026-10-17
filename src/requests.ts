import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Priority, Status } from "./intents";
import { chatDir, readJson, writeJson } from "./chat/threads";
import { touchWake } from "./wake";

/**
 * Requests: the one way people change things the loop owns. Only the loop writes the main checkout,
 * so two processes never commit there at once. Chat and the console leave a request in
 * `.loopstra/requests/`; the loop claims it (moves it to `applying/`), applies it (src/apply.ts),
 * and leaves a plain-words result in `results/` for whoever asked.
 */

/** The console's transport name: its results are read by id by the page that asked, never by chat. */
export const CONSOLE = "console";

/**
 * `via`: where the person was, in words ("the dashboard", "Slack"), for the commit and the trace.
 * `written`: the slugs whose intent.md the loop already wrote for this request. A request whose
 * commit failed is tried again, and must not then read its own write as someone else's.
 * `tries`: how many passes failed to apply it (see applyRequests, which gives up after a few).
 */
interface RequestBase { id: string; by: string; byName: string; via: string; transport: string; thread: string; at: string; written?: string[]; tries?: number }

/** What a request asks for. `expect` is the status the person saw. */
export type RequestBody =
  | { kind: "accept"; slug: string }
  | { kind: "new"; title: string; intents: Array<{ slug: string; text: string; update: boolean }> }
  | { kind: "approve"; slug: string; expect: Status }
  | { kind: "send-back"; slug: string; expect: Status; note: string }
  | { kind: "retry"; slug: string; expect: "blocked"; to: Status }
  | { kind: "close"; slug: string; expect: Status }
  | { kind: "priority"; slug: string; expect: Status; priority: Priority }
  | { kind: "hold"; slug: string; expect: Status; reason: string }
  | { kind: "release"; slug: string; expect: Status }
  /** Takes back an approve or a send back (see undoAllowed): from `expect` to `to`, restoring the note it replaced. */
  | { kind: "undo"; slug: string; expect: Status; to: Status; note: string };

export type Request = RequestBase & RequestBody;

/** What submitRequest takes: everything but the id and the time. */
export type Submission = Omit<RequestBase, "id" | "at" | "written" | "tries"> & RequestBody;

/** What the loop did with a request. `status` is the change's status after it (null when there is no change). */
export interface RequestResult { id: string; kind: string; slug: string | null; transport: string; thread: string; text: string; ok: boolean; status: Status | null; at: string }

/** The part of a result the applier works out. */
export interface Outcome { text: string; ok: boolean; status: Status | null }

export function requestsDir(root: string): string { return join(root, ".loopstra", "requests"); }
function applyingDir(root: string): string { return join(requestsDir(root), "applying"); }
function resultsDir(root: string): string { return join(requestsDir(root), "results"); }

/** A request id (see newId): anything else is never used as a file name. */
const ID = /^\d{15}-\d+-\d{4,}$/;

let counter = 0;
/** Sorts in the order requests were made. */
function newId(): string {
  return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(4, "0")}`;
}

/** Leaves a request for the loop and wakes it (see touchWake). */
export function submitRequest(root: string, req: Submission): Request {
  const full = { ...req, id: newId(), at: new Date().toISOString() } as Request;
  writeJson(join(requestsDir(root), `${full.id}.json`), full);
  touchWake(root);
  return full;
}

function readDir(dir: string): Request[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
    .map((n) => ({ n, r: readJson<Request>(join(dir, n)) }))
    // Named for its own id, or claiming, cancelling and finishing it would act on another file.
    .filter((x): x is { n: string; r: Request } => !!x.r && typeof x.r.id === "string" && ID.test(x.r.id) && x.n === `${x.r.id}.json`)
    .map((x) => x.r)
    // Requests chat left before `via` existed came from chat.
    .map((r) => ({ ...r, via: r.via ?? "chat" }));
}

/** Requests not yet claimed. */
function waiting(root: string): Request[] { return readDir(requestsDir(root)); }

/** Requests the loop has not finished, claimed or not, oldest first: what the console shows as waiting. */
export function pendingRequests(root: string): Request[] {
  return [...waiting(root), ...applyingRequests(root)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Requests the loop claimed and has not finished (a pass that failed, or one cut short), oldest first. */
export function applyingRequests(root: string): Request[] { return readDir(applyingDir(root)); }

/** The ids of the requests waiting to be claimed, oldest first. */
export function waitingIds(root: string): string[] { return waiting(root).map((r) => r.id); }

/** Takes a request for applying: false when it is gone (cancelled, or claimed already). */
export function claimRequest(root: string, id: string): boolean {
  if (!ID.test(id)) return false;
  mkdirSync(applyingDir(root), { recursive: true });
  try {
    renameSync(join(requestsDir(root), `${id}.json`), join(applyingDir(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Writes a claimed request back (its `written` list or its `tries` changed). */
export function saveApplying(root: string, req: Request): void {
  writeJson(join(applyingDir(root), `${req.id}.json`), req);
}

/** Leaves the result for whoever asked and removes the claimed request. */
export function finishRequest(root: string, req: Request, o: Outcome): void {
  const slug = "slug" in req && typeof req.slug === "string" ? req.slug : null;
  writeJson(join(resultsDir(root), `${req.id}.json`), { id: req.id, kind: req.kind, slug, transport: req.transport, thread: req.thread, text: o.text, ok: o.ok, status: o.status, at: new Date().toISOString() } satisfies RequestResult);
  rmSync(join(applyingDir(root), `${req.id}.json`), { force: true });
}

/** Cancels a request the loop has not claimed yet: true when it was still waiting (it is gone now). */
export function cancelRequest(root: string, id: string): boolean {
  if (!ID.test(id)) return false;
  try {
    unlinkSync(join(requestsDir(root), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a request is: still waiting or being applied, done (its result, which this removes, so it
 * is read once), or null (unknown, cancelled, or its result was already read).
 */
export function requestState(root: string, id: string): ({ state: "pending" } | ({ state: "done" } & RequestResult)) | null {
  if (!ID.test(id)) return null;
  if (existsSync(join(requestsDir(root), `${id}.json`)) || existsSync(join(applyingDir(root), `${id}.json`))) return { state: "pending" };
  const path = join(resultsDir(root), `${id}.json`);
  const r = readJson<RequestResult>(path);
  if (!r) return null;
  rmSync(path, { force: true });
  return { state: "done", ...r };
}

/**
 * Results the loop left for the given transports, oldest first; each is removed as it is taken, so
 * it is passed on once. Results for transports another process serves (and the console's) are left.
 */
export function takeResults(root: string, transports: ReadonlySet<string>): RequestResult[] {
  const dir = resultsDir(root);
  if (!existsSync(dir)) return [];
  const out: RequestResult[] = [];
  for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const r = readJson<RequestResult>(join(dir, n));
    if (r && (r.transport === CONSOLE || !transports.has(r.transport))) continue;
    rmSync(join(dir, n), { force: true });
    if (r) out.push(r);
  }
  return out;
}

/** Moves what chat left in the folders it used before (`.loopstra/chat/requests|results/`) into the new ones. */
export function drainOld(root: string): void {
  for (const [from, to] of [[join(chatDir(root), "requests"), requestsDir(root)], [join(chatDir(root), "results"), resultsDir(root)]] as const) {
    if (!existsSync(from)) continue;
    mkdirSync(to, { recursive: true });
    for (const n of readdirSync(from)) {
      try { renameSync(join(from, n), join(to, n)); } catch { /* left for the next pass */ }
    }
    try { rmdirSync(from); } catch { /* not empty yet */ }
  }
}

/** How long a result nobody read is kept (the page that asked went away). */
const RESULT_KEPT_MS = 24 * 60 * 60_000;

/** Removes results nobody read for a day. */
export function pruneResults(root: string, now = Date.now()): void {
  const dir = resultsDir(root);
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    try { if (now - statSync(join(dir, n)).mtimeMs > RESULT_KEPT_MS) rmSync(join(dir, n), { force: true }); } catch { /* gone already */ }
  }
}
