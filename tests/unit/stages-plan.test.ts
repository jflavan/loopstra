import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readIntent } from "../../src/intents";
import { runPlanStep } from "../../src/stages/plan";
import { setupRepo } from "./stages-design.test";

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
});
