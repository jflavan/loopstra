import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { bookkeeping, Git } from "./git";
import { effectivePriority, readIntent, writeIntent, type Intent, type Priority, type Status } from "./intents";
import type { Trace } from "./trace";

export class StepContext {
  readonly git: Git;
  constructor(
    public readonly root: string,
    public readonly cfg: Config,
    public readonly trace: Trace,
    public intent: Intent,
  ) {
    this.git = new Git(root);
  }
  get slug(): string { return this.intent.slug; }
  get runDir(): string { return join(this.root, ".loopstra", "runs", this.slug); }
  get worktreeDir(): string { return join(this.root, ".loopstra", "worktrees", this.slug); }
  get branch(): string { return `intent/${this.slug}`; }
  async reload(): Promise<void> { this.intent = await readIntent(this.root, this.slug); }
}

/**
 * `waiting`: the step only looked (for example at a pull request) and nothing changed; another
 * change may run in the same tick. `personChanged`: a person set the status while the step ran, so
 * the step ended without writing anything over it; the next tick picks up their status.
 */
export type StepResult = { ok: true; waiting?: boolean; personChanged?: boolean } | { ok: false; note: string };

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

/** Throws MainCheckoutMoved unless the repository root is on `main_branch`. */
export async function assertRootOnMain(ctx: StepContext): Promise<void> {
  try {
    await ctx.git.assertBranch(ctx.cfg.main_branch);
  } catch (e) {
    throw new MainCheckoutMoved(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Commits the change's folder on the main branch, with the generated queue.md along (the queue is
 * never committed on its own). The tick shares main with the remote once, at its end. Refuses when
 * the root is on any other branch.
 */
export async function commitArtifacts(ctx: StepContext, what: string): Promise<void> {
  await assertRootOnMain(ctx);
  await ctx.git.commitPaths([`intent/${ctx.slug}`, "intent/queue.md"], bookkeeping(`loopstra(${ctx.slug}): ${what}`));
}

/**
 * Writes frontmatter keys for the runtime: only on main, re-read from disk right before writing,
 * and never over a status a person set while the step ran (throws PersonChangedStatus instead).
 */
async function writeForStep(ctx: StepContext, patch: Partial<Intent["file"]["frontmatter"]>): Promise<void> {
  // Check before writing: a status written into another branch's checkout would land on that branch.
  await assertRootOnMain(ctx);
  const expected = ctx.intent.file.frontmatter.status;
  if (!(await writeIntent(ctx.intent, patch, { expectStatus: expected }))) {
    const found = (await readIntent(ctx.root, ctx.slug)).file.frontmatter.status;
    throw new PersonChangedStatus(expected, found);
  }
}

export async function setStatus(ctx: StepContext, status: Status, note = ""): Promise<void> {
  const from = ctx.intent.file.frontmatter.status;
  const patch: Partial<Intent["file"]["frontmatter"]> = { status, note };
  // resume_from always follows the approved state being left, even if it was already set:
  // a person may have set an approved status by hand, and the marker must follow.
  if (APPROVED.has(status)) patch.resume_from = status;
  else if (APPROVED.has(from)) patch.resume_from = from;
  await writeForStep(ctx, patch);
  ctx.trace.upsertIntent(ctx.slug, status, effectivePriority(ctx.intent.file.frontmatter));
  ctx.trace.statusChange(ctx.slug, from, status, note);
  await commitArtifacts(ctx, `${from} → ${status}`);
}

/** True when a note already tells the person which status to set. */
function saysWhatToSet(note: string): boolean {
  return /\b(set|change)\b[^.]*\b(status|to closed|to done)\b/i.test(note);
}

/**
 * The note a block writes: the reason, plus how to try again when the reason does not already say
 * which status to set. The retry status is `retryFrom` when given (a merge retried without a
 * rebuild), else the approved status the change is resumed from. Only this function words it.
 */
export function blockNote(ctx: StepContext, note: string, retryFrom?: Status): string {
  if (saysWhatToSet(note)) return note;
  const from = ctx.intent.file.frontmatter.status;
  const resume = retryFrom ?? (APPROVED.has(from) ? from : ctx.intent.file.frontmatter.resume_from);
  return resume ? `${note} When that is sorted out, set status to ${resume} to try again.` : note;
}

export async function block(ctx: StepContext, reason: string, retryFrom?: Status): Promise<{ ok: false; note: string }> {
  const note = blockNote(ctx, reason, retryFrom);
  try {
    await setStatus(ctx, "blocked", note);
  } catch (e) {
    if (!(e instanceof MainCheckoutMoved)) throw e;
    // Nothing can be recorded on main while the checkout is elsewhere; the loop pauses until it is back.
    ctx.trace.event(ctx.slug, "error", { where: "block", note, detail: e.detail });
    return { ok: false, note: OFF_MAIN_NOTE };
  }
  return { ok: false, note };
}

/**
 * Blocks with a plain note for the owner and records the technical detail (check ids,
 * commands, output, branch names) in the trace, where an engineer can find it.
 */
export async function blockWithDetail(ctx: StepContext, note: string, detail: unknown, retryFrom?: Status): Promise<{ ok: false; note: string }> {
  ctx.trace.event(ctx.slug, "error", { note, detail });
  return block(ctx, note, retryFrom);
}

/**
 * Something went wrong that the caller has not recorded yet: a plain note for the owner and detail
 * for the trace. `retryFrom` overrides the status a person sets to try again (see blockNote).
 */
export type Failure = { ok: false; note: string; detail: string; retryFrom?: Status };

export function blockWith(ctx: StepContext, f: Failure): Promise<{ ok: false; note: string }> {
  return blockWithDetail(ctx, f.note, f.detail, f.retryFrom);
}

/**
 * A once-only runtime marker in the intent's run folder (never in intent/). Returns true when
 * this call created it, false when it already existed, so "do X once" survives a restart. The
 * marker holds `content` (for a resend: the findings it was sent with), read back by readMarker.
 */
export function onceMarker(ctx: StepContext, name: string, content = ""): boolean {
  const p = join(ctx.runDir, name);
  if (existsSync(p)) return false;
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(p, content);
  return true;
}

/** Writes a run-folder file, replacing what was there. */
export function writeMarker(ctx: StepContext, name: string, content: string): void {
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, name), content);
}

