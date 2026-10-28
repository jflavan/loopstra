import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git, GIT_TIMEOUT_NOTE, GitTimeout } from "../../src/git";
import { readIntent } from "../../src/intents";
import { claim, release } from "../../src/lanes";
import { runStepGuarded } from "../../src/scheduler";
import { runBuildStep } from "../../src/stages/build";
import { runMergeStep } from "../../src/stages/merge";
import { reviewAhead } from "../../src/stages/early-review";
import { PR_LEASE, PR_PUSHING, PR_WAIT, REMOTE_AHEAD } from "../../src/stages/shared";
import { readMarker, writeMarker, writeSentBack } from "../../src/context";
import type { Trace } from "../../src/trace";
import { configPath } from "../../src/config";
import { FIRST_NEEDS } from "../../src/judges";
import { fixture, fixtureDir, judgeNotes, openRepo, seedCaught, setEnv, setupRepo, tempDir, withEnv, writeIntentOnDisk } from "../helpers";
import { requestStop, resetStop, StopRequested } from "../../src/stop";
import { localDate } from "../../src/text";

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
  test("a change sent back with a note gives the note to the next build session, once; with none, the prompt says so", async () => {
    const first = await planned({ test: "echo ok" });
    try {
      await runBuildStep(first.ctx);
      expect(await promptOf(first.ctx.runDir, first.trace, "build")).toContain("A person's notes on an earlier build of this change; address each one:\n\n(none)");
    } finally {
      first.trace.close();
      first.repo.cleanup();
    }
    const { repo, ctx, trace } = await planned({ test: "echo ok" });
    try {
      writeSentBack(repo.path, "add-numbers", "Cover negative numbers too.");
      await runBuildStep(ctx);
      expect(await promptOf(ctx.runDir, trace, "build")).toContain("Cover negative numbers too.");
      expect(existsSync(join(ctx.runDir, "sent-back.md"))).toBe(false);
    } finally {
      trace.close();
      repo.cleanup();
    }
  });

  test("a plan approved by a status edit has its exceptions recorded as the build starts", async () => {
    const { repo, ctx, trace } = await planned({ test: "echo ok" });
    try {
      mkdirSync(join(repo.path, "loopstra", "standards"), { recursive: true });
      await Bun.write(join(repo.path, "loopstra", "standards", "security.md"), "# Security\n\n## Rules\n- SEC-1: no secrets in logs\n");
      await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), `${PLAN}\n## Standards\n- SEC-1: exception: the debug log stays until the audit\n`);
      await new Git(repo.path).commitAll("standards");
      await ctx.reload();
      const before = localDate();
      await runBuildStep(ctx);
      const record = (date: string) => `# Standards decisions for add-numbers\n\n## Exceptions approved\n- SEC-1 at the plan: the debug log stays until the audit (a status edit, from intent.md, ${date})\n`;
      expect([record(before), record(localDate())]).toContain(await Bun.file(join(repo.path, "intent", "add-numbers", "standards.md")).text());
    } finally {
      trace.close();
      repo.cleanup();
    }
  });

  test("a repository's older build.md without {{feedback}} still gives the session the note", async () => {
    const { repo, ctx, trace } = await planned({ test: "echo ok" });
    try {
      const path = join(repo.path, "loopstra", "prompts", "build.md");
      const old = (await Bun.file(path).text()).replace(/A person's notes on an earlier build[^\n]*\r?\n\r?\n\{\{feedback\}\}\r?\n\r?\n/, "");
      expect(old).not.toContain("{{feedback}}");
      await Bun.write(path, old);
      writeSentBack(repo.path, "add-numbers", "Cover negative numbers too.");
      await runBuildStep(ctx);
      expect(await promptOf(ctx.runDir, trace, "build")).toContain("A person's notes on an earlier build of this change; address each one:\n\nCover negative numbers too.\n");
    } finally {
      trace.close();
      repo.cleanup();
    }
  });

  test("an older build.md gives the session the note even when the plan holds the same words", async () => {
    const { repo, ctx, trace } = await planned({ test: "echo ok" });
    try {
      await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), PLAN.replace("1. x", "1. Use zod."));
      await new Git(repo.path).commitAll("plan says it");
      await ctx.reload();
      const path = join(repo.path, "loopstra", "prompts", "build.md");
      await Bun.write(path, (await Bun.file(path).text()).replace(/A person's notes on an earlier build[^\n]*\r?\n\r?\n\{\{feedback\}\}\r?\n\r?\n/, ""));
      writeSentBack(repo.path, "add-numbers", "Use zod.");
      await runBuildStep(ctx);
      expect(await promptOf(ctx.runDir, trace, "build")).toContain("A person's notes on an earlier build of this change; address each one:\n\nUse zod.\n");
    } finally {
      trace.close();
      repo.cleanup();
    }
  });

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

  test("a rebuild forgets the earlier pull request's wait and what Loopstra last pushed for it", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    writeMarker(ctx, REMOTE_AHEAD, "");
    writeMarker(ctx, PR_WAIT, "The pull request is ready to merge, and merges once main here has what was merged on GitHub meanwhile.");
    writeMarker(ctx, PR_LEASE, "0123456789abcdef0123456789abcdef01234567");
    writeMarker(ctx, PR_PUSHING, "89abcdef0123456789abcdef0123456789abcdef");
    expect((await runBuildStep(ctx)).ok).toBe(true);
    expect(readMarker(ctx, REMOTE_AHEAD)).toBeNull();
    expect(readMarker(ctx, PR_WAIT)).toBeNull();
    expect(readMarker(ctx, PR_LEASE)).toBeNull();
    expect(readMarker(ctx, PR_PUSHING)).toBeNull();
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

  test("a fix on another model than the build's still resumes the build's session, on its own model", async () => {
    // Claude Code accepts --resume with a different --model (checked against the real CLI), so the build's context carries over.
    const { repo, ctx, trace } = await planned({ test: "exit 1" }, "stages:\n  build:\n    max_fix_loops: 1\n    steps:\n      fix: cheap\n");
    const callsFile = join(repo.path, "calls.jsonl");
    await withEnv({ LOOPSTRA_FAKE_CALLS: callsFile }, () => runBuildStep(ctx));
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
    expect(calls.map((a) => [flag(a, "--model"), flag(a, "--resume")])).toEqual([["sonnet", null], ["haiku", "fake-build"]]);
    expect(phaseNames(trace)).toContain("fix-1");
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
    await writeIntentOnDisk(ctx.intent, { status: "plan-approved" });
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

  test("removing the commands' new files after the checks is tried again when git refuses once; a refusal that lasts is traced", async () => {
    const run = Git.prototype.run;
    /** Makes `git clean` fail `times` times (a file Windows still holds open), counting every clean. */
    const refusing = (times: number) => {
      let left = times;
      let cleans = 0;
      Git.prototype.run = async function (this: Git, args, opts) {
        if (args[0] === "clean") {
          cleans++;
          if (left > 0) { left--; return { code: 1, out: "", err: "warning: failed to remove out/: Permission denied" }; }
        }
        return run.call(this, args, opts);
      };
      return () => cleans;
    };
    const cleanErrors = (trace: Trace) => trace.events("add-numbers").filter((e) => e.type === "error" && e.payload.includes("\"where\":\"clean\""));
    {
      const { repo, ctx, trace } = await planned({ test: "echo ok" });
      const cleans = refusing(1);
      try { await runBuildStep(ctx); } finally { Git.prototype.run = run; }
      expect(cleans()).toBeGreaterThanOrEqual(2);
      expect(cleanErrors(trace)).toEqual([]);
      trace.close(); repo.cleanup();
    }
    {
      const { repo, ctx, trace } = await planned({ test: "echo ok" });
      refusing(Number.POSITIVE_INFINITY);
      try { await runBuildStep(ctx); } finally { Git.prototype.run = run; }
      const errors = cleanErrors(trace);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(errors[0]!.payload)).toMatchObject({ where: "clean", error: expect.stringContaining("Permission denied") });
      trace.close(); repo.cleanup();
    }
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
    // A whole build step and a merge step, with two-second sessions: a slow Windows runner needs more than 30 s.
  }, 90_000);

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

  test("no review runs ahead on a worktree whose files the checks rewrote: review start commits them, so it could not be used", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test", lint: "echo x > lint-report.txt" });
    await Bun.write(join(repo.path, "lint-report.txt"), "tracked\n");
    await new Git(repo.path).commitAll("a tracked lint report");
    await runBuildStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    expect(earlyReviews(trace)).toEqual([]);
    trace.close(); repo.cleanup();
  });

  test("new files the test runs write are removed, so neither a fix's commit nor review start commits them", async () => {
    // A test command that writes a report on every run; the broken build fails the first run.
    const { repo, ctx, trace } = await planned({ test: "bun report.ts && bun test" });
    await Bun.write(join(repo.path, "report.ts"), 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/report.txt", `run ${Date.now()}\\n`);\n');
    await Bun.write(join(repo.path, "loopstra", "prompts", "build.md"), "{{plan}} FIXTURE:build-broken");
    await new Git(repo.path).commitAll("a test command that writes a report");
    await runBuildStep(ctx);
    expect(withoutEarlyReview(trace)).toContain("fix-1");
    const files = async (ref: string) => (await new Git(repo.path).run(["ls-tree", "-r", "--name-only", ref])).out.split("\n");
    expect(await files("intent/add-numbers")).not.toContain("out/report.txt");
    expect(existsSync(join(ctx.worktreeDir, "out", "report.txt"))).toBe(false);
    await runMergeStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("merged");
    expect(await files("main")).toContain("src/add.ts");
    expect(await files("main")).not.toContain("out/report.txt");
    trace.close(); repo.cleanup();
  });

  test("new files a test run wrote are removed even when a stop cuts the run short", async () => {
    // A test command that writes a report, then runs on until it is stopped.
    const { repo, ctx, trace } = await planned({ test: "bun report.ts" });
    await Bun.write(join(repo.path, "report.ts"), 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/report.txt", "partial\\n");\nawait Bun.sleep(60_000);\n');
    await new Git(repo.path).commitAll("a test command that writes a report");
    const report = join(ctx.worktreeDir, "out", "report.txt");
    let seen = false;
    const watch = setInterval(() => { if (existsSync(report)) { seen = true; requestStop(); } }, 20);
    try {
      await expect(runBuildStep(ctx)).rejects.toBeInstanceOf(StopRequested);
      expect(seen).toBe(true);
      expect(existsSync(report)).toBe(false);
    } finally {
      clearInterval(watch); resetStop(); trace.close(); repo.cleanup();
    }
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

  test("a review whose model changed while it ran is not used: it is keyed on the model it ran on, and round 1 runs again", async () => {
    // The early review runs on opus (strong); while it runs, a person moves the review stage to max (fable).
    const dir = fixtureDir({});
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await planned({ test: "bun test" });
        const config = configPath(repo.path);
        const moved = JSON.stringify({ type: "fake_action", write: { path: config, content: `${await Bun.file(config).text()}stages:\n  review:\n    model: max\n` } });
        await Bun.write(join(dir.path, "review@opus.jsonl"), `${moved}\n${fixture("review")}`);
        await runBuildStep(ctx);
        expect(existsSync(join(ctx.runDir, "review.early"))).toBe(true);
        expect(await Bun.file(config).text()).toContain("model: max"); // moved while it ran
        await ctx.reload();
        await runMergeStep(ctx);
        expect(earlyNotes(trace)).toEqual(["not used: the change, its plan, the review prompt or its commands moved on since it ran"]);
        expect(reviews(trace)).toEqual(["review-1"]);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
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

  test("with another change running a step, the review runs during the build only when the day also has room for that change's session", async () => {
    // Two of this change's sessions plus one of the other's: $6 needed.
    for (const [day, early] of [[5, false], [7, true]] as const) {
      const { repo, ctx, trace } = await planned({ test: "bun test" }, `claude:\n  max_budget_usd_per_day: ${day}\n  max_budget_usd: 2\n`);
      claim("say-goodbye");
      try {
        await runBuildStep(ctx);
      } finally {
        release("say-goodbye");
      }
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
      expect(earlyReviews(trace).length > 0).toBe(early);
      trace.close(); repo.cleanup();
    }
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

describe("acceptance tests from Done when", () => {
  const ON = "stages:\n  build:\n    acceptance_tests: true\n";
  type Call = { phase: string; prompt: string; acceptance: string | null };
  const calls = async (log: string): Promise<Call[]> => (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l) as Call);
  const wtOf = (repo: { path: string }) => join(repo.path, ".loopstra", "worktrees", "add-numbers");
  const ACCEPTANCE_MD = "# Acceptance tests\n\nWritten from Done when before the build. The build may not change them.\n\n## Covered by tests\n- add(1, 2) returns 3: `tests/accept.test.ts`, \"adds one and two\"\n\n## Not covered by a test\n- People find add easy to use: needs a person.\n";

  test("off (the default), no acceptance session runs and nothing is held back", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    try {
      const log = join(repo.path, "prompts.jsonl");
      await withEnv({ LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      expect((await calls(log)).map((c) => c.phase)).not.toContain("acceptance");
      expect(phaseNames(trace)).not.toContain("acceptance");
      expect(existsSync(join(repo.path, "intent", "add-numbers", "acceptance.md"))).toBe(false);
      expect((await calls(log)).find((c) => c.phase === "build")?.acceptance).toBe("[]");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("on, a session writes tests before the build; they are committed on the branch, recorded on main, held from the build, and left out of the drift check", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, ON);
    try {
      const log = join(repo.path, "prompts.jsonl");
      const r = await withEnv({ LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      expect(r.ok).toBe(true);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
      // Before the build; the test file is not in the plan, yet no reconcile runs.
      expect(withoutEarlyReview(trace)).toEqual(["branch", "acceptance", "build", "drift", "test-1", "verify"]);
      const seen = await calls(log);
      expect(seen.map((c) => c.phase).slice(0, 2)).toEqual(["acceptance", "build"]);
      const asked = seen[0]!;
      expect(asked.prompt).toContain("- add(1, 2) returns 3.");
      expect(asked.prompt).toContain("# Plan: add");
      expect(asked.prompt).toContain("`bun test`");
      // Every session after it is given the files it wrote.
      for (const c of seen.slice(1)) expect({ phase: c.phase, acceptance: c.acceptance }).toEqual({ phase: c.phase, acceptance: JSON.stringify(["tests/accept.test.ts"]) });
      // Its own commit on the branch, before the build's.
      const wt = new Git(wtOf(repo));
      const subjects = (await wt.run(["log", "--format=%s", "main..HEAD"])).out.trim().split("\n").reverse();
      expect(subjects.slice(0, 2)).toEqual(["loopstra(add-numbers): acceptance tests", "feat: add function"]);
      expect((await wt.run(["show", "--name-only", "--format=", "HEAD~1"])).out.trim()).toBe("tests/accept.test.ts");
      // Recorded on main for the owner, and in the run folder for the sessions that follow.
      expect(await Bun.file(join(repo.path, "intent", "add-numbers", "acceptance.md")).text()).toBe(ACCEPTANCE_MD);
      expect((await new Git(repo.path).run(["log", "-1", "--format=%s", "--", "intent/add-numbers/acceptance.md"])).out.trim()).not.toBe("");
      expect(readMarker(ctx, "acceptance")).toBe(JSON.stringify(["tests/accept.test.ts"]));
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a build resumed after a stop does not write its acceptance tests again; a new build does", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" }, ON);
    try {
      const log = join(repo.path, "prompts.jsonl");
      await withEnv({ LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      // Resumed: the status is still building and the run folder has the marker.
      await writeIntentOnDisk(ctx.intent, { status: "building" });
      await new Git(repo.path).commitAll("resume");
      await ctx.reload();
      await withEnv({ LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      expect((await calls(log)).filter((c) => c.phase === "acceptance").length).toBe(1);
      expect((await calls(log)).filter((c) => c.phase === "build").map((c) => c.acceptance)).toEqual([JSON.stringify(["tests/accept.test.ts"]), JSON.stringify(["tests/accept.test.ts"])]);
      // A new build (from plan-approved) writes them again.
      await writeIntentOnDisk(ctx.intent, { status: "plan-approved" });
      await new Git(repo.path).commitAll("rebuild");
      await ctx.reload();
      await withEnv({ LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      expect((await calls(log)).filter((c) => c.phase === "acceptance").length).toBe(2);
      // The tests are on the branch already and unchanged, but the session names them, so they stay held.
      expect(readMarker(ctx, "acceptance")).toBe(JSON.stringify(["tests/accept.test.ts"]));
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("an acceptance session that fails does not block: the trace says why, acceptance.md says none were written, its files are dropped and the build goes on", async () => {
    const failing = [
      `{"type":"system","subtype":"init","session_id":"fake-acceptance","cwd":"/","tools":[],"model":"fake"}`,
      `{"type":"fake_action","write":{"path":"tests/half.test.ts","content":"half\\n"}}`,
      `{"type":"result","subtype":"success","is_error":false,"session_id":"fake-acceptance","total_cost_usd":0.01,"usage":{},"structured_output":{"status":"fail","summary":"could not find the test folder","commit_message":"","tests":[],"not_testable":[]},"result":"ok"}`,
    ].join("\n") + "\n";
    const dir = fixtureDir({ acceptance: failing });
    const { repo, ctx, trace } = await planned({ test: "bun test" }, ON);
    try {
      const log = join(repo.path, "prompts.jsonl");
      const r = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path, LOOPSTRA_FAKE_PROMPTS: log }, () => runBuildStep(ctx));
      expect(r.ok).toBe(true);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("reviewing");
      expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("acceptance") && e.payload.includes("agent-fail"))).toBe(true);
      const md = await Bun.file(join(repo.path, "intent", "add-numbers", "acceptance.md")).text();
      expect(md).toStartWith("# Acceptance tests\n\nNo acceptance tests were written for this change.");
      expect(md).not.toContain("## Covered by tests");
      expect(existsSync(join(wtOf(repo), "tests", "half.test.ts"))).toBe(false);
      expect((await new Git(wtOf(repo)).run(["log", "--format=%s", "main..HEAD"])).out).not.toContain("acceptance tests");
      expect((await calls(log)).find((c) => c.phase === "build")?.acceptance).toBe("[]");
      // Not tried again when the build resumes.
      expect(readMarker(ctx, "acceptance")).toBe("[]");
    } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
  });

  test("only tests are committed and held: what the test command wrote is dropped, and a source file the session names is not held", async () => {
    const messy = [
      `{"type":"system","subtype":"init","session_id":"fake-acceptance","cwd":"/","tools":[],"model":"fake"}`,
      `{"type":"fake_action","write":{"path":"tests/accept.test.ts","content":"import { expect, test } from \\"bun:test\\";\\ntest(\\"adds one and two\\", () => { expect(1 + 2).toBe(3); });\\n"}}`,
      `{"type":"fake_action","write":{"path":"coverage/lcov.info","content":"TN:\\n"}}`,
      `{"type":"result","subtype":"success","is_error":false,"session_id":"fake-acceptance","total_cost_usd":0.01,"usage":{},"structured_output":{"status":"success","summary":"wrote one test","commit_message":"","tests":[{"criterion":"add(1, 2) returns 3","file":"tests/accept.test.ts","test":"adds one and two"},{"criterion":"the coverage report","file":"coverage/lcov.info","test":"lcov"}],"not_testable":[]},"result":"ok"}`,
    ].join("\n") + "\n";
    const dir = fixtureDir({ acceptance: messy });
    const { repo, ctx, trace } = await planned({ test: "bun test" }, ON);
    try {
      const r = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, () => runBuildStep(ctx));
      expect(r.ok).toBe(true);
      expect(readMarker(ctx, "acceptance")).toBe(JSON.stringify(["tests/accept.test.ts"]));
      const wt = new Git(wtOf(repo));
      const sha = (await wt.run(["log", "--format=%H", "--grep=acceptance tests", "main..HEAD"])).out.trim();
      expect((await wt.run(["show", "--name-only", "--format=", sha])).out.trim()).toBe("tests/accept.test.ts");
      const md = await Bun.file(join(repo.path, "intent", "add-numbers", "acceptance.md")).text();
      expect(md).not.toContain("coverage/lcov.info");
    } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
  });

  test("a fix refused an acceptance test blocks with a note that names it and says how to change it", async () => {
    const refused = [
      `{"type":"system","subtype":"init","session_id":"fake-fix-refused","cwd":"/","tools":[],"model":"fake"}`,
      `{"type":"fake_action","refuse":"tests/accept.test.ts"}`,
      `{"type":"result","subtype":"success","is_error":false,"session_id":"fake-fix-refused","total_cost_usd":0.01,"usage":{},"structured_output":{"status":"fail","summary":"The only fix is in the acceptance test","commit_message":""},"result":"ok"}`,
    ].join("\n") + "\n";
    const dir = fixtureDir({ fix: refused });
    const { repo, ctx, trace } = await planned({ test: "exit 1" }, `${ON}    max_fix_loops: 1\n`);
    try {
      const r = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, () => runBuildStep(ctx));
      expect(r.ok).toBe(false);
      const i = await readIntent(repo.path, "add-numbers");
      expect(i.file.frontmatter.status).toBe("blocked");
      expect(i.file.frontmatter.note).toBe("The assistant reported it could not finish this step. It was not allowed to edit the acceptance test `tests/accept.test.ts`, written from Done when before the build. If the test is wrong, an engineer can fix it on the branch intent/add-numbers. When that is sorted out, set status to plan-approved to try again.");
    } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
  });
});
