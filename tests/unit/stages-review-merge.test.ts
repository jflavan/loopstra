import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { runBuildStep } from "../../src/stages/build";
import { cleanupChange, DIRTY_ROOT_NOTE, MERGE_WAIT_NOTE, NO_REMOTE_PR_NOTE, runMergeStep } from "../../src/stages/merge";
import type { StepContext } from "../../src/context";
import type { Trace } from "../../src/trace";
import { lastCommit, setupRepo, withEnv } from "../helpers";

const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";
const PERSON_MERGES = "gates:\n  merge:\n    human: status\n";

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

/** Replaces a prompt with a fixture selector and commits it, so the main checkout stays clean. */
async function usePrompt(repo: string, name: string, text: string): Promise<void> {
  await Bun.write(join(repo, "loopstra", "prompts", `${name}.md`), text);
  await new Git(repo).commitAll(`test prompt ${name}`);
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

function gateRows(trace: Trace, gate: string): string[] {
  return trace.gates("add-numbers").filter((g) => g.gate === gate).map((g) => `${g.check}:${g.result}`);
}

async function onMain(repo: string, path: string): Promise<boolean> {
  return (await new Git(repo).run(["cat-file", "-e", `main:${path}`], true)).code === 0;
}

async function status(repo: string): Promise<string> {
  return (await readIntent(repo, "add-numbers")).file.frontmatter.status;
}

/** A squash merge that landed on main (main may have moved past the branch's base since). */
async function landSquash(git: Git, branch: string, message: string): Promise<void> {
  await git.run(["merge", "--squash", branch]);
  await git.run(["commit", "-q", "-m", message]);
}

/** A person edits the status line by hand and commits it. */
async function personSets(ctx: StepContext, to: "merge-approved" | "done"): Promise<void> {
  await ctx.reload();
  await writeIntent(ctx.intent, { status: to, note: "" });
  await ctx.git.commitPaths([`intent/${ctx.slug}`], `person: ${to}`);
  await ctx.reload();
}

describe("review", () => {
  test("reviewing → merge-review with a person on the merge gate: the reviewer reads git but cannot write, and nothing reaches main", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runMergeStep(ctx));
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merge-review");
    expect(i.file.frontmatter.note).toBe(MERGE_WAIT_NOTE);
    expect(i.artifacts.has("review.md")).toBe(true);
    expect(gateRows(trace, "review")).toEqual(["findings:pass"]);
    expect(gateRows(trace, "merge")).toEqual(["up-to-date:pass", "tests:pass", "findings:pass"]);
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    const recorded = await Bun.file(argsFile).json();
    const allowed = recorded.args[recorded.args.indexOf("--allowedTools") + 1] as string;
    expect(allowed.split(",")).toEqual(expect.arrayContaining(["Read", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"]));
    expect(allowed).not.toContain("Edit");
    expect(recorded.args).toEqual(expect.arrayContaining(["--disallowedTools", "Edit,Write,NotebookEdit,PowerShell"]));
    expect(recorded.prompt).toContain("git diff main...HEAD");
    // The runtime ran the tests; the reviewer is told so and told not to run them.
    expect(recorded.prompt).toContain("The test command passed after the latest change.");
    expect(recorded.prompt).toContain("Do not run the tests yourself");
    trace.close(); repo.cleanup();
  });

  test("unfinished edits no test run has seen are reviewed with a prompt that says the tests have not run on them yet", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await Bun.write(join(ctx.worktreeDir, "src", "add.ts"), "export const add = (a: number, b: number) => a + b;\n");
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runMergeStep(ctx));
    const reviewPrompt = await Bun.file(join(ctx.runDir, "phases", `${trace.phases("add-numbers").find((p) => p.name === "review-1")!.seq}-review-1`, "prompt.md")).text();
    expect(reviewPrompt).toContain("The tests have not run on the latest change yet; the runtime runs them before merging.");
    trace.close(); repo.cleanup();
  });

  test("the reviewer reads the plan reconciled for this build, else main's plan, never the branch's", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await Bun.write(join(ctx.worktreeDir, "intent", "add-numbers", "plan.md"), "# Plan: from the branch\n");
    await new Git(ctx.worktreeDir).commitAll("a plan edited on the branch");
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runMergeStep(ctx));
    let prompt = (await Bun.file(argsFile).json()).prompt as string;
    expect(prompt).toContain("## Files that change\n- src/add.ts (new)");
    expect(prompt).not.toContain("from the branch");

    await writeIntent(ctx.intent, { status: "reviewing" });
    await new Git(repo.path).commitAll("review again");
    await ctx.reload();
    await Bun.write(join(ctx.runDir, "plan.reconciled.md"), "# Plan: reconciled for this build\n");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runMergeStep(ctx));
    prompt = (await Bun.file(argsFile).json()).prompt as string;
    expect(prompt).toContain("reconciled for this build");
    trace.close(); repo.cleanup();
  });

  test("the verdict comes from the findings: no important findings passes even if the reviewer did not approve", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await usePrompt(repo.path, "review", "{{spec}} FIXTURE:review-nits-unapproved");
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merge-review");
    expect(gateRows(trace, "review")).toEqual(["findings:pass"]);
    expect(trace.gates("add-numbers").find((g) => g.gate === "review")?.evidence).toContain("approved: false");
    trace.close(); repo.cleanup();
  });

  test("important findings trigger revise and the test loop, then review again; exhausted rounds block in plain words", async () => {
    const { repo, ctx, trace } = await built("stages:\n  review:\n    max_rounds: 1\n");
    await usePrompt(repo.path, "review", "{{spec}} FIXTURE:review-reject");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change. When that is sorted out, set status to plan-approved to try again.");
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("NaN"))).toBe(true);
    expect(phaseNames(trace).slice(-4)).toEqual(["review-1", "revise-1", "retest-1", "review-2"]);
    expect(gateRows(trace, "review")).toEqual(["findings:fail", "findings:fail"]);
    expect(await lastCommit(ctx.worktreeDir)).toContain("fix: handle NaN");
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("the review round survives a restart", async () => {
    const { repo, ctx, trace } = await built("stages:\n  review:\n    max_rounds: 1\n");
    await usePrompt(repo.path, "review", "{{spec}} FIXTURE:review-reject");
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "review-round"), "2");
    const before = phaseNames(trace).length;
    await runMergeStep(ctx);
    expect(phaseNames(trace).slice(before)).toEqual(["review-2"]);
    expect(await status(repo.path)).toBe("blocked");
    trace.close(); repo.cleanup();
  });

  test("unfinished edits left in the worktree are kept on the intent branch before review, never on main", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await Bun.write(join(ctx.worktreeDir, "src", "add.ts"), "export const add = (a: number, b: number) => a + b;\n");
    const mainBefore = await new Git(repo.path).headSha();
    await runMergeStep(ctx);
    const wt = new Git(ctx.worktreeDir);
    expect(await wt.isDirty()).toBe(false);
    expect((await wt.run(["log", "--format=%s", "main..HEAD"])).out).toContain("chore: keep unfinished changes");
    expect((await new Git(repo.path).run(["log", "--format=%s", `${mainBefore}..main`])).out).not.toContain("keep unfinished");
    expect(await status(repo.path)).toBe("merge-review");
    trace.close(); repo.cleanup();
  });

  test("review before and after commands run around the rounds, before the merge checks", async () => {
    const { repo, ctx, trace } = await built(`${PERSON_MERGES}stages:\n  review:\n    before:\n      - echo before\n    after:\n      - echo after\n`);
    const before = phaseNames(trace).length;
    await runMergeStep(ctx);
    // The merge checks do not run the tests again: they passed on this code, and main only gained records.
    expect(phaseNames(trace).slice(before)).toEqual(["review-before", "review-1", "review-after"]);
    expect(trace.gates("add-numbers").find((g) => g.gate === "merge" && g.check === "tests")?.evidence).toBe("the tests already passed on this code; only records under intent/ changed since");
    trace.close(); repo.cleanup();
  });

  test("a missing intent branch blocks with how to rebuild", async () => {
    const { repo, ctx, trace } = await built();
    const git = new Git(repo.path);
    await git.worktreeRemove(ctx.worktreeDir);
    await git.deleteBranch(ctx.branch);
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("plan-approved");
    expect(i.file.frontmatter.note).not.toContain("intent/");
    trace.close(); repo.cleanup();
  });
});

