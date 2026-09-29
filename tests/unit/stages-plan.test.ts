import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runPlanStep } from "../../src/stages/plan";
import type { Trace } from "../../src/trace";
import { setupRepo } from "../helpers";

const HUMAN_PLAN = "gates:\n  plan:\n    human: status\n";

async function specApproved(config = "") {
  const s = await setupRepo("spec-approved", { config });
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n\n## Summary\ns\n");
  await new Git(s.repo.path).commitAll("spec");
  await s.ctx.reload();
  return s;
}

function statusesSeen(trace: Trace): string[] {
  return trace.events("add-numbers").filter((e) => e.type === "status_change").map((e) => (JSON.parse(e.payload) as { to: string }).to);
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

describe("plan stage", () => {
  test("with no human gate, spec-approved → plan-approved in one step with the checks run in that step", async () => {
    const { repo, ctx, trace } = await specApproved();
    const r = await runPlanStep(ctx);
    expect(r.ok).toBe(true);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("plan-approved");
    expect(i.artifacts.has("plan.md")).toBe(true);
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "files:pass", "plan-challenge:pass"]);
    expect(statusesSeen(trace)).not.toContain("plan-review");
    trace.close(); repo.cleanup();
  });

  test("with a human gate, checks pass and plan-review waits; stepping it again never advances", async () => {
    const { repo, ctx, trace } = await specApproved(HUMAN_PLAN);
    await runPlanStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("plan-review");
    expect(i.file.frontmatter.note).toContain("plan-approved");
    const phasesBefore = phaseNames(trace).length;
    await ctx.reload();
    await runPlanStep(ctx);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("plan-review");
    expect(phaseNames(trace).length).toBe(phasesBefore);
    trace.close(); repo.cleanup();
  });

  test("with a human gate and a challenge that always rejects, the step replans once and then blocks without reaching plan-review", async () => {
    const { repo, ctx, trace } = await specApproved(HUMAN_PLAN);
    await Bun.write(join(repo.path, "loopstra", "prompts", "plan-challenge.md"), "{{spec}} {{plan}} FIXTURE:plan-challenge-reject");
    const r = await runPlanStep(ctx);
    expect(r.ok).toBe(false);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["plan", "plan-challenge", "plan", "plan-challenge"]);
    expect(statusesSeen(trace)).not.toContain("plan-review");
    expect(i.file.frontmatter.note).toContain("plan-approved");
    expect(i.file.frontmatter.note).toContain("spec-approved");
    expect(i.file.frontmatter.note).not.toMatch(/plan-challenge|\(|:/);
    const second = await Bun.file(join(ctx.runDir, "phases", "3-plan", "prompt.md")).text();
    expect(second).toContain("Proof does not cover add(1, 2).");
    trace.close(); repo.cleanup();
  });

  test("the replan limit survives a restart: a replanned marker means the next failure blocks", async () => {
    const { repo, ctx, trace } = await specApproved();
    await Bun.write(join(repo.path, "loopstra", "prompts", "plan-challenge.md"), "{{spec}} {{plan}} FIXTURE:plan-challenge-reject");
    // As if killed after the automatic replan began: status planning with the marker set.
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "replanned"), "");
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: spec-approved", "status: planning"));
    await new Git(repo.path).commitAll("planning");
    await ctx.reload();
    await runPlanStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["plan", "plan-challenge"]);
    trace.close(); repo.cleanup();
  });

  test("a restart during the automatic replan sends the same concerns again", async () => {
    const { repo, ctx, trace } = await specApproved();
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "replanned"), "- The plan never says how add is tested.");
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: spec-approved", "status: planning"));
    await new Git(repo.path).commitAll("planning");
    await ctx.reload();
    await Bun.write(join(repo.path, "loopstra", "prompts", "plan.md"), "{{concerns}} FIXTURE:plan");
    await runPlanStep(ctx);
    const planPrompt = trace.phases("add-numbers").find((p) => p.name === "plan")!;
    const prompt = await Bun.file(join(ctx.runDir, "phases", `${planPrompt.seq}-plan`, "prompt.md")).text();
    expect(prompt).toContain("The plan never says how add is tested.");
    trace.close(); repo.cleanup();
  });

  test("when the plan challenger itself fails, the intent blocks without a replan", async () => {
    const { repo, ctx, trace } = await specApproved();
    await Bun.write(join(repo.path, "loopstra", "prompts", "plan-challenge.md"), "{{plan}} FIXTURE:budget");
    await runPlanStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["plan", "plan-challenge"]);
    expect(i.file.frontmatter.note).toContain("could not be checked");
    trace.close(); repo.cleanup();
  });

  test("a leftover replanned marker is cleared at spec-approved", async () => {
    const { repo, ctx, trace } = await specApproved();
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "replanned"), "");
    await runPlanStep(ctx);
    expect(existsSync(join(ctx.runDir, "replanned"))).toBe(false);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    trace.close(); repo.cleanup();
  });
});