/** The content of a marker, or null when it does not exist. */
export function readMarker(ctx: StepContext, name: string): string | null {
  const p = join(ctx.runDir, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function clearMarker(ctx: StepContext, name: string): void {
  rmSync(join(ctx.runDir, name), { force: true });
}

export async function readArtifact(ctx: StepContext, name: string): Promise<string | null> {
  const p = join(ctx.intent.dir, name);
  return existsSync(p) ? await Bun.file(p).text() : null;
}

export async function writeArtifact(ctx: StepContext, name: string, text: string): Promise<void> {
  await assertRootOnMain(ctx);
  await Bun.write(join(ctx.intent.dir, name), text.endsWith("\n") ? text : text + "\n");
  ctx.intent.artifacts.add(name);
  await commitArtifacts(ctx, `write ${name}`);
}

export function loadSessions(ctx: StepContext): Record<string, string> {
  const p = join(ctx.runDir, "sessions.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    // A corrupt or unreadable sessions.json should never crash a step; start fresh.
    return {};
  }
}

export function saveSession(ctx: StepContext, key: string, sessionId: string): void {
  mkdirSync(ctx.runDir, { recursive: true });
  const all = loadSessions(ctx);
  all[key] = sessionId;
  writeFileSync(join(ctx.runDir, "sessions.json"), JSON.stringify(all, null, 2));
}

export function clearSession(ctx: StepContext, key: string): void {
  const all = loadSessions(ctx);
  delete all[key];
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, "sessions.json"), JSON.stringify(all, null, 2));
}

/** Records a priority only when the owner stated none; an owner's own priority is never overwritten. */
export async function writeIntentPriority(ctx: StepContext, priority: Priority): Promise<void> {
  await assertRootOnMain(ctx);
  // The owner may have stated one while the step ran: read what the file says now.
  const now = await readIntent(ctx.root, ctx.slug);
  if (now.file.frontmatter.status !== ctx.intent.file.frontmatter.status) throw new PersonChangedStatus(ctx.intent.file.frontmatter.status, now.file.frontmatter.status);
  if (now.file.frontmatter.priority !== undefined) { ctx.intent.file = now.file; return; }
  await writeForStep(ctx, { priority });
  ctx.trace.upsertIntent(ctx.slug, ctx.intent.file.frontmatter.status, priority);
}
