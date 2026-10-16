import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "../../src/config";
import type { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runDesignStep } from "../../src/stages/design";
import { PLAN_AHEAD, runPlanStep } from "../../src/stages/plan";
import type { Trace } from "../../src/trace";
import { FAKE_CLAUDE, openRepo, setupRepo, tempDir, withEnv } from "../helpers";

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
  test("plan is read-only and runs in plan mode, like design", async () => {
    const { repo, ctx, trace } = await specApproved("gates:\n  plan:\n    agent: false\n");
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runPlanStep(ctx));
    expect(phaseNames(trace)).toEqual(["plan"]);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.args).toEqual(expect.arrayContaining(["--permission-mode", "plan", "--allowedTools", "Read,Glob,Grep"]));
    trace.close(); repo.cleanup();
  });

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

/** A design step on the default config: spec-approved, with the plan written ahead kept. `designPhases` counts its rows. */
async function designed(config = "") {
  const s = await setupRepo("accepted", { config });
  await runDesignStep(s.ctx);
  await s.ctx.reload();
  expect(s.ctx.intent.file.frontmatter.status).toBe("spec-approved");
  expect(existsSync(join(s.ctx.runDir, PLAN_AHEAD))).toBe(true);
  return { ...s, designPhases: phaseNames(s.trace).length };
}

/** A fresh trace and context, after the config changed (the context holds the config it was opened with). */
async function reopen(s: { repo: { path: string }; trace: Trace }, config: string) {
  s.trace.close();
  await Bun.write(configPath(s.repo.path), `${await Bun.file(configPath(s.repo.path)).text()}${config}`);
  return openRepo(s.repo.path);
}

/** What the trace says happened to plans written ahead, in order. */
function planAheadNotes(trace: Trace): string[] {
  return trace.events("add-numbers").filter((e) => e.type === "command").map((e) => JSON.parse(e.payload) as { command: string; note?: string })
    .filter((p) => p.command === "plan ahead").map((p) => p.note ?? "");
}

function keptPlan(ctx: StepContext): { key: string; base: string; envelope: { plan_markdown: string } } {
  return JSON.parse(readFileSync(join(ctx.runDir, PLAN_AHEAD), "utf8"));
}

async function commitFile(repo: string, path: string, text: string): Promise<void> {
  await Bun.write(join(repo, path), text);
  await new Git(repo).commitAll(`edit ${path}`);
}

const USES = "the plan step uses the plan written while the spec was being checked";
const ASKED_ELSE = "the intent, the spec, the plan prompt or its model changed";

