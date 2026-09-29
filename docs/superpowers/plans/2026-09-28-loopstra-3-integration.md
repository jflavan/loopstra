# Loopstra Plan 3: GitHub, Init, Skill, and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish v1: PRs and merge through GitHub when a remote exists, `loopstra init` that stamps a repo with config, prompts, the operator skill, subagents, the test-protection hook, and owner docs; `tail` and `ui` observability; `apply-lessons`; a README.

**Architecture:** Builds on Plans 1 and 2. The `gh` CLI is wrapped the same way `claude` is, behind one module with an executable override so tests use a fake. `init` is pure file stamping from `templates/`. `ui` is one HTML file served by `Bun.serve` with a JSON endpoint over the trace database. Spec: `docs/superpowers/specs/2026-09-28-loopstra-design.md` §8 steps 15-16, §10, §11, §12, §13, §14.

**Tech Stack:** Bun, TypeScript, `gh` CLI, plain HTML and JavaScript for the dashboard.

---

## File structure

| File | Responsibility |
|---|---|
| `src/github.ts` | `gh` wrapper: PR lookup, create, comment, checks, merge |
| `src/stages/review.ts`, `src/stages/merge.ts`, `src/scheduler.ts`, `src/intents.ts` | Remote path: push, open PR, poll PR gate, merge via GitHub, sync local main |
| `src/init.ts`, `templates/**` | Stamping |
| `templates/hooks/loopstra-protect-tests.ts` | The PreToolUse hook |
| `templates/skill/SKILL.md` | Operator skill |
| `templates/agents/verifier.md`, `templates/agents/reviewer.md` | Subagents |
| `templates/REVIEW.md`, `templates/intent-README.md`, `templates/config.yaml` | Policy, owner guide, starter config |
| `src/commands/tail.ts`, `src/commands/ui.ts`, `src/ui/index.html`, `src/commands/apply-lessons.ts` | Observability and lessons |
| `README.md` | Project readme |
| `tests/fake-gh/gh.ts`, `tests/unit/github.test.ts`, `tests/unit/init.test.ts`, `tests/unit/hook.test.ts`, `tests/unit/ui.test.ts`, `tests/unit/apply-lessons.test.ts`, `tests/integration/remote.test.ts` | Tests |

---

### Task 1: GitHub wrapper with a fake `gh`

**Files:**
- Create: `src/github.ts`, `tests/fake-gh/gh.ts`
- Test: `tests/unit/github.test.ts`

The fake `gh` reads `LOOPSTRA_FAKE_GH_STATE` (a JSON file path). The file holds `{ "prs": { "<branch>": { number, state, reviewDecision, checks, merged } } }` and the fake answers `gh pr view`, `gh pr create`, `gh pr comment`, `gh pr checks`, `gh pr merge` by reading and updating it. It appends every invocation to `LOOPSTRA_FAKE_GH_LOG` when set.

- [ ] **Step 1: Write the fake**

`tests/fake-gh/gh.ts`:
```ts
#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";

type Pr = { number: number; state: "OPEN" | "MERGED" | "CLOSED"; reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED"; checks: "pass" | "fail" | "pending"; merged: boolean; title?: string; body?: string; comments: string[] };
type State = { prs: Record<string, Pr>; next: number };

const args = Bun.argv.slice(2);
const statePath = process.env.LOOPSTRA_FAKE_GH_STATE!;
const state: State = existsSync(statePath) ? JSON.parse(await Bun.file(statePath).text()) : { prs: {}, next: 1 };
if (process.env.LOOPSTRA_FAKE_GH_LOG) appendFileSync(process.env.LOOPSTRA_FAKE_GH_LOG, JSON.stringify(args) + "\n");
const save = () => Bun.write(statePath, JSON.stringify(state, null, 2));
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const [group, cmd] = args;
if (group === "--version") { console.log("gh version 2.93.0 (fake)"); process.exit(0); }
if (group !== "pr") { console.error(`fake gh: unsupported ${args.join(" ")}`); process.exit(1); }

if (cmd === "view") {
  const branch = args[2]!;
  const pr = state.prs[branch];
  if (!pr) { console.error("no pull requests found"); process.exit(1); }
  console.log(JSON.stringify({ number: pr.number, state: pr.state, reviewDecision: pr.reviewDecision, mergedAt: pr.merged ? "2026-01-01T00:00:00Z" : null, url: `https://example.test/pr/${pr.number}` }));
} else if (cmd === "create") {
  const branch = flag("--head")!;
  const pr: Pr = { number: state.next++, state: "OPEN", reviewDecision: "", checks: "pending", merged: false, title: flag("--title"), body: flag("--body"), comments: [] };
  state.prs[branch] = pr;
  await save();
  console.log(`https://example.test/pr/${pr.number}`);
} else if (cmd === "comment") {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((p) => p.number === number)!;
  pr.comments.push(flag("--body") ?? "");
  await save();
} else if (cmd === "checks") {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((p) => p.number === number)!;
  const rows = pr.checks === "pending" ? [{ name: "ci", state: "PENDING" }] : [{ name: "ci", state: pr.checks === "pass" ? "SUCCESS" : "FAILURE" }];
  console.log(JSON.stringify(rows));
  process.exit(pr.checks === "pass" ? 0 : pr.checks === "fail" ? 1 : 8);
} else if (cmd === "merge") {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((p) => p.number === number)!;
  pr.state = "MERGED"; pr.merged = true;
  await save();
} else {
  console.error(`fake gh: unsupported ${args.join(" ")}`); process.exit(1);
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GitHub } from "../../src/github";
import { tempDir } from "../helpers";

