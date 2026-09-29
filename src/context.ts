import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { Git } from "./git";
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

export type StepResult = { ok: true } | { ok: false; note: string };

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

/** Commit intent-folder changes on the main branch. Refuses when the root is on any other branch. */
export async function commitArtifacts(ctx: StepContext, what: string): Promise<void> {
  await assertRootOnMain(ctx);
  await ctx.git.commitPaths([`intent/${ctx.slug}`, "intent/queue.md"], `loopstra(${ctx.slug}): ${what}`);
  if (await ctx.git.hasRemote()) {
    try { await ctx.git.pushCurrent(); } catch (e) { ctx.trace.event(ctx.slug, "error", { where: "push", error: (e as Error).message }); }
  }
}

export async function setStatus(ctx: StepContext, status: Status, note = ""): Promise<void> {
  // Check before writing: a status written into another branch's checkout would land on that branch.
  await assertRootOnMain(ctx);
  const from = ctx.intent.file.frontmatter.status;
  const patch: Partial<Intent["file"]["frontmatter"]> = { status, note };
  // resume_from always follows the approved state being left, even if it was already set:
  // a person may have set an approved status by hand, and the marker must follow.
  if (APPROVED.has(status)) patch.resume_from = status;
  else if (APPROVED.has(from)) patch.resume_from = from;
  await writeIntent(ctx.intent, patch);
  ctx.trace.upsertIntent(ctx.slug, status, effectivePriority(ctx.intent.file.frontmatter));
  ctx.trace.statusChange(ctx.slug, from, status, note);
  await commitArtifacts(ctx, `${from} → ${status}`);
}

export async function block(ctx: StepContext, note: string): Promise<{ ok: false; note: string }> {
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
export async function blockWithDetail(ctx: StepContext, note: string, detail: unknown): Promise<{ ok: false; note: string }> {
  ctx.trace.event(ctx.slug, "error", { note, detail });
  return block(ctx, note);
}

/** Something went wrong that the caller has not recorded yet: a plain note for the owner and detail for the trace. */
export type Failure = { ok: false; note: string; detail: string };

export function blockWith(ctx: StepContext, f: Failure): Promise<{ ok: false; note: string }> {
  return blockWithDetail(ctx, f.note, f.detail);
}

/**
 * A once-only runtime marker in the intent's run folder (never in intent/). Returns true when
 * this call created it, false when it already existed, so "do X once" survives a restart.
 */
export function onceMarker(ctx: StepContext, name: string): boolean {
  const p = join(ctx.runDir, name);
  if (existsSync(p)) return false;
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(p, new Date().toISOString());
  return true;
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
  if (ctx.intent.file.frontmatter.priority !== undefined) return;
  await writeIntent(ctx.intent, { priority });
  ctx.trace.upsertIntent(ctx.slug, ctx.intent.file.frontmatter.status, priority);
}
