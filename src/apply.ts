import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { APPROVE_TO, doneWords, isOpen, personReviews, questionChangedText, resultText, retryOptions, sameQuestion, SEND_BACK_TO, targetOf, undoMatches } from "./actions";
import { loadConfig, type Config } from "./config";
import { commitRecord, dropSentBack, landed, MainCheckoutMoved, statusPatch, writeSentBack } from "./context";
import { withEntry, type ConversationEntry } from "./conversation";
import { changeExists, effectivePriority, humanGates, isHeld, parseIntentFile, readIntent, SLUG, writeIntent, type Frontmatter, type Intent, type Status } from "./intents";
import { anythingToApply, claimedRequests, claimRequest, CONSOLE, drainOld, finishRequest, pruneResults, requestsDir, saveApplying, waitingIds, type Outcome, type Request } from "./requests";
import type { RecordDraft } from "./record-draft";
import { Git, GitError } from "./git";
import { errorText } from "./shell";
import { recordNotYet, StopRequested, stopRequested } from "./stop";
import { answerQuestion, readQuestion } from "./questions";
import { Trace } from "./trace";
import { CHAT_SLUG } from "./chat/agents";
import { oneLine } from "./text";
import { applySetting, CONFIG_REL, configVersion, settingPath, settingProblem, SETTINGS_SLUG, STALE_SETTINGS } from "./settings";

type StatusRequest = Extract<Request, { kind: "approve" | "send-back" | "retry" | "close" | "undo" }>;
type FieldRequest = Extract<Request, { kind: "priority" | "hold" | "release" }>;
type AnswerRequest = Extract<Request, { kind: "answer" }>;
type SettingsRequest = Extract<Request, { kind: "settings" }>;

/**
 * The passes of each root (by its resolved path): the last one queued (`tail`), and the one waiting
 * to start (`queued`), so the tick's and the applier's passes never overlap or pile up.
 */
const lanes = new Map<string, { tail: Promise<unknown>; queued: Promise<number> | null }>();

function laneOf(root: string): { tail: Promise<unknown>; queued: Promise<number> | null } {
  const key = resolve(root);
  const lane = lanes.get(key) ?? { tail: Promise.resolve(), queued: null };
  lanes.set(key, lane);
  return lane;
}

/**
 * Runs `fn` in the queue of the root's passes (see applyRequests): no pass runs while it does, so
 * nothing commits for a request meanwhile. A pass already waiting runs first; one asked for meanwhile
 * waits for `fn`. For the tick's git gc: a pack of the refs during a commit can make that commit fail.
 */
export function betweenPasses<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lane = laneOf(root);
  const next = lane.tail.then(fn, fn);
  lane.tail = next.catch(() => {});
  return next;
}

/**
 * Applies every waiting request on the main checkout, as the loop: claims each (see claimRequest),
 * then applies the claimed ones oldest first through commitRecord, each record tagged with its
 * request's id. A request that hits an unexpected problem (a commit refused, the checkout off main) is
 * traced and stays claimed for the next pass, which first asks git whether its record landed (see
 * landed): one the loop was killed in after its commit is finished as applied, never written again.
 * One that cannot be done gets a plain result saying why. One that cannot be read (see Unreadable in
 * src/requests.ts) is finished at once, and one that kept failing (see MAX_TRIES) is given up with a
 * plain result (a checkout off main, RecordRaced and RecordUnsettled are not tries: each is a reason
 * to wait); nothing is put back then, since a record that never landed wrote nothing. One whose record
 * landed and whose follow-up kept failing (a note that could not be kept, say) is finished then as
 * applied, its result saying what could not be done (see finishLanded). Passes on a root run one after another, never side by side, and at most
 * one waits behind the running one: a call while one waits gets that pass (it has not started, so it
 * sees this caller's requests too). Gives how many were finished.
 */