const FAKE = new URL("../fake-gh/gh.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("GitHub", () => {
  test("create, view, comment, checks, merge against the fake", async () => {
    const t = tempDir();
    const statePath = join(t.path, "gh.json");
    const gh = new GitHub(t.path, { executable: FAKE, env: { LOOPSTRA_FAKE_GH_STATE: statePath } });
    expect(await gh.available()).toBe(true);
    expect(await gh.prForBranch("intent/x")).toBeNull();
    const created = await gh.createPr({ head: "intent/x", base: "main", title: "x: title", body: "body" });
    expect(created.number).toBe(1);
    let pr = await gh.prForBranch("intent/x");
    expect(pr).toMatchObject({ number: 1, state: "OPEN", approved: false, merged: false });
    await gh.comment(1, "findings");
    expect(await gh.checks(1)).toBe("pending");
    const s = JSON.parse(await Bun.file(statePath).text());
    s.prs["intent/x"].checks = "pass"; s.prs["intent/x"].reviewDecision = "APPROVED";
    await Bun.write(statePath, JSON.stringify(s));
    expect(await gh.checks(1)).toBe("pass");
    pr = await gh.prForBranch("intent/x");
    expect(pr?.approved).toBe(true);
    await gh.merge(1, "squash");
    pr = await gh.prForBranch("intent/x");
    expect(pr?.merged).toBe(true);
    t.cleanup();
  });

  test("available is false when gh is missing", async () => {
    const t = tempDir();
    const gh = new GitHub(t.path, { executable: join(t.path, "missing.exe") });
    expect(await gh.available()).toBe(false);
    t.cleanup();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/github.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/github.ts`**

```ts
export const GH_ENV = "LOOPSTRA_GH_EXECUTABLE";

export interface PrInfo { number: number; state: "OPEN" | "MERGED" | "CLOSED"; approved: boolean; merged: boolean; url: string }
export type ChecksState = "pass" | "fail" | "pending";

export class GitHub {
  private readonly exe: string | null;
  private readonly env: Record<string, string>;
  constructor(private readonly cwd: string, opts: { executable?: string; env?: Record<string, string> } = {}) {
    this.exe = opts.executable ?? process.env[GH_ENV] ?? Bun.which("gh");
    this.env = opts.env ?? {};
  }

  private async run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    if (!this.exe) return { code: 127, out: "", err: "gh not found" };
    const cmd = this.exe.endsWith(".ts") ? [process.execPath, this.exe, ...args] : [this.exe, ...args];
    let proc: ReturnType<typeof Bun.spawn>;
    try { proc = Bun.spawn({ cmd, cwd: this.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...this.env } }); }
    catch (e) { return { code: 127, out: "", err: (e as Error).message }; }
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  }

  async available(): Promise<boolean> { return (await this.run(["--version"])).code === 0; }

  async prForBranch(branch: string): Promise<PrInfo | null> {
    const r = await this.run(["pr", "view", branch, "--json", "number,state,reviewDecision,mergedAt,url"]);
    if (r.code !== 0) return null;
    const j = JSON.parse(r.out) as { number: number; state: PrInfo["state"]; reviewDecision: string; mergedAt: string | null; url: string };
    return { number: j.number, state: j.state, approved: j.reviewDecision === "APPROVED", merged: !!j.mergedAt, url: j.url };
  }

  async createPr(p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.run(["pr", "create", "--head", p.head, "--base", p.base, "--title", p.title, "--body", p.body]);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${r.err.trim().split("\n").pop()}`);
    const url = r.out.trim().split("\n").pop() ?? "";
    const pr = await this.prForBranch(p.head);
    return { number: pr?.number ?? Number(url.split("/").pop()), url };
  }

  async comment(number: number, body: string): Promise<void> {
    const r = await this.run(["pr", "comment", String(number), "--body", body]);
    if (r.code !== 0) throw new Error(`gh pr comment failed: ${r.err.trim().split("\n").pop()}`);
  }

  /** gh pr checks exits 0 when all pass, 1 when any fail, 8 when pending. */
  async checks(number: number): Promise<ChecksState> {
    const r = await this.run(["pr", "checks", String(number), "--json", "name,state"]);
    if (r.code === 0) return "pass";
    if (r.code === 8) return "pending";
    if (/no checks reported/i.test(r.err)) return "pass";
    return "fail";
  }

  async merge(number: number, method: "squash" | "merge"): Promise<void> {
    const r = await this.run(["pr", "merge", String(number), method === "squash" ? "--squash" : "--merge", "--delete-branch"]);
    if (r.code !== 0) throw new Error(`gh pr merge failed: ${r.err.trim().split("\n").pop()}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/github.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/github.ts tests/fake-gh tests/unit/github.test.ts
git commit -m "feat: github wrapper over gh with a fake for tests"
```

---

### Task 2: Remote path in review, merge, and scheduler

**Files:**
- Modify: `src/stages/review.ts`, `src/stages/merge.ts`, `src/scheduler.ts`, `src/intents.ts`, `tests/unit/intents-queue.test.ts`
- Test: `tests/integration/remote.test.ts`

Behavior to add:

1. `src/intents.ts` `isRunnable`: `merge-review` is runnable when `merge` human is `none` or `pr` (the merge step polls); not runnable when `status`. Update the test in `tests/unit/intents-queue.test.ts`: the `merge-review` with `pr` expectation becomes `true`; add `expect(isRunnable(with_("merge-review"), { spec: "none", plan: "none", merge: "status", done: "none" })).toBe(false);`.
2. `src/stages/review.ts`: after the rounds and `after` commands, if `await ctx.git.hasRemote()`: push the branch (`new Git(ctx.worktreeDir).push(ctx.branch)`), then if no PR exists create one with title `${ctx.slug}: ${ctx.intent.file.title}` and body listing links to `intent/<slug>/intent.md`, `spec.md`, `plan.md`, `review.md` and the review summary, then post the findings as a comment. Record the PR number in `ctx.trace.event(slug, "command", { command: "pr", number, url })`. Then `setStatus(ctx, "merge-review", note)` where note is empty unless `gates.merge.human === "pr"`, then `"A pull request is open. Approve it on GitHub to merge, or close it to stop."`.
3. `src/stages/merge.ts`: when a remote exists, replace the local checks with: `up-to-date` (same), `pr-checks` (`gh.checks(pr.number)`: pass → pass, pending → waiting, fail → fail), `pr-approved` only when `gates.merge.human === "pr"` (approved → pass, else waiting), `findings` (same). On pass: `gh.merge(pr.number, method)`, then in the root `git fetch` and `git pull --ff-only` on main (`ctx.git.run(["pull", "--ff-only"])`), remove the worktree, delete the local branch if it still exists. If the PR is closed without merge → block with "The pull request was closed without merging. Set status to closed, or to plan-approved to rebuild."
4. `src/scheduler.ts` `start`: preflight. Refuse to start unless the root checkout is on `cfg.main_branch` (message: "Run loopstra from a checkout of <main_branch>; you are on <branch>."). If a remote exists and `gh` is unavailable, refuse with "This repo has a remote but gh was not found. Install GitHub CLI or remove the remote."
5. `GitHub` construction: `new GitHub(ctx.root)` uses `LOOPSTRA_GH_EXECUTABLE` when set, so the integration test can inject the fake through the environment, the same way `LOOPSTRA_CLAUDE_EXECUTABLE` works. The fake's state path comes from `LOOPSTRA_FAKE_GH_STATE` in the process environment, which `GitHub.run` passes through because it spreads `process.env`.

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { run, tempDir, tempGitRepo } from "../helpers";

const FAKE_CLAUDE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FAKE_GH = new URL("../fake-gh/gh.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TEMPLATES = new URL("../../templates/prompts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("the loop with a remote", () => {
  test("opens a PR, waits for checks, merges through gh, and syncs local main", async () => {
    const remote = tempDir("loopstra-remote-");
    await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
    const repo = await tempGitRepo();
    await run(["git", "remote", "add", "origin", remote.path], repo.path);
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: bun test\ngates:\n  merge:\n    human: pr\n");
    await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
    await Bun.write(join(repo.path, ".gitignore"), ".loopstra/\n");
    mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), "---\nstatus: plan-approved\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n");
    await Bun.write(join(repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
    await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n");
    await new Git(repo.path).commitAll("setup");
    await run(["git", "push", "-q", "-u", "origin", "main"], repo.path);
    const ghState = join(repo.path, ".loopstra-gh-state.json");
    process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE_CLAUDE;
    process.env.LOOPSTRA_GH_EXECUTABLE = FAKE_GH;
    process.env.LOOPSTRA_FAKE_GH_STATE = ghState;

    await tick(repo.path); // build → reviewing
    await tick(repo.path); // review → merge-review with PR
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merge-review");
    expect(i.file.frontmatter.note).toContain("pull request");
    let s = JSON.parse(await Bun.file(ghState).text());
    expect(s.prs["intent/add-numbers"].title).toBe("add-numbers: add numbers");
    expect(s.prs["intent/add-numbers"].comments.length).toBe(1);

    await tick(repo.path); // checks pending → waiting
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merge-review");

    s.prs["intent/add-numbers"].checks = "pass";
    await Bun.write(ghState, JSON.stringify(s));
    await tick(repo.path); // approval missing → waiting
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("merge-review");

    s.prs["intent/add-numbers"].reviewDecision = "APPROVED";
    await Bun.write(ghState, JSON.stringify(s));
    // Simulate GitHub merging into the remote main so the local pull has something to fetch.
    await run(["git", "push", "-q", "origin", "intent/add-numbers:main"], repo.path);
    await tick(repo.path); // merged
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merged");
    s = JSON.parse(await Bun.file(ghState).text());
    expect(s.prs["intent/add-numbers"].merged).toBe(true);
    const log = await new Git(repo.path).log(3);
    expect(log.join("\n")).toContain("feat: add function");

    delete process.env.LOOPSTRA_GH_EXECUTABLE; delete process.env.LOOPSTRA_FAKE_GH_STATE;
    repo.cleanup(); remote.cleanup();
  }, 120_000);
});
```

Note: the fake `gh pr merge` does not touch git, so the test pushes the branch into the bare remote's `main` itself before the merging tick. The merge step's `git pull --ff-only` then brings it into the local main. The `merged` status change is committed on top and pushed.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/remote.test.ts`
Expected: FAIL (no PR is created; status is merged locally instead).

- [ ] **Step 3: Implement the five behaviors listed above**

In `src/stages/review.ts` after the `after` commands:
```ts
  let note = "";
  if (await ctx.git.hasRemote()) {
    const pr = await codePhase(ctx, "pull-request", async () => {
      await wt.push(ctx.branch);
      const gh = new GitHub(ctx.root);
      let existing = await gh.prForBranch(ctx.branch);
      if (!existing) {
        const title = `${ctx.slug}: ${ctx.intent.file.title || ctx.slug}`;
        const body = [
          `Loopstra change \`${ctx.slug}\`.`, "",
          `- Intent: \`intent/${ctx.slug}/intent.md\``, `- Spec: \`intent/${ctx.slug}/spec.md\``, `- Plan: \`intent/${ctx.slug}/plan.md\``, `- Review: \`intent/${ctx.slug}/review.md\``, "",
          "## Review summary", lastSummary,
        ].join("\n");
        const created = await gh.createPr({ head: ctx.branch, base: ctx.cfg.main_branch, title, body });
        await gh.comment(created.number, lastReviewMarkdown);
        existing = await gh.prForBranch(ctx.branch);
      }
      ctx.trace.event(ctx.slug, "command", { command: "pr", number: existing?.number, url: existing?.url });
      return { ok: true as const };
    });
    if (!pr.ok) return block(ctx, `Could not open the pull request. ${pr.note}`);
    if (ctx.cfg.gates.merge.human === "pr") note = "A pull request is open. Approve it on GitHub to merge, or close it to stop.";
  }
  await setStatus(ctx, "merge-review", note);
```
Keep `lastSummary` and `lastReviewMarkdown` from the last successful review envelope inside the round loop.

In `src/stages/merge.ts`, build the checks list depending on `await ctx.git.hasRemote()` as described, and perform the merge via `gh` then `ctx.git.run(["pull", "--ff-only"])` (wrap `fetch` first). Keep the local path unchanged.

In `src/scheduler.ts` `start`, add the preflight before the loop:
```ts
  const git = new Git(root);
  const branch = await git.currentBranch();
  if (branch !== cfg.main_branch) throw new Error(`Run loopstra from a checkout of ${cfg.main_branch}; you are on ${branch}.`);
  if (await git.hasRemote() && !(await new GitHub(root).available())) throw new Error("This repo has a remote but gh was not found. Install GitHub CLI or remove the remote.");
```
and in `src/cli.ts` catch the error, print its message, and return 1.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: pull requests and merge through GitHub when a remote exists"
```

---

### Task 3: `loopstra init` and templates

**Files:**
- Create: `src/init.ts`, `templates/config.yaml`, `templates/REVIEW.md`, `templates/intent-README.md`, `templates/agents/verifier.md`, `templates/agents/reviewer.md`, `templates/hooks/loopstra-protect-tests.ts`, `templates/skill/SKILL.md`
- Modify: `src/cli.ts`
- Test: `tests/unit/init.test.ts`, `tests/unit/hook.test.ts`

- [ ] **Step 1: Write the templates**

`templates/config.yaml`:
```yaml
# Loopstra configuration. Engineers edit this; product owners never need to.
# Every key except commands.test has a default. Unknown keys are errors.
version: 1
main_branch: main
poll_seconds: 60

commands:
  # The single command that runs your tests and exits non-zero on failure.
  test: __TEST__
  # Optional. Leave a key out if you do not have it.
__INSTALL__
__LINT__
__BUILD__
__RUN__

claude:
  models:
    default: sonnet
    cheap: haiku
    strong: opus
  timeout_minutes: 30
  max_budget_usd: 5

# Gates between stages. human: status (a person edits the status line) | pr (GitHub approval) | none.
# agent: true runs an independent reviewer with a fresh context.
gates:
  intent: { human: status }
  spec:   { human: none, agent: true }
  plan:   { human: none, agent: true }
  merge:  { human: none, method: squash }
  done:   { human: none, agent: true }

# Per-stage model, skills to load, and deterministic commands to run before and after.
stages:
  design: { model: strong,  skills: [], before: [], after: [] }
  plan:   { model: strong,  skills: [], before: [], after: [] }
  build:  { model: default, skills: [], before: [], after: [], max_fix_loops: 3 }
  review: { model: strong,  skills: [], before: [], after: [], max_rounds: 2 }
  verify: { model: cheap,   skills: [], before: [], after: [] }

signals:
  main_health: { every_minutes: 30 }
```

`templates/REVIEW.md`:
```markdown
# Review instructions

Loopstra's reviewer and any Claude review of this repository follow these rules.

## Passes
- Bugs: logic errors, broken edge cases, subtle regressions.
- Security: injection risks, authentication gaps, secrets or PII in logs.
- Compliance: the change matches `spec.md` and `plan.md` for its intent, and the repository's conventions in `CLAUDE.md`.

## What Important means here
Reserve `important` for findings that break behavior, leak data, breach policy, or contradict the spec or plan. Style and naming are nits.

## Cap the nits
Report at most five nits per review; summarize the rest as a count.

## Do not report
Generated files, lockfiles, and anything CI already enforces.
```

`templates/intent-README.md`:
```markdown
# Intents

This folder is the queue of changes for this repository. Each change is a folder with a plain name, for example `claims-status-self-service/`, holding one file you write and a few the system writes.

## To ask for a change

1. Make a folder with a short name in lowercase words joined by hyphens.
2. Copy the template below into `intent.md` inside it, and fill it in with your own words.
3. When you are ready, change `status: draft` to `status: accepted` and save.

The system takes it from there. Check `queue.md` in this folder to see where every change is.

## When the system needs you

The `status` line and the `note` line at the top of `intent.md` tell you what to do. For example `status: spec-review` with a note asking you to read `spec.md`. Change the status line as the note says. To stop a change at any point, set `status: closed`.

If a change says `status: blocked`, the note explains why in plain language and what to do next.

## Template

```markdown
---
status: draft
priority: normal
author: Your name
opened: 2026-01-01
note: ""
---
# Intent: a short title

## Problem
What is wrong or missing today, and for whom.

## Proposed outcome
What should be true when this is done.

## Done when
- A short list of things someone could check to confirm it is done.

## Affected users and systems
Who and what this touches.

## Constraints
Anything that must not change, or rules this has to follow.

## Open questions
Anything you are unsure about.
```

Priority is one of `low`, `normal`, `high`, `urgent`.
```

`templates/agents/verifier.md`:
```markdown
---
name: verifier
description: Runs the app and checks a change works before the session reports done. Reports only; never fixes.
tools: Bash, Read, Glob, Grep
---
You verify changes with a fresh context. Start the app if a run command is given, exercise the changed behavior and the flows next to it, and report exactly what you tried and what happened. Do not modify any files. Do not fix problems; describe them precisely so the builder can.
```

`templates/agents/reviewer.md`:
```markdown
---
name: reviewer
description: Reviews a branch against REVIEW.md, spec.md, and plan.md with a fresh context. Reports ranked findings; never edits.
tools: Read, Glob, Grep, Bash(git *)
---
You review code you did not write. Follow the repository's `REVIEW.md` for passes and severity. Read the diff of this branch against the main branch and the surrounding code. Rank findings by severity, quote file and line, and keep nits capped. Do not modify any files.
```

`templates/hooks/loopstra-protect-tests.ts`:
```ts
#!/usr/bin/env bun
// Claude Code PreToolUse hook. During a Loopstra fix phase, block edits to test files.
// Input: JSON on stdin with tool_name and tool_input. Exit 2 blocks the action and sends stderr to Claude.
const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { file_path?: string; path?: string } };
if (process.env.LOOPSTRA_PHASE !== "fix") process.exit(0);
const path = (input.tool_input?.file_path ?? input.tool_input?.path ?? "").replace(/\\/g, "/");
const isTest = /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
if (isTest) {
  console.error(`Loopstra: test files are protected during a fix phase. Fix the code, not the test (${path}).`);
  process.exit(2);
}
process.exit(0);
```

`templates/skill/SKILL.md`:
```markdown
---
name: loopstra
description: Operate the Loopstra development loop in this repo. Use when asked to set up or onboard Loopstra, draft an intent, check loop status, unblock a change, tune stages or gates, or apply lessons to CLAUDE.md. Never runs the loop itself.
---

# Loopstra operator

Loopstra is an unattended development loop. A Bun runtime (`loopstra start`) owns the loop; Claude Code sessions do bounded work inside it. You are the operator console: you help people set it up, feed it, read it, and unblock it. You never run stages by hand and never run `loopstra start`.

Files that matter: `loopstra/config.yaml` (engineer settings), `loopstra/prompts/*.md` (one prompt per phase), `intent/<slug>/` (one folder per change: `intent.md`, `spec.md`, `plan.md`, `review.md`, `outcome.md`), `intent/queue.md` (generated), `.loopstra/` (runtime state and trace, gitignored).

## Onboard
1. Run `loopstra init` and read what it printed.
2. Open `loopstra/config.yaml`. Confirm `commands.test` is the one command that runs the tests and exits non-zero on failure; add `install`, `lint`, `build`, `run` if the repo has them.
3. Ask which gates should have a person: intent (default yes), spec, plan, merge, done. Set `human: status` or `human: pr` accordingly.
4. Ask which skills in `.claude/skills/` each stage should load and list them under `stages.<stage>.skills`.
5. Read `CLAUDE.md`; make sure its Commands block matches the config.
6. Tell them to start the loop in a terminal with `loopstra start` and to watch it with `loopstra status` or `loopstra ui`.

## Draft an intent
Interview the person in plain language: what is wrong today and for whom, what should be true when it is done, how they would check it is done, who and what it touches, any constraints, and open questions. Write `intent/<slug>/intent.md` from the template in `intent/README.md` with a short hyphenated slug they agree to. Leave `status: draft`. Tell them to set `accepted` when they are ready. Do not design or plan anything.

## Status
Run `loopstra status`. Explain each row in one sentence: what the change is, where it is, and whether anyone needs to do anything. For a blocked change, read its note aloud and offer the options below.

## Unblock
Read the `note` in the change's `intent.md`. Explain the choices: retry from the last approved state (set `status` to the value in `resume_from`), fix something first and then retry, or `closed`. Make the edit only when the person says which. For details, read `.loopstra/runs/<slug>/events.jsonl` or the phase folders under `.loopstra/runs/<slug>/phases/`.

## Tune
Edit `loopstra/prompts/<phase>.md` or `loopstra/config.yaml`. Changes take effect on the next tick. Keep prompts short and explicit; keep gate defaults deterministic.

## Apply lessons
Run `loopstra apply-lessons <slug>` to copy the proposed CLAUDE.md additions from that change's `outcome.md` into `CLAUDE.md` under a Lessons heading, then show the diff for review.
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/init.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { tempDir } from "../helpers";

describe("init", () => {
  test("stamps a bun repo with detected commands and all files, and merges settings.json", async () => {
    const t = tempDir();
    await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test", lint: "eslint .", build: "tsc", start: "bun run src/main.ts" } }));
    mkdirSync(join(t.path, ".claude"), { recursive: true });
    await Bun.write(join(t.path, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
    await Bun.write(join(t.path, "CLAUDE.md"), "# Project\n\nNotes.\n");
    const report = await init(t.path);
    expect(report.written).toContain("loopstra/config.yaml");
    const cfg = await loadConfig(t.path);
    expect(cfg.commands.test).toBe("bun test");
    expect(cfg.commands.install).toBe("bun install");
    expect(cfg.commands.lint).toBe("bun run lint");
    expect(cfg.commands.build).toBe("bun run build");
    expect(cfg.commands.run).toBe("bun run start");
    for (const f of ["loopstra/prompts/build.md", "intent/README.md", "intent/queue.md", "REVIEW.md", ".claude/agents/verifier.md", ".claude/agents/reviewer.md", ".claude/skills/loopstra/SKILL.md", ".claude/hooks/loopstra-protect-tests.ts"]) {
      expect(existsSync(join(t.path, f))).toBe(true);
    }
    const settings = JSON.parse(await Bun.file(join(t.path, ".claude", "settings.json")).text());
    expect(settings.permissions.allow).toEqual(["Bash(git *)"]);
    expect(settings.hooks.PreToolUse.length).toBe(2);
    expect(JSON.stringify(settings.hooks.PreToolUse[1])).toContain("loopstra-protect-tests");
    const claude = await Bun.file(join(t.path, "CLAUDE.md")).text();
    expect(claude).toContain("## Commands");
    expect(claude).toContain("bun test");
    expect(await Bun.file(join(t.path, ".gitignore")).text()).toContain(".loopstra/");
    t.cleanup();
  });

  test("is idempotent and never overwrites without --force", async () => {
    const t = tempDir();
    await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
    await init(t.path);
    await Bun.write(join(t.path, "loopstra", "prompts", "build.md"), "custom");
    const second = await init(t.path);
    expect(second.written).not.toContain("loopstra/prompts/build.md");
    expect(second.skipped).toContain("loopstra/prompts/build.md");
    expect(await Bun.file(join(t.path, "loopstra", "prompts", "build.md")).text()).toBe("custom");
    const settings = JSON.parse(await Bun.file(join(t.path, ".claude", "settings.json")).text());
    expect(settings.hooks.PreToolUse.length).toBe(1);
    await init(t.path, { force: true });
    expect(await Bun.file(join(t.path, "loopstra", "prompts", "build.md")).text()).not.toBe("custom");
    t.cleanup();
  });

  test("with no detectable test command, leaves a placeholder that loadConfig rejects", async () => {
    const t = tempDir();
    const report = await init(t.path);
    expect(report.warnings.join(" ")).toMatch(/commands\.test/);
    await expect(loadConfig(t.path)).rejects.toThrow(/commands\.test/);
    t.cleanup();
  });
});
```

`tests/unit/hook.test.ts`:
```ts
import { describe, expect, test } from "bun:test";

const HOOK = new URL("../../templates/hooks/loopstra-protect-tests.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function runHook(input: object, env: Record<string, string>): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn({ cmd: [process.execPath, HOOK], stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  proc.stdin.write(JSON.stringify(input)); proc.stdin.end();
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err };
}

describe("protect-tests hook", () => {
  test("blocks test file edits during fix, allows otherwise", async () => {
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "C:\\repo\\tests\\a.test.ts" } }, { LOOPSTRA_PHASE: "fix" })).code).toBe(2);
    expect((await runHook({ tool_name: "Write", tool_input: { file_path: "/repo/src/__tests__/a.ts" } }, { LOOPSTRA_PHASE: "fix" })).code).toBe(2);
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } }, { LOOPSTRA_PHASE: "fix" })).code).toBe(0);
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/a.test.ts" } }, { LOOPSTRA_PHASE: "build" })).code).toBe(0);
    const blocked = await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/a.test.ts" } }, { LOOPSTRA_PHASE: "fix" });
    expect(blocked.err).toContain("protected");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/init.test.ts tests/unit/hook.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write `src/init.ts`**

```ts
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const TEMPLATES = join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "templates");

export interface InitReport { written: string[]; skipped: string[]; warnings: string[]; next: string[] }

interface Detected { test?: string; install?: string; lint?: string; build?: string; run?: string }

export async function detectCommands(root: string): Promise<Detected> {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await Bun.file(pkgPath).text()) as { scripts?: Record<string, string> };
    const s = pkg.scripts ?? {};
    const bun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) || /\bbun\b/.test(Object.values(s).join(" "));
    const runner = bun ? "bun run" : "npm run";
    const d: Detected = { install: bun ? "bun install" : "npm install" };
    if (s.test) d.test = bun ? (s.test === "bun test" ? "bun test" : `${runner} test`) : "npm test";
    if (s.lint) d.lint = `${runner} lint`;
    if (s.build) d.build = `${runner} build`;
    if (s.start) d.run = `${runner} start`;
    else if (s.dev) d.run = `${runner} dev`;
    return d;
  }
  if (existsSync(join(root, "Makefile"))) {
    const mk = await Bun.file(join(root, "Makefile")).text();
    const has = (t: string) => new RegExp(`^${t}:`, "m").test(mk);
    return { test: has("test") ? "make test" : undefined, lint: has("lint") ? "make lint" : undefined, build: has("build") ? "make build" : undefined, run: has("run") ? "make run" : undefined };
  }
  if (existsSync(join(root, "pyproject.toml"))) return { test: "pytest", install: existsSync(join(root, "uv.lock")) ? "uv sync" : undefined };
  if (existsSync(join(root, "Cargo.toml"))) return { test: "cargo test", build: "cargo build" };
  if (existsSync(join(root, "go.mod"))) return { test: "go test ./...", build: "go build ./..." };
  return {};
}

async function stamp(root: string, rel: string, content: string, report: InitReport, force: boolean): Promise<void> {
  const target = join(root, rel);
  if (existsSync(target) && !force) { report.skipped.push(rel); return; }
  mkdirSync(dirname(target), { recursive: true });
  await Bun.write(target, content);
  report.written.push(rel);
}

export async function init(root: string, opts: { force?: boolean } = {}): Promise<InitReport> {
  const force = !!opts.force;
  const report: InitReport = { written: [], skipped: [], warnings: [], next: [] };
  const d = await detectCommands(root);

  // Config with detected commands.
  let cfg = await Bun.file(join(TEMPLATES, "config.yaml")).text();
  const line = (key: keyof Detected) => (d[key] ? `  ${key}: ${d[key]}` : `  # ${key}: `);
  cfg = cfg.replace("__TEST__", d.test ?? "").replace("__INSTALL__", line("install")).replace("__LINT__", line("lint")).replace("__BUILD__", line("build")).replace("__RUN__", line("run"));
  if (!d.test) report.warnings.push("No test command was detected. Set commands.test in loopstra/config.yaml before starting the loop.");
  await stamp(root, "loopstra/config.yaml", cfg, report, force);

  for (const name of readdirSync(join(TEMPLATES, "prompts"))) {
    await stamp(root, `loopstra/prompts/${name}`, await Bun.file(join(TEMPLATES, "prompts", name)).text(), report, force);
  }
  await stamp(root, "intent/README.md", await Bun.file(join(TEMPLATES, "intent-README.md")).text(), report, force);
  await stamp(root, "intent/queue.md", "# Queue\n\nGenerated by Loopstra on every pass. Nothing has run yet.\n", report, force);
  await stamp(root, "REVIEW.md", await Bun.file(join(TEMPLATES, "REVIEW.md")).text(), report, force);
  await stamp(root, ".claude/agents/verifier.md", await Bun.file(join(TEMPLATES, "agents", "verifier.md")).text(), report, force);
  await stamp(root, ".claude/agents/reviewer.md", await Bun.file(join(TEMPLATES, "agents", "reviewer.md")).text(), report, force);
  await stamp(root, ".claude/skills/loopstra/SKILL.md", await Bun.file(join(TEMPLATES, "skill", "SKILL.md")).text(), report, force);
  await stamp(root, ".claude/hooks/loopstra-protect-tests.ts", await Bun.file(join(TEMPLATES, "hooks", "loopstra-protect-tests.ts")).text(), report, force);

  await mergeSettings(root, report);
  await ensureClaudeMd(root, d, report);
  await ensureGitignore(root, report);

  report.next.push("Open loopstra/config.yaml and confirm commands.test.", "Decide which gates get a person (gates.*.human).", "Start the loop with `loopstra start`; watch it with `loopstra status` or `loopstra ui`.");
  return report;
}

const HOOK_COMMAND = 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/loopstra-protect-tests.ts"';

async function mergeSettings(root: string, report: InitReport): Promise<void> {
  const path = join(root, ".claude", "settings.json");
  const settings = existsSync(path) ? (JSON.parse(await Bun.file(path).text()) as Record<string, unknown>) : {};
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  const pre = hooks.PreToolUse ?? [];
  if (pre.some((h) => JSON.stringify(h).includes("loopstra-protect-tests"))) { report.skipped.push(".claude/settings.json (hook present)"); return; }
  pre.push({ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  hooks.PreToolUse = pre;
  settings.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
  report.written.push(".claude/settings.json (hook added)");
}

async function ensureClaudeMd(root: string, d: Detected, report: InitReport): Promise<void> {
  const path = join(root, "CLAUDE.md");
  const existing = existsSync(path) ? await Bun.file(path).text() : "";
  if (/^##\s+Commands/m.test(existing)) { report.skipped.push("CLAUDE.md (Commands present)"); return; }
  const lines = [
    "## Commands", "",
    `- Test: \`${d.test ?? "<set commands.test in loopstra/config.yaml>"}\` (must exit 0; never skip or delete a failing test)`,
    d.lint ? `- Lint: \`${d.lint}\`` : null, d.build ? `- Build: \`${d.build}\`` : null, d.run ? `- Run: \`${d.run}\`` : null, "",
    "Run the test command before reporting any task complete, and show the output. If a test fails, fix the code, not the test.", "",
    "## Loopstra", "",
    "This repo runs Loopstra. Changes are described in `intent/<slug>/intent.md` and flow through spec, plan, build, review, and merge on branch `intent/<slug>`. Follow `REVIEW.md` when reviewing.", "",
  ].filter((l): l is string => l !== null).join("\n");
  await Bun.write(path, (existing ? existing.trimEnd() + "\n\n" : "# Project\n\n") + lines);
  report.written.push(existing ? "CLAUDE.md (Commands added)" : "CLAUDE.md");
}

async function ensureGitignore(root: string, report: InitReport): Promise<void> {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? await Bun.file(path).text() : "";
  if (/^\.loopstra\/?$/m.test(existing)) { report.skipped.push(".gitignore"); return; }
  await Bun.write(path, (existing ? existing.trimEnd() + "\n" : "") + ".loopstra/\n");
  report.written.push(".gitignore (.loopstra/ added)");
}
```

Wire into `src/cli.ts`:
```ts
    case "init": {
      const { init } = await import("./init");
      const r = await init(root, { force: rest.includes("--force") });
      for (const w of r.written) console.log(`wrote    ${w}`);
      for (const s of r.skipped) console.log(`kept     ${s}`);
      for (const w of r.warnings) console.log(`warning  ${w}`);
      console.log("\nNext:"); for (const n of r.next) console.log(`- ${n}`);
      return 0;
    }
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/unit/init.test.ts tests/unit/hook.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/init.ts src/cli.ts templates tests/unit/init.test.ts tests/unit/hook.test.ts
git commit -m "feat: loopstra init with templates, skill, subagents, and test-protection hook"
```

---

### Task 4: `tail`, `ui`, and `apply-lessons`

**Files:**
- Create: `src/commands/tail.ts`, `src/commands/ui.ts`, `src/ui/index.html`, `src/commands/apply-lessons.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/ui.test.ts`, `tests/unit/apply-lessons.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/unit/ui.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildState } from "../../src/commands/ui";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("ui state", () => {
  test("assembles intents, phases, gates, signals, and recent events", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "one"), { recursive: true });
    await Bun.write(join(t.path, "intent", "one", "intent.md"), "---\nstatus: building\npriority: high\n---\n# Intent: one\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    const trace = Trace.open(t.path);
    trace.upsertIntent("one", "building", "high");
    const seq = trace.phaseStart("one", "build", "agent");
    trace.phaseEnd("one", seq, { status: "success", costUsd: 0.3 });
    trace.gate("one", "plan", "headings", "pass", "ok");
    trace.signal("main_health", "pass", "");
    trace.close();
    const s = await buildState(t.path, 0);
    expect(s.intents[0]).toMatchObject({ slug: "one", status: "building", plain: "building and testing", costUsd: 0.3 });
    expect(s.intents[0]?.phases[0]).toMatchObject({ name: "build", status: "success" });
    expect(s.intents[0]?.gates[0]).toMatchObject({ gate: "plan", check: "headings", result: "pass" });
    expect(s.signals[0]?.name).toBe("main_health");
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.lastEventId).toBeGreaterThan(0);
    t.cleanup();
  });
});
```

`tests/unit/apply-lessons.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyLessons } from "../../src/commands/apply-lessons";
import { tempDir } from "../helpers";

describe("applyLessons", () => {
  test("appends the proposed additions to CLAUDE.md under a Lessons heading once", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "one"), { recursive: true });
    await Bun.write(join(t.path, "intent", "one", "outcome.md"), "# Outcome\n\n## Evidence\n- x\n\n## Lessons\n- l\n\n## Proposed CLAUDE.md additions\n- Exported functions get a doc comment.\n- Never log tokens.\n");
    await Bun.write(join(t.path, "CLAUDE.md"), "# Project\n");
    const r = await applyLessons(t.path, "one");
    expect(r.added).toEqual(["- Exported functions get a doc comment.", "- Never log tokens."]);
    const text = await Bun.file(join(t.path, "CLAUDE.md")).text();
    expect(text).toContain("## Lessons");
    expect(text).toContain("Never log tokens");
    const again = await applyLessons(t.path, "one");
    expect(again.added).toEqual([]);
    expect((await Bun.file(join(t.path, "CLAUDE.md")).text()).match(/Never log tokens/g)?.length).toBe(1);
    t.cleanup();
  });

  test("reports when there is nothing to apply", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "intent", "one"), { recursive: true });
    await Bun.write(join(t.path, "intent", "one", "outcome.md"), "# Outcome\n\n## Proposed CLAUDE.md additions\nNone.\n");
    const r = await applyLessons(t.path, "one");
    expect(r.added).toEqual([]);
    t.cleanup();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/ui.test.ts tests/unit/apply-lessons.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/tail.ts`**

```ts
import { Trace } from "../trace";

export async function tail(root: string, slug?: string): Promise<never> {
  let last = 0;
  const trace = Trace.open(root);
  const initial = slug ? trace.events(slug, 0, 50) : trace.recentEvents(0, 50);
  for (const e of initial) { print(e); last = e.id; }
  for (;;) {
    await Bun.sleep(1000);
    const rows = slug ? trace.events(slug, last) : trace.recentEvents(last, 500);
    for (const e of rows) { print(e); last = Math.max(last, e.id); }
  }
}

function print(e: { ts: string; slug: string; phase_seq: number | null; type: string; payload: string }): void {
  const payload = JSON.parse(e.payload) as Record<string, unknown>;
  const detail = Object.entries(payload).filter(([k]) => k !== "stack").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ").slice(0, 200);
  console.log(`${e.ts.slice(11, 19)} ${e.slug.padEnd(24)} ${e.type.padEnd(13)} ${detail}`);
}
```

- [ ] **Step 4: Write `src/commands/ui.ts`**

```ts
import { dirname, join } from "node:path";
import { orderQueue, plainStatus, scanIntents } from "../intents";
import { Trace } from "../trace";

export interface UiState {
  generatedAt: string;
  intents: Array<{ slug: string; title: string; status: string; plain: string; priority: string; note: string; costUsd: number; phases: unknown[]; gates: unknown[] }>;
  signals: unknown[];
  events: unknown[];
  lastEventId: number;
}

export async function buildState(root: string, afterEventId: number): Promise<UiState> {
  const trace = Trace.open(root);
  try {
    const intents = orderQueue(await scanIntents(root)).map((i) => {
      const s = trace.intentSummary(i.slug);
      return {
        slug: i.slug, title: i.file.title, status: i.file.frontmatter.status, plain: plainStatus(i.file.frontmatter.status),
        priority: i.file.frontmatter.priority, note: i.file.frontmatter.note, costUsd: s?.costUsd ?? 0,
        phases: trace.phases(i.slug), gates: trace.gates(i.slug),
      };
    });
    const events = trace.recentEvents(afterEventId, 200).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
    const lastEventId = events.length ? Math.max(...events.map((e) => e.id)) : afterEventId;
    return { generatedAt: new Date().toISOString(), intents, signals: trace.signals(20), events, lastEventId };
  } finally {
    trace.close();
  }
}

export function serveUi(root: string, port = 4646): ReturnType<typeof Bun.serve> {
  const html = Bun.file(join(dirname(Bun.fileURLToPath(import.meta.url)), "..", "ui", "index.html"));
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/state") {
        const after = Number(url.searchParams.get("after") ?? 0);
        return Response.json(await buildState(root, after));
      }
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
}
```

- [ ] **Step 5: Write `src/ui/index.html`**

```html
<!doctype html>
<meta charset="utf-8">
<title>Loopstra</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
  body { margin: 0; padding: 16px; max-width: 1200px; margin-inline: auto; }
  h1 { font-size: 18px; margin: 0 0 12px; } h2 { font-size: 15px; margin: 20px 0 8px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8884; vertical-align: top; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #8883; font-size: 12px; }
  .fail { background: #e5484d33; } .pass, .success { background: #30a46c33; } .waiting, .running { background: #ffb22433; }
  .muted { opacity: .7; } details { margin: 4px 0; } pre { white-space: pre-wrap; margin: 0; font-size: 12px; }
  #events { max-height: 320px; overflow: auto; font-family: ui-monospace, monospace; font-size: 12px; }
</style>
<h1>Loopstra <span id="ts" class="muted"></span></h1>
<h2>Changes</h2>
<table><thead><tr><th>Change</th><th>Priority</th><th>Where it is</th><th>Cost</th><th>Note</th></tr></thead><tbody id="intents"></tbody></table>
<h2>Details</h2>
<div id="details"></div>
<h2>Main health</h2>
<div id="signals"></div>
<h2>Recent events</h2>
<div id="events"></div>
<script>
  let after = 0; const seen = [];
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  async function refresh() {
    const s = await (await fetch(`/api/state?after=${after}`)).json();
    document.getElementById("ts").textContent = new Date(s.generatedAt).toLocaleTimeString();
    document.getElementById("intents").innerHTML = s.intents.map((i) =>
      `<tr><td><b>${esc(i.slug)}</b><br><span class="muted">${esc(i.title)}</span></td><td>${esc(i.priority)}</td><td><span class="tag ${i.status === "blocked" ? "fail" : ""}">${esc(i.plain)}</span></td><td>$${i.costUsd.toFixed(2)}</td><td>${esc(i.note)}</td></tr>`).join("");
    document.getElementById("details").innerHTML = s.intents.filter((i) => i.phases.length).map((i) =>
      `<details><summary><b>${esc(i.slug)}</b> · ${i.phases.length} phases · ${i.gates.length} gate checks</summary>
       <table><tr><th>#</th><th>Phase</th><th>Kind</th><th>Status</th><th>Started</th><th>Cost</th><th>Error</th></tr>
       ${i.phases.map((p) => `<tr><td>${p.seq}</td><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td><span class="tag ${esc(p.status)}">${esc(p.status)}</span></td><td class="muted">${esc(p.started.slice(11, 19))}</td><td>$${(p.cost_usd || 0).toFixed(2)}</td><td>${esc(p.error || "")}</td></tr>`).join("")}</table>
       ${i.gates.length ? `<table><tr><th>Gate</th><th>Check</th><th>Result</th><th>Evidence</th></tr>${i.gates.map((g) => `<tr><td>${esc(g.gate)}</td><td>${esc(g.check)}</td><td><span class="tag ${esc(g.result)}">${esc(g.result)}</span></td><td>${esc(g.evidence)}</td></tr>`).join("")}</table>` : ""}
       </details>`).join("") || "<span class='muted'>Nothing has run yet.</span>";
    document.getElementById("signals").innerHTML = s.signals.length ? s.signals.map((g) => `<span class="tag ${esc(g.result)}">${esc(g.ts.slice(0, 16))} ${esc(g.result)}</span> `).join("") : "<span class='muted'>No runs yet.</span>";
    for (const e of s.events) { seen.push(e); after = Math.max(after, e.id); }
    while (seen.length > 200) seen.shift();
    const box = document.getElementById("events");
    box.innerHTML = seen.map((e) => `<div>${esc(e.ts.slice(11, 19))} ${esc(e.slug)} <b>${esc(e.type)}</b> ${esc(JSON.stringify(e.payload)).slice(0, 160)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }
  refresh(); setInterval(refresh, 2000);
</script>
```

- [ ] **Step 6: Write `src/commands/apply-lessons.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function applyLessons(root: string, slug: string): Promise<{ added: string[] }> {
  const outcomePath = join(root, "intent", slug, "outcome.md");
  if (!existsSync(outcomePath)) throw new Error(`No outcome.md for ${slug} yet.`);
  const outcome = await Bun.file(outcomePath).text();
  const section = /^##\s+Proposed CLAUDE\.md additions\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m.exec(outcome)?.[1] ?? "";
  const bullets = section.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l)).map((l) => l.replace(/^\*\s+/, "- "));
  const claudePath = join(root, "CLAUDE.md");
  let claude = existsSync(claudePath) ? await Bun.file(claudePath).text() : "# Project\n";
  const added = bullets.filter((b) => !claude.includes(b.replace(/^- /, "")));
  if (!added.length) return { added };
  if (!/^##\s+Lessons\s*$/m.test(claude)) claude = claude.trimEnd() + "\n\n## Lessons\n";
  claude = claude.trimEnd() + "\n" + added.join("\n") + "\n";
  await Bun.write(claudePath, claude);
  return { added };
}
```

- [ ] **Step 7: Wire `src/cli.ts`**

Add cases:
```ts
    case "tail": { const { tail } = await import("./commands/tail"); await tail(root, rest[0]); return 0; }
    case "ui": {
      const { serveUi } = await import("./commands/ui");
      const port = Number(rest[0] ?? 4646);
      serveUi(root, port);
      console.log(`Loopstra dashboard: http://localhost:${port}`);
      await new Promise(() => {});
      return 0;
    }
    case "apply-lessons": {
      const { applyLessons } = await import("./commands/apply-lessons");
      if (!rest[0]) { console.error("Usage: loopstra apply-lessons <slug>"); return 1; }
      const r = await applyLessons(root, rest[0]);
      console.log(r.added.length ? `Added to CLAUDE.md:\n${r.added.join("\n")}` : "Nothing new to add.");
      return 0;
    }
```
And update `HELP` to list `apply-lessons <slug>`.

- [ ] **Step 8: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/commands src/ui src/cli.ts tests/unit/ui.test.ts tests/unit/apply-lessons.test.ts
git commit -m "feat: tail, ui dashboard, and apply-lessons commands"
```

---

### Task 5: README and global install check

**Files:**
- Create: `README.md`
- Test: manual: `bun link` then `loopstra help` from another directory

- [ ] **Step 1: Write `README.md`**

```markdown
# Loopstra

An unattended software development loop built on Claude Code. Code owns the loop; agents own bounded phases; humans own decisions they choose to keep.

Loopstra takes a change from a plain-language `intent.md` through design, plan, build, test, review, merge, and verification, following the six stages of Anthropic's AI-Native SDLC Playbook. Every stage boundary is a gate made of deterministic checks, an independent agent reviewer, or a person, as you configure. The repository is the queue and the record: every artifact is a Markdown file in git.

## Install

```
bun install -g loopstra
```

Requires Bun, git, and Claude Code (`claude` on PATH, logged in with your subscription). `gh` is required only for repos with a GitHub remote.

## Set up a repo

```
cd your-repo
loopstra init
```

This writes `loopstra/config.yaml`, prompt files, an operator skill, two subagents, a hook that protects tests during fix phases, `REVIEW.md`, and `intent/README.md`. Open `loopstra/config.yaml`, confirm `commands.test`, and choose which gates get a person. Or open Claude Code and ask the `loopstra` skill to onboard you.

## Run

```
loopstra start          # the loop, forever, one step per tick
loopstra start --once   # a single tick
loopstra status         # where every change is
loopstra tail [slug]    # live events
loopstra ui             # local dashboard at http://localhost:4646
```

## Ask for a change

Create `intent/<slug>/intent.md` from the template in `intent/README.md`, in your own words, and set `status: accepted`. Watch `intent/queue.md`. When the loop needs you, the `status` and `note` lines at the top of the file say what to do.

## How it works

See `docs/superpowers/specs/2026-09-28-loopstra-design.md` for the full design and `docs/decisions.md` for why.
```

- [ ] **Step 2: Link and check**

Run: `bun link && cd /tmp && loopstra help`
Expected: help text prints. (On Windows Git Bash, `cd "$TEMP"` instead of `/tmp`.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: readme"
```

---

## Self-review

- **Spec coverage:** §8 steps 15-16 in Task 2; §10 GitHub in Task 1; §11 `tail` and `ui` in Task 4; §12 skill in Task 3; §13 init in Task 3; §14 preflight in Task 2. Lessons application (§8 step 19) in Task 4.
- **Type consistency:** `GitHub` methods `available`, `prForBranch`, `createPr`, `comment`, `checks`, `merge`; `init(root, {force})` returns `InitReport`; `buildState(root, after)` returns `UiState`; `applyLessons(root, slug)` returns `{added}`.
- **Placeholders:** none.
