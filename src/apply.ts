import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { doneWords, isOpen, personReviews, resultText, retryOptions, targetOf, undoMatches } from "./actions";
import { loadConfig, type Config } from "./config";
import { commitRecord, dropSentBack, MainCheckoutMoved, statusPatch, writeSentBack } from "./context";
import { Git } from "./git";
import { effectivePriority, humanGates, parseIntentFile, PRIORITIES, readIntent, SLUG, STATUSES, writeIntent, type Frontmatter, type Intent, type Status } from "./intents";
import { applyingRequests, claimRequest, CONSOLE, drainOld, finishRequest, pruneResults, requestsDir, saveApplying, waitingIds, type Outcome, type Request } from "./requests";
import { onCheckout } from "./lanes";
import { errorText } from "./shell";
import { StopRequested, stopRequested } from "./stop";
import { Trace } from "./trace";
import { CHAT_SLUG } from "./chat/agents";
import { oneLine } from "./chat/threads";

type StatusRequest = Extract<Request, { kind: "approve" | "send-back" | "retry" | "close" | "undo" }>;
type FieldRequest = Extract<Request, { kind: "priority" | "hold" | "release" }>;

/**
 * The passes of each root (by its resolved path): the last one queued (`tail`), and the one waiting
 * to start (`queued`), so the tick's and the applier's passes never overlap or pile up.
 */
const lanes = new Map<string, { tail: Promise<unknown>; queued: Promise<number> | null }>();

/**
 * Applies every waiting request on the main checkout, as the loop: claims each (see claimRequest),
 * then applies the claimed ones oldest first through commitRecord. A request that hits an unexpected
 * problem (a commit refused, the checkout off main) is traced and stays claimed for the next pass; one
 * that cannot be done gets a plain result saying why. One that cannot be read (see badShape) is
 * finished at once, and one that kept failing (see giveUp) is given up with a plain result once what it
 * wrote is put back (a checkout off main is not a try: it is a reason to wait). Passes on a root run one after another, never side
 * by side, and at most one waits behind the running one: a call while one waits gets that pass (it
 * has not started, so it sees this caller's requests too). Gives how many were finished.
 */
export function applyRequests(root: string, cfg: Config, trace: Trace): Promise<number> {
  const key = resolve(root);
  const lane = lanes.get(key) ?? { tail: Promise.resolve(), queued: null };
  lanes.set(key, lane);
  if (lane.queued) return lane.queued;
  const run = () => {
    // Started: a call from now on queues a new pass behind this one.
    if (lane.queued === next) lane.queued = null;
    return applyPass(root, cfg, trace);
  };
  const next: Promise<number> = lane.tail.then(run, run);
  lane.queued = next;
  lane.tail = next.catch(() => {});
  return next;
}

/** The roots whose loop has settled the main checkout this run (see armApplier). */
const armed = new Set<string>();

/**
 * Lets the applier at `root` apply requests. The tick calls it once it has applied requests itself:
 * by then a move of main that a kill cut short has been put back, and the checkout is on main.
 */
export function armApplier(root: string): void {
  armed.add(resolve(root));
}

/**
 * Applies requests beside the tick, so one lands while steps run: every `everyMs` (2 s) and when a
 * file appears in `.loopstra/requests/`, once the tick has armed it. Each pass loads the config and
 * opens the trace itself. Never throws; `stop` waits for a pass in flight.
 */
export function startApplier(root: string, opts: { everyMs?: number } = {}): { stop(): Promise<void> } {
  const key = resolve(root);
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const pass = () => {
    if (stopped || inFlight || !armed.has(key) || stopRequested()) return;
    inFlight = (async () => {
      let cfg: Config;
      try { cfg = await loadConfig(root); } catch { return; }
      const trace = Trace.open(root, () => {});
      try { await applyRequests(root, cfg, trace); } catch { /* a stop, or traced inside; the next pass tries again */ } finally { trace.close(); }
    })().finally(() => { inFlight = null; });
  };
  let watcher: FSWatcher | null = null;
  const unwatch = (w: FSWatcher) => {
    try { w.close(); } catch { /* closed already */ }
    if (watcher === w) watcher = null;
  };
  // Watched again on each timer pass when it is not: the folder was deleted, or watching it failed.
  const rewatch = () => {
    if (watcher || stopped) return;
    try {
      const dir = requestsDir(root);
      mkdirSync(dir, { recursive: true });
      const w = watch(dir, (_event, name) => {
        // A deleted folder's watcher fires without end (Bun on Windows): drop it, the timer watches again.
        if (!existsSync(dir)) return unwatch(w);
        if (isNewRequest(dir, name)) pass();
      });
      w.on("error", () => unwatch(w));
      watcher = w;
    } catch { /* the timer alone until the next try */ }
  };
  rewatch();
  const timer = setInterval(() => { rewatch(); pass(); }, opts.everyMs ?? 2_000);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (watcher) unwatch(watcher);
      armed.delete(key);
      await inFlight;
    },
  };
}