describe("plan written ahead", () => {
  test("the plan step uses the plan written while the spec was being checked: no plan session, the same gates", async () => {
    const { repo, ctx, trace, designPhases } = await designed();
    const kept = keptPlan(ctx);
    await runPlanStep(ctx);
    expect(phaseNames(trace).slice(designPhases)).toEqual(["plan-challenge"]);
    expect(await Bun.file(join(repo.path, "intent", "add-numbers", "plan.md")).text()).toBe(kept.envelope.plan_markdown);
    expect(trace.gates("add-numbers").filter((g) => g.gate === "plan").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "files:pass", "plan-challenge:pass"]);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    expect(planAheadNotes(trace)).toEqual(["kept for the plan step", USES]);
    trace.close(); repo.cleanup();
  });

  test("the plan written ahead was asked exactly what the plan step asks: the prompts are byte for byte the same", async () => {
    const { repo, ctx, trace } = await designed();
    rmSync(join(ctx.runDir, PLAN_AHEAD));
    await runPlanStep(ctx);
    const prompt = async (name: string) => {
      const row = trace.phases("add-numbers").find((p) => p.name === name)!;
      return readFileSync(join(ctx.runDir, "phases", `${row.seq}-${name}`, "prompt.md"));
    };
    expect((await prompt("plan")).equals(await prompt("plan-ahead"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  // Each case changes something the plan read, or a rule, between the design step and the plan step.
  const misses: [string, string, (s: Awaited<ReturnType<typeof designed>>) => Promise<{ ctx: StepContext; trace: Trace } | void>, string[]?][] = [
    ["spec.md was edited", ASKED_ELSE, async ({ repo }) => commitFile(repo.path, "intent/add-numbers/spec.md", `${readFileSync(join(repo.path, "intent", "add-numbers", "spec.md"), "utf8")}\nAlso subtract.\n`)],
    ["the intent was edited", ASKED_ELSE, async ({ repo }) => {
      const path = join(repo.path, "intent", "add-numbers", "intent.md");
      await commitFile(repo.path, "intent/add-numbers/intent.md", readFileSync(path, "utf8").replace("- add(1, 2) returns 3.", "- add(1, 2) returns 3.\n- add(2, 2) returns 4."));
    }],
    ["the plan stage's model changed", ASKED_ELSE, (s) => reopen(s, "stages:\n  plan:\n    model: default\n")],
    ["the strong model changed", ASKED_ELSE, (s) => reopen(s, "claude:\n  models:\n    strong: opus-next\n")],
    ["the plan prompt was edited", ASKED_ELSE, async ({ repo }) => {
      const path = join(repo.path, "loopstra", "prompts", "plan.md");
      await Bun.write(path, `${readFileSync(path, "utf8")}\nKeep it short.\n`);
    }],
    ["speed.plan_ahead was switched off", "speed.plan_ahead is switched off", (s) => reopen(s, "speed:\n  plan_ahead: false\n")],
    ["the plan stage gained before commands", "the plan stage has before commands", (s) => reopen(s, "stages:\n  plan:\n    before:\n      - echo before\n"), ["plan-before", "plan", "plan-challenge"]],
    ["the kept file is not JSON", "it could not be read", async ({ ctx }) => writeFileSync(join(ctx.runDir, PLAN_AHEAD), "{not json")],
    ["the kept report has no plan", "it could not be read", async ({ ctx }) => {
      const kept = keptPlan(ctx) as { envelope: Record<string, unknown> };
      delete kept.envelope.plan_markdown;
      writeFileSync(join(ctx.runDir, PLAN_AHEAD), JSON.stringify(kept));
    }],
    ["code outside intent/ was committed", "the code on main changed", async ({ repo }) => commitFile(repo.path, "README.md", "# test repo\n\nMore.\n")],
    ["a tracked file outside intent/ was edited and not committed", "the code on main changed", async ({ repo }) => { await Bun.write(join(repo.path, "README.md"), "# test repo\n\nEdited.\n"); }],
  ];
  for (const [what, reason, change, phases] of misses) {
    test(`not used when ${what}: the plan step plans as usual`, async () => {
      const s = await designed();
      const { ctx, trace } = (await change(s)) ?? s;
      await ctx.reload();
      await runPlanStep(ctx);
      expect(phaseNames(trace).slice(s.designPhases)).toEqual(phases ?? ["plan", "plan-challenge"]);
      expect(planAheadNotes(trace).at(-1)).toBe(`not used: ${reason}`);
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
      expect((await readIntent(s.repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
      trace.close(); s.repo.cleanup();
    });
  }

  test("still used when only intent/ changed on main (another change's bookkeeping)", async () => {
    const { repo, ctx, trace, designPhases } = await designed();
    await commitFile(repo.path, "intent/other-change/intent.md", "---\nstatus: draft\n---\n# Intent: other\n");
    await runPlanStep(ctx);
    expect(phaseNames(trace).slice(designPhases)).toEqual(["plan-challenge"]);
    expect(planAheadNotes(trace).at(-1)).toBe(USES);
    trace.close(); repo.cleanup();
  });

  test("a plan written ahead that plan-challenge rejects is written again by a fresh plan session, told the concerns", async () => {
    const dir = tempDir("loopstra-fixtures-");
    try {
      writeFileSync(join(dir.path, "plan-challenge-1.jsonl"), readFileSync(join(dirname(FAKE_CLAUDE), "fixtures", "plan-challenge-reject.jsonl")));
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace, designPhases } = await designed();
        await runPlanStep(ctx);
        expect(phaseNames(trace).slice(designPhases)).toEqual(["plan-challenge", "plan", "plan-challenge"]);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
        const row = trace.phases("add-numbers").find((p) => p.name === "plan")!;
        expect(readFileSync(join(ctx.runDir, "phases", `${row.seq}-plan`, "prompt.md"), "utf8")).toContain("Proof does not cover add(1, 2).");
        expect(planAheadNotes(trace)).toEqual(["kept for the plan step", USES]);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("a restart at planning still uses the kept plan", async () => {
    const { repo, ctx, trace, designPhases } = await designed();
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await commitFile(repo.path, "intent/add-numbers/intent.md", readFileSync(path, "utf8").replace("status: spec-approved", "status: planning"));
    await ctx.reload();
    await runPlanStep(ctx);
    expect(phaseNames(trace).slice(designPhases)).toEqual(["plan-challenge"]);
    expect(planAheadNotes(trace).at(-1)).toBe(USES);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    trace.close(); repo.cleanup();
  });
});
