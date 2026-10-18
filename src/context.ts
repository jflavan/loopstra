import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDir } from "./paths";
import type { Config } from "./config";
import { addDetachedWorktree, bookkeeping, Git, removeWorktree, WrongBranchError } from "./git";
import { onCheckout } from "./lanes";
import { effectivePriority, readIntent, writeChangeFile, writeIntent, type Frontmatter, type Intent, type Priority, type Status } from "./intents";
import { throwIfStopping } from "./stop";
import type { Trace } from "./trace";

/** The folder that holds each change's snapshot of main (see StepContext.snapshot). */
export function snapshotsDir(root: string): string {
  return join(root, ".loopstra", "snapshots");
}

export class StepContext {
  readonly git: Git;
  /** The commit this step's read-only sessions read, once asked for (see readCommit). */
  private reading: Promise<string> | null = null;
  /** The step's snapshot, once asked for (see snapshot). */
  private made: Promise<string> | null = null;
  /** The kinds of phase (see phaseKind) whose first session of the step has started: only that one may resume an answered question (see answerFor). */
  readonly kindsStarted = new Set<string>();
  /** When the step began (ms since the epoch): a question asked before it and not used is closed when it ends (see closeUnusedAnswer). */
  readonly startedAt = Date.now();
  constructor(
    public readonly root: string,
    public readonly cfg: Config,
    public readonly trace: Trace,
    public intent: Intent,
  ) {
    this.git = new Git(root);
  }
  get slug(): string { return this.intent.slug; }
  get runDir(): string { return runDir(this.root, this.slug); }
  get worktreeDir(): string { return join(this.root, ".loopstra", "worktrees", this.slug); }
  get branch(): string { return `intent/${this.slug}`; }
  async reload(): Promise<void> { this.intent = await readIntent(this.root, this.slug); }

  /**
   * The commit this step's read-only sessions read: main's when the step first asks. It stays the
   * same for every session of the step, so another change merging meanwhile never changes what one
   * step reads.
   */
  readCommit(): Promise<string> {
    if (!this.reading) {
      const p = this.git.run(["rev-parse", "--verify", `${this.cfg.main_branch}^{commit}`]).then((r) => r.out.trim());
      p.catch(() => { if (this.reading === p) this.reading = null; }); // a failure is not kept: the next ask tries again
      this.reading = p;
    }
    return this.reading;
  }

  /**
   * Where the step's read-only sessions run: a detached worktree of readCommit
   * (`.loopstra/snapshots/<slug>`), made the first time a session asks, so none sees the main
   * checkout's uncommitted files or main moving. Removed when the step ends (see dropSnapshot).
   */
  snapshot(): Promise<string> {
    if (!this.made) {
      const dir = join(snapshotsDir(this.root), this.slug);
      const p = this.readCommit().then(async (sha) => { await addDetachedWorktree(this.git, dir, sha); return dir; });
      p.catch(() => { if (this.made === p) this.made = null; });
      this.made = p;
    }
    return this.made;
  }

  /** Removes the step's snapshot, if it made one. */
  async dropSnapshot(): Promise<void> {
    const made = this.made;
    this.made = null;
    this.reading = null;
    if (!made) return;
    const dir = await made.catch(() => null);
    if (dir) await removeWorktree(this.git, dir);
  }
}

/**
 * `waiting`: the step only looked at a pull request (the watcher's steps) and nothing changed; it
 * looks again later. `personChanged`: a person set the status while the step ran, so
 * the step ended without writing anything over it; the next tick picks up their status.
 * `stoppedBy`: a person stopped the step's session (who), so the step ended and the change kept its
 * status. `asked`: an agent asked a person a question, so the change waits for the answer.
 */
export type StepResult =
  | { ok: true; waiting?: boolean; personChanged?: boolean; stoppedBy?: string; asked?: boolean }
  | { ok: false; note: string };

/**
 * A person changed the status in intent.md while the step ran. The step ends without blocking or
 * advancing; nothing is written over the person's status.
 */