/**
 * True when a watch event names a request file waiting in the requests folder itself. Writes under
 * `applying/` and `results/` (a pass's own), and a request claimed or cancelled meanwhile, start no
 * pass: a failed pass rewrites its claimed request, and that would start the next pass at once.
 */
function isNewRequest(dir: string, name: string | Buffer | null): boolean {
  return typeof name === "string" && /^[^/\\]+\.json$/.test(name) && existsSync(join(dir, name));
}

/**
 * When the loop gives up on a request that keeps failing: after MAX_TRIES failed passes and at least
 * GIVE_UP_MS since the first one, so a problem a person can clear in a few minutes (a stuck git lock)
 * does not cost the request.
 */
const MAX_TRIES = 5;
const GIVE_UP_MS = 10 * 60_000;

async function applyPass(root: string, cfg: Config, trace: Trace): Promise<number> {
  drainOld(root);
  pruneResults(root);
  for (const id of waitingIds(root)) claimRequest(root, id);
  let applied = 0;
  for (const req of applyingRequests(root)) {
    const bad = badShape(req);
    if (bad) {
      shapeTraced(trace, req, "refused", { problem: bad });
      finishRequest(root, req, { ok: false, status: null, text: "That request could not be read, so nothing changed." });
      applied++;
      continue;
    }
    try {
      finishRequest(root, req, await applyOne(root, cfg, trace, req));
      applied++;
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      // Traced once while it stays the same: a checkout off main would otherwise add a line every 2 s.
      trace.eventOnChange("_loop", "error", `"where":"request","id":"${req.id}"`, { where: "request", id: req.id, kind: req.kind, error: e instanceof MainCheckoutMoved ? e.message : errorText(e) }, "error");
      if (e instanceof MainCheckoutMoved) continue;
      req.tries = (req.tries ?? 0) + 1;
      if (!Number.isFinite(Date.parse(req.firstFailedAt ?? ""))) req.firstFailedAt = new Date().toISOString();
      const failing = Date.now() - Date.parse(req.firstFailedAt!);
      if (req.tries < MAX_TRIES || failing < GIVE_UP_MS) { saveApplying(root, req); continue; }
      // Never say it failed while its write is still on disk: the scheduler would act on it anyway.
      const kept = await putBack(root, cfg.main_branch, trace, req);
      if (!kept) { saveApplying(root, req); continue; }
      shapeTraced(trace, req, "failed", { tries: req.tries, ...(kept.length ? { kept, why: "intent.md holds changes the request did not make, so it was left as it is" } : {}) });
      finishRequest(root, req, { ok: false, status: null, text: kept.length ? CHANGED_SINCE : "The loop could not apply this request; an engineer can find the details in the trace." });
      applied++;
    }
  }
  return applied;
}

/** The result of a request given up on whose write a person changed since (see putBack). */
const CHANGED_SINCE = "The loop could not apply this request, and intent.md holds changes it did not make, so it was left as it is. An engineer can find the details in the trace.";

/**
 * Puts back what a request given up on wrote and never committed: each intent.md it wrote (see
 * markWritten) as it is at HEAD, or gone when HEAD has none, and a send back's kept note. Only a file
 * that still holds exactly what the request wrote: one changed since (a person's edit), one that held
 * a person's uncommitted edit before the write (see ownBefore), or one whose write an older request
 * did not record, is left as it is; the person's edit is what it says now.
 * Under the checkout lock, so it never meets a commit half way. Gives the slugs it left as they are,
 * or null (traced) when it could not be done: the request then stays claimed, and the next pass tries
 * it again.
 */
