import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git, GIT_TIMEOUT_NOTE, GitTimeout } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { runStepGuarded } from "../../src/scheduler";
import { runBuildStep } from "../../src/stages/build";
import { runMergeStep } from "../../src/stages/merge";
import { reviewAhead } from "../../src/stages/early-review";
import type { Trace } from "../../src/trace";
import { configPath } from "../../src/config";
import { FIRST_NEEDS } from "../../src/judges";
import { judgeNotes, openRepo, seedCaught, setEnv, setupRepo, tempDir, withEnv } from "../helpers";

const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

async function planned(commands: Record<string, string>, config = "") {
  const s = await setupRepo("plan-approved", { commands, config });
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), PLAN);
  await Bun.write(join(s.repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  return s;
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

/**
 * The phase names less the early-review that ran alongside the first verify: one, or none when a
 * failed verify cancelled it before its session started.
 */
function withoutEarlyReview(trace: Trace): string[] {
  const names = phaseNames(trace);
  expect(names.filter((n) => n === "early-review").length).toBeLessThanOrEqual(1);
  return names.filter((n) => n !== "early-review");
}

function promptOf(runDir: string, trace: Trace, name: string): Promise<string> {
  const p = trace.phases("add-numbers").find((x) => x.name === name)!;
  return Bun.file(join(runDir, "phases", `${p.seq}-${name}`, "prompt.md")).text();
}

/** Commands that pass only when test and lint run at the same time (see tests/meet.ts); each exits with its code after. */
function meeting(codes: { test: number; lint: number }): { test: string; lint: string; cleanup: () => void } {
  const dir = tempDir("loopstra-meet-");
  const script = join(import.meta.dir, "..", "meet.ts").replaceAll("\\", "/");
  const at = dir.path.replaceAll("\\", "/");
  // Quoted, so a path with a space (a user folder, a checkout) stays one argument.
  return { test: `bun "${script}" "${at}" test lint ${codes.test}`, lint: `bun "${script}" "${at}" lint test ${codes.lint}`, cleanup: dir.cleanup };
}

/** A command that runs far longer than any test waits, so a test that ends in time saw it cancelled. */
const LONG = `bun -e "setTimeout(() => {}, 30000)"`;

describe("build stage", () => {
  test("with speed.parallel_checks, test, lint and build start together inside one test phase", async () => {
    const m = meeting({ test: 0, lint: 0 });
    const { repo, ctx, trace } = await planned({ test: m.test, lint: m.lint, build: "echo built" }, "speed:\n  parallel_checks: true\n");
    await runBuildStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(phaseNames(trace).filter((n) => n.startsWith("test-"))).toEqual(["test-1"]);
    trace.close(); repo.cleanup(); m.cleanup();
  });

  test("with parallel checks, fix hears about the first failing command in order, not the first to fail", async () => {
    const m = meeting({ test: 1, lint: 2 });
    const { repo, ctx, trace } = await planned({ test: m.test, lint: m.lint }, "speed:\n  parallel_checks: true\nstages:\n  build:\n    max_fix_loops: 1\n");
    await runBuildStep(ctx);
    const fix = await promptOf(ctx.runDir, trace, "fix-1");
    expect(fix).toContain(`The command \`${m.test}\` failed.`);
    expect(fix).toContain("test met lint");
    trace.close(); repo.cleanup(); m.cleanup();
  });

  test("with parallel checks, a failure that is known cancels the commands still running instead of waiting for them", async () => {
    const started = Date.now();
    const { repo, ctx, trace } = await planned({ test: "exit 1", lint: LONG }, "speed:\n  parallel_checks: true\nstages:\n  build:\n    max_fix_loops: 1\n");
    await runBuildStep(ctx);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(phaseNames(trace).filter((n) => /^(test|fix)-/.test(n))).toEqual(["test-1", "fix-1", "test-2"]);
    const cancelled = trace.events("add-numbers").filter((e) => e.type === "command" && e.payload.includes("cancelled"));
    expect(cancelled.map((e) => JSON.parse(e.payload).command)).toEqual([LONG, LONG]);
    expect(await promptOf(ctx.runDir, trace, "fix-1")).toContain("The command `exit 1` failed.");
    trace.close(); repo.cleanup();
  });

  test("plan-approved → reviewing: work lands on the intent branch only, never on main", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    const r = await runBuildStep(ctx);
    expect(r.ok).toBe(true);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("reviewing");
    const wt = join(repo.path, ".loopstra", "worktrees", "add-numbers");
    expect(existsSync(join(wt, "src", "add.ts"))).toBe(true);
    const wtGit = new Git(wt);
    expect(await wtGit.isDirty()).toBe(false);
    expect(await wtGit.changedFilesSince("main")).toEqual(["src/add.ts", "tests/add.test.ts"]);
    expect((await new Git(repo.path).run(["cat-file", "-e", "main:src/add.ts"], true)).code).not.toBe(0);
    expect(existsSync(join(repo.path, "src", "add.ts"))).toBe(false);
    // early-review runs alongside the first verify (see "the first review alongside the verifier").
    expect(withoutEarlyReview(trace)).toEqual(["branch", "build", "drift", "test-1", "verify"]);
    expect(JSON.parse(await Bun.file(join(ctx.runDir, "sessions.json")).text())).toEqual({ build: "fake-build" });
    trace.close(); repo.cleanup();
  });

  test("a stale plain folder where the worktree belongs is replaced, not committed to main", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    const wt = join(repo.path, ".loopstra", "worktrees", "add-numbers");
    mkdirSync(wt, { recursive: true });
    await Bun.write(join(wt, "leftover.txt"), "from a crashed run\n");
    const mainBefore = await new Git(repo.path).headSha();
    await runBuildStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(await new Git(wt).isWorktreeRoot()).toBe(true);
    expect(existsSync(join(wt, "leftover.txt"))).toBe(false);
    const mainLog = (await new Git(repo.path).run(["log", "--name-only", "--format=", `${mainBefore}..main`])).out;
    expect(mainLog).not.toContain("src/add.ts");
    expect(mainLog).not.toContain("leftover.txt");
    trace.close(); repo.cleanup();
  });

  test("failing tests run fix in the resumed build session, record failed test phases, then block in plain words", async () => {
    const { repo, ctx, trace } = await planned({ test: "exit 1" }, "stages:\n  build:\n    max_fix_loops: 2\n");
    const argsFile = join(repo.path, "args.json");
    const r = await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runBuildStep(ctx));
    expect(r.ok).toBe(false);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The tests kept failing after several attempts to fix them. An engineer needs to look at the change. When that is sorted out, set status to plan-approved to try again.");
    expect(phaseNames(trace)).toEqual(["branch", "build", "drift", "test-1", "fix-1", "test-2", "fix-2", "test-3"]);
    expect(trace.phases("add-numbers").filter((p) => p.name.startsWith("test-")).map((p) => p.status)).toEqual(["fail", "fail", "fail"]);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.env.LOOPSTRA_PHASE).toBe("fix");
    // What the protect-tests hook needs: the base its branch diff starts from, and where to record refusals.
    expect(recorded.env.LOOPSTRA_BASE).toBe("main");
    expect(recorded.env.LOOPSTRA_PROTECTED_LOG).toBe(join(ctx.runDir, "phases", `${trace.phases("add-numbers").find((p) => p.name === "fix-2")!.seq}-fix-2`, "protected-tests.txt"));
    expect(recorded.args).toEqual(expect.arrayContaining(["--resume", "fake-build"]));
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("exit 1"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("when the build session cannot be resumed, fix retries once in a fresh session and saves it", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "build.md"), "{{plan}} FIXTURE:build-broken");
    const r = await runBuildStep(ctx);
    expect(r.ok).toBe(true);
    // early-review runs alongside the first verify (see "the first review alongside the verifier").
    expect(withoutEarlyReview(trace)).toEqual(["branch", "build", "drift", "test-1", "fix-1", "fix-1-fresh", "test-2", "verify"]);
    expect(JSON.parse(await Bun.file(join(ctx.runDir, "sessions.json")).text())).toEqual({ build: "fake-build" });
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    trace.close(); repo.cleanup();
  });

  test("files outside the plan trigger reconcile; the reconciled plan lives in the run folder, is used by verify, and a new build starts from main's plan", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    const narrower = PLAN.replace("- tests/add.test.ts (new)\n", "");
    await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), narrower);
    await new Git(repo.path).commitAll("narrower plan");
    await ctx.reload();
    await runBuildStep(ctx);
    // early-review runs alongside the first verify (see "the first review alongside the verifier").
    expect(withoutEarlyReview(trace)).toEqual(["branch", "build", "drift", "reconcile", "test-1", "verify"]);
    const reconciled = join(ctx.runDir, "plan.reconciled.md");
    expect(await Bun.file(reconciled).text()).toContain("src/extra.ts");
    // Never on the branch: the branch's copy of plan.md is main's, untouched.
    const wt = join(repo.path, ".loopstra", "worktrees", "add-numbers");
    expect(await Bun.file(join(wt, "intent", "add-numbers", "plan.md")).text()).not.toContain("src/extra.ts");
    expect(await promptOf(ctx.runDir, trace, "verify")).toContain("src/extra.ts");
    // The review that ran alongside saw the reconciled plan too, as round 1 would.
    expect(await promptOf(ctx.runDir, trace, "early-review")).toContain("src/extra.ts");
    const firstBuildSha = await new Git(wt).headSha();

    // A person retries from plan-approved: the branch and worktree are reused, and the new build is
    // compared with main's plan again, not with the plan reconciled for the earlier build.
    await Bun.write(reconciled, "# Plan: stale\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n");
    await writeIntent(ctx.intent, { status: "plan-approved" });
    await new Git(repo.path).commitAll("retry");
    await ctx.reload();
    const before = phaseNames(trace).length;
    await runBuildStep(ctx);
    expect(phaseNames(trace).slice(before).filter((n) => n !== "early-review")).toEqual(["branch", "build", "drift", "reconcile", "test-1", "verify"]);
    expect(await Bun.file(reconciled).text()).toContain("src/extra.ts");
    expect(await new Git(wt).isAncestor(firstBuildSha, "HEAD")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("a verify failure gets exactly one fix, then blocks; observations are sent once", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "verify.md"), "{{spec}} {{plan}} FIXTURE:verify-reject");
    const r = await runBuildStep(ctx);
    expect(r.ok).toBe(false);
    // early-review runs alongside the first verify (see "the first review alongside the verifier").
    expect(withoutEarlyReview(trace)).toEqual(["branch", "build", "drift", "test-1", "verify", "fix-after-verify", "retest-1", "verify-2"]);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("still did not work as the spec describes");
    expect(i.file.frontmatter.note).not.toMatch(/intent\/|verify|\d/);
    const fixPrompt = await promptOf(ctx.runDir, trace, "fix-after-verify");
    expect(fixPrompt.split("printed 12 instead of 3").length - 1).toBe(1);
    // The checks passed: the fix is told what the verifier found, not that the checks failed.
    expect(fixPrompt).toContain("The checks pass; the verifier found the change does not do what the spec says:\n- add(1, 2) printed 12 instead of 3");
    expect(fixPrompt).not.toContain("checks failed");
    trace.close(); repo.cleanup();
  });

  test("the verifier is told the tests passed and may run exactly the project's commands; a test failure reaches fix with the command's name", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test", run: "bun run start" });
    await runBuildStep(ctx);
    const verifyPrompt = await promptOf(ctx.runDir, trace, "verify");
    expect(verifyPrompt).toContain("The test command passed after the latest change.");
    expect(verifyPrompt).toContain("You may run only these shell commands, with any arguments: `bun test`, `bun run start`, `git diff`, `git log`, `git show`, `git status`.");
    trace.close(); repo.cleanup();
  });

  test("a failing test run reaches fix with the command that failed and the end of its output", async () => {
    const { repo, ctx, trace } = await planned({ test: "echo boom && exit 1" }, "stages:\n  build:\n    max_fix_loops: 1\n");
    await runBuildStep(ctx);
    const fixPrompt = await promptOf(ctx.runDir, trace, "fix-1");
    expect(fixPrompt).toContain("The command `echo boom && exit 1` failed. The end of its output:");
    expect(fixPrompt).toContain("boom");
    trace.close(); repo.cleanup();
  });

  test("a failing after command for build blocks in plain words before review", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "stages:\n  build:\n    after:\n      - exit 4\n");
    await runBuildStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("A project command that runs after the build stage failed. An engineer needs to look at it. When that is sorted out, set status to plan-approved to try again.");
    expect(phaseNames(trace).at(-1)).toBe("build-after");
    trace.close(); repo.cleanup();
  });

  test("a git command that hangs inside the step blocks with a plain note instead of stopping the loop", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    // Checking out the worktree runs this hook; it never finishes.
    const hook = join(repo.path, ".git", "hooks", "post-checkout");
    await Bun.write(hook, "#!/bin/sh\nsleep 30\n");
    chmodSync(hook, 0o755);
    (ctx as { git: Git }).git = new Git(repo.path, { timeoutMs: 300 });
    const r = await runStepGuarded(ctx);
    expect(r.ok).toBe(false);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toStartWith(GIT_TIMEOUT_NOTE);
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("did not finish within"))).toBe(true);
    rmSync(hook, { force: true });
    trace.close(); repo.cleanup();
  }, 60_000);
});

