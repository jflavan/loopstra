# Loopstra Plan 2: Stages and the Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the loop run: one intent goes from `accepted` to `done` in a local git repo with no remote, driven by `loopstra start --once` ticks, using the fake `claude` for every agent phase.

**Architecture:** Builds on Plan 1's modules. Adds a step context, shell command runner, git wrapper, phase runner (agent and code phases with tracing and envelope validation), gates and checks, one module per stage, the `main_health` signal, and the scheduler tick. GitHub, `init`, the skill, `tail`, and `ui` are Plan 3. Spec: `docs/superpowers/specs/2026-09-28-loopstra-design.md` §8, §10, §11, §14, §15.

**Tech Stack:** Bun (`Bun.$` shell for configured commands, `Bun.spawn` for git), TypeScript, zod, yaml.

---

## File structure

| File | Responsibility |
|---|---|
| `src/shell.ts` | Run one configured command string in a directory; capture exit code and output |
| `src/git.ts` | Thin git wrapper: branches, worktrees, commits, diffs, merges |
| `src/context.ts` | `StepContext`, artifact read/write, status transitions, blocking, artifact commits, session map |
| `src/phases.ts` | `agentPhase` and `codePhase`: traced, validated, persisted |
| `src/checks.ts` | Deterministic checks used by gates |
| `src/gates.ts` | Evaluate a named gate's checks and record results |
| `src/stages/design.ts` | accepted → spec-review → spec-approved |
| `src/stages/plan.ts` | spec-approved → plan-review → plan-approved |
| `src/stages/build.ts` | plan-approved → building (build, drift, test loop, verify) → reviewing |
| `src/stages/review.ts` | reviewing → merge-review |
| `src/stages/merge.ts` | merge-review → merged (local merge; PR path in Plan 3) |
| `src/stages/verify.ts` | merged → verifying → done |
| `src/signals.ts` | `main_health` |
| `src/scheduler.ts` | `tick` and `start` |
| `templates/prompts/*.md` | Default prompt per agent phase |
| `tests/fake-claude/claude.ts` | Extended: picks fixture by `LOOPSTRA_PHASE`, performs `fake_action` lines |
| `tests/integration/loop.test.ts` | End-to-end: accepted → done |

Conventions used throughout:

- Every function that can fail for a reason a person must read returns `{ ok: false, note: string }` with a plain-language note, never a technical one. Technical detail goes to the trace.
- Statuses and transitions only happen through `context.ts`.
- Every phase name passed to `agentPhase` is a `PhaseName` from `src/envelopes.ts`, and its prompt file is `loopstra/prompts/<name>.md`.

---

### Task 1: Shell command runner

**Files:**
- Create: `src/shell.ts`
- Test: `tests/unit/shell.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { runCommand } from "../../src/shell";
import { tempDir } from "../helpers";

describe("runCommand", () => {
  test("captures exit code and combined output", async () => {
    const t = tempDir();
    const r = await runCommand("echo hello", t.path);
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe("hello");
    t.cleanup();
  });

  test("non-zero exit is reported, not thrown", async () => {
    const t = tempDir();
    const r = await runCommand("exit 3", t.path);
    expect(r.code).toBe(3);
    t.cleanup();
  });

  test("passes environment variables", async () => {
    const t = tempDir();
    const r = await runCommand("echo $LOOPSTRA_PHASE", t.path, { LOOPSTRA_PHASE: "fix" });
    expect(r.output.trim()).toBe("fix");
    t.cleanup();
  });

  test("lastLine returns the last non-empty line", async () => {
    const t = tempDir();
    const r = await runCommand("echo one; echo two", t.path);
    expect(r.lastLine).toBe("two");
    t.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/shell.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/shell.ts`**

```ts
import { $ } from "bun";

export interface CommandResult {
  command: string;
  code: number;
  output: string;
  lastLine: string;
  durationMs: number;
}

/**
 * Runs one configured command string through Bun's cross-platform shell.
 * Never throws on non-zero exit; the exit code is the result.
 */
export async function runCommand(command: string, cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  const started = Date.now();
  const r = await $`${{ raw: command }}`.cwd(cwd).env({ ...process.env, ...env }).nothrow().quiet();
  const output = r.stdout.toString() + r.stderr.toString();
  const lines = output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  return { command, code: r.exitCode, output, lastLine: lines[lines.length - 1] ?? "", durationMs: Date.now() - started };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/shell.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shell.ts tests/unit/shell.test.ts
git commit -m "feat: shell command runner for configured commands"
```

---

### Task 2: Git wrapper

**Files:**
- Create: `src/git.ts`
- Test: `tests/unit/git.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { tempGitRepo } from "../helpers";

describe("Git", () => {
  test("branch, worktree, commit, changed files, merge, cleanup", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.hasRemote()).toBe(false);

    await git.createBranch("intent/x", "main");
    expect(await git.branchExists("intent/x")).toBe(true);

    const wt = join(repo.path, ".loopstra", "worktrees", "x");
    await git.worktreeAdd(wt, "intent/x");
    expect(existsSync(join(wt, "README.md"))).toBe(true);

    await Bun.write(join(wt, "src", "new.ts"), "export const a = 1;\n");
    const wtGit = new Git(wt);
    expect(await wtGit.isDirty()).toBe(true);
    await wtGit.commitAll("add new");
    expect(await wtGit.isDirty()).toBe(false);
    expect(await wtGit.changedFilesSince("main")).toEqual(["src/new.ts"]);

    expect(await git.isAncestor("main", "intent/x")).toBe(true);
    await git.merge("intent/x", "squash", "merge x");
    expect(existsSync(join(repo.path, "src", "new.ts"))).toBe(true);
    expect((await git.log(1))[0]).toContain("merge x");

    await git.worktreeRemove(wt);
    expect(existsSync(wt)).toBe(false);
    await git.deleteBranch("intent/x");
    expect(await git.branchExists("intent/x")).toBe(false);
    repo.cleanup();
  });

  test("commitPaths commits only the given paths", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "a.md"), "a");
    await Bun.write(join(repo.path, "b.md"), "b");
    await git.commitPaths(["a.md"], "only a");
    expect(await git.isDirty()).toBe(true);
    const shown = await git.run(["show", "--stat", "--oneline", "HEAD"]);
    expect(shown.out).toContain("a.md");
    expect(shown.out).not.toContain("b.md");
    repo.cleanup();
  });

  test("commitPaths with nothing to commit is a no-op", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    const before = await git.headSha();
    await git.commitPaths(["README.md"], "nothing");
    expect(await git.headSha()).toBe(before);
    repo.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/git.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/git.ts`**

```ts
export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stderr: string, public readonly code: number) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`);
  }
}

export class Git {
  constructor(public readonly cwd: string) {}

  async run(args: string[], allowFail = false): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn({ cmd: ["git", ...args], cwd: this.cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 && !allowFail) throw new GitError(args, err, code);
    return { code, out, err };
  }

