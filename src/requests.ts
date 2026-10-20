import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ID, newId } from "./ids";
import { PRIORITIES, SLUG, STATUSES, type Status } from "./intents";
import { readJson, readJsonAs, writeJson } from "./fsutil";
import { chatDir } from "./chat/threads";
import type { Trace } from "./trace";
import { touchWake } from "./wake";

/**
 * Requests: the one way people change things the loop owns. Only the loop writes the main checkout,
 * so two processes never commit there at once. Chat and the console leave a request in
 * `.loopstra/requests/`; the loop claims it (moves it to `applying/`), applies it (src/apply.ts),
 * and leaves a plain-words result in `results/` for whoever asked. A file there that is not a
 * request at all goes to `bad/` (see setAside).
 */

/** The console's transport name: its results are read by id by the page that asked, never by chat. */
export const CONSOLE = "console";

/**
 * The longest answer a request may carry: what chat's dashboard takes in one message, since chat
 * passes a person's answer on whole. The console's own form allows less (see src/console/writes.ts).
 */
const MAX_ANSWER = 20_000;

/**
 * What every request carries. `via`: where the person was, in words ("the dashboard", "Slack"), for
 * the commit and the trace; requests chat left before it existed came from chat.
 * `tries`: how many passes failed to apply it, and `firstFailedAt` (ISO) when the first did (see
 * applyRequests, which gives up after a few, and not before some minutes). A key the schema does not
 * name is dropped as the file is read: a claimed request an older loop saved with `written`,
 * `writtenHash` or `recordHash` (what it kept to put back an uncommitted write) still reads.
 */
const base = z.object({
  id: z.string().regex(ID),
  by: z.string(),
  byName: z.string(),
  via: z.string().default("chat"),
  transport: z.string(),
  thread: z.string(),
  at: z.string(),
  tries: z.number().optional(),
  firstFailedAt: z.string().optional(),
});
const slug = z.string().regex(SLUG);
const status = z.enum(STATUSES);

/**
 * A request file as the loop reads it: what it carries (see base), and what it asks for, by `kind`.
 * `expect` is the status the person saw. A retry's is blocked in every request the console or chat
 * writes; a file can say any status, which the applier refuses in words rather than as unreadable.
 */
const RequestSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("accept"), slug }),
  base.extend({ kind: z.literal("new"), title: z.string(), intents: z.array(z.object({ slug: z.string(), text: z.string(), update: z.boolean() })) }),
  base.extend({ kind: z.literal("approve"), slug, expect: status }),
  base.extend({ kind: z.literal("send-back"), slug, expect: status, note: z.string().default("") }),
  base.extend({ kind: z.literal("retry"), slug, expect: status, to: status }),
  base.extend({ kind: z.literal("close"), slug, expect: status }),
  /** `priority` null: no stated priority (the line is taken out, so the change reads as normal), as an undo puts back. */
  base.extend({ kind: z.literal("priority"), slug, expect: status, priority: z.enum(PRIORITIES).nullable() }),
  base.extend({ kind: z.literal("hold"), slug, expect: status, reason: z.string().default("") }),
  base.extend({ kind: z.literal("release"), slug, expect: status }),
  /**
   * Answers the change's waiting question (see src/questions.ts); on any open change whose question is open.
   * `question`: when the question the person answered was asked (its `at` in question.json); the loop
   * refuses the answer when another question waits by then. One without it (an older request) goes to
   * whatever question waits.
   */
  base.extend({ kind: z.literal("answer"), slug, text: z.string().max(MAX_ANSWER).refine((t) => t.trim() !== ""), question: z.string().optional() }),
  /** Takes back an approve or a send back (see undoAllowed): from `expect` to `to`, restoring the note it replaced. */
  base.extend({ kind: z.literal("undo"), slug, expect: status, to: status, note: z.string().default("") }),
]);

export type Request = z.infer<typeof RequestSchema>;

/** Omit on each member of a union (Omit alone keeps only the keys they share). */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a request asks for: a request without what every one carries. */
export type RequestBody = OmitEach<Request, keyof z.infer<typeof base>>;

/** What submitRequest takes: everything but the id and the time, and what the loop notes while applying. */
export type Submission = OmitEach<Request, "id" | "at" | "tries" | "firstFailedAt">;

/** What the loop did with a request. `status` is the change's status after it (null when there is no change). */
export interface RequestResult { id: string; kind: string; slug: string | null; transport: string; thread: string; text: string; ok: boolean; status: Status | null; at: string }

/** The part of a result the applier works out. */
export interface Outcome { text: string; ok: boolean; status: Status | null }

export function requestsDir(root: string): string { return join(root, ".loopstra", "requests"); }
function applyingDir(root: string): string { return join(requestsDir(root), "applying"); }
function resultsDir(root: string): string { return join(requestsDir(root), "results"); }
/** Where files that are not requests go (see setAside). */
function badDir(root: string): string { return join(requestsDir(root), "bad"); }