describe("the first review alongside the verifier", () => {
  const reviews = (trace: Trace) => phaseNames(trace).filter((n) => /^review-\d+$/.test(n));
  const earlyReviews = (trace: Trace) => phaseNames(trace).filter((n) => n.startsWith("early-review"));

  test("early-review runs at the same time as verify, and the merge step's first round uses it instead of a new review", async () => {
    // Both do a little git work before their sessions start; long sessions keep a slow machine's
    // difference in that work well inside the time they run together.
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "2000" });
    try {
      const { repo, ctx, trace } = await planned({ test: "bun test" });
      await runBuildStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
      const byName = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)!;
      const [v, r] = [byName("verify"), byName("early-review")];
      expect(v.started < r.ended! && r.started < v.ended!).toBe(true);
      // What is kept says what the review was asked by a hash, not a copy of the spec and plan.
      expect(await Bun.file(join(ctx.runDir, "review.early")).text()).not.toContain("## Order of work");
      await ctx.reload();
      await runMergeStep(ctx);
      expect(reviews(trace)).toEqual([]);
      expect(earlyReviews(trace)).toEqual(["early-review"]);
      expect(trace.gates("add-numbers").filter((g) => g.gate === "review").map((g) => g.result)).toEqual(["pass"]);
      expect(await Bun.file(join(repo.path, "intent", "add-numbers", "review.md")).exists()).toBe(true);
      trace.close(); repo.cleanup();
    } finally {
      restore();
    }
  });

  test("it reads a throwaway copy of the tested commit, not the worktree the verifier runs commands in", async () => {
    const t = tempDir("loopstra-prompts-");
    const log = join(t.path, "prompts.jsonl");
    try {
      const { repo, ctx, trace } = await planned({ test: "bun test" });
      await withEnv({ LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      const calls = (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l) as { phase: string; cwd: string });
      const cwdOf = (phase: string) => calls.find((c) => c.phase === phase)!.cwd.replaceAll("\\", "/");
      expect(cwdOf("review")).toEndWith(".loopstra/review/add-numbers");
      expect(cwdOf("verify")).toEndWith(".loopstra/worktrees/add-numbers");
      // The copy is gone once the review ended; round 1 can still use what it found.
      expect(existsSync(join(repo.path, ".loopstra", "review", "add-numbers"))).toBe(false);
      expect(existsSync(join(ctx.runDir, "review.early"))).toBe(true);
      trace.close(); repo.cleanup();
    } finally {
      t.cleanup();
    }
  });

  test("when verify fails, the review running alongside is cancelled at once and not kept", async () => {
    // Verify takes a moment, so the review's session has started when verify fails.
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "verify=3000,review=30000" });
    try {
      const started = Date.now();
      const { repo, ctx, trace } = await planned({ test: "bun test" });
      await Bun.write(join(repo.path, "loopstra", "prompts", "verify.md"), "{{spec}} {{plan}} FIXTURE:verify-reject");
      await runBuildStep(ctx);
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(earlyReviews(trace)).toEqual(["early-review"]);
      const early = trace.phases("add-numbers").find((p) => p.name === "early-review")!;
      expect([early.status, early.error]).toEqual(["interrupted", "cancelled: its result was no longer needed"]);
      // The fix started before the review would have ended.
      expect(trace.phases("add-numbers").find((p) => p.name === "fix-after-verify")!.started < new Date(Date.parse(early.started) + 30_000).toISOString()).toBe(true);
      expect(existsSync(join(ctx.runDir, "review.early"))).toBe(false);
      trace.close(); repo.cleanup();
    } finally {
      restore();
    }
  });

  test("when git cannot say whether the worktree is clean, verify runs alone and the build goes on", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    const isDirty = Git.prototype.isDirty;
    Git.prototype.isDirty = async () => { throw new GitTimeout(["status", "--porcelain"], 1000); };
    try {
      await runBuildStep(ctx);
    } finally {
      Git.prototype.isDirty = isDirty;
    }
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(earlyReviews(trace)).toEqual([]);
    expect(trace.events("add-numbers").some((e) => e.payload.includes("not run") && e.payload.includes("did not finish within"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("a review kept before review commands were added is not used: round 1 runs after them", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await runBuildStep(ctx);
    expect(existsSync(join(ctx.runDir, "review.early"))).toBe(true);
    trace.close();
    await Bun.write(configPath(repo.path), `${await Bun.file(configPath(repo.path)).text()}stages:\n  review:\n    before:\n      - echo before\n`);
    await new Git(repo.path).commitAll("review commands");
    const again = await openRepo(repo.path);
    await runMergeStep(again.ctx);
    expect(reviews(again.trace)).toEqual(["review-1"]);
    again.trace.close(); repo.cleanup();
  });

  test("no review runs ahead on a worktree the checks left files in: review start commits them, so it could not be used", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test", lint: "echo x > lint-report.txt" });
    await runBuildStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(earlyReviews(trace)).toEqual([]);
    trace.close(); repo.cleanup();
  });

  test("a review asked about other code, or with another prompt, is not used: round 1 runs again", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await runBuildStep(ctx);
    await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), `${await Bun.file(join(repo.path, "loopstra", "prompts", "review.md")).text()}\nAlso check the names.\n`);
    await new Git(repo.path).commitAll("a new review prompt");
    await ctx.reload();
    await runMergeStep(ctx);
    expect(reviews(trace)).toEqual(["review-1"]);
    trace.close(); repo.cleanup();
  });

  test("an early review that cannot reach the assistant is dropped; the build still ends at reviewing", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), "{{spec}} FIXTURE:usage-limit");
    await runBuildStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(existsSync(join(ctx.runDir, "review.early"))).toBe(false);
    expect(trace.phases("add-numbers").find((p) => p.name === "early-review")?.status).toBe("interrupted");
    trace.close(); repo.cleanup();
  });

  const earlyNotes = (trace: Trace) => trace.events("add-numbers").map((e) => JSON.parse(e.payload) as { command?: string; note?: string })
    .filter((p) => p.command === "early review").map((p) => p.note);

  test("shadow: early-review and early-review-cheap run alongside verify, and the comparison is recorded", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: shadow\n");
    await runBuildStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(phaseNames(trace).slice(-3).sort()).toEqual(["early-review", "early-review-cheap", "verify"]);
    expect(trace.judgeRows()).toMatchObject([{ trace_name: "early-review", how: "shadow", cheap: "pass", strong: "pass" }]);
    expect(JSON.parse(await Bun.file(join(ctx.runDir, "review.early")).text()).decidedBy).toBe("strong");
    trace.close(); repo.cleanup();
  });

  test("shadow with too little of the day left beside the verifier: the early review runs without the cheaper judge", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: shadow\nclaude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n");
    await runBuildStep(ctx);
    expect(earlyReviews(trace)).toEqual(["early-review"]);
    expect(phaseNames(trace)).not.toContain("early-review-cheap");
    expect(judgeNotes(trace)).toEqual(["not compared: today's budget has no room for another session"]);
    trace.close(); repo.cleanup();
  });

  test("the early review counts the verifier beside it even before the verifier's session holds its share", async () => {
    // Called directly, with nothing running: room for two sessions, not three, so the cheaper judge stays out.
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: shadow\nclaude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n");
    await ctx.git.run(["branch", ctx.branch]);
    await ctx.git.ensureWorktree(ctx.worktreeDir, ctx.branch);
    expect(await reviewAhead(ctx, "# Spec", PLAN)).not.toBeNull();
    expect(phaseNames(trace)).toEqual(["early-review"]);
    expect(judgeNotes(trace)).toEqual(["not compared: today's budget has no room for another session"]);
    trace.close(); repo.cleanup();
  });

  test("shadow: when verify fails after both judges answered, the early review is not kept, but its comparison stays", async () => {
    // Verify takes a while, so both judges of the early review have ended before it fails.
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "verify=3000" });
    try {
      const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: shadow\n");
      await Bun.write(join(repo.path, "loopstra", "prompts", "verify.md"), "{{spec}} {{plan}} FIXTURE:verify-reject");
      await runBuildStep(ctx);
      expect(existsSync(join(ctx.runDir, "review.early"))).toBe(false);
      expect(trace.judgeRows()).toMatchObject([{ trace_name: "early-review" }]);
      trace.close(); repo.cleanup();
    } finally {
      restore();
    }
  });

  test("shadow: when verify fails while both judges still run, both are cancelled and nothing is compared", async () => {
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "verify=3000,review=30000" });
    try {
      const started = Date.now();
      const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: shadow\n");
      await Bun.write(join(repo.path, "loopstra", "prompts", "verify.md"), "{{spec}} {{plan}} FIXTURE:verify-reject");
      await runBuildStep(ctx);
      expect(Date.now() - started).toBeLessThan(25_000);
      const status = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)?.status;
      expect([status("early-review"), status("early-review-cheap")]).toEqual(["interrupted", "interrupted"]);
      expect(existsSync(join(ctx.runDir, "review.early"))).toBe(false);
      expect(trace.judgeRows()).toEqual([]);
      trace.close(); repo.cleanup();
    } finally {
      restore();
    }
  });

  test("first: an early review the cheaper judge decided is used while it is still trusted", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: first\n");
    seedCaught(repo.path, trace, "review", FIRST_NEEDS);
    await runBuildStep(ctx);
    expect(reviews(trace)).toEqual([]);
    expect(phaseNames(trace)).toContain("early-review-cheap");
    expect(JSON.parse(await Bun.file(join(ctx.runDir, "review.early")).text()).decidedBy).toBe("cheap");
    await ctx.reload();
    await runMergeStep(ctx);
    expect(reviews(trace)).toEqual([]);
    expect(earlyNotes(trace)).toEqual(["review-1 uses the review that ran alongside the verifier"]);
    expect(trace.lastGate("add-numbers", "review", "findings")?.evidence).toEndWith("; decided by the cheaper judge (sonnet)");
    trace.close(); repo.cleanup();
  });

  test("first: an early review the cheaper judge decided is dropped once a miss was found since; round 1 runs on the strong model", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: first\n");
    seedCaught(repo.path, trace, "review", FIRST_NEEDS);
    await runBuildStep(ctx);
    expect(JSON.parse(await Bun.file(join(ctx.runDir, "review.early")).text()).decidedBy).toBe("cheap");
    // Another change's audit: the cheaper judge passed what the strong one rejected.
    seedCaught(repo.path, trace, "review", 1, { mode: "first", cheap: "pass" });
    await ctx.reload();
    await runMergeStep(ctx);
    expect(earlyNotes(trace)).toEqual(["not used: it was decided by the cheaper judge, which is no longer trusted to decide alone"]);
    expect(reviews(trace)).toEqual(["review-1"]);
    trace.close(); repo.cleanup();
  });

  test("first: an early review the cheaper judge decided is dropped once a daily budget is set with no session cap", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, "speed:\n  cheap_judges: first\n");
    seedCaught(repo.path, trace, "review", FIRST_NEEDS);
    await runBuildStep(ctx);
    expect(JSON.parse(await Bun.file(join(ctx.runDir, "review.early")).text()).decidedBy).toBe("cheap");
    // Before the next tick the owner sets a daily budget and no session cap: the cheaper judge never decides alone there.
    ctx.cfg.claude.max_budget_usd_per_day = 50;
    delete ctx.cfg.claude.max_budget_usd;
    await ctx.reload();
    await runMergeStep(ctx);
    expect(earlyNotes(trace)).toEqual(["not used: it was decided by the cheaper judge, which is no longer trusted to decide alone"]);
    expect(reviews(trace)).toEqual(["review-1"]);
    trace.close(); repo.cleanup();
  });

  for (const [what, config] of [
    ["speed.overlap_judges is off", "speed:\n  overlap_judges: false\n"],
    ["build has after commands", "stages:\n  build:\n    after:\n      - echo after\n"],
    ["review has before commands", "stages:\n  review:\n    before:\n      - echo before\n"],
    ["a daily budget has no room for two sessions", "claude:\n  max_budget_usd_per_day: 5\n"],
  ] as const) {
    test(`no review runs during the build when ${what}`, async () => {
      const { repo, ctx, trace } = await planned({ test: "bun test" }, config);
      await runBuildStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
      expect(earlyReviews(trace)).toEqual([]);
      trace.close(); repo.cleanup();
    });
  }
});
