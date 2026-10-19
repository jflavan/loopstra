import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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

/** The longest answer a request may carry. */
const MAX_ANSWER = 4000;

/**
 * What every request carries. `via`: where the person was, in words ("the dashboard", "Slack"), for
 * the commit and the trace; requests chat left before it existed came from chat.
 * `written`: the slugs whose intent.md the loop already wrote for this request. A request whose
 * commit failed is tried again, and must not then read its own write as someone else's.
 * `writtenHash`: for each of those slugs, the sha256 (hex) of the exact text the loop wrote, so a
 * request given up on puts back only a file nobody else changed, before or since (older requests have none).
 * `recordHash`: likewise for the conversation.md entry a send back, an undo of one or an answer wrote:
 * kept only when the file held no uncommitted edit before the write (see writeRecord in src/apply.ts).
 * `tries`: how many passes failed to apply it, and `firstFailedAt` (ISO) when the first did (see
 * applyRequests, which gives up after a few, and not before some minutes).
 */
const base = z.object({
  id: z.string().regex(ID),
  by: z.string(),
  byName: z.string(),
  via: z.string().default("chat"),
  transport: z.string(),
  thread: z.string(),
  at: z.string(),
  written: z.array(z.string()).optional(),
  writtenHash: z.record(z.string(), z.string()).optional(),
  recordHash: z.string().optional(),
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
export type Submission = OmitEach<Request, "id" | "at" | "written" | "writtenHash" | "recordHash" | "tries" | "firstFailedAt">;

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
 */
interface Unreadable { id: string; kind: string; slug: string | null; transport: string; thread: string; problem: string }

/** What makes a request file someone's (see Unreadable). Anything less is not a request (see setAside). */
const RequestFile = z.object({ id: z.string().regex(ID), transport: z.string(), thread: z.string() }).loose();

interface Read { requests: Request[]; unreadable: Unreadable[] }

/**
 * The request files in a folder, oldest first: the requests, and the ones someone waits on that are
 * not requests the loop knows (see Unreadable). A file that is not a request at all is set aside.
 */
function readDir(root: string, dir: string, trace?: Trace): Read {
  const read: Read = { requests: [], unreadable: [] };
  if (!existsSync(dir)) return read;
  for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const file = readJsonAs(join(dir, n), RequestFile);
    // Named for its own id, or claiming, cancelling and finishing it would act on another file.
    if (!file || n !== `${file.id}.json`) { setAside(root, dir, n, trace); continue; }
    const r = RequestSchema.safeParse(file);
    if (r.success) { read.requests.push(r.data); continue; }
    read.unreadable.push({
      id: file.id,
      kind: typeof file.kind === "string" ? file.kind : "",
      slug: typeof file.slug === "string" && SLUG.test(file.slug) ? file.slug : null,
      transport: file.transport,
      thread: file.thread,
      problem: r.error.issues.map((i) => `${i.path.join(".") || "top"}: ${i.message}`).join("; "),
    });
  }
  return read;
}

/**
 * Moves a file in a requests folder that is not a request (not JSON, no id of its own, not named
 * for it) to `requests/bad/<name>`, once. Left where it is, every pass would read it again every
 * 2 s, and the console would say its request is pending for ever. Traced when the reader has a
 * trace (a pass); the applier's look between passes has none, and only moves it. A file that cannot
 * be moved (held open) is left for the next look.
 */
function setAside(root: string, dir: string, name: string, trace?: Trace): void {
  try {
    mkdirSync(badDir(root), { recursive: true });
    renameSync(join(dir, name), join(badDir(root), name));
    trace?.event("_loop", "error", { where: "request", file: name, error: `${name} is not a request; it was moved to .loopstra/requests/bad/` });
  } catch { /* see above */ }
}

/** Request files not yet claimed. */
function waiting(root: string, trace?: Trace): Read { return readDir(root, requestsDir(root), trace); }

/** Request files the loop claimed and has not finished (a pass that failed, or one cut short), oldest first. */
export function claimedRequests(root: string, trace?: Trace): Read { return readDir(root, applyingDir(root), trace); }

/** Requests the loop has not finished, claimed or not, oldest first: what the console shows as waiting. */
export function pendingRequests(root: string): Request[] {
  return [...waiting(root).requests, ...applyingRequests(root)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Requests the loop claimed and has not finished, oldest first (see claimedRequests). */
export function applyingRequests(root: string): Request[] { return claimedRequests(root).requests; }

/** The ids of the request files waiting to be claimed, oldest first: the requests, and the ones someone waits on that cannot be read (see Unreadable). */
export function waitingIds(root: string, trace?: Trace): string[] {
  const read = waiting(root, trace);
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

/** Writes a claimed request back (its `written` list or its `tries` changed). */
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
 * read, or that someone waits on: a file that is not a request is set aside here, so it never keeps
 * the applier busy), or a folder chat used before still there to drain. An idle applier does next to
 * nothing every 2 s.
 */
export function anythingToApply(root: string): boolean {
  const claimed = claimedRequests(root);
  return waitingIds(root).length > 0 || claimed.requests.length > 0 || claimed.unreadable.length > 0 || oldDirs(root).some(([from]) => existsSync(from));
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
