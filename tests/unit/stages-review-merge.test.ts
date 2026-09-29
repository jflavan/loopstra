import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runBuildStep } from "../../src/stages/build";
import { runMergeStep } from "../../src/stages/merge";
import { runReviewStep } from "../../src/stages/review";
import { setupRepo } from "../helpers";

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