  async currentBranch(): Promise<string> { return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim(); }
  async headSha(): Promise<string> { return (await this.run(["rev-parse", "HEAD"])).out.trim(); }
  async hasRemote(): Promise<boolean> { return (await this.run(["remote"])).out.trim().length > 0; }
  async branchExists(name: string): Promise<boolean> { return (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], true)).code === 0; }
  async createBranch(name: string, from: string): Promise<void> { await this.run(["branch", name, from]); }
  async deleteBranch(name: string): Promise<void> { await this.run(["branch", "-D", name]); }
  async worktreeAdd(path: string, branch: string): Promise<void> { await this.run(["worktree", "add", path, branch]); }
  async worktreeRemove(path: string): Promise<void> { await this.run(["worktree", "remove", "--force", path]); await this.run(["worktree", "prune"]); }
  async isDirty(): Promise<boolean> { return (await this.run(["status", "--porcelain"])).out.trim().length > 0; }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> { return (await this.run(["merge-base", "--is-ancestor", ancestor, descendant], true)).code === 0; }
  async log(n: number): Promise<string[]> { return (await this.run(["log", `-${n}`, "--format=%h %s"])).out.trim().split("\n").filter(Boolean); }

  async commitAll(message: string): Promise<boolean> {
    await this.run(["add", "-A"]);
    if (!(await this.isDirty())) return false;
    await this.run(["commit", "-q", "-m", message]);
    return true;
  }

  async commitPaths(paths: string[], message: string): Promise<boolean> {
    await this.run(["add", "-A", "--", ...paths]);
    const staged = (await this.run(["diff", "--cached", "--name-only"])).out.trim();
    if (!staged) return false;
    await this.run(["commit", "-q", "-m", message, "--", ...paths]);
    return true;
  }

  async changedFilesSince(base: string): Promise<string[]> {
    return (await this.run(["diff", "--name-only", `${base}...HEAD`])).out.trim().split("\n").filter(Boolean);
  }

  async rebaseOnto(base: string): Promise<boolean> {
    const r = await this.run(["rebase", base], true);
    if (r.code !== 0) { await this.run(["rebase", "--abort"], true); return false; }
    return true;
  }

  async merge(branch: string, method: "squash" | "merge", message: string): Promise<void> {
    if (method === "squash") {
      await this.run(["merge", "--squash", branch]);
      await this.run(["commit", "-q", "-m", message]);
    } else {
      await this.run(["merge", "--no-ff", "-m", message, branch]);
    }
  }

  async push(branch: string): Promise<void> { await this.run(["push", "-u", "origin", branch]); }
  async pushCurrent(): Promise<void> { await this.run(["push"]); }
  async fetch(): Promise<void> { await this.run(["fetch", "--quiet"], true); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/git.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/unit/git.test.ts
git commit -m "feat: git wrapper for branches, worktrees, commits, and merges"
```

---

### Task 3: Config additions and step context

**Files:**
- Modify: `src/config.ts` (add `commands.install`)
- Create: `src/context.ts`
- Test: `tests/unit/context.test.ts`, add one case to `tests/unit/config.test.ts`

- [ ] **Step 1: Add the config test case**

Append to `tests/unit/config.test.ts` inside the describe:
```ts
  test("accepts an optional install command", async () => {
    const t = tempDir();
    writeConfig(t.path, "version: 1\ncommands:\n  test: bun test\n  install: bun install\n");
    const cfg = await loadConfig(t.path);
    expect(cfg.commands.install).toBe("bun install");
    t.cleanup();
  });
```

In `src/config.ts`, add `install: z.string().optional(),` to `commands` after `run`.

- [ ] **Step 2: Write the failing context test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import { StepContext, block, readArtifact, setStatus, writeArtifact, loadSessions, saveSession } from "../../src/context";
import { tempGitRepo } from "../helpers";

async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("intent");
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const intent = await readIntent(repo.path, "x");
  const ctx = new StepContext(repo.path, cfg, trace, intent);
  return { repo, ctx, trace };
}

describe("StepContext", () => {
  test("setStatus writes frontmatter, records resume_from on approved states, commits, and traces", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review", "Read spec.md.");
    let i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toBe("Read spec.md.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
    await setStatus(ctx, "spec-approved");
    i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("spec-approved");
    expect(i.file.frontmatter.note).toBe("");
    const log = await new Git(repo.path).log(1);
    expect(log[0]).toContain("loopstra(x)");
    expect(trace.events("x").some((e) => e.type === "status_change")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("block sets blocked with a note and keeps resume_from", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await block(ctx, "The intent needs a Done when section.");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The intent needs a Done when section.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
    trace.close(); repo.cleanup();
  });

  test("artifacts read and write in the intent folder and are committed", async () => {
    const { repo, ctx, trace } = await setup();
    expect(await readArtifact(ctx, "spec.md")).toBeNull();
    await writeArtifact(ctx, "spec.md", "# Spec\n");
    expect(await readArtifact(ctx, "spec.md")).toBe("# Spec\n");
    expect(ctx.intent.artifacts.has("spec.md")).toBe(true);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("sessions persist per intent", async () => {
    const { repo, ctx, trace } = await setup();
    expect(loadSessions(ctx)).toEqual({});
    saveSession(ctx, "build", "sid-1");
    expect(loadSessions(ctx)).toEqual({ build: "sid-1" });
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/context.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write `src/context.ts`**

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/context.test.ts tests/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/context.ts tests/unit/context.test.ts tests/unit/config.test.ts
git commit -m "feat: step context with status transitions, artifact commits, and session map"
```

---

### Task 4: Phase runner

**Files:**
- Create: `src/phases.ts`
- Modify: `tests/fake-claude/claude.ts` (phase-named fixtures and `fake_action`)
- Create: `tests/fake-claude/fixtures/intake.jsonl`
- Test: `tests/unit/phases.test.ts`

- [ ] **Step 1: Extend the fake**

Replace `tests/fake-claude/claude.ts` with:
```ts
#!/usr/bin/env bun
// Fake `claude` executable: replays a stream-json fixture. Never calls the network.
// Fixture selection, in order: $LOOPSTRA_FAKE_FIXTURE, "FIXTURE:<name>" in the prompt,
// $LOOPSTRA_FAKE_FIXTURE_DIR/<$LOOPSTRA_PHASE>.jsonl, fixtures/<$LOOPSTRA_PHASE>.jsonl, fixtures/simple-success.jsonl.
// A fixture line {"type":"fake_action","write":{"path":"...","content":"..."}} writes a file
// under the current directory before the remaining lines are emitted, so a fake "build" can change code.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Bun.argv.slice(2);
const prompt = await Bun.stdin.text();
const phase = process.env.LOOPSTRA_PHASE ?? "";

if (process.env.LOOPSTRA_FAKE_ARGS) {
  await Bun.write(process.env.LOOPSTRA_FAKE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { LOOPSTRA_PHASE: phase || null } }));
}

const here = join(dirname(Bun.main), "fixtures");
const named = /FIXTURE:([a-z0-9-]+)/.exec(prompt)?.[1];
const candidates = [
  process.env.LOOPSTRA_FAKE_FIXTURE,
  named ? join(here, `${named}.jsonl`) : undefined,
  process.env.LOOPSTRA_FAKE_FIXTURE_DIR && phase ? join(process.env.LOOPSTRA_FAKE_FIXTURE_DIR, `${phase}.jsonl`) : undefined,
  phase ? join(here, `${phase}.jsonl`) : undefined,
  join(here, "simple-success.jsonl"),
].filter((p): p is string => !!p && existsSync(p));
const fixture = candidates[0]!;

if (fixture.endsWith("hang.jsonl")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "hang-session" }));
  await new Promise(() => {});
}

for (const line of (await Bun.file(fixture).text()).split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as { type: string; write?: { path: string; content: string } };
  if (e.type === "fake_action" && e.write) {
    const target = join(process.cwd(), e.write.path);
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, e.write.content);
    continue;
  }
  console.log(line);
}
process.exit(0);
```

`tests/fake-claude/fixtures/intake.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-intake","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-intake","total_cost_usd":0.002,"usage":{},"structured_output":{"status":"success","summary":"intent is clear","notes_for_next_phase":"","priority":"high","missing_sections":[],"question":""},"result":"ok"}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { agentPhase, codePhase } from "../../src/phases";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

const FAKE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "Intent for {{slug}}:\n{{intent}}\nSkills: {{skills}}");
  mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("intent");
  process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const ctx = new StepContext(repo.path, cfg, trace, await readIntent(repo.path, "x"));
  return { repo, ctx, trace };
}

describe("agentPhase", () => {
  test("renders the prompt, runs claude, validates the envelope, persists files, and traces", async () => {
    const { repo, ctx, trace } = await setup();
    const r = await agentPhase(ctx, {
      name: "intake", model: "cheap", permissionMode: "default", tools: "read",
      vars: { intent: ctx.intent.file.body, skills: "" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.priority).toBe("high");
      expect(r.sessionId).toBe("fake-intake");
    }
    const phaseDir = join(repo.path, ".loopstra", "runs", "x", "phases", "1-intake");
    expect(existsSync(join(phaseDir, "prompt.md"))).toBe(true);
    expect(existsSync(join(phaseDir, "raw.jsonl"))).toBe(true);
    expect(existsSync(join(phaseDir, "envelope.json"))).toBe(true);
    expect(await Bun.file(join(phaseDir, "prompt.md")).text()).toContain("Intent for x:");
    const phases = trace.phases("x");
    expect(phases[0]?.name).toBe("intake");
    expect(phases[0]?.status).toBe("success");
    expect(phases[0]?.cost_usd).toBeCloseTo(0.002);
    trace.close(); repo.cleanup();
  });

  test("a missing prompt file is a plain failure", async () => {
    const { repo, ctx, trace } = await setup();
    const r = await agentPhase(ctx, { name: "design", model: "strong", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.note).toMatch(/loopstra\/prompts\/design\.md/);
    trace.close(); repo.cleanup();
  });

  test("an envelope that fails validation is a failure with the phase recorded as fail", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "design.md"), "x FIXTURE:intake");
    const r = await agentPhase(ctx, { name: "design", model: "strong", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    expect(trace.phases("x")[0]?.status).toBe("fail");
    trace.close(); repo.cleanup();
  });
});

describe("codePhase", () => {
  test("runs a function inside a traced phase and reports failure without throwing", async () => {
    const { repo, ctx, trace } = await setup();
    const ok = await codePhase(ctx, "tests", async () => ({ ok: true as const, value: 42 }));
    expect(ok).toEqual({ ok: true, value: 42 });
    const bad = await codePhase(ctx, "boom", async () => { throw new Error("kaboom"); });
    expect(bad.ok).toBe(false);
    const phases = trace.phases("x");
    expect(phases.map((p) => p.status)).toEqual(["success", "fail"]);
    expect(phases[1]?.error).toContain("kaboom");
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/phases.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write `src/phases.ts`**

```ts
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPhase, type PermissionMode } from "./claude";
import { modelFor } from "./config";
import type { StepContext } from "./context";
import { Envelopes, jsonSchemaFor, type Envelope, type PhaseName } from "./envelopes";
import { renderPrompt, type PromptVars } from "./prompts";

export type ToolSet = "read" | "read+commands" | "build";

export interface AgentPhaseSpec {
  name: PhaseName;
  model: "default" | "cheap" | "strong";
  permissionMode: PermissionMode;
  tools: ToolSet;
  vars: PromptVars;
  /** Run in this directory (the worktree for build phases). Defaults to the repo root. */
  cwd?: string;
  /** Resume this session id. */
  resume?: string;
  /** Extra environment for the claude process (e.g. LOOPSTRA_PHASE=fix). */
  env?: Record<string, string>;
  /** Names of skills to mention at the top of the prompt. */
  skills?: string[];
}

export type AgentPhaseResult<N extends PhaseName> =
  | { ok: true; envelope: Envelope<N>; sessionId: string | null; costUsd: number }
  | { ok: false; note: string; sessionId: string | null };

const READ_TOOLS = ["Read", "Glob", "Grep", "LS"];

export function toolsFor(ctx: StepContext, set: ToolSet): string[] {
  if (set === "read") return READ_TOOLS;
  if (set === "build") return ctx.cfg.claude.allowed_tools;
  const cmds = Object.values(ctx.cfg.commands).filter((c): c is string => !!c);
  return [...READ_TOOLS, ...cmds.map((c) => `Bash(${c})`)];
}

export async function agentPhase<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }): Promise<AgentPhaseResult<N>> {
  const promptPath = join(ctx.root, "loopstra", "prompts", `${spec.name}.md`);
  if (!existsSync(promptPath)) {
    return { ok: false, note: `The prompt file loopstra/prompts/${spec.name}.md is missing. Run \`loopstra init\` to restore it.`, sessionId: null };
  }
  const skillsLine = (spec.skills ?? []).length ? `Use these skills: ${(spec.skills ?? []).map((s) => `\`${s}\``).join(", ")}.\n\n` : "";
  const prompt = skillsLine + renderPrompt(await Bun.file(promptPath).text(), { slug: ctx.slug, ...spec.vars });

  const seq = ctx.trace.phaseStart(ctx.slug, spec.name, "agent");
  const dir = join(ctx.runDir, "phases", `${seq}-${spec.name}`);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "prompt.md"), prompt);
  const raw = Bun.file(join(dir, "raw.jsonl")).writer();

  const r = await runPhase({
    cwd: spec.cwd ?? ctx.root,
    prompt,
    schema: jsonSchemaFor(spec.name),
    model: modelFor(ctx.cfg, spec.model),
    permissionMode: spec.permissionMode,
    allowedTools: toolsFor(ctx, spec.tools),
    timeoutMs: ctx.cfg.claude.timeout_minutes * 60_000,
    maxBudgetUsd: ctx.cfg.claude.max_budget_usd,
    resume: spec.resume,
    env: { LOOPSTRA_PHASE: spec.name, LOOPSTRA_SLUG: ctx.slug, ...(spec.env ?? {}) },
    onEvent: (e) => {
      raw.write(JSON.stringify(e) + "\n");
      if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e), seq);
    },
  });
  raw.end();

  if (!r.ok) {
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: r.reason });
    return { ok: false, note: `The ${spec.name} step could not finish: ${r.reason}.`, sessionId: r.sessionId };
  }
  const parsed = Envelopes[spec.name].safeParse(r.structuredOutput);
  await Bun.write(join(dir, "envelope.json"), JSON.stringify({ valid: parsed.success, output: r.structuredOutput }, null, 2));
  if (!parsed.success) {
    const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: `invalid envelope: ${err}` });
    return { ok: false, note: `The ${spec.name} step returned an answer in the wrong shape. Details are in the trace.`, sessionId: r.sessionId };
  }
  const envelope = parsed.data as Envelope<N>;
  if (envelope.status === "fail") {
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: envelope.summary });
    return { ok: false, note: `The ${spec.name} step reported a problem: ${envelope.summary}`, sessionId: r.sessionId };
  }
  ctx.trace.phaseEnd(ctx.slug, seq, { status: "success", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined });
  return { ok: true, envelope, sessionId: r.sessionId, costUsd: r.costUsd };
}

function summarize(e: Record<string, unknown>): Record<string, unknown> {
  if (e.type === "assistant") {
    const content = (e as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content ?? [];
    return { type: "assistant", items: content.map((c) => c.type === "tool_use" ? `tool:${c.name}` : c.type === "text" ? `text:${(c.text ?? "").slice(0, 120)}` : c.type) };
  }
  if (e.type === "result") return { type: "result", subtype: e.subtype, cost: e.total_cost_usd };
  return { type: e.type, subtype: e.subtype };
}

export type CodePhaseResult<T> = ({ ok: true } & T) | { ok: false; note: string };

/** Runs deterministic work as a traced phase. Exceptions become a failed phase, never a crash. */
export async function codePhase<T extends object>(ctx: StepContext, name: string, fn: () => Promise<{ ok: true } & T>): Promise<CodePhaseResult<T>> {
  const seq = ctx.trace.phaseStart(ctx.slug, name, "code");
  try {
    const r = await fn();
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success" });
    return r;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: msg });
    return { ok: false, note: `The ${name} step failed: ${msg.split("\n")[0]}` };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/phases.test.ts tests/unit/claude-run.test.ts`
