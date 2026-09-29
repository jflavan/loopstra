import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runBuildStep } from "../../src/stages/build";
import { runMergeStep } from "../../src/stages/merge";
import { runReviewStep } from "../../src/stages/review";
import type { Trace } from "../../src/trace";
import { setupRepo, withEnv } from "../helpers";

const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

async function built(config = "") {
  const s = await setupRepo("plan-approved", { commands: { test: "bun test" }, config });
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), PLAN);
  await Bun.write(join(s.repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  await runBuildStep(s.ctx);
  await s.ctx.reload();
  return s;
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

function reviewGates(trace: Trace): string[] {
  return trace.gates("add-numbers").filter((g) => g.gate === "review").map((g) => `${g.check}:${g.result}`);
}

describe("review", () => {
  test("reviewing → merge-review: the reviewer may read git history but not write, and the verdict is recorded as a gate row", async () => {
    const { repo, ctx, trace } = await built();
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runReviewStep(ctx));
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merge-review");
    expect(i.artifacts.has("review.md")).toBe(true);
    expect(reviewGates(trace)).toEqual(["findings:pass"]);
    const recorded = await Bun.file(argsFile).json();
    const allowed = recorded.args[recorded.args.indexOf("--allowedTools") + 1] as string;
    expect(allowed.split(",")).toEqual(expect.arrayContaining(["Read", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"]));
    expect(allowed).not.toContain("Edit");
    expect(recorded.args).toEqual(expect.arrayContaining(["--disallowedTools", "Edit,Write,NotebookEdit"]));
    expect(recorded.prompt).toContain("git diff main...HEAD");
    expect(existsSync(join(ctx.runDir, "review-round"))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("the verdict comes from the findings: no important findings passes even if the reviewer did not approve", async () => {
    const { repo, ctx, trace } = await built();
    await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), "{{spec}} FIXTURE:review-nits-unapproved");
    await runReviewStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("merge-review");
    expect(reviewGates(trace)).toEqual(["findings:pass"]);
    expect(trace.gates("add-numbers").find((g) => g.gate === "review")?.evidence).toContain("approved: false");
    trace.close(); repo.cleanup();
  });

  test("important findings trigger revise and the test loop, then review again; exhausted rounds block in plain words", async () => {
    const { repo, ctx, trace } = await built("stages:\n  review:\n    max_rounds: 1\n");
    await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), "{{spec}} FIXTURE:review-reject");
    await runReviewStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change.");
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("NaN"))).toBe(true);
    expect(phaseNames(trace).slice(-4)).toEqual(["review-1", "revise-1", "retest-1", "review-2"]);
    expect(reviewGates(trace)).toEqual(["findings:fail", "findings:fail"]);
    expect(await new Git(ctx.worktreeDir).log(1)).toEqual([expect.stringContaining("fix: handle NaN")]);
    trace.close(); repo.cleanup();
  });

  test("the review round survives a restart", async () => {
    const { repo, ctx, trace } = await built("stages:\n  review:\n    max_rounds: 1\n");
    await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), "{{spec}} FIXTURE:review-reject");
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "review-round"), "2");
    const before = phaseNames(trace).length;
    await runReviewStep(ctx);
    expect(phaseNames(trace).slice(before)).toEqual(["review-2"]);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    trace.close(); repo.cleanup();
  });

  test("unfinished edits left in the worktree are kept on the intent branch before review, never on main", async () => {
    const { repo, ctx, trace } = await built();
    await Bun.write(join(ctx.worktreeDir, "src", "add.ts"), "export const add = (a: number, b: number) => a + b;\n");
    const mainBefore = await new Git(repo.path).headSha();
    await runReviewStep(ctx);
    const wt = new Git(ctx.worktreeDir);
    expect(await wt.isDirty()).toBe(false);
    expect((await wt.run(["log", "--format=%s", "main..HEAD"])).out).toContain("chore: keep unfinished changes");
    expect((await new Git(repo.path).run(["log", "--format=%s", `${mainBefore}..main`])).out).not.toContain("keep unfinished");
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("merge-review");
    trace.close(); repo.cleanup();
  });

  test("review before and after commands run around the rounds", async () => {
    const { repo, ctx, trace } = await built("stages:\n  review:\n    before:\n      - echo before\n    after:\n      - echo after\n");
    const before = phaseNames(trace).length;
    await runReviewStep(ctx);
    expect(phaseNames(trace).slice(before)).toEqual(["review-before", "review-1", "review-after"]);
    trace.close(); repo.cleanup();
  });

  test("a missing intent branch blocks with how to rebuild", async () => {
    const { repo, ctx, trace } = await built();
    const git = new Git(repo.path);
    await git.worktreeRemove(ctx.worktreeDir);
    await git.deleteBranch(ctx.branch);
    await runReviewStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("plan-approved");
    expect(i.file.frontmatter.note).not.toContain("intent/");
    trace.close(); repo.cleanup();
  });
});

describe("merge", () => {
  test("merge-review → merged locally with cleanup", async () => {
    const { repo, ctx, trace } = await built();
    await runReviewStep(ctx);
    await ctx.reload();
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merged");
    expect(existsSync(join(repo.path, "src", "add.ts"))).toBe(true);
    expect(existsSync(join(repo.path, ".loopstra", "worktrees", "add-numbers"))).toBe(false);
    expect(await new Git(repo.path).branchExists("intent/add-numbers")).toBe(false);
    expect(trace.gates("add-numbers").filter((g) => g.gate === "merge").map((g) => `${g.check}:${g.result}`)).toEqual(["up-to-date:pass", "tests:pass", "findings:pass"]);
    trace.close(); repo.cleanup();
  });

  test("merge reads the newest review verdict", async () => {
    const { repo, ctx, trace } = await built();
    await runReviewStep(ctx);
    await ctx.reload();
    trace.gate("add-numbers", "review", "findings", "fail", "a later review found an important problem");
    await runMergeStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    expect(trace.gates("add-numbers").filter((g) => g.gate === "merge").map((g) => `${g.check}:${g.result}`)).toEqual(["up-to-date:pass", "tests:pass", "findings:fail"]);
    trace.close(); repo.cleanup();
  });

  test("a rebase conflict blocks in plain words and leaves main clean", async () => {
    const { repo, ctx, trace } = await built();
    await runReviewStep(ctx);
    await ctx.reload();
    await Bun.write(join(repo.path, "src", "add.ts"), "// main version\n");
    await new Git(repo.path).commitAll("conflicting change on main");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).not.toMatch(/<<<<|CONFLICT \(|\bgit\b/);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a merge that git refuses blocks in plain words with detail in the trace", async () => {
    const { repo, ctx, trace } = await built();
    await runReviewStep(ctx);
    await ctx.reload();
    // An untracked file on main that the merge would overwrite makes git refuse the merge itself.
    await Bun.write(join(repo.path, "src", "add.ts"), "// someone's scratch file\n");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("could not be merged");
    expect(i.file.frontmatter.note).not.toMatch(/CONFLICT|<<<<|git /i);
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("merge"))).toBe(true);
    expect(await Bun.file(join(repo.path, "src", "add.ts")).text()).toContain("scratch file");
    trace.close(); repo.cleanup();
  });
});