export class PersonChangedStatus extends Error {
  constructor(public readonly expected: string, public readonly found: string) {
    super(`a person changed the status from ${expected} to ${found} while the step ran`);
    this.name = "PersonChangedStatus";
  }
}

/** Records that a step ended because a person changed the status, and the quiet result for it. */
export function personChangedStatus(ctx: StepContext, e: PersonChangedStatus): StepResult {
  ctx.trace.event(ctx.slug, "person-changed-status", { from: e.expected, to: e.found, note: "the step ended without writing; the next tick picks up the person's status" });
  return { ok: true, personChanged: true };
}

const APPROVED: ReadonlySet<Status> = new Set(["accepted", "spec-approved", "plan-approved", "merge-approved", "merged"]);

export const OFF_MAIN_NOTE = "The main checkout is on a different branch; an engineer needs to switch it back.";

/** The repository root is not on `main_branch`, so artifacts must not be written or committed there. */
export class MainCheckoutMoved extends Error {
  constructor(public readonly detail: string) {
    super(OFF_MAIN_NOTE);
    this.name = "MainCheckoutMoved";
  }
}

/** Throws MainCheckoutMoved unless the checkout at `git` is on `main` (a stop request or a git error passes through). */
async function assertOnMain(git: Git, main: string): Promise<void> {
  try {
    await git.assertBranch(main);
  } catch (e) {
    if (e instanceof WrongBranchError) throw new MainCheckoutMoved(e.message);
    throw e;
  }
}

/**
 * Writes a change's record on main and commits it: every record (statuses, artifacts, a person's
 * edits, chat's drafts, the main-health draft) is written this one way. One checkout-lock section:
 * the checkout must be on main (MainCheckoutMoved otherwise, since a record written into another
 * branch's checkout would land on that branch); `write` writes files under intent/<slug> (it may
 * give false: nothing to commit after all); then they are committed with the generated queue.md,
 * which is never committed on its own. Once writing has begun the commit is not stopped by a stop
 * request (only bounded by git's time limit), so a stop never leaves a record written but not
 * committed. All or nothing: when the commit fails (a held index lock, a timeout, a hook), the files
 * are put back as they were before the write and nothing is left staged (see putBackRecord), then the
 * error goes on; a record left written but not committed would hold up every sync and local merge.
 * The tick shares main with the remote once, at its end. False when nothing was committed.
 */
export function commitRecord(root: string, main: string, slug: string, what: string, write: () => Promise<boolean | void> = async () => {}): Promise<boolean> {
  return onCheckout(root, async () => {
    const git = new Git(root);
    await assertOnMain(git, main);
    throwIfStopping();
    const paths = [`intent/${slug}`, "intent/queue.md"];
    const before = filesUnder(root, paths);
    const head = await git.headSha();
    if ((await write()) === false) return false;
    const written = filesUnder(root, paths);
    const message = bookkeeping(`loopstra(${slug}): ${what}`);
    try {
      return await git.commitPaths(paths, message, { finish: true });
    } catch (e) {
      if (await nothingLanded(git, head, message)) await putBackRecord(git, root, paths, before, written);
      throw e;
    }
  });
}

/**
 * True when a failed commit of `message` on `head` left nothing of its own in HEAD, so its record
 * can be put back: HEAD is still `head`, or moved on by someone else's commit (a person's, in the
 * main checkout meanwhile). False when its own commit landed before its error (git's time limit cut
 * in after it), since putting the files back would leave main's checkout behind its own HEAD, and
 * when HEAD cannot be read: the files are then left written, which loses nothing.
 */
async function nothingLanded(git: Git, head: string, message: string): Promise<boolean> {
  const now = await git.run(["log", "-1", "--format=%H%n%P%n%s", "HEAD"], { allowFail: true, cleanup: true }).catch(() => null);
  if (now?.code !== 0) return false;
  const [sha, parents, subject] = now.out.trim().split("\n");
  return sha === head || parents !== head || subject !== message;
}