async function putBack(root: string, main: string, trace: Trace, req: Request): Promise<string[] | null> {
  const slugs = (req.written ?? []).filter((s) => SLUG.test(s));
  const kept = slugs.filter((s) => !stillOurs(root, req, s));
  try {
    await onCheckout(root, async () => {
      const git = new Git(root);
      // Off main, HEAD is another branch's: what it holds is not what this request overwrote.
      if ((await git.currentBranch()) !== main) throw new Error(`the checkout is not on ${main}`);
      for (const slug of slugs.filter((s) => !kept.includes(s))) {
        const path = `intent/${slug}/intent.md`;
        if ((await git.run(["cat-file", "-e", `HEAD:${path}`], true)).code === 0) await git.run(["checkout", "HEAD", "--", path]);
        else {
          await git.run(["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
          rmSync(join(root, path), { force: true });
        }
      }
    });
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    trace.eventOnChange("_loop", "error", `"where":"request give-up","id":"${req.id}"`, { where: "request give-up", id: req.id, kind: req.kind, written: slugs, error: `what it wrote could not be put back, so it stays claimed: ${errorText(e)}` }, "error");
    return null;
  }
  // Gone even with a kept file: the request failed, and a note the person cannot see must not steer the next session.
  if (req.kind === "send-back" && slugs.includes(req.slug)) dropSentBack(root, req.slug);
  return kept;
}

const KINDS: ReadonlySet<string> = new Set(["accept", "new", "approve", "send-back", "retry", "close", "priority", "hold", "release", "undo"]);
const isStatus = (v: unknown): boolean => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

/**
 * Why a request file cannot be read as the request it says it is, or null when it can. Checked
 * before applying: a request with a wrong field would otherwise fail the same way every pass.
 */
function badShape(req: Request): string | null {
  const r = req as unknown as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return "it asks for nothing the loop knows";
  if (r.kind === "new") {
    const ok = Array.isArray(r.intents) && r.intents.every((i: unknown) => {
      const x = i as Record<string, unknown> | null;
      return !!x && typeof x === "object" && typeof x.slug === "string" && typeof x.text === "string" && typeof x.update === "boolean";
    });
    return ok ? null : "its changes are not a list of slug, text and update";
  }
  if (typeof r.slug !== "string" || !SLUG.test(r.slug)) return "its slug is not a change name";
  if (r.kind === "accept") return null;
  if (!isStatus(r.expect)) return "the status it saw is not a status";
  if ((r.kind === "retry" || r.kind === "undo") && !isStatus(r.to)) return "the status it goes to is not a status";
  if (r.kind === "priority" && r.priority !== null && !(PRIORITIES as readonly unknown[]).includes(r.priority)) return "its priority is not a priority";
  for (const k of ["note", "reason"]) if (r[k] !== undefined && typeof r[k] !== "string") return `its ${k} is not text`;
  return null;
}

/** A request event for a request that may not be well formed: under its slug when it has a real one. */
function shapeTraced(trace: Trace, req: Request, result: string, more: Record<string, unknown>): void {
  const slug = "slug" in req && typeof req.slug === "string" && SLUG.test(req.slug) ? req.slug : "_loop";
  trace.event(slug, "request", { id: req.id, kind: req.kind, by: req.byName, byId: req.by, via: req.via, transport: req.transport, result, ...more });
}

function applyOne(root: string, cfg: Config, trace: Trace, req: Request): Promise<Outcome> {
  switch (req.kind) {
    case "accept": return applyAccept(root, cfg.main_branch, trace, req);
    case "new": return applyNew(root, cfg.main_branch, trace, req);
    case "priority": case "hold": case "release": return applyField(root, cfg, trace, req);
    default: return applyStatus(root, cfg, trace, req);
  }
}

/** Who and where, for a commit subject or a note: "John from the dashboard". */
function byWhom(req: Request): string {
  return `${oneLine(req.byName, 80)} from ${oneLine(req.via, 40)}`;
}

/** The sha256 (hex) of a change's intent.md as it is on disk, or null when it cannot be read. */
function intentHash(root: string, slug: string): string | null {
  try { return createHash("sha256").update(readFileSync(join(root, "intent", slug, "intent.md"))).digest("hex"); } catch { return null; }
}

/** True when this slug's intent.md still holds exactly what the request last wrote (unknown for an older request: false). */
function stillOurs(root: string, req: Request, slug: string): boolean {
  const want = req.writtenHash?.[slug];
  return !!want && intentHash(root, slug) === want;
}

/**
 * True when the request has written this slug's intent.md before (an earlier try whose commit
 * failed) and someone changed it since. An older request, with no hash, is never known to be.
 */
function changedSince(root: string, req: Request, slug: string): boolean {
  return (req.written ?? []).includes(slug) && !!req.writtenHash?.[slug] && !stillOurs(root, req, slug);
}

/**
 * Records on the claimed request that the loop wrote this slug's intent.md, before committing it,
 * with the hash of what is on disk now. `own` is false when the file held someone else's change
 * before this write (see ownBefore), or an older try's write with no hash: then no hash is kept,
 * and a give-up leaves the file as it is (see putBack).
 */
function markWritten(root: string, req: Request, slug: string, own = true): void {
  req.written = [...new Set([...(req.written ?? []), slug])];
  const hashes = { ...req.writtenHash };
  const hash = own ? intentHash(root, slug) : null;
  if (hash) hashes[slug] = hash;
  else delete hashes[slug];
  req.writtenHash = hashes;
  saveApplying(root, req);
}

/**
 * True when a write now would replace only what this request wrote before, or, on its first, only
 * what main has: a person's uncommitted edit would be under the write, and putting back HEAD's file
 * would lose it. Called inside commitRecord, under the checkout lock, before writing.
 */
async function ownBefore(root: string, req: Request, slug: string): Promise<boolean> {
  if ((req.written ?? []).includes(slug)) return stillOurs(root, req, slug);
  const path = `intent/${slug}/intent.md`;
  const git = new Git(root);
  // A file main does not have is someone's own when it is on disk already (an uncommitted draft).
  if ((await git.run(["cat-file", "-e", `HEAD:${path}`], true)).code !== 0) return !existsSync(join(root, path));
  return (await git.run(["diff", "--quiet", "HEAD", "--", path], true)).code === 0;
}

async function applyAccept(root: string, main: string, trace: Trace, req: Extract<Request, { kind: "accept" }>): Promise<Outcome> {
  const path = join(root, "intent", req.slug, "intent.md");
  // The console words results like its other actions; chat speaks as itself.
  const fromConsole = req.transport === CONSOLE;
  if (!SLUG.test(req.slug) || !existsSync(path)) {
    trace.event(CHAT_SLUG, "chat-request", { id: req.id, kind: "accept", slug: req.slug, by: req.byName, via: req.via, result: "missing" });
    return { ok: false, status: null, text: fromConsole ? `There is no change called ${req.slug} in the main code.` : `I could not start ${req.slug}: it is not in the main code. If it came from a pull request, that needs to be merged first.` };
  }
  let refused = null as Status | null;
  await commitRecord(root, main, req.slug, `accepted by ${byWhom(req)}`, async () => {
    const intent = await readIntent(root, req.slug);
    const was = intent.file.frontmatter.status;
    // Written by an earlier try of this request whose commit failed: commit it now.
    const ours = was === "accepted" && (req.written ?? []).includes(req.slug);
    // Looked at even when an earlier try wrote it: a person may have edited it since (see ownBefore).
    const own = await ownBefore(root, req, req.slug);
    if (!ours && !(await writeIntent(intent, { status: "accepted", note: "" }, { expectStatus: "draft" }))) {
      refused = was;
      return false;
    }
    markWritten(root, req, req.slug, own);
  });
  if (refused !== null) {
    trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, via: req.via, result: "not-draft", status: refused });
    return { ok: false, status: refused, text: fromConsole ? `${req.slug} is ${refused} now, not a draft; nothing changed.` : `I did not start ${req.slug}: it is ${refused} now, not a draft, so someone already changed it.` };
  }
  trace.statusChange(req.slug, "draft", "accepted", `accepted by ${byWhom(req)}`);
  trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, byId: req.by, via: req.via, transport: req.transport, result: "accepted" });
  return { ok: true, status: "accepted", text: fromConsole ? resultText({ kind: "accept", expect: "draft" }, req.slug, "accepted") : `Started ${req.slug}. I will say here when it needs anyone, and when it is done.` };
}

