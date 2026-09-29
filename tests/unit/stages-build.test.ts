import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git, GIT_TIMEOUT_NOTE } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { runStepGuarded } from "../../src/scheduler";
import { runBuildStep } from "../../src/stages/build";
import type { Trace } from "../../src/trace";
import { setupRepo, withEnv } from "../helpers";

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

function promptOf(runDir: string, trace: Trace, name: string): Promise<string> {
  const p = trace.phases("add-numbers").find((x) => x.name === name)!;
  return Bun.file(join(runDir, "phases", `${p.seq}-${name}`, "prompt.md")).text();
}

describe("build stage", () => {
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
    expect(phaseNames(trace)).toEqual(["branch", "build", "drift", "test-1", "verify"]);
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
    expect(recorded.args).toEqual(expect.arrayContaining(["--resume", "fake-build"]));
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("exit 1"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("when the build session cannot be resumed, fix retries once in a fresh session and saves it", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "build.md"), "{{plan}} FIXTURE:build-broken");
    const r = await runBuildStep(ctx);
    expect(r.ok).toBe(true);
    expect(phaseNames(trace)).toEqual(["branch", "build", "drift", "test-1", "fix-1", "fix-1-fresh", "test-2", "verify"]);
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
    expect(phaseNames(trace)).toEqual(["branch", "build", "drift", "reconcile", "test-1", "verify"]);
    const reconciled = join(ctx.runDir, "plan.reconciled.md");
    expect(await Bun.file(reconciled).text()).toContain("src/extra.ts");
    // Never on the branch: the branch's copy of plan.md is main's, untouched.
    const wt = join(repo.path, ".loopstra", "worktrees", "add-numbers");
    expect(await Bun.file(join(wt, "intent", "add-numbers", "plan.md")).text()).not.toContain("src/extra.ts");
    expect(await promptOf(ctx.runDir, trace, "verify")).toContain("src/extra.ts");
    const firstBuildSha = await new Git(wt).headSha();

    // A person retries from plan-approved: the branch and worktree are reused, and the new build is
    // compared with main's plan again, not with the plan reconciled for the earlier build.
    await Bun.write(reconciled, "# Plan: stale\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n");
    await writeIntent(ctx.intent, { status: "plan-approved" });
    await new Git(repo.path).commitAll("retry");
    await ctx.reload();
    const before = phaseNames(trace).length;
    await runBuildStep(ctx);
    expect(phaseNames(trace).slice(before)).toEqual(["branch", "build", "drift", "reconcile", "test-1", "verify"]);
    expect(await Bun.file(reconciled).text()).toContain("src/extra.ts");
    expect(await new Git(wt).isAncestor(firstBuildSha, "HEAD")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("a verify failure gets exactly one fix, then blocks; observations are sent once", async () => {
    const { repo, ctx, trace } = await planned({ test: "bun test" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "verify.md"), "{{spec}} {{plan}} FIXTURE:verify-reject");
    const r = await runBuildStep(ctx);
    expect(r.ok).toBe(false);
    expect(phaseNames(trace)).toEqual(["branch", "build", "drift", "test-1", "verify", "fix-after-verify", "retest-1", "verify-2"]);
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