/** The files under these paths (each a file or a folder, relative to `root`), with what each holds, by path relative to `root`. */
function filesUnder(root: string, paths: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const visit = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) visit(`${rel}/${name}`);
    else out.set(rel, readFileSync(abs));
  };
  for (const p of paths) visit(p);
  return out;
}

/**
 * Puts a record whose commit failed back as it was before the write: each file the write changed
 * gets its old content back, one it made goes, one it removed comes back. A file that changed again
 * since the write (a person's edit) is left as it is. Then the paths are unstaged. The unstage runs
 * even after a stop request, like the commit it undoes, and a failure of it is left: the files are
 * already back, and an index git could not write still has what HEAD has for them.
 */
async function putBackRecord(git: Git, root: string, paths: string[], before: Map<string, Buffer>, written: Map<string, Buffer>): Promise<void> {
  for (const [rel, text] of written) {
    const abs = join(root, rel);
    const was = before.get(rel);
    if (was?.equals(text) || !existsSync(abs) || !readFileSync(abs).equals(text)) continue;
    if (was) writeFileSync(abs, was);
    else rmSync(abs, { force: true });
  }
  for (const [rel, was] of before) {
    const abs = join(root, rel);
    if (!written.has(rel) && !existsSync(abs)) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, was); }
  }
  try {
    await git.run(["reset", "-q", "--", ...paths], { allowFail: true, cleanup: true });
  } catch { /* a timeout: the commit's own error is the one to report */ }
}

/**
 * commitRecord for a step's own change. When it fails, the step's intent goes back to what it was
 * before the write: the write already changed it in memory, and commitRecord put the file back, so a
 * block that follows starts from the status saved, not from one never saved (which it would take for
 * a person's). Not read again from the file: a status a person set meanwhile, which commitRecord
 * leaves, must still meet the block as theirs (PersonChangedStatus), not be blocked over.
 */
export async function commitForStep(ctx: StepContext, what: string, write: () => Promise<boolean | void>): Promise<boolean> {
  const { file, artifacts } = ctx.intent;
  const known = new Set(artifacts);
  try {
    return await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, what, write);
  } catch (e) {
    ctx.intent.file = file;
    ctx.intent.artifacts = known;
    throw e;
  }
}

/**
 * Writes frontmatter keys for the runtime (inside commitRecord), re-read from disk right before
 * writing, never over a status a person set while the step ran, nor into a change a person deleted
 * meanwhile (throws PersonChangedStatus instead).
 */
export async function writeForStep(ctx: StepContext, patch: Partial<Intent["file"]["frontmatter"]>): Promise<void> {
  const expected = ctx.intent.file.frontmatter.status;
  if (!(await writeIntent(ctx.intent, patch, { expectStatus: expected }))) {
    throwIfDeleted(ctx);
    const found = (await readIntent(ctx.root, ctx.slug)).file.frontmatter.status;
    throw new PersonChangedStatus(expected, found);
  }
}

/** Throws PersonChangedStatus when the change's intent.md is gone: a person deleted the change while the step ran. */
function throwIfDeleted(ctx: StepContext): void {
  if (!existsSync(join(ctx.intent.dir, "intent.md"))) throw new PersonChangedStatus(ctx.intent.file.frontmatter.status, "deleted");
}

/**
 * The frontmatter a status change writes: the status, the note, and resume_from following the
 * approved state (entered, or being left). The runtime's steps and the requests people make both use it.
 */
export function statusPatch(from: Status, to: Status, note: string): Partial<Frontmatter> {
  const patch: Partial<Frontmatter> = { status: to, note };
  // resume_from always follows the approved state being left, even if it was already set:
  // a person may have set an approved status by hand, and the marker must follow.
  if (APPROVED.has(to)) patch.resume_from = to;
  else if (APPROVED.has(from)) patch.resume_from = from;
  return patch;
}

/** Writes the status and commits it (see commitRecord). `extra` goes into the traced status change. */
export async function setStatus(ctx: StepContext, status: Status, note = "", extra: Record<string, unknown> = {}): Promise<void> {
  const from = ctx.intent.file.frontmatter.status;
  const patch = statusPatch(from, status, note);
  await commitForStep(ctx, `${from} → ${status}`, async () => {
    await writeForStep(ctx, patch);
    ctx.trace.upsertIntent(ctx.slug, status, effectivePriority(ctx.intent.file.frontmatter));
    ctx.trace.statusChange(ctx.slug, from, status, note, extra);
  });
}