Expected: PASS. If `Bun.file(...).writer()` is unavailable, collect lines in an array and write once at the end.

- [ ] **Step 6: Commit**

```bash
git add src/phases.ts tests/fake-claude tests/unit/phases.test.ts
git commit -m "feat: agent and code phase runners with envelope validation and persistence"
```

---

### Task 5: Checks and gates

**Files:**
- Create: `src/checks.ts`, `src/gates.ts`
- Test: `tests/unit/gates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { headingsPresent, filesExistOrNew, diffWithinPlan, parsePlanFiles } from "../../src/checks";
import { evaluateGate, type Check } from "../../src/gates";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import { tempGitRepo, tempDir } from "../helpers";

describe("checks", () => {
  test("headingsPresent names the missing headings", () => {
    expect(headingsPresent("# Spec\n## Overview\n## Areas of concern\n", ["Overview", "Areas of concern"])).toEqual({ ok: true });
    expect(headingsPresent("# Spec\n## Overview\n", ["Overview", "Risks"])).toEqual({ ok: false, missing: ["Risks"] });
  });

  test("parsePlanFiles reads the Files that change section", () => {
    const plan = "# Plan\n\n## Files that change\n- src/a.ts (new)\n- src/b.ts\n- `src/c.ts` (new)\n\n## Order of work\n1. x\n";
    expect(parsePlanFiles(plan)).toEqual([{ path: "src/a.ts", new: true }, { path: "src/b.ts", new: false }, { path: "src/c.ts", new: true }]);
  });

  test("filesExistOrNew reports existing files marked new and missing files not marked new", () => {
    const t = tempDir();
    mkdirSync(join(t.path, "src"), { recursive: true });
    Bun.write(join(t.path, "src", "b.ts"), "");
    expect(filesExistOrNew(t.path, [{ path: "src/a.ts", new: true }, { path: "src/b.ts", new: false }])).toEqual({ ok: true });
    expect(filesExistOrNew(t.path, [{ path: "src/zzz.ts", new: false }])).toEqual({ ok: false, problems: ["src/zzz.ts is listed as an existing file but does not exist"] });
    t.cleanup();
  });

  test("diffWithinPlan lists files changed outside the plan, ignoring plan.md itself and lockfiles", () => {
    expect(diffWithinPlan(["src/a.ts", "src/x.ts", "bun.lock"], [{ path: "src/a.ts", new: false }])).toEqual(["src/x.ts"]);
  });
});

describe("evaluateGate", () => {
  async function setup() {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
    mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: spec-review\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await new Git(repo.path).commitAll("intent");
    const trace = Trace.open(repo.path);
    const ctx = new StepContext(repo.path, await loadConfig(repo.path), trace, await readIntent(repo.path, "x"));
    return { repo, ctx, trace };
  }

  test("passes when all checks pass and records each", async () => {
    const { repo, ctx, trace } = await setup();
    const checks: Check[] = [
      { name: "headings", run: async () => ({ result: "pass", evidence: "all present" }) },
      { name: "agent", run: async () => ({ result: "pass", evidence: "approved" }) },
    ];
    const r = await evaluateGate(ctx, "spec", checks);
    expect(r).toEqual({ result: "pass" });
    expect(trace.gates("x").map((g) => g.check)).toEqual(["headings", "agent"]);
    trace.close(); repo.cleanup();
  });

  test("stops at the first failure and returns its evidence", async () => {
    const { repo, ctx, trace } = await setup();
    let ran = 0;
    const checks: Check[] = [
      { name: "a", run: async () => ({ result: "fail", evidence: "Risks heading missing" }) },
      { name: "b", run: async () => { ran++; return { result: "pass", evidence: "" }; } },
    ];
    const r = await evaluateGate(ctx, "plan", checks);
    expect(r).toEqual({ result: "fail", check: "a", evidence: "Risks heading missing" });
    expect(ran).toBe(0);
    trace.close(); repo.cleanup();
  });

  test("waiting is returned when a check is waiting", async () => {
    const { repo, ctx, trace } = await setup();
    const r = await evaluateGate(ctx, "merge", [{ name: "pr", run: async () => ({ result: "waiting", evidence: "no approval yet" }) }]);
    expect(r).toEqual({ result: "waiting", check: "pr", evidence: "no approval yet" });
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/gates.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/checks.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

export function headingsPresent(markdown: string, headings: string[]): { ok: true } | { ok: false; missing: string[] } {
  const present = new Set([...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => (m[1] ?? "").toLowerCase()));
  const missing = headings.filter((h) => !present.has(h.toLowerCase()));
  return missing.length ? { ok: false, missing } : { ok: true };
}

export interface PlanFile { path: string; new: boolean }

/** Reads "## Files that change" bullets: `- path (new)` or `- \`path\``. */
export function parsePlanFiles(plan: string): PlanFile[] {
  const section = /^##\s+Files that change\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m.exec(plan)?.[1] ?? "";
  const out: PlanFile[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+`?([^\s`]+)`?\s*(\(new\))?/.exec(line);
    if (m?.[1]) out.push({ path: m[1], new: !!m[2] });
  }
  return out;
}

export function filesExistOrNew(root: string, files: PlanFile[]): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const f of files) {
    if (!f.new && !existsSync(join(root, f.path))) problems.push(`${f.path} is listed as an existing file but does not exist`);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

const IGNORED_DRIFT = [/^bun\.lock$/, /^package-lock\.json$/, /^yarn\.lock$/, /^intent\//, /^loopstra\//];

/** Files changed on the branch that the plan did not list. */
export function diffWithinPlan(changed: string[], planned: PlanFile[]): string[] {
  const allowed = new Set(planned.map((p) => p.path));
  return changed.filter((c) => !allowed.has(c) && !IGNORED_DRIFT.some((re) => re.test(c)));
}
```

- [ ] **Step 4: Write `src/gates.ts`**

```ts
import type { StepContext } from "./context";

export type CheckResult = { result: "pass" | "fail" | "waiting"; evidence: string };
export interface Check { name: string; run: () => Promise<CheckResult> }
export type GateName = "intent" | "spec" | "plan" | "merge" | "done";
export type GateOutcome = { result: "pass" } | { result: "fail" | "waiting"; check: string; evidence: string };

/** Runs checks in order. Stops at the first fail or waiting. Records every check that ran. */
export async function evaluateGate(ctx: StepContext, gate: GateName, checks: Check[]): Promise<GateOutcome> {
  for (const check of checks) {
    let r: CheckResult;
    try { r = await check.run(); } catch (e) { r = { result: "fail", evidence: `check crashed: ${(e as Error).message}` }; }
    ctx.trace.gate(ctx.slug, gate, check.name, r.result, r.evidence);
    if (r.result !== "pass") return { result: r.result, check: check.name, evidence: r.evidence };
  }
  return { result: "pass" };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/gates.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/checks.ts src/gates.ts tests/unit/gates.test.ts
git commit -m "feat: deterministic checks and gate evaluation"
```

---

### Task 6: Default prompt templates

**Files:**
- Create: `templates/prompts/{intake,design,spec-check,plan,plan-challenge,build,fix,reconcile,verify,review,revise,done-check,lessons}.md`
- Test: `tests/unit/templates.test.ts`

Every prompt ends with the same instruction: respond only through the structured output. Keep each under 40 lines. Write them exactly as below.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelopes } from "../../src/envelopes";