export function applyRequests(root: string, cfg: Config, trace: Trace): Promise<number> {
  const lane = laneOf(root);
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

/** How long after a watch event that found nothing waiting the applier looks again (see startApplier). */
const RENAME_SETTLE_MS = 200;

/**
 * Lets the applier at `root` apply requests. The tick calls it once it has applied requests itself:
 * by then a move of main that a kill cut short has been put back, and the checkout is on main.
 */
export function armApplier(root: string): void {
  armed.add(resolve(root));
}

/**
 * Applies requests beside the tick, so one lands while steps run: every `everyMs` (2 s) and when a
 * file appears in `.loopstra/requests/`, once the tick has armed it. A pass with nothing to apply (see
 * anythingToApply) ends at once; one with work loads the config and opens the trace itself. Never
 * throws; `stop` waits for a pass in flight.
 */
export function startApplier(root: string, opts: { everyMs?: number } = {}): { stop(): Promise<void> } {
  const key = resolve(root);
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const pass = () => {
    if (stopped || inFlight || !armed.has(key) || stopRequested() || !anythingToApply(root)) return;
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
  // A watcher whose folder is gone is dropped here too: on macOS deleting the folder may never fire it.
  const rewatch = () => {
    if (stopped) return;
    const dir = requestsDir(root);
    if (watcher && !existsSync(dir)) unwatch(watcher);
    if (watcher) return;
    try {
      mkdirSync(dir, { recursive: true });
      const w = watch(dir, () => {
        // A deleted folder's watcher fires without end (Bun on Windows): drop it, the timer watches again.
        if (!existsSync(dir)) return unwatch(w);
        if (newRequestWaiting(root)) return pass();
        // macOS may report only the temporary file's creation and fold the rename into it: look
        // once more when the rename has had time to land.
        setTimeout(() => { if (!stopped && newRequestWaiting(root)) pass(); }, RENAME_SETTLE_MS);
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
 * True when a request waits in the requests folder itself, not yet claimed: what a watch event starts
 * a pass for. Writes under `applying/` and `results/` (a pass's own) start none: a failed pass rewrites
 * its claimed request, and that would start the next pass at once. The event's file name is not used:
 * a request is written to a temporary file and renamed, and macOS may name either one, or none.
 */
function newRequestWaiting(root: string): boolean {
  return waitingIds(root).length > 0;
}

/**
 * When the loop gives up on a request that keeps failing: after MAX_TRIES failed passes and at least
 * GIVE_UP_MS since the first one, so a problem a person can clear in a few minutes (a stuck git lock)
 * does not cost the request.
 */
const MAX_TRIES = 5;
const GIVE_UP_MS = 10 * 60_000;

/** How often a root's results nobody read are pruned (see pruneResults): a day's results need no look every 2 s. */
const PRUNE_EVERY_MS = 60 * 60_000;
/** When each root's results were last pruned (by its resolved path). */
const pruned = new Map<string, number>();

async function applyPass(root: string, cfg: Config, trace: Trace): Promise<number> {
  drainOld(root);
  const key = resolve(root);
  if (Date.now() - (pruned.get(key) ?? 0) >= PRUNE_EVERY_MS) {
    pruned.set(key, Date.now());
    pruneResults(root);
  }
  for (const id of waitingIds(root, { trace })) claimRequest(root, id);
  let applied = 0;
  const claimed = claimedRequests(root, { trace });
  // A request with a wrong field would otherwise fail the same way every pass: finished at once, under its slug when it has a real one.
  for (const u of claimed.unreadable) {
    traced(trace, u.slug ?? "_loop", u, "refused", { problem: u.problem });
    finishRequest(root, u, { ok: false, status: null, text: "That request could not be read, so nothing changed." });
    applied++;
  }
  for (const req of claimed.requests) {
    try {
      finishRequest(root, req, await applyOne(root, cfg, trace, req));
      applied++;
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      // A checkout off main, main moving twice, or a record a kill cut short not finished yet: a reason
      // to wait, not a try. Traced once while it stays the same: a wait would otherwise add a line every 2 s.
      const waits = e instanceof MainCheckoutMoved || recordNotYet(e);
      trace.eventOnChange("_loop", "error", `"where":"request","id":"${req.id}"`, { where: "request", id: req.id, kind: req.kind, error: waits ? e.message : errorText(e) }, "error");
      if (waits) continue;
      req.tries = (req.tries ?? 0) + 1;
      if (!Number.isFinite(Date.parse(req.firstFailedAt ?? ""))) req.firstFailedAt = new Date().toISOString();
      const failing = Date.now() - Date.parse(req.firstFailedAt!);
      if (req.tries < MAX_TRIES || failing < GIVE_UP_MS) { saveApplying(root, req); continue; }
      // At the give-up point. A record that landed is not taken back: what kept failing came after it.
      if (await anyLanded(root, cfg.main_branch, req)) {
        finishRequest(root, req, await finishLanded(root, cfg, trace, req));
        applied++;
        continue;
      }
      // Nothing to put back: a record is committed before anything of it is written to the checkout.
      traced(trace, slugOf(req), req, "failed", { tries: req.tries });
      finishRequest(root, req, { ok: false, status: null, text: "The loop could not apply this request; an engineer can find the details in the trace." });
      applied++;
    }
  }
  return applied;
}

/**
 * True when a record of the request landed (see doneBefore): for a new request, for any of its drafts;
 * for a settings request, its one record of loopstra/config.yaml (see landed). Such a request is not given up on at the give-up point but finished as applied (see finishLanded). A
 * git that cannot answer counts as not landed, so a request is still given up on when git itself
 * keeps failing; a stop request passes through.
 */
async function anyLanded(root: string, main: string, req: Request): Promise<boolean> {
  const asks = req.kind === "settings" ? [() => settingsLanded(root, main, req)]
    : (req.kind === "new" ? req.intents.map((i) => i.slug) : [req.slug]).filter((x) => SLUG.test(x)).map((slug) => () => doneBefore(root, main, req, slug));
  for (const ask of asks) {
    try {
      if (await ask()) return true;
    } catch (e) {
      if (e instanceof StopRequested) throw e;
    }
  }
  return false;
}

/**
 * A request at the give-up point whose record landed: applied once more as its last try, so nothing is
 * written again (see landed) and what goes with the record is tried once more, a failure there being
 * said in the result instead of thrown (see followUp). Should even that throw, a plain result says the
 * request was applied and something that goes with it kept failing.
 */
async function finishLanded(root: string, cfg: Config, trace: Trace, req: Request): Promise<Outcome> {
  try {
    return await applyOne(root, cfg, trace, req, true);
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    traced(trace, slugOf(req), req, "applied", { problem: errorText(e) });
    return { ok: true, status: null, text: "The loop applied this request, but something that goes with it kept failing; an engineer can find the details in the trace." };
  }
}

/**
 * Runs what goes with a request's landed record (keeping a note, storing an answer). A failure
 * throws, so the request is tried again, except on its last try (see finishLanded): then it is
 * traced, and `note` (a sentence for the request's result) is given back, after a space, instead.
 */
function followUp(trace: Trace, req: { id: string; kind: string; slug: string }, lastTry: boolean, note: string, fn: () => void): string {
  if (!lastTry) { fn(); return ""; }
  try {
    fn();
    return "";
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    trace.event(req.slug, "error", { where: "request", id: req.id, kind: req.kind, error: errorText(e), note });
    return ` ${note}`;
  }
}

/** True for an undo that takes back a send back (not an approve). */
function undoesSendBack(req: Request): boolean {
  return req.kind === "undo" && SEND_BACK_TO[req.to] === req.expect;
}

/** Adds a request's conversation.md entry to its record's draft, so it lands in the same commit (see commitRecord). */
function writeRecord(slug: string, entry: ConversationEntry, draft: RecordDraft): void {
  const rel = `intent/${slug}/conversation.md`;
  draft.write(rel, withEntry(draft.read(rel) ?? "", entry));
}

/** Applies one request; `lastTry`: at the give-up point, with its record landed (see finishLanded). */
function applyOne(root: string, cfg: Config, trace: Trace, req: Request, lastTry = false): Promise<Outcome> {
  switch (req.kind) {
    case "accept": return applyAccept(root, cfg.main_branch, trace, req);
    case "new": return applyNew(root, cfg.main_branch, trace, req, lastTry);
    case "priority": case "hold": case "release": return applyField(root, cfg, trace, req);
    case "answer": return applyAnswer(root, cfg, trace, req, lastTry);
    case "settings": return applySettings(root, cfg, trace, req);
    default: return applyStatus(root, cfg, trace, req, lastTry);
  }
}

/** Who and where, for a commit subject or a note: "John from the dashboard". */
function byWhom(req: Request): string {
  return `${oneLine(req.byName, 80)} from ${oneLine(req.via, 40)}`;
}

/**
 * True when the request's record for this slug landed (see landed), or when a loop from before
 * records carried the request's id wrote it: such a loop, killed after writing the request's
 * intent.md (and maybe committing it) and then upgraded, left no trailer to find, only the sha256 of
 * what it wrote on the claimed request (`writtenHash`). The file still holding just that, in the
 * checkout or at main, is that write, so the request is finished as applied, not refused as done
 * already. A hash the file no longer matches (the change moved on since) counts for nothing.
 */
async function doneBefore(root: string, main: string, req: Request, slug: string): Promise<boolean> {
  if (await landed(root, main, req.id, slug, req.at)) return true;
  const want = req.writtenHash?.[slug];
  if (!want) return false;
  const rel = `intent/${slug}/intent.md`;
  const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  if (existsSync(join(root, rel)) && sha(readFileSync(join(root, rel))) === want) return true;
  const atMain = await new Git(root).run(["show", `${main}:${rel}`], true);
  return atMain.code === 0 && sha(atMain.out) === want;
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
  // Its record landed in a pass the loop was killed in: finished as started, not written again.
  if (!(await doneBefore(root, main, req, req.slug))) {
    await commitRecord(root, main, req.slug, `accepted by ${byWhom(req)}`, async (draft) => {
      const intent = await readIntent(root, req.slug);
      const was = intent.file.frontmatter.status;
      if (!(await writeIntent(intent, { status: "accepted", note: "" }, { expectStatus: "draft" }, draft))) {
        refused = was;
        return false;
      }
      return true;
    }, { request: req.id, trace });
  }
  if (refused !== null) {
    trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, via: req.via, result: "not-draft", status: refused });
    return { ok: false, status: refused, text: fromConsole ? `${req.slug} is ${refused} now, not a draft; nothing changed.` : `I did not start ${req.slug}: it is ${refused} now, not a draft, so someone already changed it.` };
  }
  trace.statusChange(req.slug, "draft", "accepted", `accepted by ${byWhom(req)}`);
  trace.event(req.slug, "chat-request", { id: req.id, kind: "accept", by: req.byName, byId: req.by, via: req.via, transport: req.transport, result: "accepted" });
  return { ok: true, status: "accepted", text: fromConsole ? resultText({ kind: "accept", expect: "draft" }, req.slug, "accepted") : `Started ${req.slug}. I will say here when it needs anyone, and when it is done.` };
}

/** Adds each draft of a new request. On its last try (see finishLanded) a draft whose commit fails is named in the result, not thrown. */
async function applyNew(root: string, main: string, trace: Trace, req: Extract<Request, { kind: "new" }>, lastTry: boolean): Promise<Outcome> {
  const added: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const i of req.intents) {
    if (!SLUG.test(i.slug)) { skipped.push(`${i.slug} (not a valid change name)`); continue; }
    const path = join(root, "intent", i.slug, "intent.md");
    // Its record landed in a pass the loop was killed in: the file there is this request's, added already.
    const done = await doneBefore(root, main, req, i.slug);
    if (!done && existsSync(path)) {
      let status = "unreadable";
      try { status = parseIntentFile(await Bun.file(path).text()).frontmatter.status; } catch { /* keep unreadable */ }
      if (!i.update || status !== "draft") { skipped.push(`${i.slug} (it already exists and is ${status})`); continue; }
    }
    if (!done) {
      try {
        await commitRecord(root, main, i.slug, `${i.update ? "update" : "open"} intent from chat`, async (draft) => {
          draft.write(`intent/${i.slug}/intent.md`, i.text);
        }, { request: req.id, trace });
      } catch (e) {
        if (!lastTry || e instanceof StopRequested) throw e;
        trace.event(i.slug, "error", { where: "request", id: req.id, kind: "new", error: errorText(e) });
        failed.push(i.slug);
        continue;
      }
    }
    trace.event(i.slug, "chat-request", { id: req.id, kind: "new", by: req.byName, update: i.update });
    added.push(i.slug);
  }
  const parts: string[] = [];
  if (added.length) parts.push(`Added to the queue as drafts: ${added.join(", ")}. Read them in intent/, then set status to accepted, or ask me to start one.`);
  if (skipped.length) parts.push(`Not written, because something changed meanwhile: ${skipped.join("; ")}.`);
  if (failed.length) parts.push(`Could not be written: ${failed.join(", ")}; an engineer can find why in the trace.`);
  return { ok: added.length > 0, status: null, text: parts.join(" ") || "Nothing was written." };
}

/** True when the settings request's record landed (see landed): it has loopstra/config.yaml, not a change's folder. */
function settingsLanded(root: string, main: string, req: SettingsRequest): Promise<boolean> {
  return landed(root, main, req.id, SETTINGS_SLUG, req.at, [CONFIG_REL]);
}

/** A settings request's refusals that are not a problem with the setting itself. */
const UNCOMMITTED_CONFIG = `${CONFIG_REL} has changes in the main checkout that are not committed. Commit or undo them first, then change the setting again.`;

/**
 * Changes one model setting (see src/settings.ts) as one record of loopstra/config.yaml on main,
 * tagged with the request's id like every request's record, so a pass killed after it landed
 * finishes it as saved. Refused with nothing committed: a path that is not a model setting, a value it
 * cannot take or a config that would not load with it (the reason is the result), a file that
 * changed since the page read it (`version`), and a file with edits in the main checkout that are
 * not committed (or one the last commit does not have), which the record would otherwise commit with it. The last two are checked inside the
 * record, under the checkout lock and after a record a kill cut short is finished (which may bring the
 * file up itself). There is no change, so the result has no status, and it is traced under _loop.
 */
async function applySettings(root: string, cfg: Config, trace: Trace, req: SettingsRequest): Promise<Outcome> {
  const main = cfg.main_branch;
  const done = (result: string, ok: boolean, text: string, more: Record<string, unknown> = {}): Outcome => {
    traced(trace, "_loop", req, result, { path: req.path, value: req.value, ...more });
    return { ok, status: null, text };
  };
  const saved = () => done("applied", true, `Saved: ${req.path} is now ${req.value ?? "its default"}. Sessions that start from now on use it.`);
  const notSaved = (problem: string) => done("refused", false, `That setting was not saved: ${problem}`, { problem });
  if (await settingsLanded(root, main, req)) return saved();
  const path = settingPath(req.path);
  if (!path) return notSaved(`${oneLine(req.path, 80)} is not a setting the page can change.`);
  const problem = settingProblem(path, req.value);
  if (problem) return notSaved(problem);
  // The result of the record's write refusing, when it did (a refusal ends the record: see commitRecord).
  const refused: { outcome?: () => Outcome } = {};
  const refuse = (outcome: () => Outcome) => { refused.outcome = outcome; return false; };
  const git = new Git(root);
  await commitRecord(root, main, SETTINGS_SLUG, `${req.path} → ${req.value ?? "default"} by ${byWhom(req)}`, async (draft) => {
    const args = ["diff", "--quiet", "HEAD", "--", CONFIG_REL];
    const diff = await git.run(args, { allowFail: true });
    // 1 is "it differs"; anything else is git failing, which must not read as either answer.
    if (diff.code > 1) throw new GitError(args, diff.out, diff.err, diff.code);
    if (diff.code === 1) return refuse(() => done("refused", false, UNCOMMITTED_CONFIG));
    // diff says nothing of a file the last commit does not have (never committed, or removed from git):
    // the record would commit it whole, with whatever is in it. Any failure here refuses, which commits nothing.
    if ((await git.run(["cat-file", "-e", `HEAD:${CONFIG_REL}`], { allowFail: true })).code !== 0) return refuse(() => done("refused", false, UNCOMMITTED_CONFIG));
    const text = draft.read(CONFIG_REL);
    if (text === null) return refuse(() => notSaved(`there is no ${CONFIG_REL} in the main code.`));
    if (configVersion(text) !== req.version) return refuse(() => done("stale", false, STALE_SETTINGS));
    const r = applySetting(join(root, CONFIG_REL), text, path, req.value);
    if (!r.ok) return refuse(() => notSaved(r.problem));
    draft.write(CONFIG_REL, r.text);
    return true;
  }, { request: req.id, trace, paths: [CONFIG_REL] });
  if (refused.outcome) return refused.outcome();
  // Committed, or nothing to commit: the file already says it.
  return saved();
}

/** The change a request is about, or the plain reason it cannot be read. */
async function current(root: string, slug: string): Promise<{ intent: Intent } | { problem: string }> {
  if (!changeExists(root, slug)) return { problem: `There is no change called ${slug} in the main code.` };
  try {
    return { intent: await readIntent(root, slug) };
  } catch {
    return { problem: `${slug}'s intent.md cannot be read, so nothing changed. Fix it, then try again.` };
  }
}

/** What a request is about, for its trace event: its change, or _loop for one about no change. */
const slugOf = (req: Request): string => ("slug" in req ? req.slug : "_loop");

/** Traces a request's `result` under `slug`, with who asked and from where. */
function traced(trace: Trace, slug: string, req: { id: string; kind: string; transport: string; by?: string; byName?: string; via?: string }, result: string, more: Record<string, unknown> = {}): void {
  trace.event(slug, "request", { id: req.id, kind: req.kind, by: req.byName, byId: req.by, via: req.via, transport: req.transport, result, ...more });
}

/** A request refused at `status` (traced so), with `text` as its result. */
function refuse(trace: Trace, req: StatusRequest | FieldRequest | AnswerRequest, status: Status, text: string, more: Record<string, unknown> = {}): Outcome {
  traced(trace, req.slug, req, "refused", { status, ...more });
  return { ok: false, status, text };
}

/** A field or answer request's change while it is open; else the refusal that ends the request. */
async function openChange(root: string, trace: Trace, req: FieldRequest | AnswerRequest): Promise<Frontmatter | Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req.slug, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const fm = found.intent.file.frontmatter;
  return isOpen(fm.status) ? fm : refuse(trace, req, fm.status, `${req.slug} is ${fm.status}; nothing changed.`);
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

/** A status request whose change moved on: nothing of it was written (a record that does not land writes nothing), so nothing is taken back. */
function movedOn(trace: Trace, req: StatusRequest, status: Status): Outcome {
  traced(trace, req.slug, req, "moved-on", { status });
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
async function applyStatus(root: string, cfg: Config, trace: Trace, req: StatusRequest, lastTry: boolean): Promise<Outcome> {
  const found = await current(root, req.slug);
  if ("problem" in found) { traced(trace, req.slug, req, "missing"); return { ok: false, status: null, text: found.problem }; }
  const was = found.intent.file.frontmatter.status;
  const to = targetOf(req);
  // Its record landed in a pass the loop was killed in: finished as applied, neither taken for a change
  // that moved on (its own record moved it) nor written again.
  const done = await doneBefore(root, cfg.main_branch, req, req.slug);
  if (!done && was !== req.expect) return movedOn(trace, req, was);
  const problem = done ? null : notAllowed(req, found.intent.file.frontmatter, cfg, trace);
  if (problem || !to) return refuse(trace, req, was, problem ?? `${req.slug} cannot do that now.`);
  const note = noteFor(req);
  let refused = null as Status | null;
  if (!done) {
    await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async (draft) => {
      const fresh = await readIntent(root, req.slug);
      if (!(await writeIntent(fresh, patchFor(req, to, note), { expectStatus: req.expect }, draft))) {
        refused = fresh.file.frontmatter.status;
        return false;
      }
      if (req.kind === "send-back") writeRecord(req.slug, { kind: "sent-back", who: req.byName, via: req.via, text: req.note.trim(), at: new Date() }, draft);
      // The send back's note no longer stands: said in the record every work session reads.
      if (undoesSendBack(req)) writeRecord(req.slug, { kind: "took-back", who: req.byName, via: req.via, at: new Date() }, draft);
      return true;
    }, { request: req.id, trace });
  }
  if (refused !== null) return movedOn(trace, req, refused);
  // Kept for the next session only once the send back landed: one that never did must not steer it.
  let after = "";
  if (req.kind === "send-back") {
    const kept = req.note.trim();
    after += followUp(trace, req, lastTry, "Its note for the next session could not be kept; an engineer can find why in the trace.", () => writeSentBack(root, req.slug, kept));
  }
  trace.upsertIntent(req.slug, to, effectivePriority(found.intent.file.frontmatter));
  trace.statusChange(req.slug, req.expect, to, note, { by: req.byName, via: req.via });
  traced(trace, req.slug, req, "applied", { from: req.expect, to, what: doneWords(req) });
  if (req.kind === "undo") after += followUp(trace, req, lastTry, "The note it was sent back with could not be dropped, so the next session may still read it; an engineer can find why in the trace.", () => dropSentBack(root, req.slug));
  return { ok: true, status: to, text: resultText(req, req.slug, to) + after };
}

/**
 * The frontmatter a status request writes (see statusPatch). An undo of an approve also takes
 * resume_from back, to the approved status before the review (where a send back goes): left at the
 * approval, a later block would offer to retry from the approval the person took back. From done back
 * to verifying it stays as it was (merged).
 */
function patchFor(req: StatusRequest, to: Status, note: string): Partial<Frontmatter> {
  const patch = statusPatch(req.expect, to, note);
  const before = SEND_BACK_TO[to];
  if (req.kind === "undo" && APPROVE_TO[to] === req.expect && before) patch.resume_from = before;
  return patch;
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
  const fm = await openChange(root, trace, req);
  if ("ok" in fm) return fm;
  // Its record landed in a pass the loop was killed in: finished as applied, not refused as done already.
  const done = await doneBefore(root, cfg.main_branch, req, req.slug);
  if (!done && req.kind === "hold" && isHeld(fm)) return refuse(trace, req, fm.status, `${req.slug} is held already; nothing changed.`);
  if (!done && req.kind === "release" && !isHeld(fm)) return refuse(trace, req, fm.status, `${req.slug} is not held; nothing changed.`);
  // A priority of null takes the line out: the change had no stated priority.
  const patch: Partial<Frontmatter> = req.kind === "priority" ? (req.priority ? { priority: req.priority } : {}) : req.kind === "hold" ? { hold: holdLine(req) } : {};
  const remove: Array<keyof Frontmatter> = req.kind === "release" ? ["hold"] : req.kind === "priority" && !req.priority ? ["priority"] : [];
  if (!done) {
    await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(req)} by ${byWhom(req)}`, async (draft) => {
      await writeIntent(await readIntent(root, req.slug), patch, { remove }, draft);
    }, { request: req.id, trace });
  }
  if (req.kind === "priority") trace.upsertIntent(req.slug, fm.status, effectivePriority({ priority: req.priority ?? undefined }));
  traced(trace, req.slug, req, "applied", { status: fm.status, what: doneWords(req) });
  return { ok: true, status: fm.status, text: resultText(req, req.slug, fm.status) };
}

/**
 * Answers the change's waiting question: on any open change whose question is open, whatever its status
 * now. In one commit ("question answered by <who> from <where>"), the question line goes and the answer
 * goes into conversation.md; once that landed, the answer is stored for the session that asked (see
 * answerQuestion).
 */
async function applyAnswer(root: string, cfg: Config, trace: Trace, req: AnswerRequest, lastTry: boolean): Promise<Outcome> {
  const fm = await openChange(root, trace, req);
  if ("ok" in fm) return fm;
  // Its record landed in a pass the loop was killed in: finished as applied, not refused as answered already.
  const done = await doneBefore(root, cfg.main_branch, req, req.slug);
  if (!done && !fm.question.trim()) return refuse(trace, req, fm.status, `${req.slug} has no question waiting; nothing changed.`);
  // An answer to the question the person saw, not to one asked since (a request naming none, from before, goes to whichever waits).
  if (!done && !sameQuestion(req.question, readQuestion(root, req.slug)?.open?.at)) return refuse(trace, req, fm.status, questionChangedText(req.slug), { why: "question changed" });
  const text = req.text.trim();
  const shape = { kind: "answer" as const, expect: fm.status, note: text };
  if (!done) {
    await commitRecord(root, cfg.main_branch, req.slug, `${doneWords(shape)} by ${byWhom(req)}`, async (draft) => {
      await writeIntent(await readIntent(root, req.slug), {}, { remove: ["question"] }, draft);
      writeRecord(req.slug, { kind: "answer", who: req.byName, via: req.via, text, at: new Date() }, draft);
    }, { request: req.id, trace });
  }
  // Stored only once the answer landed: one that never did must not resume the session.
  const after = followUp(trace, req, lastTry, "The answer could not be kept for the session that asked, so that session starts afresh and reads the answer in conversation.md; an engineer can find why in the trace.",
    () => { answerQuestion(root, req.slug, { text, by: req.byName, via: req.via }); });
  traced(trace, req.slug, req, "applied", { status: fm.status, what: doneWords(shape) });
  return { ok: true, status: fm.status, text: resultText(shape, req.slug, fm.status) + after };
}
