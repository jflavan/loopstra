import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { claim, release } from "../../src/lanes";
import { runDesignStep } from "../../src/stages/design";
import { PLAN_AHEAD } from "../../src/stages/plan";
import { QuestionAsked, requestStop, resetStop, StopRequested } from "../../src/stop";
import { readConversation } from "../../src/conversation";
import { writeSentBack } from "../../src/context";
import type { Trace } from "../../src/trace";
import { FIRST_NEEDS } from "../../src/judges";
import { fixture, fixtureDir, judgeNotes, seedCaught, setEnv, setupRepo, stopAfterPass, withEnv } from "../helpers";

const HUMAN_SPEC = "gates:\n  spec:\n    human: status\n";

function statusesSeen(trace: Trace): string[] {
  return trace.events("add-numbers").filter((e) => e.type === "status_change").map((e) => (JSON.parse(e.payload) as { to: string }).to);
}

function phaseNames(trace: Trace): string[] {
  return trace.phases("add-numbers").map((p) => p.name);
}

/** The phases without the plan written alongside each spec-check (at most one per spec-check: a plan called off before it started has none). */
function withoutPlanAhead(trace: Trace): string[] {
  const names = phaseNames(trace);
  expect(names.filter((n) => n === "early-plan").length).toBeLessThanOrEqual(names.filter((n) => n === "spec-check").length);
  return names.filter((n) => n !== "early-plan");
}

/** What alongside traces for work called off because the judge's result could not use it. */
const CALLED_OFF = "cancelled: its result was no longer needed";

/** Makes every plan session hang until it is killed, so a test shows the step does not wait for it. */
async function hangingPlan(repo: string): Promise<void> {
  await Bun.write(join(repo, "loopstra", "prompts", "plan.md"), "{{intent}} {{spec}} {{concerns}} FIXTURE:hang");
}

/** What the trace says happened to plans written ahead, in order. */
function planAheadNotes(trace: Trace): string[] {
  return trace.events("add-numbers").filter((e) => e.type === "command").map((e) => JSON.parse(e.payload) as { command: string; note?: string })
    .filter((p) => p.command === "plan ahead").map((p) => p.note ?? "");
}

describe("design stage", () => {
  test("a change sent back with a note gives the note to the next design session, once", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      writeSentBack(repo.path, "add-numbers", "Cover negative numbers too.");
      await runDesignStep(ctx);
      const design = trace.phases("add-numbers").find((p) => p.name === "design")!;
      const prompt = await Bun.file(join(ctx.runDir, "phases", `${design.seq}-design`, "prompt.md")).text();
      expect(prompt).toContain("A person sent the earlier version back with this note:\nCover negative numbers too.");
      expect(existsSync(join(ctx.runDir, "sent-back.md"))).toBe(false);
    } finally {
      trace.close();
      repo.cleanup();
    }
  });

  test("a repository's older design.md without {{findings}} still gives the session the note", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const path = join(repo.path, "loopstra", "prompts", "design.md");
      await Bun.write(path, (await Bun.file(path).text()).replaceAll("{{findings}}", ""));
      writeSentBack(repo.path, "add-numbers", "Cover negative numbers too.");
      await runDesignStep(ctx);
      const design = trace.phases("add-numbers").find((p) => p.name === "design")!;
      const prompt = await Bun.file(join(ctx.runDir, "phases", `${design.seq}-design`, "prompt.md")).text();
      expect(prompt).toContain("A person sent the earlier version back with this note:\nCover negative numbers too.");
    } finally {
      trace.close();
      repo.cleanup();
    }
  });

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
    expect(withoutPlanAhead(trace)).toEqual(["intake", "design", "spec-check"]);
    expect(i.file.frontmatter.note).toContain("could not be checked");
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("design is read-only and runs in plan mode, like plan", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "gates:\n  spec:\n    agent: false\n" });
    const argsFile = join(repo.path, "args.json");
    await withEnv({ LOOPSTRA_FAKE_ARGS: argsFile }, () => runDesignStep(ctx));
    expect(phaseNames(trace)).toEqual(["intake", "design"]);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.env.LOOPSTRA_PHASE).toBe("design");
    expect(recorded.args).toEqual(expect.arrayContaining(["--permission-mode", "plan", "--allowedTools", "Read,Glob,Grep"]));
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

  test("intake with a question asks it: the change waits with question: open, not blocked", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    expect(await runDesignStep(ctx).then(() => null, (e: unknown) => e)).toBeInstanceOf(QuestionAsked);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).not.toBe("blocked");
    expect(i.file.frontmatter.question).toBe("open");
    expect(i.file.frontmatter.note).toBe("");
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

  test("with speed.plan_ahead off, the phases are exactly as before", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  plan_ahead: false\n" });
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    expect(phaseNames(trace)).toEqual(["intake", "design", "spec-check"]);
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("intake's question is recorded and its row ends asked; nothing else runs", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    expect(await runDesignStep(ctx).then(() => null, (e: unknown) => e)).toBeInstanceOf(QuestionAsked);
    expect(readConversation(repo.path, "add-numbers")).toContain("intake asks\nWhich portal page should show the status?");
    expect(trace.phases("add-numbers").map((p) => [p.name, p.status])).toEqual([["intake", "asked"]]);
    trace.close(); repo.cleanup();
  });
});