const ROOT = new URL("../../templates/prompts/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("prompt templates", () => {
  test("one template per phase, each mentioning its variables and structured output", async () => {
    for (const name of Object.keys(Envelopes)) {
      const p = join(ROOT, `${name}.md`);
      expect(existsSync(p)).toBe(true);
      const text = await Bun.file(p).text();
      expect(text).toContain("{{");
      expect(text.toLowerCase()).toContain("structured output");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/templates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the templates**

`templates/prompts/intake.md`:
```markdown
You are the intake step of an unattended development loop. A product owner wrote the intent below in their own words. You do not design or build anything here.

Intent `{{slug}}`:

{{intent}}

Do two things.

1. Decide the priority from the words in the intent: `urgent` for outages or legal deadlines, `high` for clear customer or revenue impact, `low` for nice-to-haves, otherwise `normal`. If the intent already states a priority, keep it.
2. Decide whether the intent is clear enough to design from. It is clear enough when the Problem, Proposed outcome, and Done when sections exist and a designer could act on them without guessing. If not, write one specific question for the owner in plain language, and list any missing section names in `missing_sections`. Leave `question` empty when the intent is clear.

Respond only through the structured output.
```

`templates/prompts/design.md`:
```markdown
You are producing the requirements and design spec for one change. Read the codebase as needed. Do not modify any files; return the spec text through the structured output and the runtime will write `spec.md`.

Intent `{{slug}}`:

{{intent}}

Skills to apply: {{skills}}

Write `spec_markdown` as a complete Markdown document with these headings, in this order:

# Spec: <title>
## Summary
## Requirements
## Design
## Affected code
## Out of scope
## Open questions
## Areas of concern

Requirements must be testable statements. Design describes how the change fits the existing code, naming real files and modules you found. Carry every open question from the intent forward: answer it or list it. Areas of concern lists anything where policies, constraints, or existing code conflict, or where you had to guess. Put the same concerns in the `concerns` array.

Respond only through the structured output.
```

`templates/prompts/spec-check.md`:
```markdown
You are an independent reviewer with no memory of how the spec was written. Judge whether the spec solves the problem the intent states.

Intent:

{{intent}}

Spec:

{{spec}}

For each requirement you can derive from the intent's Problem, Proposed outcome, and Done when sections, record whether the spec meets it and the evidence, quoting the spec. Set `approved` to true only when every requirement is met and no open question from the intent has been dropped.

Respond only through the structured output.
```

`templates/prompts/plan.md`:
```markdown
You are planning the implementation of one change. You are in plan mode: read the codebase, do not modify it. Return the plan through the structured output and the runtime will write `plan.md`.

Intent:

{{intent}}

Spec:

{{spec}}

Skills to apply: {{skills}}

Write `plan_markdown` with these headings, in this order:

# Plan: <title>
## Files that change
## Order of work
## Risks
## Proof

Files that change is a bullet list, one file per line, as `- path` for existing files and `- path (new)` for new ones. List every file the change will touch. Order of work is a numbered list a developer with no other context could follow. Risks names what could break and how the plan avoids it. Proof names the tests and checks that will show the change works, in terms someone could run.

Also return the same file list in `files`.

Respond only through the structured output.
```

`templates/prompts/plan-challenge.md`:
```markdown
You are an independent reviewer challenging an implementation plan before any code is written. Read the codebase to check the plan's claims.

Spec:

{{spec}}

Plan:

{{plan}}

Ask: what would break, what is missing, which listed files do not exist or are wrong, which alternative was not considered, and whether the Proof section would actually prove the change works. Record each as a concern with `blocking` true only when the plan cannot be executed as written or would break existing behavior. Set `approved` to true when there are no blocking concerns.

Respond only through the structured output.
```

`templates/prompts/build.md`:
```markdown
You are implementing one change in an isolated worktree on branch `intent/{{slug}}`. Follow the plan exactly. Commit as you go with clear messages.

Plan:

{{plan}}

Spec, for reference:

{{spec}}

Skills to apply: {{skills}}

Rules: implement only what the plan lists. Do not weaken, skip, or delete tests. Run the project's test command before you finish and fix what fails. When done, report every file you changed in `changed_files` and a one-line `commit_message` the runtime will use for anything you left uncommitted.

Respond only through the structured output.
```

`templates/prompts/fix.md`:
```markdown
The checks failed after your last change. Fix the code, not the checks. Test files are protected during this step.

Failure output:

{{failure_output}}

Verifier observations, if any:

{{observations}}

Make the smallest change that makes the checks pass, run the test command again, and report every file you changed in `changed_files` with a one-line `commit_message`.

Respond only through the structured output.
```

`templates/prompts/reconcile.md`:
```markdown
The implementation touched files the plan did not list. Update the plan so it matches what was actually needed, keeping the same headings and format. Do not change code.

Current plan:

{{plan}}

Files changed on the branch but not in the plan:

{{findings}}

Return the full updated plan in `plan_markdown`.

Respond only through the structured output.
```

`templates/prompts/verify.md`:
```markdown
You are the verifier. You have a fresh context and did not write this change. Your job is to run it and report, never to fix.

Spec:

{{spec}}

Plan:

{{plan}}

If a run command is configured you may use it: {{skills}}

Exercise the changed behavior and the flows next to it. Record each thing you tried and what happened in `observations`. Set `passed` to false if anything the spec requires does not work or anything adjacent broke.

Respond only through the structured output.
```

`templates/prompts/review.md`:
```markdown
You are the reviewer. You have a fresh context and did not write this change. Follow the repository's `REVIEW.md` for the review passes and severity rules. Read the diff on this branch against the main branch and the code around it.

Spec:

{{spec}}

Plan:

{{plan}}

Report findings with `severity` `important` only for things that break behavior, leak data, breach policy, or contradict the spec or plan. Everything else is a `nit`; report at most five nits. Set `approved` to true when there are no important findings. Write `review_markdown` as a short document with a Summary heading and a Findings heading listing each finding with its severity and location.

Respond only through the structured output.
```

`templates/prompts/revise.md`:
```markdown
Review found important problems with your change. Address every important finding. Do not weaken tests or the review policy.

Findings:

{{findings}}

Make the changes, run the test command, and report every file you changed in `changed_files` with a one-line `commit_message`.

Respond only through the structured output.
```

`templates/prompts/done-check.md`:
```markdown
You are checking whether a merged change achieved what the product owner asked for. You have a fresh context. You may run the configured project commands.

The owner's Done when criteria:

{{done_when}}

Spec:

{{spec}}

Review summary:

{{review}}

For each criterion, record whether it is met and the evidence: a test that covers it, a command output, or a file you inspected. Be honest about criteria that cannot be verified from the repository alone; mark them unmet and say why. Write `outcome_markdown` as a short document with an Outcome heading and an Evidence heading, in plain language a product owner can read.

Respond only through the structured output.
```

`templates/prompts/lessons.md`:
```markdown
You are recording lessons from one completed change so the next change goes better.

Review:

{{review}}

Fix history and notes:

{{previous}}

List concrete lessons in `lessons`. If the same kind of mistake was flagged more than once, or a convention was learned the hard way, write the correction as short bullet points suitable for the repository's CLAUDE.md in `claude_md_additions`. Leave it empty when there is nothing worth adding.

Respond only through the structured output.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/prompts tests/unit/templates.test.ts
git commit -m "feat: default prompt templates for every agent phase"
```

---

### Task 7: Design stage

**Files:**
- Create: `src/stages/design.ts`, `src/stages/shared.ts`
- Create fixtures: `tests/fake-claude/fixtures/design.jsonl`, `tests/fake-claude/fixtures/spec-check.jsonl`
- Test: `tests/unit/stages-design.test.ts`

- [ ] **Step 1: Fixtures**

`tests/fake-claude/fixtures/design.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-design","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-design","total_cost_usd":0.05,"usage":{},"structured_output":{"status":"success","summary":"spec written","notes_for_next_phase":"","spec_markdown":"# Spec: add\n\n## Summary\nAdd an add function.\n\n## Requirements\n- add(a, b) returns a + b.\n\n## Design\nNew file src/add.ts exporting add.\n\n## Affected code\nsrc/add.ts (new), tests/add.test.ts (new)\n\n## Out of scope\nSubtraction.\n\n## Open questions\nNone.\n\n## Areas of concern\nNone.\n","concerns":[]},"result":"ok"}
```

`tests/fake-claude/fixtures/spec-check.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-spec-check","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-spec-check","total_cost_usd":0.03,"usage":{},"structured_output":{"status":"success","summary":"spec covers the intent","notes_for_next_phase":"","approved":true,"findings":[{"requirement":"add works","met":true,"evidence":"Requirements: add(a, b) returns a + b."}]},"result":"ok"}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runDesignStep } from "../../src/stages/design";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

const FAKE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TEMPLATES = new URL("../../templates/prompts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export async function setupRepo(status: string, configExtra = "") {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: echo ok\n${configExtra}`);
  mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), `---\nstatus: ${status}\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n`);
  await new Git(repo.path).commitAll("intent");
  process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;
  const trace = Trace.open(repo.path);
  const ctx = new StepContext(repo.path, await loadConfig(repo.path), trace, await readIntent(repo.path, "add-numbers"));
  return { repo, ctx, trace };
}

describe("design stage", () => {
  test("accepted → spec-review with spec.md written and committed; then agent gate → spec-approved", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await runDesignStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.priority).toBe("high");
    expect(i.artifacts.has("spec.md")).toBe(true);
    expect(await new Git(repo.path).isDirty()).toBe(false);

    await ctx.reload();
    await runDesignStep(ctx);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
    trace.close(); repo.cleanup();
  });

  test("spec-review with a human gate leaves a note and does not advance", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", "gates:\n  spec:\n    human: status\n");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toContain("spec-approved");
    trace.close(); repo.cleanup();
  });

  test("intake with a question blocks the intent", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "tests-fixture-intake-question.jsonl"), `{"type":"system","subtype":"init","session_id":"q"}\n{"type":"result","subtype":"success","session_id":"q","total_cost_usd":0,"structured_output":{"status":"success","summary":"","notes_for_next_phase":"","priority":"normal","missing_sections":[],"question":"Which portal page should show the status?"}}\n`);
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    cpSync(join(repo.path, "tests-fixture-intake-question.jsonl"), join(new URL("../fake-claude/fixtures", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "intake-question.jsonl"));
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("Which portal page");
    trace.close(); repo.cleanup();
  });
});
```

Note for the implementer: the third test copies a fixture into the fake's fixtures folder. Instead, commit `tests/fake-claude/fixtures/intake-question.jsonl` with that content and delete the copy lines from the test. Keep the `FIXTURE:intake-question` prompt override.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/stages-design.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Write `src/stages/shared.ts`**

```ts
import { runCommand } from "../shell";
import { block, readArtifact, setStatus, type StepContext, type StepResult } from "../context";
import { codePhase } from "../phases";
import type { Check } from "../gates";
import { headingsPresent } from "../checks";
import type { Status } from "../intents";

/** Runs a stage's before/after commands as one code phase. Any failure blocks. */
export async function runHookCommands(ctx: StepContext, which: "before" | "after", stage: keyof StepContext["cfg"]["stages"], cwd = ctx.root): Promise<StepResult> {
  const cmds = ctx.cfg.stages[stage][which];
  if (!cmds.length) return { ok: true };
  const r = await codePhase(ctx, `${stage}-${which}`, async () => {
    for (const cmd of cmds) {
      const res = await runCommand(cmd, cwd, { LOOPSTRA_SLUG: ctx.slug, LOOPSTRA_STAGE: stage });
      ctx.trace.event(ctx.slug, "command", { command: cmd, code: res.code, lastLine: res.lastLine, durationMs: res.durationMs });
      if (res.code !== 0) throw new Error(`\`${cmd}\` failed: ${res.lastLine || `exit ${res.code}`}`);
    }
    return { ok: true as const };
  });
  return r.ok ? { ok: true } : block(ctx, `A ${which} command for the ${stage} stage failed. ${r.note}`);
}

export function headingsCheck(name: string, text: string, headings: string[]): Check {
  return {
    name,
    run: async () => {
      const r = headingsPresent(text, headings);
      return r.ok ? { result: "pass", evidence: "all headings present" } : { result: "fail", evidence: `missing headings: ${r.missing.join(", ")}` };
    },
  };
}

export const SPEC_HEADINGS = ["Summary", "Requirements", "Design", "Affected code", "Out of scope", "Open questions", "Areas of concern"];
export const PLAN_HEADINGS = ["Files that change", "Order of work", "Risks", "Proof"];

/** The note written when a human gate is waiting. */
export function humanNote(artifact: string, approvedStatus: Status): string {
  return `Read ${artifact}. When you are happy with it, change the status line to ${approvedStatus}. To stop this change, set it to closed.`;
}

export async function artifacts(ctx: StepContext): Promise<{ intent: string; spec: string; plan: string; review: string }> {
  return {
    intent: ctx.intent.file.body,
    spec: (await readArtifact(ctx, "spec.md")) ?? "",
    plan: (await readArtifact(ctx, "plan.md")) ?? "",
    review: (await readArtifact(ctx, "review.md")) ?? "",
  };
}

export { setStatus };
```

- [ ] **Step 5: Write `src/stages/design.ts`**

```ts
import { block, setStatus, writeArtifact, writeIntentPriority, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, headingsCheck, humanNote, runHookCommands, SPEC_HEADINGS } from "./shared";

/** One step of Stage 1 and 2. Called when status is accepted, designing, or spec-review. */
export async function runDesignStep(ctx: StepContext): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === "accepted" || status === "designing") return design(ctx);
  if (status === "spec-review") return specGate(ctx);
  return { ok: true };
}

async function design(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "designing") await setStatus(ctx, "designing");
  const before = await runHookCommands(ctx, "before", "design");
  if (!before.ok) return before;

  const a = await artifacts(ctx);
  const intake = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: { intent: a.intent } });
  if (!intake.ok) return block(ctx, intake.note);
  if (intake.envelope.question || intake.envelope.missing_sections.length) {
    const missing = intake.envelope.missing_sections.length ? ` Missing sections: ${intake.envelope.missing_sections.join(", ")}.` : "";
    return block(ctx, `${intake.envelope.question || "The intent needs more detail before it can be designed."}${missing} Update intent.md, then set status to accepted.`);
  }
  await writeIntentPriority(ctx, intake.envelope.priority);

  const design = await agentPhase(ctx, {
    name: "design", model: ctx.cfg.stages.design.model, permissionMode: "default", tools: "read",
    vars: { intent: a.intent, skills: ctx.cfg.stages.design.skills.join(", ") }, skills: ctx.cfg.stages.design.skills,
  });
  if (!design.ok) return block(ctx, design.note);
  await writeArtifact(ctx, "spec.md", design.envelope.spec_markdown);

  const after = await runHookCommands(ctx, "after", "design");
  if (!after.ok) return after;
  await setStatus(ctx, "spec-review", ctx.cfg.gates.spec.human === "none" ? "" : humanNote("spec.md", "spec-approved"));
  return { ok: true };
}

