import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { Git } from "./git";
import { readIntent, writeIntent, type Intent, type Status } from "./intents";
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

const APPROVED: ReadonlySet<Status> = new Set(["accepted", "spec-approved", "plan-approved", "merged"]);

/** Commit intent-folder changes on the main branch. */
export async function commitArtifacts(ctx: StepContext, what: string): Promise<void> {
  await ctx.git.commitPaths([`intent/${ctx.slug}`, "intent/queue.md"], `loopstra(${ctx.slug}): ${what}`);
  if (await ctx.git.hasRemote()) {
    try { await ctx.git.pushCurrent(); } catch (e) { ctx.trace.event(ctx.slug, "error", { where: "push", error: (e as Error).message }); }
  }
}

export async function setStatus(ctx: StepContext, status: Status, note = ""): Promise<void> {
  const from = ctx.intent.file.frontmatter.status;
  const patch: Partial<Intent["file"]["frontmatter"]> = { status, note };
  if (APPROVED.has(status)) patch.resume_from = status;
  else if (!ctx.intent.file.frontmatter.resume_from && APPROVED.has(from)) patch.resume_from = from;
  await writeIntent(ctx.intent, patch);
  ctx.trace.upsertIntent(ctx.slug, status, ctx.intent.file.frontmatter.priority);
  ctx.trace.statusChange(ctx.slug, from, status, note);
  await commitArtifacts(ctx, `${from} → ${status}`);
}

export async function block(ctx: StepContext, note: string): Promise<{ ok: false; note: string }> {
  await setStatus(ctx, "blocked", note);
  return { ok: false, note };
}

export async function readArtifact(ctx: StepContext, name: string): Promise<string | null> {
  const p = join(ctx.intent.dir, name);
  return existsSync(p) ? await Bun.file(p).text() : null;
}

export async function writeArtifact(ctx: StepContext, name: string, text: string): Promise<void> {
  await Bun.write(join(ctx.intent.dir, name), text.endsWith("\n") ? text : text + "\n");
  ctx.intent.artifacts.add(name);
  await commitArtifacts(ctx, `write ${name}`);
}

export function loadSessions(ctx: StepContext): Record<string, string> {
  const p = join(ctx.runDir, "sessions.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : {};
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
