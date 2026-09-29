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