/** True when a note already tells the person which status to set. */
function saysWhatToSet(note: string): boolean {
  return /\b(set|change)\b[^.]*\b(status|to closed|to done)\b/i.test(note);
}

/**
 * The status a person sets to try a block again, as blockNote words it: `retryFrom` when given, else
 * the approved status the change is resumed from. Null when the note already says what to set, or
 * there is no approved status to go back to.
 */
export function retryTarget(ctx: StepContext, note: string, retryFrom?: Status): Status | null {
  if (saysWhatToSet(note)) return null;
  const from = ctx.intent.file.frontmatter.status;
  return retryFrom ?? (APPROVED.has(from) ? from : ctx.intent.file.frontmatter.resume_from) ?? null;
}

/** The owner's notes for a passing hiccup (the assistant crashed, or took too long): nothing to sort out first. */
export const CRASH_NOTE = "The assistant stopped unexpectedly.";
export const TIMEOUT_NOTE = "The assistant took too long on this step.";

/**
 * The note a block writes: the reason, plus how to try again when the reason does not already say
 * which status to set. The retry status is `retryFrom` when given (a merge retried without a
 * rebuild), else the approved status the change is resumed from. A passing hiccup (a crash or a
 * timeout) just says "To try again, ..."; anything else says "When that is sorted out, ...". Only
 * this function words it.
 */
export function blockNote(ctx: StepContext, note: string, retryFrom?: Status): string {
  const resume = retryTarget(ctx, note, retryFrom);
  if (!resume) return note;
  if (note.includes(CRASH_NOTE) || note.includes(TIMEOUT_NOTE)) return `${note} To try again, set status to ${resume}.`;
  return `${note} When that is sorted out, set status to ${resume} to try again.`;
}


/**
 * Something went wrong that the caller has not recorded yet: a plain note for the owner and detail
 * for the trace. `retryFrom` overrides the status a person sets to try again (see blockNote).
 */
export type Failure = { ok: false; note: string; detail: string; retryFrom?: Status };

/**
 * Blocks the change with a plain note for the owner (worded by blockNote). A `detail` (check ids,
 * commands, output, branch names) goes to the trace, where an engineer can find it. A Failure can
 * be passed as the options whole: `block(ctx, f.note, f)`.
 */
export async function block(ctx: StepContext, reason: string, opts: { detail?: unknown; retryFrom?: Status } = {}): Promise<{ ok: false; note: string }> {
  if (opts.detail !== undefined) ctx.trace.event(ctx.slug, "error", { note: reason, detail: opts.detail });
  const note = blockNote(ctx, reason, opts.retryFrom);
  // Recorded in the trace, so the console can offer the status the note names as a retry.
  const retry = retryTarget(ctx, reason, opts.retryFrom);
  try {
    await setStatus(ctx, "blocked", note, retry ? { retry } : {});
  } catch (e) {
    if (!(e instanceof MainCheckoutMoved)) throw e;
    // Nothing can be recorded on main while the checkout is elsewhere; the loop pauses until it is back.
    ctx.trace.event(ctx.slug, "error", { where: "block", note, detail: e.detail });
    return { ok: false, note: OFF_MAIN_NOTE };
  }
  return { ok: false, note };
}

/** The content of a run-folder file (the intent's runtime state, never in intent/), or null when it does not exist. */
export function readMarker(ctx: StepContext, name: string): string | null {
  const p = join(ctx.runDir, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Writes a run-folder file, replacing what was there. */
export function writeMarker(ctx: StepContext, name: string, content: string): void {
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, name), content);
}

export function clearMarker(ctx: StepContext, name: string): void {
  rmSync(join(ctx.runDir, name), { force: true });
}