/** Leaves a request for the loop and wakes it (see touchWake). */
export function submitRequest(root: string, req: Submission): Request {
  const full = { ...req, id: newId(), at: new Date().toISOString() } as Request;
  writeJson(join(requestsDir(root), `${full.id}.json`), full);
  touchWake(root);
  return full;
}

/**
 * A request file someone waits on (named for its id, with the transport and thread its result goes
 * to) whose body is not a request the loop knows: a wrong field, a kind it has no action for. The
 * pass finishes it with a plain result (see src/apply.ts), as it would any request, rather than try
 * it, or leave the page that asked waiting. `slug`: the change it names, when that is a change name.
 * `by`, `byName` and `via`: who asked and from where, when the file says so in words.
 */
interface Unreadable { id: string; kind: string; slug: string | null; transport: string; thread: string; problem: string; by?: string; byName?: string; via?: string }

/** What makes a request file someone's (see Unreadable). Anything less is not a request (see setAside). */
const RequestFile = z.object({ id: z.string().regex(ID), transport: z.string(), thread: z.string() }).loose();

/** `due`: a file that is not a request has waited long enough to be set aside, by a pass (see Tidy). */
interface Read { requests: Request[]; unreadable: Unreadable[]; due: boolean }

/**
 * Given by the applier only. Its passes give the trace: a file that is not a request is set aside
 * there (see setAside), and traced once. Its look between passes gives none: such a file only makes
 * it start a pass (`due`), so the move is always traced. Every other reader (the console, chat) only
 * passes such a file over: it may be half written, or held open for a moment on Windows.
 */
export interface Tidy { trace?: Trace; badAfterMs?: number }

/**
 * How long a file must have stayed unreadable, look after look, before the applier sets it aside: a
 * file half written, or held open for a moment (an antivirus on Windows), reads again well before.
 */
const BAD_AFTER_MS = 30_000;

/**
 * When the applier first found each request file unreadable, by its path. Only its looks (those
 * given a Tidy) record one; an entry is forgotten once the file reads, or at the next such look of
 * its folder once the file is gone (see forgetGone).
 */
const unreadableSince = new Map<string, number>();

/**
 * How long a file that could not be set aside (see setAside) is left before it is tried again,
 * unless it changes: each try is a whole pass (the config, the trace, the old folders), and the
 * applier looks every 2 s.
 */
const SET_ASIDE_RETRY_MS = 60_000;

/** The last failed set-aside of each file, by its path: when it was, and the file's modification time then. Forgotten once the file is gone (see forgetGone). */
const setAsideFailed = new Map<string, { at: number; mtimeMs: number }>();

/** The file's modification time, or null when it cannot be read (gone meanwhile). */
function mtimeOf(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/** True while a set-aside of the file at `path` failed less than SET_ASIDE_RETRY_MS ago and the file has not changed since. */
function setAsideWaits(path: string): boolean {
  const failed = setAsideFailed.get(path);
  if (!failed) return false;
  if (Date.now() - failed.at < SET_ASIDE_RETRY_MS && mtimeOf(path) === failed.mtimeMs) return true;
  setAsideFailed.delete(path);
  return false;
}

/** Forgets what unreadableSince and setAsideFailed hold for files of `dir` no longer among `names` (gone, or set aside). */
function forgetGone(dir: string, names: readonly string[]): void {
  const here = new Set(names.map((n) => join(dir, n)));
  for (const map of [unreadableSince, setAsideFailed]) {
    for (const path of map.keys()) if (dirname(path) === dir && !here.has(path)) map.delete(path);
  }
}

/**
 * The request files in a folder, oldest first: the requests, and the ones someone waits on that are
 * not requests the loop knows (see Unreadable). A file that is not a request at all is passed over,
 * and set aside by the applier (see Tidy).
 */
function readDir(root: string, dir: string, tidy?: Tidy): Read {
  const read: Read = { requests: [], unreadable: [], due: false };
  const names = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).sort() : [];
  if (tidy) forgetGone(dir, names);
  for (const n of names) {
    const file = readJsonAs(join(dir, n), RequestFile);
    // Named for its own id, or claiming, cancelling and finishing it would act on another file.
    if (!file || n !== `${file.id}.json`) {
      if (!tidy) continue;
      const path = join(dir, n);
      const since = unreadableSince.get(path) ?? Date.now();
      unreadableSince.set(path, since);
      if (Date.now() - since >= (tidy.badAfterMs ?? BAD_AFTER_MS) && !setAsideWaits(path)) {
        if (!tidy.trace) read.due = true;
        else {
          const mtimeMs = mtimeOf(path);
          if (setAside(root, dir, n, tidy.trace)) unreadableSince.delete(path);
          else if (mtimeMs !== null) setAsideFailed.set(path, { at: Date.now(), mtimeMs });
        }
      }
      continue;
    }
    unreadableSince.delete(join(dir, n));
    setAsideFailed.delete(join(dir, n));
    const r = RequestSchema.safeParse(file);
    if (r.success) { read.requests.push(r.data); continue; }
    read.unreadable.push({
      id: file.id,
      kind: typeof file.kind === "string" ? file.kind : "",
      slug: typeof file.slug === "string" && SLUG.test(file.slug) ? file.slug : null,
      transport: file.transport,
      thread: file.thread,
      problem: r.error.issues.map((i) => `${i.path.join(".") || "top"}: ${i.message}`).join("; "),
      ...(typeof file.by === "string" ? { by: file.by } : {}),
      ...(typeof file.byName === "string" ? { byName: file.byName } : {}),
      ...(typeof file.via === "string" ? { via: file.via } : {}),
    });
  }
  return read;
}