async function specGate(ctx: StepContext): Promise<StepResult> {
  const a = await artifacts(ctx);
  const checks: Check[] = [headingsCheck("headings", a.spec, SPEC_HEADINGS)];
  if (ctx.cfg.gates.spec.agent) {
    checks.push({
      name: "spec-check",
      run: async () => {
        const r = await agentPhase(ctx, { name: "spec-check", model: "strong", permissionMode: "default", tools: "read", vars: { intent: a.intent, spec: a.spec } });
        if (!r.ok) return { result: "fail", evidence: r.note };
        const unmet = r.envelope.findings.filter((f) => !f.met).map((f) => `${f.requirement}: ${f.evidence}`);
        return r.envelope.approved ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: unmet.join("; ") || r.envelope.summary };
      },
    });
  }
  const outcome = await evaluateGate(ctx, "spec", checks);
  if (outcome.result === "pass") { await setStatus(ctx, "spec-approved"); return { ok: true }; }
  return block(ctx, `The spec did not pass its check (${outcome.check}): ${outcome.evidence}. Fix spec.md or the intent, then set status to accepted to redesign.`);
}
```

Add to `src/context.ts`:
```ts
export async function writeIntentPriority(ctx: StepContext, priority: Intent["file"]["frontmatter"]["priority"]): Promise<void> {
  if (ctx.intent.file.frontmatter.priority === priority) return;
  await writeIntent(ctx.intent, { priority });
  ctx.trace.upsertIntent(ctx.slug, ctx.intent.file.frontmatter.status, priority);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/stages-design.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/stages src/context.ts tests/unit/stages-design.test.ts tests/fake-claude/fixtures
git commit -m "feat: design stage from accepted to spec-approved"
```

---

### Task 8: Plan stage

**Files:**
- Create: `src/stages/plan.ts`
- Fixtures: `tests/fake-claude/fixtures/plan.jsonl`, `tests/fake-claude/fixtures/plan-challenge.jsonl`
- Test: `tests/unit/stages-plan.test.ts`

- [ ] **Step 1: Fixtures**

`tests/fake-claude/fixtures/plan.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-plan","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-plan","total_cost_usd":0.04,"usage":{},"structured_output":{"status":"success","summary":"plan written","notes_for_next_phase":"","plan_markdown":"# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. Write the failing test.\n2. Implement add.\n\n## Risks\nNone.\n\n## Proof\n`bun test` passes with tests/add.test.ts covering add(1, 2).\n","files":[{"path":"src/add.ts","new":true},{"path":"tests/add.test.ts","new":true}]},"result":"ok"}
```

`tests/fake-claude/fixtures/plan-challenge.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-plan-challenge","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-plan-challenge","total_cost_usd":0.03,"usage":{},"structured_output":{"status":"success","summary":"plan is sound","notes_for_next_phase":"","approved":true,"concerns":[]},"result":"ok"}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readIntent } from "../../src/intents";
import { runPlanStep } from "../../src/stages/plan";
import { setupRepo } from "./stages-design.test";

describe("plan stage", () => {
  test("spec-approved → plan-review with plan.md; agent gate → plan-approved", async () => {
    const { repo, ctx, trace } = await setupRepo("spec-approved");
    await Bun.write(join(repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
    await ctx.reload();
    await runPlanStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("plan-review");
    expect(i.artifacts.has("plan.md")).toBe(true);
    await ctx.reload();
    await runPlanStep(ctx);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("plan-approved");
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "files:pass", "plan-challenge:pass"]);
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/stages-plan.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/stages/plan.ts`**

```ts
import { filesExistOrNew, parsePlanFiles } from "../checks";
import { block, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, headingsCheck, humanNote, PLAN_HEADINGS, runHookCommands } from "./shared";

/** One step of the plan half of Stage 3. Called for spec-approved, planning, plan-review. */
export async function runPlanStep(ctx: StepContext): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === "spec-approved" || status === "planning") return plan(ctx, "");
  if (status === "plan-review") return planGate(ctx);
  return { ok: true };
}

async function plan(ctx: StepContext, concerns: string): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "planning") await setStatus(ctx, "planning");
  const before = await runHookCommands(ctx, "before", "plan");
  if (!before.ok) return before;
  const a = await artifacts(ctx);
  const r = await agentPhase(ctx, {
    name: "plan", model: ctx.cfg.stages.plan.model, permissionMode: "plan", tools: "read",
    vars: { intent: a.intent, spec: a.spec, skills: ctx.cfg.stages.plan.skills.join(", "), concerns }, skills: ctx.cfg.stages.plan.skills,
  });
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, "plan.md", r.envelope.plan_markdown);
  const after = await runHookCommands(ctx, "after", "plan");
  if (!after.ok) return after;
  await setStatus(ctx, "plan-review", ctx.cfg.gates.plan.human === "none" ? "" : humanNote("plan.md", "plan-approved"));
  return { ok: true };
}

async function planGate(ctx: StepContext): Promise<StepResult> {
  const a = await artifacts(ctx);
  const files = parsePlanFiles(a.plan);
  const checks: Check[] = [
    headingsCheck("headings", a.plan, PLAN_HEADINGS),
    { name: "files", run: async () => { const r = filesExistOrNew(ctx.root, files); return r.ok ? { result: "pass", evidence: `${files.length} files listed` } : { result: "fail", evidence: r.problems.join("; ") }; } },
  ];
  let blockingConcerns: string[] = [];
  if (ctx.cfg.gates.plan.agent) {
    checks.push({
      name: "plan-challenge",
      run: async () => {
        const r = await agentPhase(ctx, { name: "plan-challenge", model: "strong", permissionMode: "default", tools: "read", vars: { spec: a.spec, plan: a.plan } });
        if (!r.ok) return { result: "fail", evidence: r.note };
        blockingConcerns = r.envelope.concerns.filter((c) => c.blocking).map((c) => c.concern);
        return r.envelope.approved ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: blockingConcerns.join("; ") || r.envelope.summary };
      },
    });
  }
  const outcome = await evaluateGate(ctx, "plan", checks);
  if (outcome.result === "pass") { await setStatus(ctx, "plan-approved"); return { ok: true }; }
  if (outcome.check === "plan-challenge" && !ctx.intent.file.frontmatter.note.startsWith("replanned")) {
    // One resend of the plan with the concerns, then block if it fails again.
    await setStatus(ctx, "planning", "replanned once after review concerns");
    const again = await plan(ctx, blockingConcerns.join("\n"));
    if (!again.ok) return again;
    await ctx.reload();
    return { ok: true };
  }
  return block(ctx, `The plan did not pass its check (${outcome.check}): ${outcome.evidence}. Fix plan.md, then set status to spec-approved to replan.`);
}
```

Also fix `plan()` so it keeps the "replanned" marker: when `concerns` is non-empty, the `setStatus(ctx, "plan-review", ...)` note must be `"replanned once after review concerns"` when the gate is not human, so the gate can detect the second attempt. Implement that by computing `const note = ctx.cfg.gates.plan.human === "none" ? (concerns ? "replanned once after review concerns" : "") : humanNote(...)`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/stages-plan.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stages/plan.ts tests/unit/stages-plan.test.ts tests/fake-claude/fixtures
git commit -m "feat: plan stage from spec-approved to plan-approved"
```

---

### Task 9: Build stage with test loop and verify

**Files:**
- Create: `src/stages/build.ts`
- Fixtures: `tests/fake-claude/fixtures/build.jsonl`, `fix.jsonl`, `verify.jsonl`, `reconcile.jsonl`
- Test: `tests/unit/stages-build.test.ts`

- [ ] **Step 1: Fixtures**

`tests/fake-claude/fixtures/build.jsonl` (writes real files into the worktree):
```
{"type":"system","subtype":"init","session_id":"fake-build","cwd":"/","tools":[],"model":"fake"}
{"type":"fake_action","write":{"path":"src/add.ts","content":"export function add(a: number, b: number): number {\n  return a + b;\n}\n"}}
{"type":"fake_action","write":{"path":"tests/add.test.ts","content":"import { expect, test } from \"bun:test\";\nimport { add } from \"../src/add\";\ntest(\"adds\", () => { expect(add(1, 2)).toBe(3); });\n"}}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-build","total_cost_usd":0.2,"usage":{},"structured_output":{"status":"success","summary":"implemented add","notes_for_next_phase":"","changed_files":["src/add.ts","tests/add.test.ts"],"commit_message":"feat: add function"},"result":"ok"}
```

`tests/fake-claude/fixtures/fix.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-build","cwd":"/","tools":[],"model":"fake"}
{"type":"fake_action","write":{"path":"src/add.ts","content":"export function add(a: number, b: number): number {\n  return a + b;\n}\n"}}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-build","total_cost_usd":0.1,"usage":{},"structured_output":{"status":"success","summary":"fixed add","notes_for_next_phase":"","changed_files":["src/add.ts"],"commit_message":"fix: add"},"result":"ok"}
```

`tests/fake-claude/fixtures/verify.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-verify","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-verify","total_cost_usd":0.02,"usage":{},"structured_output":{"status":"success","summary":"works","notes_for_next_phase":"","passed":true,"observations":["ran bun test: 1 pass"]},"result":"ok"}
```

