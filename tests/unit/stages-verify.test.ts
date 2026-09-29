import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runVerifyStep } from "../../src/stages/verify";
import { setupRepo } from "../helpers";

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

  test("verify before and after commands run around the done-check and outcome", async () => {
    const { repo, ctx, trace } = await setupRepo("merged", { config: "stages:\n  verify:\n    before:\n      - echo before\n    after:\n      - echo after\n" });
    await Bun.write(join(repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n");
    await Bun.write(join(repo.path, "intent", "add-numbers", "plan.md"), "# Plan\n");
    await new Git(repo.path).commitAll("artifacts");
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(trace.phases("add-numbers").map((p) => p.name)).toEqual(["verify-before", "done-check", "lessons", "verify-after"]);
    trace.close(); repo.cleanup();
  });
});