async function applyNew(root: string, main: string, trace: Trace, req: Extract<Request, { kind: "new" }>): Promise<Outcome> {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const i of req.intents) {
    if (!SLUG.test(i.slug)) { skipped.push(`${i.slug} (not a valid change name)`); continue; }
    const dir = join(root, "intent", i.slug);
    const path = join(dir, "intent.md");
    // Written by an earlier try of this request whose commit failed: that is ours, not someone else's
    // (unless someone changed it since).
    const ours = (req.written ?? []).includes(i.slug) && !changedSince(root, req, i.slug);
    if (existsSync(path) && !ours) {
      let status = "unreadable";
      try { status = parseIntentFile(await Bun.file(path).text()).frontmatter.status; } catch { /* keep unreadable */ }
      if (!i.update || status !== "draft") { skipped.push(`${i.slug} (it already exists and is ${status})`); continue; }
    }
    await commitRecord(root, main, i.slug, `${i.update ? "update" : "open"} intent from chat`, async () => {
      const own = await ownBefore(root, req, i.slug);
      mkdirSync(dir, { recursive: true });
      await Bun.write(path, i.text);
      markWritten(root, req, i.slug, own);
    });
    trace.event(i.slug, "chat-request", { id: req.id, kind: "new", by: req.byName, update: i.update });
    added.push(i.slug);
  }
  const parts: string[] = [];
  if (added.length) parts.push(`Added to the queue as drafts: ${added.join(", ")}. Read them in intent/, then set status to accepted, or ask me to start one.`);
  if (skipped.length) parts.push(`Not written, because something changed meanwhile: ${skipped.join("; ")}.`);
  return { ok: added.length > 0, status: null, text: parts.join(" ") || "Nothing was written." };
}

