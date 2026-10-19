import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonAs, writeFileAtomic } from "./fsutil";
import { loopstraDir, runDir } from "./paths";
import type { Config } from "./config";
import { addDetachedWorktree, bookkeeping, Git, removeWorktree, WrongBranchError } from "./git";
import { onCheckout } from "./lanes";
import { effectivePriority, parseIntentFile, readIntent, writeChangeFile, writeIntent, type Frontmatter, type Intent, type Priority, type Status } from "./intents";
import { RecordDraft, type DraftChange } from "./record-draft";
import { errorText } from "./shell";
import { RecordRaced, RecordUnsettled, throwIfStopping } from "./stop";
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
    if (dir) await removeWorktree(this.git, dir, { cleanup: true });
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

/**
 * The branch the checkout at `git` is on (`symbolic-ref --short HEAD`), or null when it is on none
 * (detached) or git cannot say. Asked even after a stop request (see GitRunOptions' `cleanup`): a
 * stop that lands once a record has drafted does not stop it (see commitRecord).
 */
async function checkoutBranch(git: Git): Promise<string | null> {
  const r = await git.run(["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true, cleanup: true });
  return r.code === 0 ? r.out.trim() : null;
}

/**
 * Throws MainCheckoutMoved unless the checkout is still on `main`, once a record has drafted (see
 * commitRecord): a person switched branches meanwhile, so what the draft read and the folder as it is
 * on disk may be their branch's. Nothing has landed then.
 */
async function assertStillOnMain(git: Git, root: string, main: string): Promise<void> {
  const branch = await checkoutBranch(git);
  if (branch !== main) throw new MainCheckoutMoved(`the checkout at ${root} moved to ${branch ?? "no branch"} while a record was made, not ${main}`);
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

/** The record being brought into the checkout (see commitRecord), so a kill in between is finished (see settleRecord). */
const RecordMarkerSchema = z.object({ parent: z.string(), commit: z.string(), slug: z.string(), paths: z.array(z.string()) });
type RecordMarker = z.infer<typeof RecordMarkerSchema>;
const markerPath = (root: string) => join(loopstraDir(root), "recording.json");

/**
 * Writes a change's record on main and commits it: every record (statuses, artifacts, a person's
 * edits, chat's drafts, the main-health draft) is written this one way, under the checkout lock and
 * only on main (MainCheckoutMoved otherwise). A record a kill cut short is finished first (see
 * settleRecord); while it cannot be, nothing is committed (RecordUnsettled), since a
 * commit over a checkout still behind main would undo it. `write` writes into a draft, never the
 * checkout (it may give false: nothing to commit after all). Once it has drafted, and before each
 * further try, the checkout must still be on main (MainCheckoutMoved otherwise, with nothing landed:
 * what the draft read and the folder on disk may be another branch's). The commit is made first, from
 * the main branch (`refs/heads/<main>`, not HEAD, so a switch after this point never moves a person's
 * branch), the change's folder and queue.md as they are on disk, and the draft over them (see
 * Git.commitFiles); the main branch moves to it with a compare-and-swap (tried once more from its
 * new commit when someone committed meanwhile, then RecordRaced); only then are the drafted files written to the
 * checkout, each unless a person saved it since the draft read it, or since the write when the draft
 * never read it (theirs then stays, uncommitted, as any edit of theirs), and the index brought up for
 * the paths. A marker (`.loopstra/recording.json`) covers a kill between main moving and the checkout
 * matching. A throw before main moved changed nothing anywhere. Once main moved the record has landed
 * and true is given whatever fails after: every file is still tried, the marker stays for the next
 * settleRecord (a marker left over is harmless: settling leaves a file that already holds the
 * commit's content), and the trace (`opts.trace`) says what failed when it can. A checkout no
 * longer on main by then is not written at all: the marker stays, and settleRecord finishes the
 * record once the checkout is back on main. A stop
 * request ends it only before a commit is built (nothing has landed then, on a retry too); from there
 * on it does not stop it. `opts.request` tags the commit with the request it applies
 * (`Loopstra-Request: <id>`), so a later pass can ask git whether it landed. False when nothing was
 * committed.
 */
export function commitRecord(root: string, main: string, slug: string, what: string, write: (draft: RecordDraft) => Promise<boolean | void> = async () => {}, opts: { request?: string; trace?: Trace } = {}): Promise<boolean> {
  return onCheckout(root, async () => {
    const git = new Git(root);
    await assertOnMain(git, main);
    if (!(await settleRecord(root, main, opts.trace))) throw new RecordUnsettled();
    throwIfStopping();
    const paths = [`intent/${slug}`, "intent/queue.md"];
    const ref = `refs/heads/${main}`;
    const message = bookkeeping(`loopstra(${slug}): ${what}`) + (opts.request ? `\n\nLoopstra-Request: ${opts.request}` : "");
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await assertStillOnMain(git, root, main);
      const parent = await git.commitOf(ref);
      if (!parent) throw new Error(`there is no branch ${main} to record on`);
      const draft = new RecordDraft(root, slug);
      if ((await write(draft)) === false) return false;
      await assertStillOnMain(git, root, main);
      const changes = draft.changes();
      // What each drafted file held on disk when the draft read it, or now for one it never read: a
      // file that holds anything else when the checkout is written is a person's save.
      const seen = new Map(changes.map((c) => {
        const read = draft.readFromDisk(c.rel);
        return [c.rel, read !== undefined ? read : readIfThere(join(root, c.rel))] as const;
      }));
      const commit = await git.commitFiles(parent, paths, changes, message);
      if (!commit) return false;
      const marker: RecordMarker = { parent, commit, slug, paths: changes.map((c) => c.rel) };
      writeFileAtomic(markerPath(root), JSON.stringify(marker));
      if (!(await git.moveRef(ref, parent, commit))) {
        // Someone committed on main meanwhile: nothing moved, and the record is made again from main's new commit.
        rmSync(markerPath(root), { force: true });
        continue;
      }
      await afterLanding(git, root, main, slug, commit, paths, changes, seen, opts.trace);
      return true;
    }
    throw new RecordRaced(slug);
  });
}

/**
 * commitRecord once main has moved to the record's commit: the checkout is brought up to it (see
 * bringUp) and the marker removed, unless the checkout is no longer on main (a person switched
 * branches meanwhile: their branch is not written, and settleRecord finishes the record once it is
 * back on main). Never throws: the record has landed whatever fails here, which is traced when the
 * trace can be written, and leaves the marker for the next settle.
 */
async function afterLanding(git: Git, root: string, main: string, slug: string, commit: string, paths: string[], changes: DraftChange[], seen: Map<string, Buffer | null>, trace?: Trace): Promise<void> {
  const traced = (error: string) => {
    try { trace?.event(slug, "error", { where: "record", commit, error }); } catch { /* the trace cannot be written either: the marker still stands */ }
  };
  try {
    if ((await checkoutBranch(git)) !== main) {
      try {
        trace?.event(slug, "command", { command: "record landed while the checkout is on another branch", commit, note: `not written into the checkout; finished once it is back on ${main}` });
      } catch { /* the marker still stands */ }
      return;
    }
    const failed = await bringUp(git, root, paths, changes, seen);
    if (failed.length) traced(`the record landed, but the checkout could not be brought up to it (${failed.join("; ")}); it is finished on the next settle`);
    else rmSync(markerPath(root), { force: true });
  } catch (e) {
    traced(`the record landed, but finishing it failed (${errorText(e)}); it is finished on the next settle`);
  }
}

/** How far before `since` landed looks: a commit's date is the committing machine's clock, which may be behind. */
const LANDED_SLACK_MS = 60 * 60_000;

/**
 * True when a record tagged with `id` (see commitRecord's `opts.request`) landed on main for `slug`:
 * the main branch's history of the change's folder (`refs/heads/<main>`, not HEAD: a person may
 * have switched branches) has a commit with the line `Loopstra-Request: <id>`, the whole line (a subject naming the id, or a longer id it begins, is not it). A pass the loop was
 * killed in after that commit and before it finished leaves exactly this; the caller then finishes
 * as if it had just committed, and writes nothing again. `since` (ISO, when the request or message
 * was made) bounds the walk to an hour before it; one that is not a date bounds nothing. A git that
 * fails throws: "not landed" would write the record twice.
 */
export async function landed(root: string, main: string, id: string, slug: string, since?: string): Promise<boolean> {
  const from = since === undefined ? NaN : Date.parse(since);
  const bound = Number.isFinite(from) ? [`--since=${new Date(from - LANDED_SLACK_MS).toISOString()}`] : [];
  // An id is digits and hyphens (see ID in src/ids.ts), so it needs no escaping in the pattern.
  const r = await new Git(root).run(["log", "-1", "--format=%H", ...bound, `--grep=^Loopstra-Request: ${id}$`, `refs/heads/${main}`, "--", `intent/${slug}`]);
  return r.out.trim() !== "";
}

/**
 * Brings the checkout (on main) up to a record whose commit main now has: each drafted file is written or
 * removed unless a person saved it since `seen` noted it, then the index is reset for the paths. Every
 * file is tried, and the reset too, whatever failed before. What failed, each with its error.
 */
async function bringUp(git: Git, root: string, paths: string[], changes: DraftChange[], seen: Map<string, Buffer | null>): Promise<string[]> {
  const failed: string[] = [];
  for (const c of changes) {
    try {
      const abs = join(root, c.rel);
      const now = readIfThere(abs);
      const was = seen.get(c.rel) ?? null;
      // A person saved it since it was noted: theirs stays, uncommitted.
      if (!(now === null ? was === null : was !== null && now.equals(was))) continue;
      if (c.text === null) rmSync(abs, { force: true });
      else writeFileAtomic(abs, c.text, loopstraDir(root));
    } catch (e) {
      failed.push(`${c.rel}: ${errorText(e)}`);
    }
  }
  try {
    // The whole folder: the commit also took a person's unstaged edits in it, whose index entries are
    // now behind main. A path that matches nothing (queue.md not made yet) does not stop the others.
    await git.run(["reset", "-q", "--", ...paths], { cleanup: true });
  } catch (e) {
    failed.push(`the index: ${errorText(e)}`);
  }
  return failed;
}

/**
 * Finishes a record a kill (or a failure after main moved, or a branch switch) left between moving
 * main and writing the checkout (see commitRecord), at the start of each tick, of each record and of
 * a local merge. Only with the checkout on `main`: off it, HEAD is a person's branch, and the marker
 * waits. Main at the marker's parent: main never moved, and the marker goes. Main at the marker's commit or past it: each file the marker names
 * that still holds what the parent had (as git compares it) is brought up to the commit; one holding
 * anything else is left (a person's edit since, or the commit's own content already written); the
 * index is brought up for the record's paths. Anything else (main reset by a person): the marker goes.
 * Under the checkout lock, so a record in progress is never taken for one a kill cut short; a stop
 * request does not stop it. Traced when there is a trace. Never throws: true when no marker is left,
 * false when one is (off main, or a failure, which is traced and tried again on the next settle).
 */
export function settleRecord(root: string, main: string, trace?: Trace): Promise<boolean> {
  return onCheckout(root, () => settle(root, main, trace));
}

async function settle(root: string, main: string, trace?: Trace): Promise<boolean> {
  let slug = "_loop";
  try {
    const m = readJsonAs(markerPath(root), RecordMarkerSchema);
    // No marker, or one that is not one (half-written): nothing to finish.
    if (!m) { rmSync(markerPath(root), { force: true }); return true; }
    slug = m.slug;
    const git = new Git(root);
    const o = { allowFail: true, cleanup: true };
    const branch = await git.run(["symbolic-ref", "-q", "--short", "HEAD"], o);
    if (branch.code !== 0 || branch.out.trim() !== main) return false;
    const head = (await git.run(["rev-parse", "--verify", `refs/heads/${main}`], { cleanup: true })).out.trim();
    const landed = head === m.commit || (await git.run(["merge-base", "--is-ancestor", m.commit, head], o)).code === 0;
    if (head !== m.parent && landed) {
      for (const rel of m.paths) {
        const inParent = (await git.run(["cat-file", "-e", `${m.parent}:${rel}`], o)).code === 0;
        // A file the parent did not have and the disk has now: the record's already, or a person's. Left.
        if (!inParent && existsSync(join(root, rel))) continue;
        const untouched = (await git.run(["diff", "--quiet", m.parent, "--", rel], o)).code === 0;
        if (!untouched) continue;
        const inCommit = (await git.run(["cat-file", "-e", `${m.commit}:${rel}`], o)).code === 0;
        if (inCommit) await git.run(["checkout", m.commit, "--", rel], { cleanup: true });
        else rmSync(join(root, rel), { force: true });
      }
      await git.run(["reset", "-q", "--", `intent/${m.slug}`, "intent/queue.md"], { cleanup: true });
      trace?.event(m.slug, "command", { command: "finish a record a kill cut short", commit: m.commit });
    } else if (head !== m.parent) {
      trace?.event(m.slug, "command", { command: "drop the marker of a record main no longer has (main was reset)", commit: m.commit });
    }
    rmSync(markerPath(root), { force: true });
    return true;
  } catch (e) {
    trace?.event(slug, "error", { where: "record", error: `a record a kill cut short could not be finished; it is tried again: ${errorText(e)}` });
    return false;
  }
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

/** What a file holds, or null when it is not there. */
function readIfThere(abs: string): Buffer | null {
  try { return readFileSync(abs); } catch (e) { if (codeOf(e) === "ENOENT") return null; throw e; }
}

/**
 * commitRecord for a step's own change. The write changes the step's intent in memory as it drafts;
 * when the record fails, the intent goes back to what it was before (nothing of the draft reached
 * disk), so a block that follows starts from the status saved, not from one never saved (which it
 * would take for a person's). Not read again from the file: a status a person set meanwhile must
 * still meet the block as theirs (PersonChangedStatus), not be blocked over. A second try of the
 * write (main moved meanwhile, see commitRecord) starts from the intent as it was before the first.
 */
export async function commitForStep(ctx: StepContext, what: string, write: (draft: RecordDraft) => Promise<boolean | void>): Promise<boolean> {
  const { file, artifacts } = ctx.intent;
  const known = new Set(artifacts);
  const restore = () => { ctx.intent.file = file; ctx.intent.artifacts = new Set(known); };
  try {
    return await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, what, async (draft) => { restore(); return write(draft); }, { trace: ctx.trace });
  } catch (e) {
    restore();
    throw e;
  }
}

/**
 * Writes frontmatter keys for the runtime into the record's draft (inside commitRecord), read right
 * before writing, never over a status a person set while the step ran, nor into a change a person
 * deleted meanwhile (throws PersonChangedStatus instead).
 */
export async function writeForStep(ctx: StepContext, patch: Partial<Intent["file"]["frontmatter"]>, draft: RecordDraft): Promise<void> {
  const expected = ctx.intent.file.frontmatter.status;
  if (!(await writeIntent(ctx.intent, patch, { expectStatus: expected }, draft))) {
    throwIfDeleted(ctx, draft);
    const found = parseIntentFile(draft.read(intentRel(ctx))!).frontmatter.status;
    throw new PersonChangedStatus(expected, found);
  }
}

/** The change's intent.md, relative to the repository (as a draft names it). */
const intentRel = (ctx: StepContext) => `intent/${ctx.slug}/intent.md`;

/** Throws PersonChangedStatus when the change's intent.md is gone: a person deleted the change while the step ran. */
function throwIfDeleted(ctx: StepContext, draft: RecordDraft): void {
  if (draft.read(intentRel(ctx)) === null) throw new PersonChangedStatus(ctx.intent.file.frontmatter.status, "deleted");
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

/**
 * Writes the status and commits it (see commitRecord). `extra` goes into the traced status change,
 * which is traced once the commit landed (a write tried again, or never committed, is not traced).
 */
export async function setStatus(ctx: StepContext, status: Status, note = "", extra: Record<string, unknown> = {}): Promise<void> {
  const from = ctx.intent.file.frontmatter.status;
  const patch = statusPatch(from, status, note);
  const landed = await commitForStep(ctx, `${from} → ${status}`, async (draft) => {
    await writeForStep(ctx, patch, draft);
  });
  if (!landed) return;
  ctx.trace.upsertIntent(ctx.slug, status, effectivePriority(ctx.intent.file.frontmatter));
  ctx.trace.statusChange(ctx.slug, from, status, note, extra);
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
function retryTarget(ctx: StepContext, note: string, retryFrom?: Status): Status | null {
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
  if (!existsSync(p)) return null;
  return Bun.file(p).text();
}

/** Writes an artifact whole on main and commits it (see commitRecord); never into a change a person deleted (PersonChangedStatus). */
export async function writeArtifact(ctx: StepContext, name: string, text: string): Promise<void> {
  await commitForStep(ctx, `write ${name}`, async (draft) => {
    throwIfDeleted(ctx, draft);
    writeChangeFile(ctx.intent, name, text.endsWith("\n") ? text : text + "\n", draft);
    ctx.intent.artifacts.add(name);
  });
}

/** Commits the change's own folder on main as it is now (a person's uncommitted edits to it); nothing else is touched. */
export async function recordPersonEdits(ctx: StepContext): Promise<void> {
  await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, "record edits made by a person", undefined, { trace: ctx.trace });
}

/** Run-folder file: the agent sessions to resume, by key. */
const SESSIONS = "sessions.json";

/**
 * The sessions to resume, by key. Only a plain object's string values count: a file that holds
 * anything else (null, a list, a number where an id should be) should never crash a step, so the
 * rest is dropped, as a corrupt or unreadable file is.
 */
export function loadSessions(ctx: StepContext): Record<string, string> {
  let read: unknown;
  try {
    read = JSON.parse(readMarker(ctx, SESSIONS) ?? "{}");
  } catch {
    return {};
  }
  if (!read || typeof read !== "object" || Array.isArray(read)) return {};
  return Object.fromEntries(Object.entries(read).filter((kv): kv is [string, string] => typeof kv[1] === "string"));
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
  const landed = await commitForStep(ctx, "record priority", async (draft) => {
    // The owner may have stated one while the step ran: read what the file says now, if it is still there.
    throwIfDeleted(ctx, draft);
    const now = parseIntentFile(draft.read(intentRel(ctx))!);
    if (now.frontmatter.status !== ctx.intent.file.frontmatter.status) throw new PersonChangedStatus(ctx.intent.file.frontmatter.status, now.frontmatter.status);
    if (now.frontmatter.priority !== undefined) { ctx.intent.file = now; return false; }
    await writeForStep(ctx, { priority }, draft);
    return true;
  });
  if (landed) ctx.trace.upsertIntent(ctx.slug, ctx.intent.file.frontmatter.status, priority);
}
