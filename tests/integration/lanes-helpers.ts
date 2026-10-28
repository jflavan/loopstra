import { expect } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readPause } from "../../src/heartbeat";
import { readIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import { copyRepo, FAKE_CLAUDE, fixture, run, TEMPLATES, tempDir, tempGitRepo } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

/**
 * A change in a test repository. `writes`: the files its build writes (path → content); by default
 * only its own src/<slug>.ts, so changes never conflict. Its plan lists them. `planFiles`: the plan's
 * file list instead (null: a plan with no Files that change section).
 */
export interface Change { slug: string; status: string; priority?: string; dependsOn?: string[]; writes?: Record<string, string>; planFiles?: string[] | null }

/** The files a change's build writes. */
const writesOf = (c: Change) => c.writes ?? { [`src/${c.slug}.ts`]: "export function add(a: number, b: number): number {\n  return a + b;\n}\n" };

/** A plan that lists the files the change's build writes (or `planFiles`); the change's own file is new. */
function planFor(c: Change): string {
  const files = c.planFiles === undefined ? Object.keys(writesOf(c)) : c.planFiles;
  const line = (f: string) => `- ${f}${f === `src/${c.slug}.ts` ? " (new)" : ""}`;
  const list = files === null ? "" : `## Files that change\n${files.map(line).join("\n")}\n\n`;
  return `# Plan: ${c.slug}\n\n${list}## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n`;
}

/** The change's build session, as a fake fixture: it writes the change's files. */
function buildFixture(c: Change): string {
  const lines = fixture("build").split("\n").filter((l) => l.trim());
  const writes = Object.entries(writesOf(c)).map(([path, content]) => JSON.stringify({ type: "fake_action", write: { path, content } }));
  return [lines[0], ...writes, lines.at(-1)].join("\n") + "\n";
}

/** Statuses at which a change already has its spec and plan (a spec-approved one has its spec). */
const PLANNED = new Set(["plan-approved", "building", "reviewing", "merge-review", "merge-approved"]);

/** Writes a change's intent (and spec and plan at the planned statuses), and its own build fixture. Not committed. */
export async function writeChange(path: string, fixtures: string, c: Change): Promise<void> {
  const dir = join(path, "intent", c.slug);
  mkdirSync(dir, { recursive: true });
  const deps = c.dependsOn ? `depends_on: [${c.dependsOn.join(", ")}]\n` : "";
  const priority = c.priority ? `priority: ${c.priority}\n` : "";
  await Bun.write(join(dir, "intent.md"), `---\nstatus: ${c.status}\n${priority}${deps}---\n# Intent: ${c.slug}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`);
  if (PLANNED.has(c.status) || c.status === "spec-approved") await Bun.write(join(dir, "spec.md"), "# Spec\n\n## Summary\ns\n");
  if (PLANNED.has(c.status)) await Bun.write(join(dir, "plan.md"), planFor(c));
  mkdirSync(join(fixtures, c.slug), { recursive: true });
  writeFileSync(join(fixtures, c.slug, "build.jsonl"), buildFixture(c));
  writeFileSync(join(fixtures, c.slug, "plan.jsonl"), planFixture(c));
}

/**
 * The change's resolve session, as a fake fixture: it writes `writes` (path → content) in the
 * worktree, and says whether it `resolved` the conflicts.
 */
export function resolveFixture(fixtures: string, slug: string, writes: Record<string, string>, resolved = true): void {
  const lines: unknown[] = [{ type: "system", subtype: "init", session_id: `fake-resolve-${slug}`, cwd: "/", tools: [], model: "fake" }];
  for (const [path, content] of Object.entries(writes)) lines.push({ type: "fake_action", write: { path, content } });
  lines.push({
    type: "result", subtype: "success", is_error: false, session_id: `fake-resolve-${slug}`, total_cost_usd: 0.1, usage: {}, result: "ok",
    structured_output: { status: "success", summary: "done", resolved, reason: resolved ? "" : "the two changes want different things", summary_markdown: "Kept both." },
  });
  mkdirSync(join(fixtures, slug), { recursive: true });
  writeFileSync(join(fixtures, slug, "resolve.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** The change's plan session, as a fake fixture: it writes planFor(c), so changes planned in a test list their own files. */
function planFixture(c: Change): string {
  return fixture("plan").split("\n").filter((l) => l.trim()).map((l) => {
    const e = JSON.parse(l) as { type: string; structured_output?: { plan_markdown: string } };
    if (e.type === "result" && e.structured_output) e.structured_output.plan_markdown = planFor(c);
    return JSON.stringify(e);
  }).join("\n") + "\n";
}

/**
 * A repository with Loopstra set up, `max_parallel_changes: n`, these changes, and `files` committed
 * on main. Each change's build comes from its own fixture folder. `thinkAhead`: speed.think_ahead,
 * off by default so the lanes' own behaviour is what is tested.
 */
export async function lanesRepo(n: number, changes: Change[], config = "", files: Record<string, string> = {}, thinkAhead = false) {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: echo ok\nspeed:\n  max_parallel_changes: ${n}\n  think_ahead: ${thinkAhead}\n${config}`);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(repo.path, path), content);
  const fixtures = tempDir("loopstra-fixtures-");
  for (const c of changes) await writeChange(repo.path, fixtures.path, c);
  await new Git(repo.path).commitAll("setup");
  const env: Record<string, string> = { LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path };
  return { path: repo.path, fixtures: fixtures.path, env, cleanup: () => { repo.cleanup(); fixtures.cleanup(); } };
}

export async function statusOf(repo: string, slug: string): Promise<string> {
  return (await readIntent(repo, slug)).file.frontmatter.status;
}

/** Reads the trace and closes it. */
export function inTrace<T>(repo: string, fn: (t: Trace) => T): T {
  const t = Trace.open(repo);
  try { return fn(t); } finally { t.close(); }
}

/** The pause's back-off is over: the next tick runs steps again. */
export async function expirePause(repo: string): Promise<void> {
  const p = readPause(repo)!;
  await Bun.write(join(repo, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
}

export const payloadOf = <T>(e: { payload: string }) => JSON.parse(e.payload) as T;

/** A file of 20 numbered lines, with `edit` replacing some of them (by line number). */
export function numbered(edit: Record<number, string> = {}): string {
  return Array.from({ length: 20 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
}

/** The id of the event that ended a change's (first) phase called `name`. */
export function phaseEndId(trace: Trace, slug: string, name: string): number {
  const events = trace.events(slug);
  const start = events.findIndex((e) => e.type === "phase_start" && payloadOf<{ name: string }>(e).name === name);
  expect(start).toBeGreaterThanOrEqual(0);
  return events.slice(start).find((e) => e.type === "phase_end")!.id;
}

/** The changes in the order their merge phases ended. */
export function mergeOrder(trace: Trace, slugs: string[]): string[] {
  return [...slugs].sort((a, b) => phaseEndId(trace, a, "merge") - phaseEndId(trace, b, "merge"));
}

export type LanesRepo = Awaited<ReturnType<typeof lanesRepo>>;
export type RemoteRepo = LanesRepo & { remote: string; state: string };

/** The fake gh's settings for a repository whose remote is the bare repository `remote`. */
function ghEnv(env: Record<string, string>, remote: string): Record<string, string> {
  return { ...env, LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_STATE: join(remote, "fake-gh.json"), LOOPSTRA_FAKE_GH_REMOTE: remote };
}

/** lanesRepo with a bare repository as its GitHub remote, and the fake gh, which merges there for real. */
export async function remoteLanesRepo(n: number, changes: Change[], config = "", files: Record<string, string> = {}): Promise<RemoteRepo> {
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  const r = await lanesRepo(n, changes, config, files);
  await run(["git", "remote", "add", "origin", remote.path], r.path);
  await run(["git", "push", "-q", "-u", "origin", "main"], r.path);
  return { ...r, remote: remote.path, state: join(remote.path, "fake-gh.json"), env: ghEnv(r.env, remote.path), cleanup: () => { r.cleanup(); remote.cleanup(); } };
}

/** A copy of a remote repository and of its remote (with the fake gh's pull requests), wired to each other. */
export async function copyRemoteRepo(r: RemoteRepo): Promise<RemoteRepo> {
  const repo = await copyRepo(r.path);
  const remote = tempDir("loopstra-remote-");
  cpSync(r.remote, remote.path, { recursive: true });
  await run(["git", "remote", "set-url", "origin", remote.path], repo.path);
  return { ...r, path: repo.path, remote: remote.path, state: join(remote.path, "fake-gh.json"), env: ghEnv(r.env, remote.path), cleanup: () => { repo.cleanup(); remote.cleanup(); } };
}

/** Every open pull request's checks have passed on GitHub. */
export async function checksPass(r: RemoteRepo): Promise<void> {
  const s = await Bun.file(r.state).json();
  for (const pr of Object.values<{ checks: string }>(s.prs)) pr.checks = "pass";
  await Bun.write(r.state, JSON.stringify(s));
}

/**
 * Sets speed.max_parallel_changes, commits everything, and pushes main. A changed config is code
 * outside intent/: with more than one change at a time, open pull requests are then out of date.
 */
export async function commitWithLanes(r: RemoteRepo, n: number): Promise<void> {
  await Bun.write(configPath(r.path), (await Bun.file(configPath(r.path)).text()).replace(/max_parallel_changes: \d/, `max_parallel_changes: ${n}`));
  await new Git(r.path).commitAll(`${n} at a time`);
  await run(["git", "push", "-q", "origin", "main"], r.path);
}

/** A person pushes a commit adding `file` to the change's branch on GitHub (its pull request's branch). */
export async function personPushes(r: RemoteRepo, slug: string, file: string): Promise<void> {
  const clone = tempDir("loopstra-person-");
  try {
    const git = (args: string[]) => run(["git", ...args], clone.path).then((x) => expect(x.code).toBe(0));
    await git(["clone", "-q", "-b", `intent/${slug}`, r.remote, "."]);
    await Bun.write(join(clone.path, file), "export const fix = 1;\n");
    await git(["add", "-A"]);
    await git(["-c", "user.name=Person", "-c", "user.email=person@example.com", "commit", "-q", "-m", `person: ${file}`]);
    await git(["push", "-q", "origin", `intent/${slug}`]);
  } finally { clone.cleanup(); }
}

/** A held session: the change's `phase` session waits until the returned `release` is called, then replays `answer`. */
export function holdSession(r: LanesRepo, slug: string, phase: string, answer = phase): () => void {
  const release = join(r.fixtures, `release-${slug}-${phase}`);
  mkdirSync(join(r.fixtures, slug), { recursive: true });
  writeFileSync(join(r.fixtures, slug, `${phase}.jsonl`), `${JSON.stringify({ type: "fake_action", wait_for: release })}\n${fixture(answer)}`);
  return () => writeFileSync(release, "");
}

/** Waits until `done` is true of the trace (read afresh each time), or a minute has passed. */
export async function traceShows(repo: string, done: (t: Trace) => boolean): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !inTrace(repo, done)) await Bun.sleep(100);
}

/** Waits until the change is at `status` (read afresh each time), or a minute has passed. */
export async function statusShows(repo: string, slug: string, status: string, also: () => boolean = () => true): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !((await statusOf(repo, slug).catch(() => "")) === status && also())) await Bun.sleep(100);
}
