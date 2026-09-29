import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runDesignStep } from "../../src/stages/design";
import type { Trace } from "../../src/trace";
import { setupRepo } from "../helpers";

const HUMAN_SPEC = "gates:\n  spec:\n    human: status\n";

function statusesSeen(trace: Trace): string[] {
  return trace.events("add-numbers").filter((e) => e.type === "status_change").map((e) => (JSON.parse(e.payload) as { to: string }).to);
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

describe("design stage", () => {
  test("with no human gate, accepted → spec-approved in one step: spec written, checks run in the same step", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const r = await runDesignStep(ctx);
    expect(r.ok).toBe(true);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(i.file.frontmatter.priority).toBe("high");
    expect(i.artifacts.has("spec.md")).toBe(true);
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
    expect(statusesSeen(trace)).not.toContain("spec-review");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("with a human gate, checks run first and spec-review waits; stepping it again never advances", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: HUMAN_SPEC });
    await runDesignStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toContain("spec-approved");
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
    const phasesBefore = phaseNames(trace).length;

    await ctx.reload();
    const r = await runDesignStep(ctx);
    expect(r.ok).toBe(true);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(phaseNames(trace).length).toBe(phasesBefore);
    trace.close(); repo.cleanup();
  });

  test("a rejected spec is written once more with the findings, then blocks in plain words, never reaching spec-review", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: HUMAN_SPEC });
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{intent}} {{spec}} FIXTURE:spec-check-reject");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["intake", "design", "spec-check", "design", "spec-check"]);
    expect(statusesSeen(trace)).not.toContain("spec-review");
    const note = i.file.frontmatter.note;
    expect(note).toContain("spec-approved");
    expect(note).toContain("accepted");
    expect(note).not.toMatch(/spec-check|headings|\(|:/);
    const second = await Bun.file(join(ctx.runDir, "phases", "4-design", "prompt.md")).text();
    expect(second).toContain("negative numbers");
    trace.close(); repo.cleanup();
  });

  test("when the spec checker itself fails, the intent blocks without a rewrite", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{spec}} FIXTURE:budget");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(phaseNames(trace)).toEqual(["intake", "design", "spec-check"]);
    expect(i.file.frontmatter.note).toContain("could not be checked");
    trace.close(); repo.cleanup();
  });

  test("a leftover redesigned marker is cleared at accepted", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "redesigned"), "");
    await runDesignStep(ctx);
    expect(existsSync(join(ctx.runDir, "redesigned"))).toBe(false);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    trace.close(); repo.cleanup();
  });

  test("an owner's stated priority survives intake and is shown to the intake prompt", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: accepted\n", "status: accepted\npriority: urgent\n"));
    await new Git(repo.path).commitAll("owner priority");
    await ctx.reload();
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(i.file.frontmatter.priority).toBe("urgent");
    const intakePrompt = await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "phases", "1-intake", "prompt.md")).text();
    expect(intakePrompt).toContain("Priority the owner stated: urgent");
    trace.close(); repo.cleanup();
  });

  test("with no stated priority, intake's priority is written and the prompt says not stated", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await runDesignStep(ctx);
    const intakePrompt = await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "phases", "1-intake", "prompt.md")).text();
    expect(intakePrompt).toContain("Priority the owner stated: not stated");
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.priority).toBe("high");
    trace.close(); repo.cleanup();
  });

  test("intake with a question blocks the intent", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("Which portal page");
    trace.close(); repo.cleanup();
  });

  test("a failing before command blocks with a plain note; the command and its output go to the trace", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "stages:\n  design:\n    before:\n      - bun -e \"console.log('lint says no'); process.exit(3)\"\n" });
    const r = await runDesignStep(ctx);
    expect(r.ok).toBe(false);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("A project command that runs before the design stage failed. An engineer needs to look at it. When that is sorted out, set status to accepted to try again.");
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("lint says no"))).toBe(true);
    expect(phaseNames(trace)).toEqual(["design-before"]);
    trace.close(); repo.cleanup();
  });

  test("intake naming missing sections blocks with the section names and how to continue", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-missing");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("Done when");
    expect(i.file.frontmatter.note).toContain("set status to accepted");
    expect(phaseNames(trace)).toEqual(["intake"]);
    trace.close(); repo.cleanup();
  });
});