`tests/fake-claude/fixtures/reconcile.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-build","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-build","total_cost_usd":0.02,"usage":{},"structured_output":{"status":"success","summary":"plan updated","notes_for_next_phase":"","plan_markdown":"# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n- src/extra.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n"},"result":"ok"}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runBuildStep } from "../../src/stages/build";
import { setupRepo } from "./stages-design.test";

const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

async function planned(configExtra = "") {
  const s = await setupRepo("plan-approved", configExtra);
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), PLAN);
  await Bun.write(join(s.repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  return s;
}

describe("build stage", () => {
  test("plan-approved → reviewing: branch, worktree, build commits, tests pass, verify passes", async () => {
    const { repo, ctx, trace } = await planned("commands:\n  test: bun test\n");
    const r = await runBuildStep(ctx);
    expect(r.ok).toBe(true);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("reviewing");
    const wt = join(repo.path, ".loopstra", "worktrees", "add-numbers");
    expect(existsSync(join(wt, "src", "add.ts"))).toBe(true);
    const wtGit = new Git(wt);
    expect(await wtGit.isDirty()).toBe(false);
    expect(await wtGit.changedFilesSince("main")).toEqual(["src/add.ts", "tests/add.test.ts"]);
    const names = trace.phases("add-numbers").map((p) => p.name);
    expect(names).toEqual(["branch", "build", "drift", "test-1", "verify"]);
    expect(JSON.parse(await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "sessions.json")).text())).toEqual({ build: "fake-build" });
    trace.close(); repo.cleanup();
  });

  test("a failing test command runs fix with LOOPSTRA_PHASE=fix and resumes the build session, then blocks after max loops", async () => {
    const { repo, ctx, trace } = await planned("commands:\n  test: exit 1\nstages:\n  build:\n    max_fix_loops: 2\n");
    const argsFile = join(repo.path, "args.json");
    process.env.LOOPSTRA_FAKE_ARGS = argsFile;
    const r = await runBuildStep(ctx);
    delete process.env.LOOPSTRA_FAKE_ARGS;
    expect(r.ok).toBe(false);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toMatch(/2 fix attempt/);
    const names = trace.phases("add-numbers").map((p) => p.name);
    expect(names).toEqual(["branch", "build", "drift", "test-1", "fix-1", "test-2", "fix-2", "test-3"]);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.env.LOOPSTRA_PHASE).toBe("fix");
    expect(recorded.args).toEqual(expect.arrayContaining(["--resume", "fake-build"]));
    trace.close(); repo.cleanup();
  });

  test("files outside the plan trigger reconcile which rewrites plan.md on the branch", async () => {
    const { repo, ctx, trace } = await planned("commands:\n  test: bun test\n");
    await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), PLAN.replace("- tests/add.test.ts (new)\n", ""));
    await new Git(repo.path).commitAll("narrower plan");
    await ctx.reload();
    await runBuildStep(ctx);
    const names = trace.phases("add-numbers").map((p) => p.name);
    expect(names).toContain("reconcile");
    const wtPlan = await Bun.file(join(repo.path, ".loopstra", "worktrees", "add-numbers", "intent", "add-numbers", "plan.md")).text();
    expect(wtPlan).toContain("src/extra.ts");
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/stages-build.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/stages/build.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { diffWithinPlan, parsePlanFiles } from "../checks";
import { block, clearSession, loadSessions, saveSession, setStatus, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase, codePhase } from "../phases";
import { runCommand, type CommandResult } from "../shell";
import { artifacts, runHookCommands } from "./shared";

/** Stage 3 build half plus Stage 4. Called for plan-approved and building. Ends at reviewing or blocked. */
export async function runBuildStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "building") await setStatus(ctx, "building");

  const branch = await codePhase(ctx, "branch", async () => {
    if (!(await ctx.git.branchExists(ctx.branch))) await ctx.git.createBranch(ctx.branch, ctx.cfg.main_branch);
    if (!existsSync(ctx.worktreeDir)) await ctx.git.worktreeAdd(ctx.worktreeDir, ctx.branch);
    if (ctx.cfg.commands.install) {
      const r = await runCommand(ctx.cfg.commands.install, ctx.worktreeDir);
      ctx.trace.event(ctx.slug, "command", { command: ctx.cfg.commands.install, code: r.code, lastLine: r.lastLine });
      if (r.code !== 0) throw new Error(`install failed: ${r.lastLine}`);
    }
    return { ok: true as const };
  });
  if (!branch.ok) return block(ctx, `Could not prepare the branch for building. ${branch.note}`);

  const before = await runHookCommands(ctx, "before", "build", ctx.worktreeDir);
  if (!before.ok) return before;

  const wt = new Git(ctx.worktreeDir);
  const a = await artifacts(ctx);
  const stage = ctx.cfg.stages.build;

  const build = await agentPhase(ctx, {
    name: "build", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
    vars: { plan: a.plan, spec: a.spec, skills: stage.skills.join(", ") }, skills: stage.skills,
  });
  if (!build.ok) return block(ctx, build.note);
  if (build.sessionId) saveSession(ctx, "build", build.sessionId);
  await wt.commitAll(build.envelope.commit_message || `loopstra(${ctx.slug}): build`);

  // Plan drift: files changed that the plan did not list.
  const drift = await codePhase(ctx, "drift", async () => {
    const changed = await wt.changedFilesSince(ctx.cfg.main_branch);
    const extra = diffWithinPlan(changed, parsePlanFiles(a.plan));
    ctx.trace.event(ctx.slug, "command", { command: "drift", changed, extra });
    return { ok: true as const, extra };
  });
  if (!drift.ok) return block(ctx, drift.note);
  if (drift.extra.length) {
    const rec = await agentPhase(ctx, {
      name: "reconcile", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      resume: loadSessions(ctx).build, vars: { plan: a.plan, findings: drift.extra.map((f) => `- ${f}`).join("\n") },
    });
    if (!rec.ok) return block(ctx, rec.note);
    await Bun.write(join(ctx.worktreeDir, "intent", ctx.slug, "plan.md"), rec.envelope.plan_markdown);
    await wt.commitAll(`loopstra(${ctx.slug}): reconcile plan with implementation`);
  }

  // Test loop.
  let failure: CommandResult | null = null;
  let observations = "";
  for (let i = 1; i <= stage.max_fix_loops + 1; i++) {
    failure = await runChecks(ctx, `test-${i}`);
    if (!failure && i > 1 && observations) observations = "";
    if (!failure) {
      const verify = await agentPhase(ctx, {
        name: "verify", model: ctx.cfg.stages.verify.model, permissionMode: "default", tools: "read+commands", cwd: ctx.worktreeDir,
        vars: { spec: a.spec, plan: a.plan, skills: ctx.cfg.commands.run ? `run command: ${ctx.cfg.commands.run}` : "" },
      });
      if (!verify.ok) return block(ctx, verify.note);
      if (verify.envelope.passed) break;
      observations = verify.envelope.observations.map((o) => `- ${o}`).join("\n");
      failure = { command: "verify", code: 1, output: observations, lastLine: "verifier found problems", durationMs: 0 };
    }
    if (i > stage.max_fix_loops) {
      return block(ctx, `The tests kept failing after ${stage.max_fix_loops} fix attempt${stage.max_fix_loops === 1 ? "" : "s"}. Last failure: ${failure.lastLine}. An engineer should look at branch ${ctx.branch}.`);
    }
    const fix = await agentPhase(ctx, {
      name: "fix", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      resume: loadSessions(ctx).build, env: { LOOPSTRA_PHASE: "fix" },
      vars: { failure_output: failure.output.slice(-8000), observations },
    });
    if (!fix.ok) {
      if (/could not finish/.test(fix.note) && loadSessions(ctx).build) clearSession(ctx, "build"); // a dead session: next attempt starts fresh
      return block(ctx, fix.note);
    }
    if (fix.sessionId) saveSession(ctx, "build", fix.sessionId);
    await wt.commitAll(fix.envelope.commit_message || `loopstra(${ctx.slug}): fix`);
  }

  await setStatus(ctx, "reviewing");
  return { ok: true };
}

/** Runs test, lint, build in order in the worktree. Returns the first failure, or null when all pass. */
export async function runChecks(ctx: StepContext, phaseName: string): Promise<CommandResult | null> {
  const r = await codePhase(ctx, phaseName, async () => {
    const cmds = [ctx.cfg.commands.test, ctx.cfg.commands.lint, ctx.cfg.commands.build].filter((c): c is string => !!c);
    for (const cmd of cmds) {
      const res = await runCommand(cmd, ctx.worktreeDir, { LOOPSTRA_SLUG: ctx.slug });
      ctx.trace.event(ctx.slug, "command", { command: cmd, code: res.code, lastLine: res.lastLine, durationMs: res.durationMs });
      if (res.code !== 0) return { ok: true as const, failure: res };
    }
    return { ok: true as const, failure: null };
  });
  if (!r.ok) return { command: "checks", code: 1, output: r.note, lastLine: r.note, durationMs: 0 };
  return r.failure;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/stages-build.test.ts`
Expected: PASS, 3 tests. The first test runs a real `bun test` inside the worktree; the target `package.json` has no dependencies so no install is needed.

- [ ] **Step 6: Commit**

```bash
git add src/stages/build.ts tests/unit/stages-build.test.ts tests/fake-claude/fixtures
git commit -m "feat: build stage with worktree, drift reconcile, test-fix loop, and verify"
```

---

### Task 10: Review and merge stages (local)

**Files:**
- Create: `src/stages/review.ts`, `src/stages/merge.ts`
- Fixtures: `tests/fake-claude/fixtures/review.jsonl`, `revise.jsonl`, `review-reject.jsonl`
- Test: `tests/unit/stages-review-merge.test.ts`

- [ ] **Step 1: Fixtures**

`tests/fake-claude/fixtures/review.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-review","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-review","total_cost_usd":0.06,"usage":{},"structured_output":{"status":"success","summary":"looks good","notes_for_next_phase":"","approved":true,"findings":[{"severity":"nit","file":"src/add.ts","line":1,"finding":"could add a doc comment"}],"review_markdown":"# Review\n\n## Summary\nLooks good.\n\n## Findings\n- nit src/add.ts:1 could add a doc comment\n"},"result":"ok"}
```

`tests/fake-claude/fixtures/review-reject.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-review","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-review","total_cost_usd":0.06,"usage":{},"structured_output":{"status":"success","summary":"missing handling","notes_for_next_phase":"","approved":false,"findings":[{"severity":"important","file":"src/add.ts","line":1,"finding":"does not handle NaN"}],"review_markdown":"# Review\n\n## Summary\nProblems.\n\n## Findings\n- important src/add.ts:1 does not handle NaN\n"},"result":"ok"}
```

`tests/fake-claude/fixtures/revise.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-build","cwd":"/","tools":[],"model":"fake"}
{"type":"fake_action","write":{"path":"src/add.ts","content":"export function add(a: number, b: number): number {\n  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(\"NaN\");\n  return a + b;\n}\n"}}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-build","total_cost_usd":0.1,"usage":{},"structured_output":{"status":"success","summary":"handled NaN","notes_for_next_phase":"","changed_files":["src/add.ts"],"commit_message":"fix: handle NaN"},"result":"ok"}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runBuildStep } from "../../src/stages/build";
import { runMergeStep } from "../../src/stages/merge";
import { runReviewStep } from "../../src/stages/review";
import { setupRepo } from "./stages-design.test";

const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

async function built(configExtra = "") {
  const s = await setupRepo("plan-approved", "commands:\n  test: bun test\n" + configExtra);
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), PLAN);
  await Bun.write(join(s.repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  await runBuildStep(s.ctx);
  await s.ctx.reload();
  return s;
}

describe("review and merge", () => {
  test("reviewing → merge-review with review.md; merge-review → merged locally with cleanup", async () => {
    const { repo, ctx, trace } = await built();
    await runReviewStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merge-review");
    expect(i.artifacts.has("review.md")).toBe(true);

    await ctx.reload();
    await runMergeStep(ctx);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merged");
    expect(existsSync(join(repo.path, "src", "add.ts"))).toBe(true);
    expect(existsSync(join(repo.path, ".loopstra", "worktrees", "add-numbers"))).toBe(false);
    expect(await new Git(repo.path).branchExists("intent/add-numbers")).toBe(false);
    expect(trace.gates("add-numbers").filter((g) => g.gate === "merge").map((g) => `${g.check}:${g.result}`)).toEqual(["up-to-date:pass", "tests:pass", "findings:pass"]);
    trace.close(); repo.cleanup();
  });

  test("important findings trigger revise, then re-test and re-review; exhausted rounds block", async () => {
    const { repo, ctx, trace } = await built("stages:\n  review:\n    max_rounds: 1\n");
    await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), "{{spec}} FIXTURE:review-reject");
    await runReviewStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("NaN");
    const names = trace.phases("add-numbers").map((p) => p.name);
    expect(names.slice(-4)).toEqual(["review-1", "revise-1", "retest-1", "review-2"]);
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/stages-review-merge.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/stages/review.ts`**

