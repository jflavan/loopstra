import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readIntent } from "../../src/intents";
import { runPlanStep } from "../../src/stages/plan";
import { setupRepo } from "../helpers";

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

  test("replan limit survives a human plan gate", async () => {
    const { repo, ctx, trace } = await setupRepo("spec-approved", { config: "gates:\n  plan:\n    human: status\n" });
    await Bun.write(join(repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
    await Bun.write(join(repo.path, "loopstra", "prompts", "plan-challenge.md"), "{{spec}} {{plan}} FIXTURE:plan-challenge-reject");
    await ctx.reload();
    await runPlanStep(ctx); // -> plan-review
    await ctx.reload();
    await runPlanStep(ctx); // challenge rejects -> automatic replan -> plan-review
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("plan-review");
    await ctx.reload();
    await runPlanStep(ctx); // rejects again -> blocked
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    trace.close(); repo.cleanup();
  });

  test("a leftover replanned marker is cleared at spec-approved", async () => {
    const { repo, ctx, trace } = await setupRepo("spec-approved");
    await Bun.write(join(repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "replanned"), "");
    await ctx.reload();
    await runPlanStep(ctx);
    expect(existsSync(join(ctx.runDir, "replanned"))).toBe(false);
    trace.close(); repo.cleanup();
  });
});