/**
 * Moves a file in a requests folder that is not a request (not JSON, no id of its own, not named
 * for it) to `requests/bad/<name>`, once. Left where it is, every pass would read it again every
 * 2 s, and the console would say its request is pending for ever. Traced. A file that cannot be
 * moved (held open) is left, and tried again after SET_ASIDE_RETRY_MS or once it changes (see
 * setAsideWaits); true once it is moved.
 */
function setAside(root: string, dir: string, name: string, trace: Trace): boolean {
  try {
    mkdirSync(badDir(root), { recursive: true });
    renameSync(join(dir, name), join(badDir(root), name));
  } catch {
    return false;
  }
  try {
    trace.event("_loop", "error", { where: "request", file: name, error: `${name} is not a request; it was moved to .loopstra/requests/bad/` });
  } catch { /* the trace closed meanwhile */ }
  return true;
}

/** Request files not yet claimed. */
function waiting(root: string, tidy?: Tidy): Read { return readDir(root, requestsDir(root), tidy); }

/** Request files the loop claimed and has not finished (a pass that failed, or one cut short), oldest first. */
export function claimedRequests(root: string, tidy?: Tidy): Read { return readDir(root, applyingDir(root), tidy); }

/** Requests the loop has not finished, claimed or not, oldest first: what the console shows as waiting. */
export function pendingRequests(root: string): Request[] {
  return [...waiting(root).requests, ...applyingRequests(root)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Requests the loop claimed and has not finished, oldest first (see claimedRequests). */
export function applyingRequests(root: string): Request[] { return claimedRequests(root).requests; }

/** The ids of the request files waiting to be claimed, oldest first: the requests, and the ones someone waits on that cannot be read (see Unreadable). */
export function waitingIds(root: string, tidy?: Tidy): string[] {
  const read = waiting(root, tidy);
  return [...read.requests, ...read.unreadable].map((r) => r.id).sort();
}

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

/** Writes a claimed request back (its `tries` changed). */
export function saveApplying(root: string, req: Request): void {
  writeJson(join(applyingDir(root), `${req.id}.json`), req);
}

/** Leaves the result for whoever asked and removes the claimed request (or the claimed file nobody could read). */
export function finishRequest(root: string, req: Request | Unreadable, o: Outcome): void {
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
 * Where a request is, for the console page that asked: still waiting or being applied, done (its
 * result, which this removes, so it is read once), or null (unknown, cancelled, its result already
 * read, or a result for another transport, which is left for chat to take: see takeResults).
 */
export function requestState(root: string, id: string): ({ state: "pending" } | ({ state: "done" } & RequestResult)) | null {
  if (!ID.test(id)) return null;
  if (existsSync(join(requestsDir(root), `${id}.json`)) || existsSync(join(applyingDir(root), `${id}.json`))) return { state: "pending" };
  const path = join(resultsDir(root), `${id}.json`);
  const r = readJson<RequestResult>(path);
  if (!r || r.transport !== CONSOLE) return null;
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

/** The folders chat used before (`.loopstra/chat/requests|results/`), each with the one it moved to. */
function oldDirs(root: string): ReadonlyArray<readonly [string, string]> {
  return [[join(chatDir(root), "requests"), requestsDir(root)], [join(chatDir(root), "results"), resultsDir(root)]];
}

/**
 * True when an applier pass has something to do: a request file waiting or claimed (one that can be
 * read, or that someone waits on), a file that is not a request to set aside (the pass does it, and
 * traces it, so it never keeps the applier busy), or a folder chat used before still there to drain.
 * An idle applier does next to nothing every 2 s.
 */
export function anythingToApply(root: string, badAfterMs?: number): boolean {
  const tidy: Tidy = badAfterMs === undefined ? {} : { badAfterMs };
  const claimed = claimedRequests(root, tidy);
  const waits = waiting(root, tidy);
  return waits.requests.length > 0 || waits.unreadable.length > 0 || waits.due || claimed.requests.length > 0 || claimed.unreadable.length > 0 || claimed.due || oldDirs(root).some(([from]) => existsSync(from));
}

/** Moves what chat left in the folders it used before (`.loopstra/chat/requests|results/`) into the new ones. */
export function drainOld(root: string): void {
  for (const [from, to] of oldDirs(root)) {
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
