import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import type { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runDesignStep } from "../../src/stages/design";
import { PLAN_AHEAD, runPlanStep } from "../../src/stages/plan";
import { resetStop } from "../../src/stop";
import { localDate } from "../../src/text";
import type { Trace } from "../../src/trace";
import { fixture, fixtureDir, openRepo, setupRepo, stopAfterPass, withEnv } from "../helpers";

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

/** A design step on the default config (after `first`, if given): spec-approved, with the plan written ahead kept. `designPhases` counts its rows. */
async function designed(config = "", first?: (repo: string) => Promise<void>) {
  const s = await setupRepo("accepted", { config });
  await first?.(s.repo.path);
  await runDesignStep(s.ctx);
  await s.ctx.dropSnapshot(); // the design step has ended: the plan step reads main afresh
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
    expect((await prompt("plan")).equals(await prompt("early-plan"))).toBe(true);
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
    ["code outside intent/ was committed (another change merged, say)", "the code on main changed", async ({ repo }) => commitFile(repo.path, "README.md", "# test repo\n\nMore.\n")],
    ["a new file outside intent/ was committed", "the code on main changed", async ({ repo }) => commitFile(repo.path, "src/new.ts", "export const x = 1;\n")],
    ["the kept base is not a commit id", "it could not be read", async ({ ctx }) => writeFileSync(join(ctx.runDir, PLAN_AHEAD), JSON.stringify({ ...keptPlan(ctx), base: "--cached" }))],
    ["the kept report says it failed", "it could not be read", async ({ ctx }) => {
      const kept = keptPlan(ctx) as { envelope: Record<string, unknown> };
      writeFileSync(join(ctx.runDir, PLAN_AHEAD), JSON.stringify({ ...kept, envelope: { ...kept.envelope, status: "fail" } }));
    }],
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

  test("not used when the plan's model changed while it was being written: it is keyed on the model it ran on", async () => {
    // The plan written ahead runs on opus (strong); while it runs, a person moves the plan stage to default (sonnet).
    const dir = fixtureDir({});
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const s = await designed("", async (path) => {
          const config = configPath(path);
          const moved = JSON.stringify({ type: "fake_action", write: { path: config, content: `${readFileSync(config, "utf8")}stages:\n  plan:\n    model: default\n` } });
          writeFileSync(join(dir.path, "plan@opus.jsonl"), `${moved}\n${fixture("plan")}`);
        });
        expect(readFileSync(configPath(s.repo.path), "utf8")).toContain("model: default"); // moved while it ran
        await runPlanStep(s.ctx);
        expect(phaseNames(s.trace).slice(s.designPhases)).toEqual(["plan", "plan-challenge"]);
        expect(planAheadNotes(s.trace).at(-1)).toBe(`not used: ${ASKED_ELSE}`);
        s.trace.close(); s.repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("still used whatever is left uncommitted in the main checkout: no session sees it, during the design step or after", async () => {
    const { repo, ctx, trace, designPhases } = await designed("", async (path) => { await Bun.write(join(path, "README.md"), "# test repo\n\nEdited.\n"); });
    await new Git(repo.path).run(["checkout", "--", "README.md"]);
    await Bun.write(join(repo.path, "src", "new.ts"), "export const x = 1;\n");
    await runPlanStep(ctx);
    expect(phaseNames(trace).slice(designPhases)).toEqual(["plan-challenge"]);
    expect(planAheadNotes(trace).at(-1)).toBe(USES);
    trace.close(); repo.cleanup();
  });

  test("still used when only a setting the plan does not see changed in loopstra/config.yaml", async () => {
    const s = await designed();
    const { ctx, trace } = await reopen(s, "signals:\n  main_health:\n    every_minutes: 45\n");
    await new Git(s.repo.path).commitAll("edit loopstra/config.yaml");
    await runPlanStep(ctx);
    expect(phaseNames(trace).slice(s.designPhases)).toEqual(["plan-challenge"]);
    expect(planAheadNotes(trace).at(-1)).toBe(USES);
    trace.close(); s.repo.cleanup();
  });

  test("still used when only intent/ changed on main (another change's bookkeeping)", async () => {
    const { repo, ctx, trace, designPhases } = await designed();
    await commitFile(repo.path, "intent/other-change/intent.md", "---\nstatus: draft\n---\n# Intent: other\n");
    await runPlanStep(ctx);
    expect(phaseNames(trace).slice(designPhases)).toEqual(["plan-challenge"]);
    expect(planAheadNotes(trace).at(-1)).toBe(USES);
    trace.close(); repo.cleanup();
  });

  test("a plan written ahead that plan-challenge rejects is written again by a fresh plan session, told the concerns", async () => {
    const dir = fixtureDir({ "plan-challenge-1": fixture("plan-challenge-reject") });
    try {
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

describe("cheaper judges on the plan challenge", () => {
  const SHADOW = "speed:\n  cheap_judges: shadow\n";

  test("shadow: a cheaper report that cannot be read is recorded as failed, and the strong judge decides", async () => {
    const dir = fixtureDir({ "plan-challenge@sonnet": fixture("plan-challenge").replace("\"approved\":true,", "") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await specApproved(SHADOW);
        await runPlanStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
        expect(trace.judgeRows()).toMatchObject([{ judge: "plan-challenge", cheap: "failed", strong: "pass" }]);
        expect(trace.phases("add-numbers").find((p) => p.name === "plan-challenge-cheap")?.status).toBe("fail");
        expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "files:pass", "plan-challenge:pass"]);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("shadow: a stop after the strong judge passed the plan, while the cheaper judge still runs, keeps the pass", async () => {
    await withEnv({ LOOPSTRA_FAKE_DELAY_MS: "plan-challenge@sonnet=60000" }, async () => {
      const { repo, ctx, trace } = await specApproved(SHADOW);
      const stopWatching = stopAfterPass(trace, repo.path, "plan-challenge", "plan-approved");
      try {
        expect(await runPlanStep(ctx)).toEqual({ ok: true });
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
        expect(trace.phases("add-numbers").find((p) => p.name === "plan-challenge-cheap")?.status).toBe("interrupted");
        expect(trace.judgeRows()).toEqual([]);
      } finally {
        stopWatching();
        resetStop();
        trace.close(); repo.cleanup();
      }
    });
  });

  test("shadow: a cheaper judge that cannot reach the assistant is dropped; the step passes on the strong verdict, unpaused", async () => {
    const dir = fixtureDir({ "plan-challenge@sonnet": fixture("outage") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await specApproved(SHADOW);
        expect((await runPlanStep(ctx)).ok).toBe(true);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
        expect(trace.judgeRows()).toEqual([]);
        const notes = trace.events("add-numbers").filter((e) => e.type === "command").map((e) => JSON.parse(e.payload) as { command: string; note?: string });
        expect(notes.find((n) => n.command === "plan-challenge-cheap")?.note).toStartWith("dropped: ");
        expect(existsSync(join(repo.path, ".loopstra", "paused.json"))).toBe(false);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });
});

describe("plan stage with standards", () => {
  const NO_AHEAD = "speed:\n  plan_ahead: false\n";
  const SECURITY = "# Security\n\n## Rules\n- SEC-1: no secrets in logs\n";
  const ARCH = "---\napplies_to:\n  - services/billing/**\n---\n# Service architecture\n\n## Rules\n- ARCH-1: billing goes through the gateway\n- ARCH-2: no direct table reads\n";
  /** The plan fixture, listing `files` and with `section` as its Standards section (JSON-escaped newlines). */
  const planWith = (files: string, section: string) => fixture("plan")
    .replace("- src/add.ts (new)\\n- tests/add.test.ts (new)", files)
    .replace("covering add(1, 2).\\n", `covering add(1, 2).\\n\\n## Standards\\n${section}\\n`);
  const gates = (trace: Trace) => trace.gates("add-numbers").map((g) => `${g.check}:${g.result}:${g.evidence}`);

  async function withStandards(repo: string): Promise<void> {
    mkdirSync(join(repo, "loopstra", "standards"), { recursive: true });
    await Bun.write(join(repo, "loopstra", "standards", "security.md"), SECURITY);
    await Bun.write(join(repo, "loopstra", "standards", "architecture.md"), ARCH);
    await new Git(repo).commitAll("standards");
  }

  async function planned(plan: string, extra: Record<string, string> = {}) {
    const dir = fixtureDir({ plan, ...extra });
    try {
      return await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const s = await specApproved(NO_AHEAD);
        await withStandards(s.repo.path);
        await s.ctx.dropSnapshot();
        await s.ctx.reload();
        await runPlanStep(s.ctx);
        return s;
      });
    } finally {
      dir.cleanup();
    }
  }

  const BILLING = "- services/billing/api.ts (new)";

  test("the plan's scoped standards come from its file list", async () => {
    const some = await planned(planWith(BILLING, "- SEC-1: not logged, Proof 1"));
    expect(gates(some.trace)[2]).toBe("standards:fail:missing ARCH-1, ARCH-2");
    some.trace.close(); some.repo.cleanup();
    const full = await planned(planWith(BILLING, "- SEC-1: ok, Proof 1\\n- ARCH-1: ok\\n- ARCH-2: does not apply: no reads"));
    expect(gates(full.trace)[2]).toBe("standards:pass:all 3 rules addressed");
    expect((await readIntent(full.repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    full.trace.close(); full.repo.cleanup();
    const docs = await planned(planWith("- docs/x.md (new)", "- SEC-1: not logged, Proof 1"));
    expect(gates(docs.trace)[2]).toBe("standards:pass:all 1 rules addressed");
    docs.trace.close(); docs.repo.cleanup();
  });

  test("a plan missing a rule that applies fails with the missing label", async () => {
    const s = await planned(planWith(BILLING, "- SEC-1: ok\\n- ARCH-1: ok"));
    expect((await readIntent(s.repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    expect(gates(s.trace)[2]).toBe("standards:fail:missing ARCH-2");
    expect(phaseNames(s.trace)).toEqual(["plan", "plan"]);
    s.trace.close(); s.repo.cleanup();
  });

  test("a concern with standard and blocking fails the gate, with the label in the evidence", async () => {
    const reject = fixture("plan-challenge-reject").replace('"blocking":true', '"blocking":true,"standard":"ARCH-2"');
    const s = await planned(planWith(BILLING, "- SEC-1: ok\\n- ARCH-1: ok\\n- ARCH-2: ok"), { "plan-challenge-1": reject });
    expect(gates(s.trace)).toContain("plan-challenge:fail:ARCH-2: Proof does not cover add(1, 2).");
    s.trace.close(); s.repo.cleanup();
  });

  test("the writer sees the spec view and the challenger the plan's view", async () => {
    const s = await planned(planWith(BILLING, "- SEC-1: ok\\n- ARCH-1: ok\\n- ARCH-2: ok"));
    const prompt = async (name: string) => {
      const p = s.trace.phases("add-numbers").find((x) => x.name === name)!;
      return Bun.file(join(s.ctx.runDir, "phases", `${p.seq}-${name}`, "prompt.md")).text();
    };
    const writer = await prompt("plan");
    expect(writer).toContain("Add `## Standards` after Proof.");
    expect(writer).toContain("These apply only to"); // ARCH is scoped, listed apart
    const challenger = await prompt("plan-challenge");
    expect(challenger).toContain("Check the plan against the standards below.");
    expect(challenger).not.toContain("These apply only to");
    s.trace.close(); s.repo.cleanup();
  });

  /** As planned, with `files` written into the change's folder (and committed) first, and more config. */
  async function plannedWith(plan: string, files: Record<string, string>, config = "") {
    const dir = fixtureDir({ plan });
    try {
      return await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const s = await specApproved(NO_AHEAD + config);
        await withStandards(s.repo.path);
        for (const [name, text] of Object.entries(files)) await Bun.write(join(s.repo.path, "intent", "add-numbers", name), text);
        await new Git(s.repo.path).commitAll("files");
        await s.ctx.dropSnapshot();
        await s.ctx.reload();
        await runPlanStep(s.ctx);
        return s;
      });
    } finally {
      dir.cleanup();
    }
  }

  const READS = "billing reads the orders table until it is migrated";
  const EXCEPTED = `- SEC-1: ok\\n- ARCH-1: exception: ${READS}\\n- ARCH-2: ok`;
  const recordOf = (reason: string) => `# Standards decisions for add-numbers\n\n## Exceptions approved\n- ARCH-1 at the spec: ${reason} (J., from the console, 2026-10-28)\n`;
  const record = (s: { repo: { path: string } }) => readFileSync(join(s.repo.path, "intent", "add-numbers", "standards.md"), "utf8");

  test("the plan repeating an exception approved at the spec goes straight to plan-approved", async () => {
    const s = await plannedWith(planWith(BILLING, EXCEPTED), { "standards.md": recordOf(READS) });
    const fm = (await readIntent(s.repo.path, "add-numbers")).file.frontmatter;
    expect(fm.status).toBe("plan-approved");
    expect(fm.plan_gate).toBeUndefined();
    s.trace.close(); s.repo.cleanup();
  });

  test("a new or reworded exception in the plan waits in plan-review with its own plan_gate", async () => {
    const cases: Record<string, string>[] = [{}, { "standards.md": recordOf("billing reads the orders table") }];
    for (const files of cases) {
      const s = await plannedWith(planWith(BILLING, EXCEPTED), files);
      const fm = (await readIntent(s.repo.path, "add-numbers")).file.frontmatter;
      expect(fm).toMatchObject({ status: "plan-review", plan_gate: "status" });
      expect(fm.note).toBe(`The plan asks for an exception to ARCH-1 (Service architecture): ${READS}. Read plan.md. To allow it, set status to plan-approved; to have the plan written again without it, send it back with a note.`);
      s.trace.close(); s.repo.cleanup();
    }
  });

  test("with a person on the plan gate, a plan with an exception waits with the exception's note and no plan_gate", async () => {
    const s = await plannedWith(planWith(BILLING, EXCEPTED), {}, HUMAN_PLAN);
    const fm = (await readIntent(s.repo.path, "add-numbers")).file.frontmatter;
    expect(fm.status).toBe("plan-review");
    expect(fm.plan_gate).toBeUndefined();
    expect(fm.note).toStartWith("The plan asks for an exception to ARCH-1 (Service architecture)");
    s.trace.close(); s.repo.cleanup();
  });

  test("a spec approved by a status edit has its exceptions recorded as the plan step starts", async () => {
    const spec = `# Spec\n\n## Summary\ns\n\n## Standards\n- ARCH-1: exception: ${READS}\n`;
    const before = localDate();
    const s = await plannedWith(planWith(BILLING, EXCEPTED), { "spec.md": spec });
    const expected = (date: string) => `# Standards decisions for add-numbers\n\n## Exceptions approved\n- ARCH-1 at the spec: ${READS} (a status edit, from intent.md, ${date})\n`;
    expect([expected(before), expected(localDate())]).toContain(record(s));
    // The plan repeats it: approved already.
    expect((await readIntent(s.repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    s.trace.close(); s.repo.cleanup();
  });

  test("a record naming a standard no longer on main does not stop the step", async () => {
    const s = await plannedWith(planWith(BILLING, "- SEC-1: ok\\n- ARCH-1: ok\\n- ARCH-2: ok"), { "standards.md": "# Standards decisions for add-numbers\n\n## Added\n- payments: card data (J., from the console, 2026-10-28)\n" });
    expect((await readIntent(s.repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    s.trace.close(); s.repo.cleanup();
  });

  test("a spec approved by a status edit with nothing new writes no record", async () => {
    const s = await plannedWith(planWith(BILLING, "- SEC-1: ok\\n- ARCH-1: ok\\n- ARCH-2: ok"), { "spec.md": "# Spec\n\n## Summary\ns\n\n## Standards\n- SEC-1: kept\n" });
    expect(existsSync(join(s.repo.path, "intent", "add-numbers", "standards.md"))).toBe(false);
    expect((await readIntent(s.repo.path, "add-numbers")).file.frontmatter.status).toBe("plan-approved");
    s.trace.close(); s.repo.cleanup();
  });

  /** A design step with standards, its plan written ahead kept (default config); `between` runs before the plan step. */
  async function aheadWith(between: (repo: string) => Promise<void>) {
    const dir = fixtureDir({ design: fixture("design").replace("## Areas of concern\\nNone.\\n", "## Areas of concern\\nNone.\\n\\n## Standards\\nNone."), plan: planWith("- docs/x.md (new)", "- SEC-1: ok") });
    try {
      return await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const s = await designed("", withStandards);
        await between(s.repo.path);
        await s.ctx.dropSnapshot();
        await s.ctx.reload();
        await runPlanStep(s.ctx);
        return s;
      });
    } finally {
      dir.cleanup();
    }
  }

  test("plan-ahead is still used when the standards did not change", async () => {
    const s = await aheadWith(async () => {});
    expect(planAheadNotes(s.trace).at(-1)).toBe(USES);
    s.trace.close(); s.repo.cleanup();
  });

  test("plan-ahead's key changes when standards change", async () => {
    const s = await aheadWith(async (repo) => commitFile(repo, "loopstra/standards/security.md", `${SECURITY}- SEC-2: tokens expire\n`));
    expect(planAheadNotes(s.trace).at(-1)).toBe(`not used: ${ASKED_ELSE}`);
    s.trace.close(); s.repo.cleanup();
  });
});