describe("merge", () => {
  test("with no person on the merge gate, the review step merges in the same step and cleans up", async () => {
    const { repo, ctx, trace } = await built();
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    expect(await new Git(repo.path).branchExists("intent/add-numbers")).toBe(false);
    expect(gateRows(trace, "merge")).toEqual(["up-to-date:pass", "tests:pass", "findings:pass"]);
    expect(existsSync(join(ctx.runDir, "merging"))).toBe(false);
    expect(existsSync(join(ctx.runDir, "review-round"))).toBe(false);
    // The next tick checks main's health, attributed to this change.
    expect(await Bun.file(join(repo.path, ".loopstra", "health-pending")).text()).toBe("add-numbers");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("approval through a pull request without a remote blocks plainly; merge-approved merges here instead", async () => {
    const { repo, ctx, trace } = await built("gates:\n  merge:\n    human: pr\n");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe(NO_REMOTE_PR_NOTE);
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    await personSets(ctx, "merge-approved");
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("with a person on the gate: merge-review waits, and merge-approved re-checks and merges", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await ctx.reload();
    expect(ctx.intent.file.frontmatter.status).toBe("merge-review");
    // Stepping the waiting status never advances and never merges.
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merge-review");
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);

    await personSets(ctx, "merge-approved");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merged");
    expect(i.file.frontmatter.resume_from).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    expect(await new Git(repo.path).branchExists("intent/add-numbers")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a person sets merge-approved without committing: the merge proceeds, and main gets one commit with the branch's tree", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    const git = new Git(repo.path);
    // The owner edits the status line and saves, but never commits.
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: merge-review", "status: merge-approved"));
    // An unsaved edit to another change's intent.md does not stand in the way either.
    mkdirSync(join(repo.path, "intent", "other"), { recursive: true });
    const other = join(repo.path, "intent", "other", "intent.md");
    await Bun.write(other, "---\nstatus: draft\n---\n# Intent: other\n");
    await git.commitPaths(["intent/other"], "other change");
    await Bun.write(other, "---\nstatus: draft\n---\n# Intent: other\n\nStill thinking.\n");
    await ctx.reload();
    const r = await runMergeStep(ctx);
    expect(r.ok).toBe(true);
    expect(await status(repo.path)).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    // The person's status edit is on main, and the other change's unsaved edit is still unsaved.
    const log = (await git.run(["log", "--format=%s", "main"])).out.split(/\r?\n/);
    expect(log).toContain("loopstra(add-numbers): record edits made by a person [skip ci]");
    expect(await Bun.file(other).text()).toContain("Still thinking.");
    expect((await git.run(["status", "--porcelain", "--untracked-files=no"])).out.trim()).toBe("M intent/other/intent.md");
    // The merge itself is one commit whose tree is the branch's (as it was when merged).
    const mergeCommit = (await git.run(["log", "--format=%H", "--grep", "^add-numbers: add numbers$", "main"])).out.trim().split(/\r?\n/);
    expect(mergeCommit).toHaveLength(1);
    expect((await git.run(["diff", "--name-only", `${mergeCommit[0]}^`, mergeCommit[0]!])).out.trim().split(/\r?\n/).sort()).toEqual(["src/add.ts", "tests/add.test.ts"]);
    expect((await git.run(["diff", "--cached", "--name-only"])).out.trim()).toBe("");
    trace.close(); repo.cleanup();
  });

  test("an unsaved queue.md (the generated queue, committed only along with other records) never holds up a merge", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await personSets(ctx, "merge-approved");
    const queue = join(repo.path, "intent", "queue.md");
    await Bun.write(queue, "# Queue\n\ncommitted\n");
    await ctx.git.commitPaths(["intent/queue.md"], "queue");
    await Bun.write(queue, "# Queue\n\nnewer, not committed\n");
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("an unsaved edit to a tracked source file outside intent/ still blocks the merge, and stays as it was", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await personSets(ctx, "merge-approved");
    await Bun.write(join(repo.path, "README.md"), "# test repo\n\nunsaved\n");
    const head = await new Git(repo.path).headSha();
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe(DIRTY_ROOT_NOTE);
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    expect(await Bun.file(join(repo.path, "README.md")).text()).toContain("unsaved");
    // Only the blocked status was recorded on main.
    expect((await new Git(repo.path).run(["diff", "--name-only", head, "main"])).out.trim()).toBe("intent/add-numbers/intent.md");
    trace.close(); repo.cleanup();
  });

  test("merge-approved reads the newest review verdict", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await personSets(ctx, "merge-approved");
    trace.gate("add-numbers", "review", "findings", "fail", "a later review found an important problem");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("important problems");
    expect(gateRows(trace, "merge").slice(-3)).toEqual(["up-to-date:pass", "tests:pass", "findings:fail"]);
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a rebase conflict blocks in plain words and leaves main clean", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await Bun.write(join(repo.path, "src", "add.ts"), "// main version\n");
    await new Git(repo.path).commitAll("conflicting change on main");
    await personSets(ctx, "merge-approved");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).not.toMatch(/<<<<|CONFLICT \(|\bgit\b|intent\/|rebase/);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a merge that git refuses blocks in plain words with detail in the trace", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await personSets(ctx, "merge-approved");
    // An untracked file on main that the merge would overwrite makes git refuse the merge itself.
    await Bun.write(join(repo.path, "src", "add.ts"), "// someone's scratch file\n");
    const git = new Git(repo.path);
    const head = await git.headSha();
    await runMergeStep(ctx);
    // Nothing landed: main only gained the blocked status, and nothing is staged.
    expect((await git.run(["diff", "--name-only", head, "main"])).out.trim()).toBe("intent/add-numbers/intent.md");
    expect((await git.run(["diff", "--cached", "--name-only"])).out.trim()).toBe("");
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("could not be merged");
    expect(i.file.frontmatter.note).not.toMatch(/CONFLICT|<<<<|git |intent\//i);
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("merge"))).toBe(true);
    expect(await Bun.file(join(repo.path, "src", "add.ts")).text()).toContain("scratch file");
    expect(existsSync(join(ctx.runDir, "merging"))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("unsaved changes in the main checkout block the merge, and a person's staged file is left staged", async () => {
    const { repo, ctx, trace } = await built();
    await Bun.write(join(repo.path, "README.md"), "# test repo\n\nwork in progress\n");
    const git = new Git(repo.path);
    await git.run(["add", "README.md"]);
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe(DIRTY_ROOT_NOTE);
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    expect((await git.run(["diff", "--cached", "--name-only"])).out.trim()).toBe("README.md");
    expect(await Bun.file(join(repo.path, "README.md")).text()).toContain("work in progress");
    trace.close(); repo.cleanup();
  });

  test("a cleanup failure is traced and the change is still merged; cleanup can be retried", async () => {
    const { repo, ctx, trace } = await built();
    const git = new Git(repo.path);
    // A locked worktree cannot be removed with a single --force.
    await git.run(["worktree", "lock", ctx.worktreeDir]);
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("cleanup"))).toBe(true);
    expect(existsSync(ctx.worktreeDir)).toBe(true);
    await git.run(["worktree", "unlock", ctx.worktreeDir]);
    expect(await cleanupChange(ctx)).toBe(true);
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    expect(await git.branchExists(ctx.branch)).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("resuming merge-approved after the merge landed records it as merged without merging twice", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await personSets(ctx, "merge-approved");
    // Stopped right after the merge commit, before the status was recorded.
    const git = new Git(repo.path);
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(join(ctx.runDir, "merging"), await git.headSha());
    await landSquash(git, ctx.branch, "add-numbers: add numbers");
    const merges = (await git.run(["log", "--format=%s", "main"])).out.split("\n").filter((l) => l.startsWith("add-numbers:")).length;
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect((await git.run(["log", "--format=%s", "main"])).out.split("\n").filter((l) => l.startsWith("add-numbers:")).length).toBe(merges);
    expect(await git.branchExists(ctx.branch)).toBe(false);
    expect(existsSync(join(ctx.runDir, "merging"))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("resuming reviewing after the merge landed (no person on the gate) records it as merged", async () => {
    const { repo, ctx, trace } = await built();
    const git = new Git(repo.path);
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(join(ctx.runDir, "merging"), await git.headSha());
    await landSquash(git, ctx.branch, "add-numbers: add numbers");
    const before = phaseNames(trace).length;
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect(phaseNames(trace).slice(before)).toEqual([]);
    expect(await git.branchExists(ctx.branch)).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a merge marker whose merge never landed is ignored", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    await personSets(ctx, "merge-approved");
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(join(ctx.runDir, "merging"), "stale");
    await runMergeStep(ctx);
    expect(await status(repo.path)).toBe("merged");
    expect(await onMain(repo.path, "src/add.ts")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("fixes the merge checks commit after approval go back to review before anything merges", async () => {
    const { repo, ctx, trace } = await built(PERSON_MERGES);
    await runMergeStep(ctx);
    // main moves on with a test the change does not satisfy yet; the fix makes it pass.
    await Bun.write(join(repo.path, "tests", "main.test.ts"), 'import { existsSync } from "node:fs";\nimport { expect, test } from "bun:test";\ntest("fixed", () => { expect(existsSync("FIXED")).toBe(true); });\n');
    await new Git(repo.path).commitAll("a new test on main");
    await usePrompt(repo.path, "fix", "{{failure_output}} FIXTURE:fix-writes-fixed");
    await personSets(ctx, "merge-approved");
    await runMergeStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("reviewing");
    expect(await onMain(repo.path, "FIXED")).toBe(false);
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    expect(await Bun.file(join(ctx.runDir, "review-round")).text()).toBe("2");

    await ctx.reload();
    const before = phaseNames(trace).length;
    await runMergeStep(ctx);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("merge-review");
    // The fix already passed the tests (merge-test-2 before the review); nothing moved since.
    expect(phaseNames(trace).slice(before)).toEqual(["review-2"]);
    expect(await onMain(repo.path, "FIXED")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("fixes after the last allowed review round block in plain words", async () => {
    const { repo, ctx, trace } = await built(`${PERSON_MERGES}stages:\n  review:\n    max_rounds: 1\n`);
    await runMergeStep(ctx);
    await Bun.write(join(ctx.runDir, "review-round"), "2");
    await Bun.write(join(repo.path, "tests", "main.test.ts"), 'import { existsSync } from "node:fs";\nimport { expect, test } from "bun:test";\ntest("fixed", () => { expect(existsSync("FIXED")).toBe(true); });\n');
    await new Git(repo.path).commitAll("a new test on main");
    await usePrompt(repo.path, "fix", "{{failure_output}} FIXTURE:fix-writes-fixed");
    await personSets(ctx, "merge-approved");
    await runMergeStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("reviewed as many times as allowed");
    expect(await onMain(repo.path, "src/add.ts")).toBe(false);
    trace.close(); repo.cleanup();
  });
});