/** The change a request is about, or the plain reason it cannot be read. */
async function current(root: string, slug: string): Promise<{ intent: Intent } | { problem: string }> {
  if (!SLUG.test(slug) || !existsSync(join(root, "intent", slug, "intent.md"))) return { problem: `There is no change called ${slug} in the main code.` };
  try {
    return { intent: await readIntent(root, slug) };
  } catch {
    return { problem: `${slug}'s intent.md cannot be read, so nothing changed. Fix it, then try again.` };
  }
}

function traced(trace: Trace, req: StatusRequest | FieldRequest, result: string, more: Record<string, unknown> = {}): void {
  trace.event(req.slug, "request", { id: req.id, kind: req.kind, by: req.byName, byId: req.by, via: req.via, transport: req.transport, result, ...more });
}

/** Why a status request is not something the change can do from `expect`, or null when it is. */
function notAllowed(req: StatusRequest, fm: Frontmatter, cfg: Config, trace: Trace): string | null {
  const human = humanGates(cfg);
  switch (req.kind) {
    case "approve": case "send-back":
      if (!targetOf(req)) return `${req.slug} cannot be ${req.kind === "approve" ? "approved" : "sent back"} while it is ${req.expect}.`;
      if (!personReviews(req.expect, human)) return `${req.slug} cannot be ${req.kind === "approve" ? "approved" : "sent back"} now: nobody reviews that step, so the loop goes on by itself.`;
      return req.kind === "send-back" && !(req.note ?? "").trim() ? "Say what should change, and send it back again." : null;
    case "retry": {
      // An old block's retry status says nothing about a change that is not blocked now. The type
      // says blocked; a request file can say anything.
      const saw: Status = req.expect;
      if (saw !== "blocked") return `${req.slug} is not blocked, so there is nothing to retry.`;
      const options = retryOptions(trace, req.slug, fm.note);
      if (options.includes(req.to)) return null;
      return options.length ? `${req.slug} cannot be retried from ${req.to}; its note names ${options.join(" or ")}.` : `${req.slug} cannot be retried from ${req.to}; its note names no status to retry from.`;
    }
    case "close": return isOpen(req.expect) ? null : `${req.slug} is ${req.expect} already.`;
    case "undo": return undoMatches(trace, req.slug, req.expect, req.to) ? null : `${req.slug} cannot go back from ${req.expect} to ${req.to}.`;
  }
}

/**
 * A status request whose change moved on. A send back whose write landed before a failed commit
 * kept its note in the run folder (see writeSentBack): that goes too, or it would steer the next
 * session though the send back never happened.
 */
function movedOn(root: string, trace: Trace, req: StatusRequest, status: Status): Outcome {
  if (req.kind === "send-back" && (req.written ?? []).includes(req.slug)) dropSentBack(root, req.slug);
  traced(trace, req, "moved-on", { status });
  return { ok: false, status, text: `${req.slug} moved on to ${status}; nothing changed.` };
}

/** The note a status request leaves on the change. */
function noteFor(req: StatusRequest): string {
  switch (req.kind) {
    case "send-back": return `Sent back by ${byWhom(req)}: ${req.note.trim()}`;
    case "close": return `Closed by ${byWhom(req)}.`;
    case "undo": return req.note ?? "";
    default: return "";
  }
}