```ts
import { block, loadSessions, saveSession, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase } from "../phases";
import { runChecks } from "./build";
import { artifacts, runHookCommands } from "./shared";

/** Stage 5 review rounds. Called for reviewing. Ends at merge-review or blocked. */
export async function runReviewStep(ctx: StepContext): Promise<StepResult> {
  const a = await artifacts(ctx);
  const stage = ctx.cfg.stages.review;
  const wt = new Git(ctx.worktreeDir);
  let lastImportant: string[] = [];

  for (let round = 1; round <= stage.max_rounds + 1; round++) {
    const review = await agentPhase(ctx, {
      name: "review", model: stage.model, permissionMode: "default", tools: "read", cwd: ctx.worktreeDir,
      vars: { spec: a.spec, plan: a.plan, skills: stage.skills.join(", ") }, skills: stage.skills,
    });
    if (!review.ok) return block(ctx, review.note);
    await writeArtifact(ctx, "review.md", review.envelope.review_markdown);
    ctx.trace.event(ctx.slug, "gate_check", { gate: "review", round, approved: review.envelope.approved, findings: review.envelope.findings.length });
    lastImportant = review.envelope.findings.filter((f) => f.severity === "important").map((f) => `${f.file}:${f.line} ${f.finding}`);
    if (review.envelope.approved && !lastImportant.length) break;
    if (round > stage.max_rounds) {
      return block(ctx, `Review still found important problems after ${stage.max_rounds} revision round${stage.max_rounds === 1 ? "" : "s"}: ${lastImportant.join("; ")}. An engineer should look at branch ${ctx.branch}.`);
    }
    const revise = await agentPhase(ctx, {
      name: "revise", model: ctx.cfg.stages.build.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      resume: loadSessions(ctx).build, vars: { findings: lastImportant.map((f) => `- ${f}`).join("\n") },
    });
    if (!revise.ok) return block(ctx, revise.note);
    if (revise.sessionId) saveSession(ctx, "build", revise.sessionId);
    await wt.commitAll(revise.envelope.commit_message || `loopstra(${ctx.slug}): revise`);
    const failure = await runChecks(ctx, `retest-${round}`);
    if (failure) return block(ctx, `After revising for review, the tests failed: ${failure.lastLine}. An engineer should look at branch ${ctx.branch}.`);
  }

  const after = await runHookCommands(ctx, "after", "build", ctx.worktreeDir);
  if (!after.ok) return after;
  await setStatus(ctx, "merge-review");
  return { ok: true };
}
```

Then rename the review phase names so the test's expectations hold: in `agentPhase` the trace name is `spec.name`; for round numbering pass the round through the trace. Simplest: add an optional `traceName?: string` to `AgentPhaseSpec` in `src/phases.ts`, use `spec.traceName ?? spec.name` for `phaseStart` and the phase directory, and set `traceName: \`review-${round}\`` and `traceName: \`revise-${round}\`` here. Also use `traceName` for `fix-${i}` in `src/stages/build.ts` and update that test's expected names accordingly (it already expects `fix-1`, `fix-2`).

- [ ] **Step 5: Write `src/stages/merge.ts`**

```ts
import { existsSync } from "node:fs";
import { block, setStatus, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { Git } from "../git";
import { codePhase } from "../phases";
import { runChecks } from "./build";

/** Merge gate and merge. Called for merge-review. Local path only; GitHub path is added in Plan 3. */
export async function runMergeStep(ctx: StepContext): Promise<StepResult> {
  const wt = new Git(ctx.worktreeDir);
  if (!existsSync(ctx.worktreeDir)) return block(ctx, `The work for this change is missing from .loopstra/worktrees. Set status to plan-approved to rebuild.`);

  const checks: Check[] = [
    {
      name: "up-to-date",
      run: async () => {
        if (await ctx.git.isAncestor(ctx.cfg.main_branch, ctx.branch)) return { result: "pass", evidence: "branch contains main" };
        const ok = await wt.rebaseOnto(ctx.cfg.main_branch);
        return ok ? { result: "pass", evidence: "rebased onto main" } : { result: "fail", evidence: "rebase onto main hit conflicts" };
      },
    },
    {
      name: "tests",
      run: async () => {
        const failure = await runChecks(ctx, "merge-tests");
        return failure ? { result: "fail", evidence: failure.lastLine } : { result: "pass", evidence: "all commands exit 0" };
      },
    },
    {
      name: "findings",
      run: async () => {
        const last = [...ctx.trace.events(ctx.slug)].reverse().find((e) => e.type === "gate_check" && JSON.parse(e.payload).gate === "review");
        const approved = last ? (JSON.parse(last.payload) as { approved: boolean }).approved : false;
        return approved ? { result: "pass", evidence: "review approved" } : { result: "fail", evidence: "last review did not approve" };
      },
    },
  ];
  if (ctx.cfg.gates.merge.human === "status") {
    checks.push({ name: "human", run: async () => ({ result: "waiting", evidence: "waiting for a person to set status to merged" }) });
  }

  const outcome = await evaluateGate(ctx, "merge", checks);
  if (outcome.result === "waiting") return { ok: true };
  if (outcome.result === "fail") return block(ctx, `The change is not ready to merge (${outcome.check}): ${outcome.evidence}. An engineer should look at branch ${ctx.branch}.`);

  const merged = await codePhase(ctx, "merge", async () => {
    const title = ctx.intent.title || ctx.slug;
    await ctx.git.merge(ctx.branch, ctx.cfg.gates.merge.method, `${ctx.slug}: ${title}`);
    await ctx.git.worktreeRemove(ctx.worktreeDir);
    await ctx.git.deleteBranch(ctx.branch);
    return { ok: true as const };
  });
  if (!merged.ok) return block(ctx, `Merging failed. ${merged.note}`);
  await setStatus(ctx, "merged");
  return { ok: true };
}
```

Note: `ctx.intent.title` is `ctx.intent.file.title`; use that.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/stages-review-merge.test.ts tests/unit/stages-build.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/stages src/phases.ts tests/unit/stages-review-merge.test.ts tests/unit/stages-build.test.ts tests/fake-claude/fixtures
git commit -m "feat: review rounds and local merge gate"
```

---

### Task 11: Verify stage and main_health signal

**Files:**
- Create: `src/stages/verify.ts`, `src/signals.ts`
- Fixtures: `tests/fake-claude/fixtures/done-check.jsonl`, `lessons.jsonl`
- Test: `tests/unit/stages-verify.test.ts`, `tests/unit/signals.test.ts`

- [ ] **Step 1: Fixtures**

`tests/fake-claude/fixtures/done-check.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-done","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-done","total_cost_usd":0.03,"usage":{},"structured_output":{"status":"success","summary":"criteria met","notes_for_next_phase":"","met":true,"evidence":[{"criterion":"add(1, 2) returns 3.","met":true,"evidence":"tests/add.test.ts covers it and passes"}],"outcome_markdown":"# Outcome\n\n## Outcome\nThe add function exists and works.\n\n## Evidence\n- add(1, 2) returns 3: covered by tests/add.test.ts, passing.\n"},"result":"ok"}
```

`tests/fake-claude/fixtures/lessons.jsonl`:
```
{"type":"system","subtype":"init","session_id":"fake-lessons","cwd":"/","tools":[],"model":"fake"}
{"type":"result","subtype":"success","is_error":false,"session_id":"fake-lessons","total_cost_usd":0.01,"usage":{},"structured_output":{"status":"success","summary":"one lesson","notes_for_next_phase":"","lessons":["Add doc comments to exported functions."],"claude_md_additions":"- Exported functions get a one-line doc comment."},"result":"ok"}
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/stages-verify.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runVerifyStep } from "../../src/stages/verify";
import { setupRepo } from "./stages-design.test";

describe("verify stage", () => {
  test("merged → done with outcome.md containing evidence and lessons", async () => {
    const { repo, ctx, trace } = await setupRepo("merged");
    await Bun.write(join(repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n");
    await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), "# Plan\n");
    await Bun.write(join(repo.path, "intent", "add-numbers", "review.md"), "# Review\n");
    await new Git(repo.path).commitAll("artifacts");
    await ctx.reload();
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    const outcome = await Bun.file(join(repo.path, "intent", "add-numbers", "outcome.md")).text();
    expect(outcome).toContain("## Evidence");
    expect(outcome).toContain("## Lessons");
    expect(outcome).toContain("## Proposed CLAUDE.md additions");
    expect(outcome).toContain("doc comment");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });
});
```

`tests/unit/signals.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { runMainHealth } from "../../src/signals";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

async function setup(testCmd: string) {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: ${testCmd}\n`);
  await new Git(repo.path).commitAll("config");
  return { repo, cfg: await loadConfig(repo.path), trace: Trace.open(repo.path) };
}

describe("main_health", () => {
  test("green stays quiet; green then red opens a draft intent in plain language", async () => {
    const { repo, cfg, trace } = await setup("echo ok");
    await runMainHealth(repo.path, cfg, trace, "add-numbers");
    expect(trace.signals()[0]?.result).toBe("pass");
    expect(existsSync(join(repo.path, "intent"))).toBe(false);

    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: exit 1\n");
    await new Git(repo.path).commitAll("break");
    const cfg2 = await loadConfig(repo.path);
    await runMainHealth(repo.path, cfg2, trace, "add-numbers");
    expect(trace.signals()[0]?.result).toBe("fail");
    const dirs = readdirSync(join(repo.path, "intent"));
    expect(dirs).toEqual(["fix-tests-after-add-numbers"]);
    const text = await Bun.file(join(repo.path, "intent", "fix-tests-after-add-numbers", "intent.md")).text();
    expect(text).toContain("status: draft");
    expect(text).toContain("## Problem");
    expect(text).toContain("add-numbers");
    expect(text).toContain("## Done when");

    // A second red run does not open a duplicate.
    await runMainHealth(repo.path, cfg2, trace, "add-numbers");
    expect(readdirSync(join(repo.path, "intent")).length).toBe(1);
    trace.close(); repo.cleanup();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/stages-verify.test.ts tests/unit/signals.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/stages/verify.ts`**

```ts
import { block, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, humanNote } from "./shared";

/** Stage 6 for one intent. Called for merged and verifying. Ends at done or blocked. */
export async function runVerifyStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "verifying") await setStatus(ctx, "verifying");
  const a = await artifacts(ctx);
  const doneWhen = ctx.intent.file.sections["Done when"] ?? "";

  let outcomeMd = "";
  let unmet: string[] = [];
  const checks: Check[] = [];
  if (ctx.cfg.gates.done.agent) {
    checks.push({
      name: "done-check",
      run: async () => {
        const r = await agentPhase(ctx, { name: "done-check", model: "strong", permissionMode: "default", tools: "read+commands", vars: { done_when: doneWhen, spec: a.spec, review: a.review } });
        if (!r.ok) return { result: "fail", evidence: r.note };
        outcomeMd = r.envelope.outcome_markdown;
        unmet = r.envelope.evidence.filter((e) => !e.met).map((e) => `${e.criterion} (${e.evidence})`);
        return r.envelope.met ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: unmet.join("; ") };
      },
    });
  }
  if (ctx.cfg.gates.done.human === "status") {
    checks.push({ name: "human", run: async () => ({ result: "waiting", evidence: "waiting for a person to confirm" }) });
  }

  const outcome = await evaluateGate(ctx, "done", checks);
  if (outcomeMd) await writeArtifact(ctx, "outcome.md", outcomeMd);
  if (outcome.result === "waiting") {
    if (!ctx.intent.file.frontmatter.note) await setStatus(ctx, "verifying", humanNote("outcome.md", "done"));
    return { ok: true };
  }
  if (outcome.result === "fail") {
    return block(ctx, `The change merged but its Done when criteria are not all met: ${outcome.evidence}. Decide whether to open a follow-up intent, then set this one to done or closed.`);
  }

  const lessons = await agentPhase(ctx, { name: "lessons", model: "cheap", permissionMode: "default", tools: "read", vars: { review: a.review, previous: ctx.trace.phases(ctx.slug).filter((p) => p.status === "fail").map((p) => `${p.name}: ${p.error ?? ""}`).join("\n") } });
  const body = (outcomeMd || "# Outcome\n\n## Outcome\nDone.\n\n## Evidence\n(no automated check configured)\n").trimEnd();
  const lessonsMd = lessons.ok
    ? `\n\n## Lessons\n${lessons.envelope.lessons.map((l) => `- ${l}`).join("\n") || "- None recorded."}\n\n## Proposed CLAUDE.md additions\n${lessons.envelope.claude_md_additions.trim() || "None."}\n`
    : `\n\n## Lessons\n- The lessons step did not finish: ${lessons.note}\n`;
  await writeArtifact(ctx, "outcome.md", body + lessonsMd);
  await setStatus(ctx, "done");
  return { ok: true };
}
```

- [ ] **Step 5: Write `src/signals.ts`**

```ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { Git } from "./git";
import { runCommand } from "./shell";
import type { Trace } from "./trace";