/**
 * A once-only run-folder marker. Returns true when this call created it, false when it already
 * existed, so "do X once" survives a restart. The marker holds `content` (for a resend: the
 * findings it was sent with), read back by readMarker.
 */
export function onceMarker(ctx: StepContext, name: string, content = ""): boolean {
  if (readMarker(ctx, name) !== null) return false;
  writeMarker(ctx, name, content);
  return true;
}

export async function readArtifact(ctx: StepContext, name: string): Promise<string | null> {
  const p = join(ctx.intent.dir, name);
  return existsSync(p) ? await Bun.file(p).text() : null;
}

/** Writes an artifact whole on main and commits it (see commitRecord); never into a change a person deleted (PersonChangedStatus). */
export async function writeArtifact(ctx: StepContext, name: string, text: string): Promise<void> {
  await commitForStep(ctx, `write ${name}`, async () => {
    throwIfDeleted(ctx);
    writeChangeFile(ctx.intent, name, text.endsWith("\n") ? text : text + "\n");
    ctx.intent.artifacts.add(name);
  });
}

/** Commits the change's own folder on main as it is now (a person's uncommitted edits to it); nothing else is touched. */
export async function recordPersonEdits(ctx: StepContext): Promise<void> {
  await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, "record edits made by a person");
}

/** Run-folder file: the agent sessions to resume, by key. */
const SESSIONS = "sessions.json";

export function loadSessions(ctx: StepContext): Record<string, string> {
  try {
    return JSON.parse(readMarker(ctx, SESSIONS) ?? "{}") as Record<string, string>;
  } catch {
    // A corrupt or unreadable sessions.json should never crash a step; start fresh.
    return {};
  }
}

export function saveSession(ctx: StepContext, key: string, sessionId: string): void {
  writeMarker(ctx, SESSIONS, JSON.stringify({ ...loadSessions(ctx), [key]: sessionId }, null, 2));
}

export function clearSession(ctx: StepContext, key: string): void {
  const all = loadSessions(ctx);
  delete all[key];
  writeMarker(ctx, SESSIONS, JSON.stringify(all, null, 2));
}

/** Run-folder file: the note a person sent the change back with, for the next writing or build session (see sentBackNote). */
export const SENT_BACK = "sent-back.md";

/** Keeps the note a person sent a change back with, until the next session of the stage it went back to has used it. */
export function writeSentBack(root: string, slug: string, note: string): void {
  const dir = runDir(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SENT_BACK), note);
}

/** The note the change was sent back with, worded for a session ("" when there is none). */
export function sentBackNote(ctx: StepContext): string {
  const note = readMarker(ctx, SENT_BACK)?.trim() ?? "";
  return note ? `A person sent the earlier version back with this note:\n${note}` : "";
}

/** Drops a kept sent-back note (its send back was undone, or never landed); with `only`, only when it is that note. */
export function dropSentBack(root: string, slug: string, only?: string): void {
  const path = join(runDir(root, slug), SENT_BACK);
  if (only !== undefined && (!existsSync(path) || readFileSync(path, "utf8") !== only)) return;
  rmSync(path, { force: true });
}


/**
 * Records a priority only when the owner stated none; an owner's own priority is never overwritten.
 * It is committed at once (see commitRecord): left unsaved through the design session, it would
 * hold up a sync or a merge (main would have unsaved changes).
 */
export async function writeIntentPriority(ctx: StepContext, priority: Priority): Promise<void> {
  await commitForStep(ctx, "record priority", async () => {
    // The owner may have stated one while the step ran: read what the file says now, if it is still there.
    throwIfDeleted(ctx);
    const now = await readIntent(ctx.root, ctx.slug);
    if (now.file.frontmatter.status !== ctx.intent.file.frontmatter.status) throw new PersonChangedStatus(ctx.intent.file.frontmatter.status, now.file.frontmatter.status);
    if (now.file.frontmatter.priority !== undefined) { ctx.intent.file = now.file; return false; }
    await writeForStep(ctx, { priority });
    ctx.trace.upsertIntent(ctx.slug, ctx.intent.file.frontmatter.status, priority);
    return true;
  });
}