/**
 * Approve, send back, retry, close and undo: only when the status is still the one the person saw
 * (`expect`), and only when the action is allowed from it. Committed as "<what> by <who> from <where>".
 */
async function applyStatus(root: string, cfg: Config, trace: Trace, req: StatusRequest): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const was = found.intent.file.frontmatter.status;
  const to = targetOf(req);
  // Written by an earlier try of this request whose commit failed: commit it now.
  const ours = (req.written ?? []).includes(req.slug) && was === to;
  if (!ours && was !== req.expect) return movedOn(root, trace, req, was);
  const problem = ours ? null : notAllowed(req, found.intent.file.frontmatter, cfg, trace);
  if (problem || !to) { traced(trace, req, "refused", { status: was }); return { ok: false, status: was, text: problem ?? `${req.slug} cannot do that now.` }; }
  const note = noteFor(req);
  let refused = null as Status | null;
  await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async () => {
    if (!ours) {
      const fresh = await readIntent(root, req.slug);
      const own = await ownBefore(root, req, req.slug);
      if (!(await writeIntent(fresh, statusPatch(req.expect, to, note), { expectStatus: req.expect }))) {
        refused = fresh.file.frontmatter.status;
        return false;
      }
      markWritten(root, req, req.slug, own);
    }
    // Kept with the write, before the commit: a crash after the commit must not lose it. Given up on, it goes (see putBack).
    if (req.kind === "send-back") writeSentBack(root, req.slug, req.note.trim());
  });
  if (refused !== null) return movedOn(root, trace, req, refused);
  trace.upsertIntent(req.slug, to, effectivePriority(found.intent.file.frontmatter));
  trace.statusChange(req.slug, req.expect, to, note, { by: req.byName, via: req.via });
  traced(trace, req, "applied", { from: req.expect, to, what: doneWords(req) });
  if (req.kind === "undo") dropSentBack(root, req.slug);
  return { ok: true, status: to, text: resultText(req, req.slug, to) };
}

/** The hold line for a hold request: the reason, then who and where. */
function holdLine(req: Extract<Request, { kind: "hold" }>): string {
  const reason = oneLine(req.reason ?? "", 300).replace(/[.\s]+$/, "") || "held";
  return `${reason} (${oneLine(req.byName, 80)}, ${oneLine(req.via, 40)})`;
}

/**
 * Priority, hold and release: on any open change, whatever its status now (a running change moves
 * on every few minutes; a hold must still land). Committed like the status requests.
 */
async function applyField(root: string, cfg: Config, trace: Trace, req: FieldRequest): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const fm = found.intent.file.frontmatter;
  if (!isOpen(fm.status)) { traced(trace, req, "refused", { status: fm.status }); return { ok: false, status: fm.status, text: `${req.slug} is ${fm.status}; nothing changed.` }; }
  // Written by an earlier try of this request whose commit failed: commit it now, not refuse it as done.
  const ours = (req.written ?? []).includes(req.slug);
  if (!ours && req.kind === "hold" && fm.hold.trim()) { traced(trace, req, "refused", { status: fm.status }); return { ok: false, status: fm.status, text: `${req.slug} is held already; nothing changed.` }; }
  if (!ours && req.kind === "release" && !fm.hold.trim()) { traced(trace, req, "refused", { status: fm.status }); return { ok: false, status: fm.status, text: `${req.slug} is not held; nothing changed.` }; }
  // A priority of null takes the line out: the change had no stated priority.
  const patch: Partial<Frontmatter> = req.kind === "priority" ? (req.priority ? { priority: req.priority } : {}) : req.kind === "hold" ? { hold: holdLine(req) } : {};
  const remove: Array<keyof Frontmatter> = req.kind === "release" ? ["hold"] : req.kind === "priority" && !req.priority ? ["priority"] : [];
  await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async () => {
    // A person's edit, before this request or since an earlier try, is kept in the file; a give-up then leaves it as it is.
    const own = await ownBefore(root, req, req.slug);
    await writeIntent(await readIntent(root, req.slug), patch, { remove });
    markWritten(root, req, req.slug, own);
  });
  if (req.kind === "priority") trace.upsertIntent(req.slug, fm.status, effectivePriority({ priority: req.priority ?? undefined }));
  traced(trace, req, "applied", { status: fm.status, what: doneWords(req) });
  return { ok: true, status: fm.status, text: resultText(req, req.slug, fm.status) };
}