describe("plan ahead", () => {
  test("the first plan is written while spec-check runs, and kept in the run folder when the spec passes", async () => {
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "600" });
    try {
      const { repo, ctx, trace } = await setupRepo("accepted");
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
      expect(withoutPlanAhead(trace)).toEqual(["intake", "design", "spec-check"]);
      const byName = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)!;
      // Judged by start order: on a slow machine the two sessions need not overlap in time.
      expect(byName("early-plan").started < byName("spec-check").ended!).toBe(true);
      const kept = JSON.parse(await Bun.file(join(ctx.runDir, PLAN_AHEAD)).text()) as { key: string; base: string; envelope: { plan_markdown: string } };
      expect(kept.key).toContain(await Bun.file(join(repo.path, "intent", "add-numbers", "spec.md")).text());
      expect(kept.base).toMatch(/^[0-9a-f]{40}$/);
      expect(kept.envelope.plan_markdown).toContain("## Files that change");
      expect(existsSync(join(repo.path, "intent", "add-numbers", "plan.md"))).toBe(false);
      expect(planAheadNotes(trace)).toEqual(["kept for the plan step"]);
      // The session written ahead is the plan session: same phase for hooks and the fake.
      const prompt = await Bun.file(join(ctx.runDir, "phases", `${byName("early-plan").seq}-early-plan`, "prompt.md")).text();
      expect(prompt).toContain("add(1, 2) returns 3");
      trace.close(); repo.cleanup();
    } finally {
      restore();
    }
  });

  for (const [what, config, status] of [
    ["speed.plan_ahead is off", "speed:\n  plan_ahead: false\n", "spec-approved"],
    ["a person is on the spec gate", HUMAN_SPEC, "spec-review"],
    ["the plan stage has before commands", "stages:\n  plan:\n    before:\n      - echo before\n", "spec-approved"],
    ["a daily budget has no session cap", "claude:\n  max_budget_usd_per_day: 10\n", "spec-approved"],
    ["the spec gate has no judge", "gates:\n  spec:\n    agent: false\n", "spec-approved"],
  ] as const) {
    test(`no plan is written ahead when ${what}`, async () => {
      const { repo, ctx, trace } = await setupRepo("accepted", { config });
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe(status);
      expect(phaseNames(trace)).not.toContain("early-plan");
      expect(planAheadNotes(trace)).toEqual([]); // not even started and dropped
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
      trace.close(); repo.cleanup();
    });
  }

  test("with a session cap, a plan is written ahead only when the day has room for two whole sessions", async () => {
    // After intake and design (about $0.05), a day of 10 leaves room for two $1 sessions; a day of 1.6 does not.
    for (const [day, ahead] of [[10, true], [1.6, false]] as const) {
      const { repo, ctx, trace } = await setupRepo("accepted", { config: `claude:\n  max_budget_usd_per_day: ${day}\n  max_budget_usd: 1\n` });
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
      expect(phaseNames(trace).includes("early-plan")).toBe(ahead);
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(ahead);
      trace.close(); repo.cleanup();
    }
  });

  test("with another change running a step, a plan is written ahead only when the day also has room for that change's session", async () => {
    // After intake and design (about $0.05), a day of 2.5 has room for two $1 sessions, not three.
    for (const others of [0, 1]) {
      const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n" });
      if (others) claim("say-goodbye");
      try {
        await runDesignStep(ctx);
      } finally {
        release("say-goodbye");
      }
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
      expect(phaseNames(trace).includes("early-plan")).toBe(others === 0);
      trace.close(); repo.cleanup();
    }
  });

  test("a spec rejected once calls off the plan beside it at once; the second check gets a new one, and only that one is kept", async () => {
    const dir = fixtureDir({
      "spec-check-1": fixture("spec-check-reject"),
      "spec-check-2": fixture("spec-check"),
      "design-2": fixture("design").replace("Add an add function.", "Add an add function, for negative numbers too."),
    });
    try {
      // Plans take longer than the first check, so the first one is still running when the spec is rejected.
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path, LOOPSTRA_FAKE_DELAY_MS: "plan=1500" }, async () => {
        const { repo, ctx, trace } = await setupRepo("accepted");
        await runDesignStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        expect(withoutPlanAhead(trace)).toEqual(["intake", "design", "spec-check", "design", "spec-check"]);
        expect(planAheadNotes(trace)).toEqual([CALLED_OFF, "kept for the plan step"]);
        const kept = JSON.parse(await Bun.file(join(ctx.runDir, PLAN_AHEAD)).text()) as { key: string };
        expect(kept.key).toContain("for negative numbers too");
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("a spec rejected twice blocks with nothing kept, without waiting for the plans beside it", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{intent}} {{spec}} FIXTURE:spec-check-reject");
    await hangingPlan(repo.path);
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    expect(withoutPlanAhead(trace)).toEqual(["intake", "design", "spec-check", "design", "spec-check"]);
    expect(planAheadNotes(trace)).toEqual([CALLED_OFF, CALLED_OFF]);
    expect(trace.phases("add-numbers").filter((p) => p.name === "early-plan").every((p) => p.status === "interrupted")).toBe(true);
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("when the spec checker cannot run, the plan written alongside is called off and the change blocks at once", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{spec}} FIXTURE:budget");
    await hangingPlan(repo.path);
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.note).toContain("could not be checked");
    expect(planAheadNotes(trace)).toEqual([CALLED_OFF]);
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a plan that finished before the spec was rejected is not kept", async () => {
    // The checker takes longer than the plan, so the plan has an answer when the rejection comes.
    await withEnv({ LOOPSTRA_FAKE_DELAY_MS: "spec-check=1500" }, async () => {
      const { repo, ctx, trace } = await setupRepo("accepted");
      await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{intent}} {{spec}} FIXTURE:spec-check-reject");
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
      expect(planAheadNotes(trace)).toEqual(["not kept: the spec did not pass its check", "not kept: the spec did not pass its check"]);
      expect(trace.phases("add-numbers").filter((p) => p.name === "early-plan").map((p) => p.status)).toEqual(["success", "success"]);
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
      trace.close(); repo.cleanup();
    });
  });

  test("a stop after spec-check passed, while the plan still runs, keeps the pass and loses only the plan", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await hangingPlan(repo.path);
    // The pass is committed before the step waits for the plan: stop a moment after main has it.
    const committed = () => Bun.spawnSync({ cmd: ["git", "log", "-1", "--format=%s"], cwd: repo.path }).stdout.toString().includes("→ spec-approved");
    let asked = false;
    const watch = setInterval(() => { if (!asked && committed()) { asked = true; setTimeout(requestStop, 300); } }, 50);
    try {
      expect(await runDesignStep(ctx)).toEqual({ ok: true });
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
      expect(trace.phases("add-numbers").find((p) => p.name === "early-plan")?.status).toBe("interrupted");
      expect(planAheadNotes(trace)).toEqual(["not kept: stopped by request"]);
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    } finally {
      clearInterval(watch);
      resetStop();
      trace.close(); repo.cleanup();
    }
  });

  test("the plan written ahead reads the design step's snapshot of main, and is kept with the commit it read", async () => {
    const plan = fixture("plan").split("\n");
    plan.splice(1, 0, JSON.stringify({ type: "fake_action", write: { path: "NEW.md", content: "new\n" } }));
    const dir = fixtureDir({ "plan-1": plan.join("\n") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await setupRepo("accepted");
        await Bun.write(join(repo.path, "uncommitted.md"), "a person's work in progress\n");
        await runDesignStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        expect(planAheadNotes(trace)).toEqual(["kept for the plan step"]);
        // What a session leaves in its snapshot never reaches the main checkout.
        expect(existsSync(join(repo.path, "NEW.md"))).toBe(false);
        // The commit main was on when the step's first session started (the step had just recorded designing).
        const base = JSON.parse(readFileSync(join(ctx.runDir, PLAN_AHEAD), "utf8")).base as string;
        expect((await new Git(repo.path).run(["log", "-1", "--format=%s", base])).out).toContain("accepted → designing");
        expect((await new Git(repo.path).run(["cat-file", "-e", `${base}:uncommitted.md`], true)).code).not.toBe(0);
        await ctx.dropSnapshot();
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  for (const [status, config, ahead] of [
    ["merge-approved", "", false],
    ["reviewing", "", false],
    ["merge-review", "", false], // no person on the merge gate: it merges once its checks pass
    ["merge-review", "gates:\n  merge:\n    human: status\n", true], // waiting for a person
    ["building", "", true],
  ] as const) {
    test(`with another change at ${status}${config ? " (a person on the merge gate)" : ""}, a plan is ${ahead ? "" : "not "}written ahead`, async () => {
      const { repo, ctx, trace } = await setupRepo("accepted", { config });
      const other = join(repo.path, "intent", "other-change");
      mkdirSync(other, { recursive: true });
      const text = readFileSync(join(repo.path, "intent", "add-numbers", "intent.md"), "utf8").replace(/status: \S+/, `status: ${status}`);
      writeFileSync(join(other, "intent.md"), text);
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
      expect(phaseNames(trace).includes("early-plan")).toBe(ahead);
      trace.close(); repo.cleanup();
    });
  }

  test("a spec that fails its headings check is rewritten before any plan is written ahead", async () => {
    const dir = fixtureDir({ "design-1": fixture("design").replace("## Open questions\\nNone.\\n\\n", "") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await setupRepo("accepted");
        await runDesignStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        expect(withoutPlanAhead(trace)).toEqual(["intake", "design", "design", "spec-check"]);
        expect(phaseNames(trace).indexOf("early-plan")).toBeGreaterThan(phaseNames(trace).lastIndexOf("design"));
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  for (const [what, plan] of [
    ["reports it could not finish", fixture("agent-fail")],
    ["returns a report that cannot be read", fixture("plan").replace(/"plan_markdown":"[^"]*"/, "\"plan_md\":\"x\"")],
  ] as const) {
    test(`a plan written ahead that ${what} is not kept; the spec still passes`, async () => {
      const dir = fixtureDir({ "plan-1": plan });
      try {
        await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
          const { repo, ctx, trace } = await setupRepo("accepted");
          await runDesignStep(ctx);
          expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
          expect(trace.phases("add-numbers").find((p) => p.name === "early-plan")?.status).toBe("fail");
          expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
          expect(planAheadNotes(trace)).toEqual([]);
          trace.close(); repo.cleanup();
        });
      } finally {
        dir.cleanup();
      }
    });
  }

  test("a plan written ahead that cannot reach the assistant is dropped; the spec still passes", async () => {
    const dir = fixtureDir({ "plan-1": fixture("usage-limit") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await setupRepo("accepted");
        await runDesignStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        expect(trace.phases("add-numbers").find((p) => p.name === "early-plan")?.status).toBe("interrupted");
        expect(planAheadNotes(trace)).toHaveLength(1);
        expect(planAheadNotes(trace)[0]).toStartWith("dropped: ");
        expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("a stop requested while spec-check and the plan run ends both; the design starts over next time with nothing kept", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{spec}} FIXTURE:hang");
    await Bun.write(join(repo.path, "loopstra", "prompts", "plan.md"), "{{intent}} {{spec}} {{concerns}} FIXTURE:hang");
    const running = () => trace.phases("add-numbers").filter((p) => p.status === "running").map((p) => p.name).sort();
    const watch = setInterval(() => { if (running().length === 2) requestStop(); }, 50);
    try {
      expect(await runDesignStep(ctx).catch((e) => e)).toBeInstanceOf(StopRequested);
      const rows = trace.phases("add-numbers").filter((p) => p.name === "spec-check" || p.name === "early-plan");
      expect(rows.map((p) => `${p.name}:${p.status}`).sort()).toEqual(["early-plan:interrupted", "spec-check:interrupted"]);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("designing");
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    } finally {
      clearInterval(watch);
      resetStop();
      trace.close(); repo.cleanup();
    }
  });

  test("a plan.ahead found while designing is cleared before the spec is written", async () => {
    const { repo, ctx, trace } = await setupRepo("designing", { config: "speed:\n  plan_ahead: false\n" });
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, PLAN_AHEAD), "{\"key\":\"old\"}");
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(false);
    trace.close(); repo.cleanup();
  });
});

describe("cheaper judges on the spec check", () => {
  test("shadow: a cheaper pass of a spec the strong judge rejects changes nothing; the rewrite gets the strong judge's findings", async () => {
    const dir = fixtureDir({ "spec-check@sonnet": fixture("spec-check"), "spec-check@opus-1": fixture("spec-check-reject") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: shadow\n" });
        await runDesignStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        const second = trace.phases("add-numbers").filter((p) => p.name === "design")[1]!;
        expect(await Bun.file(join(ctx.runDir, "phases", `${second.seq}-design`, "prompt.md")).text()).toContain("The spec never mentions negative numbers.");
        // The cheaper judge writes no gate rows: only the strong spec-check's.
        expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:fail", "headings:pass", "spec-check:pass"]);
        expect(trace.judgeRows().map((r) => `${r.cheap}/${r.strong}`)).toEqual(["pass/reject", "pass/pass"]);
        expect(judgeNotes(trace)[0]).toBe("the cheaper judge (sonnet) passed what the strong judge (opus) rejected; the strong judge decided");
        expect(phaseNames(trace).filter((n) => n === "spec-check-cheap")).toHaveLength(2);
        trace.close(); repo.cleanup();
      });
    } finally {
      dir.cleanup();
    }
  });

  test("shadow alongside the plan written ahead needs room for three sessions", async () => {
    // After intake and design (about $0.05), a day of 2.5 with $1 sessions has room for two, not three.
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: shadow\nclaude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n" });
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    expect(phaseNames(trace)).toContain("early-plan");
    expect(phaseNames(trace)).not.toContain("spec-check-cheap");
    expect(judgeNotes(trace)).toEqual(["not compared: today's budget has no room for another session"]);
    expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("with no plan written ahead, the same day has room for the shadow beside spec-check", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: shadow\n  plan_ahead: false\nclaude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n" });
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    // The two judges start together, so either row may come first.
    expect(phaseNames(trace).slice(0, 2)).toEqual(["intake", "design"]);
    expect(phaseNames(trace).slice(2).sort()).toEqual(["spec-check", "spec-check-cheap"]);
    expect(trace.judgeRows().map((r) => `${r.cheap}/${r.strong}`)).toEqual(["pass/pass"]);
    trace.close(); repo.cleanup();
  });

  test("with room for three, the shadow runs beside spec-check and the plan written ahead, and all three are kept or recorded", async () => {
    await withEnv({ LOOPSTRA_FAKE_DELAY_MS: "600" }, async () => {
      const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: shadow\nclaude:\n  max_budget_usd_per_day: 10\n  max_budget_usd: 1\n" });
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
      const byName = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)!;
      // Judged by start order: on a slow machine the sessions need not overlap in time.
      expect(byName("spec-check-cheap").started < byName("spec-check").ended!).toBe(true);
      expect(byName("early-plan").started < byName("spec-check").ended!).toBe(true);
      expect(trace.judgeRows().map((r) => `${r.cheap}/${r.strong}`)).toEqual(["pass/pass"]);
      expect(existsSync(join(ctx.runDir, PLAN_AHEAD))).toBe(true);
      trace.close(); repo.cleanup();
    });
  });

  test("shadow: a stop after the strong judge passed the spec, while the cheaper judge and the plan still run, keeps the pass", async () => {
    await withEnv({ LOOPSTRA_FAKE_DELAY_MS: "spec-check@sonnet=60000" }, async () => {
      const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: shadow\n" });
      await hangingPlan(repo.path);
      const stopWatching = stopAfterPass(trace, repo.path, "spec-check", "spec-approved");
      try {
        expect(await runDesignStep(ctx)).toEqual({ ok: true });
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
        const status = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)?.status;
        expect([status("spec-check"), status("spec-check-cheap"), status("early-plan")]).toEqual(["success", "interrupted", "interrupted"]);
        expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
        // Only the comparison and the plan are lost.
        expect(trace.judgeRows()).toEqual([]);
        expect(judgeNotes(trace)).toEqual(["not compared: stopped by request"]);
        expect(planAheadNotes(trace)).toEqual(["not kept: stopped by request"]);
      } finally {
        stopWatching();
        resetStop();
        trace.close(); repo.cleanup();
      }
    });
  });

  test("shadow: a spec the strong judge rejects calls off the plan beside it at once, while the cheaper judge still runs", async () => {
    await withEnv({ LOOPSTRA_FAKE_DELAY_MS: "spec-check@sonnet=5000" }, async () => {
      // Restarted during the automatic rewrite, so one rejection blocks.
      const { repo, ctx, trace } = await setupRepo("designing", { config: "speed:\n  cheap_judges: shadow\n" });
      mkdirSync(ctx.runDir, { recursive: true });
      writeFileSync(join(ctx.runDir, "redesigned"), "- earlier findings\n");
      await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{intent}} {{spec}} FIXTURE:spec-check-reject");
      await hangingPlan(repo.path);
      await runDesignStep(ctx);
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
      expect(planAheadNotes(trace)).toEqual([CALLED_OFF]);
      // Called off once the strong judge rejected, not once the cheaper judge ended (it may not have
      // started its session yet); the comparison is still recorded.
      const calledOff = trace.events("add-numbers").find((e) => e.type === "command" && e.payload.includes("plan ahead"))!;
      const cheap = trace.phases("add-numbers").find((p) => p.name === "spec-check-cheap")!;
      expect(calledOff.ts < cheap.ended!).toBe(true);
      expect(trace.judgeRows().map((r) => `${r.cheap}/${r.strong}`)).toEqual(["reject/reject"]);
      trace.close(); repo.cleanup();
    });
  });

  test("first, earned: a cheaper pass decides alone and the gate's evidence names the cheaper judge", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "speed:\n  cheap_judges: first\n" });
    seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
    await runDesignStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("spec-approved");
    // The plan is written beside the judge, which here is the cheaper one alone.
    expect(phaseNames(trace)).toContain("early-plan");
    expect(phaseNames(trace).filter((n) => n !== "early-plan")).toEqual(["intake", "design", "spec-check-cheap"]);
    expect(trace.gates("add-numbers").find((g) => g.check === "spec-check")?.evidence).toBe("spec covers the intent (decided by the cheaper judge, sonnet)");
    trace.close(); repo.cleanup();
  });
});