/**
 * Runs the test command on the main branch in a clean, temporary worktree.
 * Green after green: nothing. Red after green: opens a draft intent. Red after red: nothing new.
 */
export async function runMainHealth(root: string, cfg: Config, trace: Trace, afterSlug: string | null): Promise<"pass" | "fail" | "error"> {
  const git = new Git(root);
  const wt = join(root, ".loopstra", "worktrees", "_main-health");
  let result: "pass" | "fail" | "error";
  let output = "";
  try {
    if (existsSync(wt)) { await git.worktreeRemove(wt); }
    mkdirSync(join(root, ".loopstra", "worktrees"), { recursive: true });
    await git.run(["worktree", "add", "--detach", wt, cfg.main_branch]);
    if (cfg.commands.install) await runCommand(cfg.commands.install, wt);
    const r = await runCommand(cfg.commands.test, wt);
    result = r.code === 0 ? "pass" : "fail";
    output = r.output.slice(-4000);
  } catch (e) {
    result = "error";
    output = (e as Error).message;
  } finally {
    try { if (existsSync(wt)) await git.worktreeRemove(wt); } catch { rmSync(wt, { recursive: true, force: true }); }
  }
  const previous = trace.signals(1)[0]?.result ?? "pass";
  trace.signal("main_health", result, output);
  if (result === "fail" && previous === "pass") await openFailureIntent(root, git, afterSlug, output);
  return result;
}

async function openFailureIntent(root: string, git: Git, afterSlug: string | null, output: string): Promise<void> {
  const slug = afterSlug ? `fix-tests-after-${afterSlug}` : `fix-tests-on-main-${new Date().toISOString().slice(0, 10)}`;
  const dir = join(root, "intent", slug);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const lastLines = output.trim().split(/\r?\n/).slice(-15).join("\n");
  const what = afterSlug ? `after the change "${afterSlug}" merged` : "on the main branch";
  await Bun.write(join(dir, "intent.md"), `---
status: draft
priority: high
author: loopstra
opened: ${new Date().toISOString().slice(0, 10)}
note: "Opened automatically because the tests on main started failing. Review it and set status to accepted, or closed."
---
# Intent: tests broke ${what}

## Problem
Before this, the tests on main passed. Now they fail. The last lines of the test output were:

\`\`\`
${lastLines}
\`\`\`

## Proposed outcome
The tests on main pass again.

## Done when
- The test command exits successfully on main.

## Affected users and systems
Everyone working on this repository.

## Open questions
Should the change be reverted, or fixed forward?
`);
  await git.commitPaths([`intent/${slug}`], `loopstra(${slug}): open intent for failing tests on main`);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/stages-verify.test.ts tests/unit/signals.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/stages/verify.ts src/signals.ts tests/unit/stages-verify.test.ts tests/unit/signals.test.ts tests/fake-claude/fixtures
git commit -m "feat: verify stage with outcome and lessons, and main_health signal"
```

---

### Task 12: Scheduler and `start --once`

**Files:**
- Create: `src/scheduler.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/loop.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { tempGitRepo } from "../helpers";

const FAKE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TEMPLATES = new URL("../../templates/prompts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("the loop", () => {
  test("drives one intent from accepted to done across ticks, one step per tick, with no remote", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: bun test\n");
    await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
    await Bun.write(join(repo.path, ".gitignore"), ".loopstra/\n");
    mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), "---\nstatus: accepted\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n");
    mkdirSync(join(repo.path, "intent", "later"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "later", "intent.md"), "---\nstatus: draft\n---\n# Intent: later\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await new Git(repo.path).commitAll("setup");
    process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;

    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await tick(repo.path);
      const status = (await readIntent(repo.path, "add-numbers")).file.frontmatter.status;
      seen.push(`${r.picked ?? "-"}:${status}`);
      if (status === "done") break;
    }
    expect(seen).toEqual([
      "add-numbers:spec-review",
      "add-numbers:spec-approved",
      "add-numbers:plan-review",
      "add-numbers:plan-approved",
      "add-numbers:reviewing",
      "add-numbers:merge-review",
      "add-numbers:merged",
      "add-numbers:done",
    ]);
    expect(existsSync(join(repo.path, "src", "add.ts"))).toBe(true);
    expect(existsSync(join(repo.path, "intent", "add-numbers", "outcome.md"))).toBe(true);
    expect(await Bun.file(join(repo.path, "intent", "queue.md")).text()).toContain("add-numbers");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    const idle = await tick(repo.path);
    expect(idle.picked).toBeNull();
    repo.cleanup();
  }, 120_000);

  test("a bad config does not crash a tick", async () => {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\nbogus: true\n");
    const r = await tick(repo.path);
    expect(r.picked).toBeNull();
    expect(r.error).toMatch(/bogus/);
    repo.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/loop.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/scheduler.ts`**

```ts
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { StepContext, block, commitArtifacts, type StepResult } from "./context";
import { Git } from "./git";
import { checkConsistency, isRunnable, orderQueue, renderQueue, scanIntents, type Intent } from "./intents";
import { runMainHealth } from "./signals";
import { runBuildStep } from "./stages/build";
import { runDesignStep } from "./stages/design";
import { runMergeStep } from "./stages/merge";
import { runPlanStep } from "./stages/plan";
import { runReviewStep } from "./stages/review";
import { runVerifyStep } from "./stages/verify";
import { Trace } from "./trace";

export interface TickResult { picked: string | null; result?: StepResult; error?: string; signal?: string }

let lastMainHealth = 0;
let lastMergedSlug: string | null = null;

export async function tick(root: string): Promise<TickResult> {
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch (e) { return { picked: null, error: (e as Error).message }; }
  const trace = Trace.open(root);
  try {
    trace.event("_loop", "tick", {});
    const out: TickResult = { picked: null };

    // Signals: after a merge, or on the interval.
    const due = Date.now() - lastMainHealth > cfg.signals.main_health.every_minutes * 60_000;
    if (lastMergedSlug || due) {
      out.signal = await runMainHealth(root, cfg, trace, lastMergedSlug);
      lastMainHealth = Date.now();
      lastMergedSlug = null;
    }

    // Scan, check, render queue.
    const intents = await scanIntents(root);
    for (const i of intents) {
      trace.upsertIntent(i.slug, i.file.frontmatter.status, i.file.frontmatter.priority);
      const problem = checkConsistency(i);
      if (problem && i.file.frontmatter.status !== "blocked") {
        const ctx = new StepContext(root, cfg, trace, i);
        await block(ctx, problem);
      }
    }
    const ordered = orderQueue(await scanIntents(root));
    await Bun.write(join(root, "intent", "queue.md"), renderQueue(ordered)).catch(() => {});
    await new Git(root).commitPaths(["intent/queue.md"], "loopstra: update queue").catch(() => {});

    // Pick and run one step.
    const human = { spec: cfg.gates.spec.human, plan: cfg.gates.plan.human, merge: cfg.gates.merge.human, done: cfg.gates.done.human };
    const next = ordered.find((i) => isRunnable(i, human));
    if (!next) return out;
    out.picked = next.slug;
    const ctx = new StepContext(root, cfg, trace, next);
    try {
      out.result = await runStep(ctx);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      trace.event(next.slug, "error", { error: msg, stack: (e as Error).stack });
      out.result = await block(ctx, `Something unexpected went wrong: ${msg.split("\n")[0]}. Details are in the trace.`);
    }
    if (ctx.intent.file.frontmatter.status === "merged") lastMergedSlug = ctx.slug;
    return out;
  } finally {
    trace.close();
  }
}

async function runStep(ctx: StepContext): Promise<StepResult> {
  switch (ctx.intent.file.frontmatter.status) {
    case "accepted": case "designing": case "spec-review": return runDesignStep(ctx);
    case "spec-approved": case "planning": case "plan-review": return runPlanStep(ctx);
    case "plan-approved": case "building": return runBuildStep(ctx);
    case "reviewing": return runReviewStep(ctx);
    case "merge-review": return runMergeStep(ctx);
    case "merged": case "verifying": return runVerifyStep(ctx);
    default: return { ok: true };
  }
}

export async function start(root: string, opts: { once: boolean }): Promise<void> {
  const cfg = await loadConfig(root);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; console.log("\nStopping after this step."); });
  do {
    const r = await tick(root);
    if (r.error) console.error(`Config problem, will retry next tick:\n${r.error}`);
    else if (r.picked) console.log(`${new Date().toISOString()} ${r.picked}: ${r.result?.ok ? "step done" : r.result?.note}`);
    else console.log(`${new Date().toISOString()} idle`);
    if (opts.once || stopping) break;
    await Bun.sleep(cfg.poll_seconds * 1000);
  } while (!stopping);
}
```

Note: a `runStep` call for `merge-review` with a human `pr` gate is not reachable because `isRunnable` excludes it; the GitHub polling for that case is added in Plan 3 by making the scheduler poll PR state before the runnable check.

- [ ] **Step 4: Wire `start` into `src/cli.ts`**

Add to the switch:
```ts
    case "start": {
      const { start } = await import("./scheduler");
      const { resolveClaude } = await import("./claude");
      if (!resolveClaude()) { console.error("claude was not found on PATH. Install Claude Code first."); return 1; }
      await start(root, { once: rest.includes("--once") });
      return 0;
    }
```

- [ ] **Step 5: Run the integration test and the full suite**

Run: `bun test && bun run typecheck`
Expected: all PASS, typecheck clean. The loop test takes tens of seconds because each build step runs a real `bun test` in the worktree.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler.ts src/cli.ts tests/integration/loop.test.ts
git commit -m "feat: scheduler tick and start command; end-to-end loop test"
```

---

## Self-review

- **Spec coverage:** §8 steps 1 to 20 map to Tasks 7 to 11 (PR open in step 15 and PR checks in 16 deferred to Plan 3 as the spec's "when a remote exists" branch); §10 git in Task 2; §14 tick in Task 12; §15 errors: phase timeouts and budgets in `phases.ts` (Plan 1), hook command failures block (Task 3/7), tick boundary catch (Task 12). Signals after merge and on interval: Task 12. Consistency check every tick: Task 12. `queue.md` regenerated: Task 12.
- **Type consistency:** `agentPhase` returns `{ok, envelope, sessionId, costUsd}`; `codePhase` returns `{ok, ...T} | {ok:false, note}`; `runChecks` returns `CommandResult | null`; `setStatus(ctx, status, note?)`; `block(ctx, note)`; `evaluateGate(ctx, gate, checks)` returns `GateOutcome`; `StepContext` has `git`, `slug`, `runDir`, `worktreeDir`, `branch`, `reload()`.
- **Placeholders:** none.
