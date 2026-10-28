import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeMarker } from "../../src/context";
import { Git } from "../../src/git";
import { pauseAfterUnavailable, readPause } from "../../src/heartbeat";
import { readIntent } from "../../src/intents";
import { claim, release } from "../../src/lanes";
import { STANDARDS_APPLIED } from "../../src/stages/merge";
import { NEEDS_PERSON_DONE_NOTE, runVerifyStep, STANDARDS_UNMET_NOTE, UNMET_NOTE } from "../../src/stages/verify";
import { readOutcomeStandards } from "../../src/standards";
import { AssistantUnavailable } from "../../src/stop";
import type { PhaseRow, Trace } from "../../src/trace";
import { fixture, fixtureDir, setEnv, setupRepo, tempDir, withEnv, writeIntentOnDisk } from "../helpers";

async function merged(opts: { config?: string; doneCheck?: string; commands?: Record<string, string> } = {}) {
  const s = await setupRepo("merged", { config: opts.config, commands: opts.commands });
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "spec.md"), "# Spec\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), "# Plan\n");
  await Bun.write(join(s.repo.path, "intent", "add-numbers", "review.md"), "# Review\n");
  if (opts.doneCheck) await Bun.write(join(s.repo.path, "loopstra", "prompts", "done-check.md"), `{{done_when}} FIXTURE:${opts.doneCheck}`);
  await new Git(s.repo.path).commitAll("artifacts");
  await s.ctx.reload();
  return s;
}

async function outcomeOf(repo: string): Promise<string> {
  return Bun.file(join(repo, "intent", "add-numbers", "outcome.md")).text();
}

async function lessonsOf(repo: string): Promise<string> {
  return Bun.file(join(repo, "intent", "add-numbers", "lessons.md")).text();
}

/**
 * Whether lessons started before the done-check ended: true when they run together, false when lessons
 * waits for it. (Their sessions need not overlap in time: on a slow machine the done-check's copy of
 * main can take longer to make than the whole lessons session.)
 */
function together(doneCheck: PhaseRow, lessons: PhaseRow): boolean {
  return lessons.started < doneCheck.ended!;
}

/** The lessons row: early-lessons when it ran alongside the done-check, lessons when after it. */
function lessonsRow(trace: Trace): PhaseRow {
  return trace.phases("add-numbers").find((p) => p.name === "early-lessons" || p.name === "lessons")!;
}

function promptOf(runDir: string, p: PhaseRow): Promise<string> {
  return Bun.file(join(runDir, "phases", `${p.seq}-${p.name}`, "prompt.md")).text();
}

describe("verify stage", () => {
  test("lessons runs alongside the done-check; with speed.overlap_judges off, after it", async () => {
    // A long done-check: the two add their copies of main one after the other, and a slow machine takes a while over each.
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "done-check=4000,lessons=600" });
    try {
      for (const on of [true, false]) {
        const { repo, ctx, trace } = await merged({ config: `speed:
  overlap_judges: ${on}
` });
        await runVerifyStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
        const byName = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)!;
        expect(together(byName("done-check"), lessonsRow(trace))).toBe(on);
        // Lessons runs once either way: nothing failed while they ran together.
        expect(trace.phases("add-numbers").filter((p) => p.name.endsWith("lessons")).map((p) => p.name)).toEqual([on ? "early-lessons" : "lessons"]);
        expect(await lessonsOf(repo.path)).toContain("doc comment");
        trace.close(); repo.cleanup();
      }
    } finally {
      restore();
    }
  }, 90_000);

  test("with a daily budget, lessons runs alongside only when the day has room for two whole sessions", async () => {
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "done-check=4000,lessons=600" });
    try {
      // No session cap: the first session would hold the rest of the day and starve the other.
      for (const [config, overlaps] of [
        ["claude:\n  max_budget_usd_per_day: 5\n", false],
        ["claude:\n  max_budget_usd_per_day: 5\n  max_budget_usd: 3\n", false],
        ["claude:\n  max_budget_usd_per_day: 5\n  max_budget_usd: 2\n", true],
      ] as const) {
        const { repo, ctx, trace } = await merged({ config });
        await runVerifyStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
        const byName = (n: string) => trace.phases("add-numbers").find((p) => p.name === n)!;
        expect(together(byName("done-check"), lessonsRow(trace))).toBe(overlaps);
        trace.close(); repo.cleanup();
      }
    } finally {
      restore();
    }
  }, 90_000);

  test("with another change running a step, lessons runs alongside only when the day also has room for that change's session", async () => {
    claim("say-goodbye");
    try {
      // Two of this change's sessions plus one of the other's: $6 needed.
      for (const [config, overlaps] of [
        ["claude:\n  max_budget_usd_per_day: 5\n  max_budget_usd: 2\n", false],
        ["claude:\n  max_budget_usd_per_day: 7\n  max_budget_usd: 2\n", true],
      ] as const) {
        const { repo, ctx, trace } = await merged({ config });
        await runVerifyStep(ctx);
        expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
        expect(lessonsRow(trace).name).toBe(overlaps ? "early-lessons" : "lessons");
        trace.close(); repo.cleanup();
      }
    } finally {
      release("say-goodbye");
    }
  });

  test("lessons that cannot reach the assistant never turn a done-check failure into a pause: the change blocks", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "crash" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "lessons.md"), "{{review}} FIXTURE:usage-limit");
    await new Git(repo.path).commitAll("lessons prompt");
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    trace.close(); repo.cleanup();
  });

  test("when the done-check cannot be completed, the change blocks and the lessons that ran alongside are not written", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "crash" });
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("blocked");
    expect(existsSync(join(repo.path, "intent", "add-numbers", "lessons.md"))).toBe(false);
    expect(trace.phases("add-numbers").some((p) => p.name === "early-lessons")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("a usage limit on the done-check keeps the loop's pause growing, though lessons alongside reached the assistant", async () => {
    // The done-check takes a moment, so lessons has succeeded before it fails (a failure first cancels lessons).
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "done-check=2000" });
    try {
      const { repo, ctx, trace } = await merged({ doneCheck: "usage-limit" });
      pauseAfterUnavailable(repo.path);
      pauseAfterUnavailable(repo.path);
      expect(await runVerifyStep(ctx).catch((e: unknown) => e)).toBeInstanceOf(AssistantUnavailable);
      expect(lessonsRow(trace).status).toBe("success");
      // The scheduler counts this outage on top of the two before it, so the back-off keeps growing.
      expect(readPause(repo.path)?.failures).toBe(2);
      trace.close(); repo.cleanup();
    } finally {
      restore();
    }
  });

  test("lessons hear the fix history as it stands once the done-check ended; work that ran alongside is left out of it", async () => {
    // The done-check's first session crashes and its retry passes, while lessons runs alongside.
    const fixtures = tempDir("loopstra-fixtures-");
    copyFileSync(join(import.meta.dir, "..", "fake-claude", "fixtures", "crash.jsonl"), join(fixtures.path, "done-check-1.jsonl"));
    try {
      const { repo, ctx, trace } = await merged();
      for (const [name, error] of [["fix-1", "crash: the build broke"], ["early-review", "timeout: an optional review"]] as const) {
        trace.phaseEnd("add-numbers", trace.phaseStart("add-numbers", name, "agent"), { status: "fail", error });
      }
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, () => runVerifyStep(ctx));
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
      const rows = trace.phases("add-numbers");
      expect(rows.filter((p) => p.name.startsWith("done-check")).map((p) => [p.name, p.status])).toEqual([["done-check", "fail"], ["done-check-retry", "success"]]);
      // The lessons that ran alongside missed the done-check's failure, so lessons runs again, after it.
      const early = rows.find((p) => p.name === "early-lessons")!;
      const late = rows.find((p) => p.name === "lessons")!;
      expect(await promptOf(ctx.runDir, early)).not.toContain("done-check: crash");
      const told = await promptOf(ctx.runDir, late);
      expect(told).toContain("done-check: crash");
      expect(told).toContain("fix-1: crash: the build broke");
      expect(told).not.toContain("early-review");
      trace.close(); repo.cleanup();
    } finally {
      fixtures.cleanup();
    }
  });

  test("lessons are told the change's failed phases, but never a cheaper judge's failure", async () => {
    const { repo, ctx, trace } = await merged();
    const fail = (name: string, error: string) => trace.phaseEnd("add-numbers", trace.phaseStart("add-numbers", name, "agent"), { status: "fail", error });
    fail("spec-check-cheap", "invalid envelope from the cheaper judge");
    fail("build", "the build broke");
    await runVerifyStep(ctx);
    // Lessons ran alongside the done-check (early-lessons), and again after it only if the history changed.
    const told = trace.phases("add-numbers").filter((x) => x.name.endsWith("lessons"));
    expect(told.length).toBeGreaterThan(0);
    for (const p of told) {
      const prompt = await promptOf(ctx.runDir, p);
      expect(prompt).toContain("build: the build broke");
      expect(prompt).not.toContain("spec-check-cheap");
      expect(prompt).not.toContain("invalid envelope from the cheaper judge");
    }
    trace.close(); repo.cleanup();
  });

  test("merged → done: outcome.md for the owner, lessons.md for engineers, both written by the runtime and committed", async () => {
    const { repo, ctx, trace } = await merged({ config: "stages:\n  verify:\n    skills:\n      - checking-results\n" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    expect(i.file.frontmatter.note).toBe("");
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## Evidence");
    expect(outcome).not.toContain("Lessons");
    expect(outcome).not.toContain("CLAUDE.md");
    expect(outcome).not.toContain("For a person to confirm");
    const lessons = await lessonsOf(repo.path);
    expect(lessons).toContain("## Lessons");
    expect(lessons).toContain("## Proposed CLAUDE.md additions");
    expect(lessons).toContain("doc comment");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    expect((await new Git(repo.path).run(["cat-file", "-e", "main:intent/add-numbers/lessons.md"], true)).code).toBe(0);
    // Both judges are told the verify stage's skills.
    for (const name of ["done-check", "early-lessons"]) {
      const p = trace.phases("add-numbers").find((x) => x.name === name)!;
      expect(await Bun.file(join(ctx.runDir, "phases", `${p.seq}-${name}`, "prompt.md")).text()).toContain("`checking-results`");
    }
    expect(trace.gates("add-numbers").map((g) => `${g.gate}/${g.check}:${g.result}`)).toEqual(["done/done-check:pass"]);
    trace.close(); repo.cleanup();
  });

  test("the done-check is given the acceptance tests written from Done when, and told a passing one meets its criterion", async () => {
    const covered = "- add(1, 2) returns 3: `tests/accept.test.ts`, \"adds one and two\"";
    const accepted = `# Acceptance tests\n\nWritten from Done when before the build. The build may not change them.\n\n## Covered by tests\n${covered}\n\n## Not covered by a test\n- People find add easy to use: needs a person.\n`;
    const doneCheckPrompt = async (ctx: { runDir: string }, trace: Trace) => promptOf(ctx.runDir, trace.phases("add-numbers").find((p) => p.name === "done-check")!);
    {
      const { repo, ctx, trace } = await merged();
      await Bun.write(join(repo.path, "intent", "add-numbers", "acceptance.md"), accepted);
      await new Git(repo.path).commitAll("acceptance");
      await ctx.reload();
      writeMarker(ctx, "acceptance", JSON.stringify(["tests/accept.test.ts"]));
      await runVerifyStep(ctx);
      const prompt = await doneCheckPrompt(ctx, trace);
      expect(prompt).toContain(covered);
      expect(prompt).not.toContain("People find add easy to use");
      expect(prompt).toContain("A criterion covered by an acceptance test that passes in this copy of main is met");
      trace.close(); repo.cleanup();
    }
    {
      const { ctx, trace, repo } = await merged();
      await runVerifyStep(ctx);
      expect(await doneCheckPrompt(ctx, trace)).toContain("No acceptance tests were written for this change.");
      trace.close(); repo.cleanup();
    }
    {
      // acceptance.md from an earlier build, when this build wrote none (the setting was turned off
      // since): those tests were this build's to change, so the judge is not told they hold.
      const { repo, ctx, trace } = await merged();
      await Bun.write(join(repo.path, "intent", "add-numbers", "acceptance.md"), accepted);
      await new Git(repo.path).commitAll("acceptance");
      await ctx.reload();
      await runVerifyStep(ctx);
      const prompt = await doneCheckPrompt(ctx, trace);
      expect(prompt).toContain("No acceptance tests were written for this change.");
      expect(prompt).not.toContain(covered);
      trace.close(); repo.cleanup();
    }
    {
      // A repository's own done-check.md without {{acceptance}} still gets the list, at its end.
      const { repo, ctx, trace } = await merged({ doneCheck: "done-check" });
      await Bun.write(join(repo.path, "intent", "add-numbers", "acceptance.md"), accepted);
      await new Git(repo.path).commitAll("acceptance");
      await ctx.reload();
      writeMarker(ctx, "acceptance", JSON.stringify(["tests/accept.test.ts"]));
      await runVerifyStep(ctx);
      const prompt = await doneCheckPrompt(ctx, trace);
      expect(prompt).toContain(`passes in this copy of main is met, with the test as its evidence:\n\n${covered}\n`);
      trace.close(); repo.cleanup();
    }
    {
      // Without acceptance tests, an older prompt is left as it was.
      const { ctx, trace, repo } = await merged({ doneCheck: "done-check" });
      await runVerifyStep(ctx);
      expect(await doneCheckPrompt(ctx, trace)).not.toContain("acceptance");
      trace.close(); repo.cleanup();
    }
  });

  test("the done-check runs in a throwaway copy of main, so what it builds never reaches the owner's checkout", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-writes" });
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(existsSync(join(repo.path, "built-by-done-check.txt"))).toBe(false);
    expect(existsSync(join(repo.path, ".loopstra", "verify", "add-numbers"))).toBe(false);
    // Lessons read the step's snapshot of main, which goes once the step has ended.
    await ctx.dropSnapshot();
    expect((await new Git(repo.path).run(["worktree", "list"])).out.trim().split("\n")).toHaveLength(1);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("verify before and after commands run around the done-check and outcome", async () => {
    const { repo, ctx, trace } = await merged({ config: "stages:\n  verify:\n    before:\n      - echo before\n    after:\n      - echo after\n" });
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    const names = trace.phases("add-numbers").map((p) => p.name);
    // done-check and lessons run at the same time, so either may start first.
    expect([names[0], new Set(names.slice(1, 3)), names[3]]).toEqual(["verify-before", new Set(["done-check", "early-lessons"]), "verify-after"]);
    trace.close(); repo.cleanup();
  });

  test("with a person on the done gate: outcome and lessons are written, verifying waits, and the person sets done", async () => {
    const { repo, ctx, trace } = await merged({ config: "gates:\n  done:\n    human: status\n    agent: true\nstages:\n  verify:\n    after:\n      - echo after\n" });
    await runVerifyStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("verifying");
    expect(i.file.frontmatter.note).toContain("outcome.md");
    expect(i.file.frontmatter.note).toContain("done");
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## Evidence");
    expect(await lessonsOf(repo.path)).toContain("## Lessons");
    expect(trace.phases("add-numbers").map((p) => p.name).sort()).toEqual(["done-check", "early-lessons", "verify-after"]);
    expect(trace.phases("add-numbers").at(-1)!.name).toBe("verify-after");

    // Stepping the waiting status does nothing.
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("verifying");
    expect(trace.phases("add-numbers")).toHaveLength(3);

    await writeIntentOnDisk(ctx.intent, { status: "done", note: "" });
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    trace.close(); repo.cleanup();
  });

  test("unmet criteria block in plain words, with the outcome written for the person", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-unmet" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("not met");
    expect(i.file.frontmatter.note).toContain("outcome.md");
    expect(i.file.frontmatter.note).not.toContain("returns 4");
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## Not met");
    expect(outcome).toContain("add(1, 2) returns 3.");
    expect(await lessonsOf(repo.path)).toContain("## Lessons");
    trace.close(); repo.cleanup();
  });

  test("results that need a person never block: done, with a note and a section in outcome.md", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-needs-person" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("done");
    expect(i.file.frontmatter.note).toBe(NEEDS_PERSON_DONE_NOTE);
    const outcome = await outcomeOf(repo.path);
    expect(outcome).toContain("## For a person to confirm");
    expect(outcome).toContain("Accountants find it easier to use.");
    trace.close(); repo.cleanup();
  });

  test("a judge that cannot finish blocks as a failed check, never as criteria unmet", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "agent-fail" });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The final check could not be completed; an engineer should look. When that is sorted out, set status to merged to try again.");
    expect(i.file.frontmatter.resume_from).toBe("merged");
    expect(i.artifacts.has("outcome.md")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("an install that fails in the done-check's copy blocks as a failed check and never runs the judge", async () => {
    const { repo, ctx, trace } = await merged({ commands: { test: "echo ok", install: "echo no network && exit 3" } });
    await runVerifyStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toStartWith("The final check could not be completed; an engineer should look.");
    expect(trace.events("add-numbers").some((e) => e.type === "error" && e.payload.includes("install failed: no network"))).toBe(true);
    expect(trace.phases("add-numbers").some((p) => p.name === "done-check")).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("verifying with nobody on the done gate finishes as done", async () => {
    const { repo, ctx, trace } = await merged();
    await Bun.write(join(repo.path, "intent", "add-numbers", "outcome.md"), "# Outcome\n");
    await writeIntentOnDisk(ctx.intent, { status: "verifying" });
    await new Git(repo.path).commitAll("verifying");
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(trace.phases("add-numbers")).toHaveLength(0);
    trace.close(); repo.cleanup();
  });
});

describe("verify stage with standards", () => {
  const SOC2 = "# SOC 2\n\n## Rules\n- SOC-1: changes are reviewed\n";
  const SECRETS = "---\napplies_to:\n  - src/**\ncheck: \"true\"\n---\n# Secrets\n\n## Rules\n- SEC-1: no secrets in logs\n- SEC-2: tokens expire\n";
  const EXCEPTION = "# Standards decisions for add-numbers\n\n## Added\n- docs: the guide changes too (J., from the console, 2026-10-28)\n\n## Exceptions approved\n- SEC-2 at the plan: tokens are issued elsewhere (J., from the console, 2026-10-28)\n";
  const DOCS = "---\napplies_to:\n  - docs/**\n---\n# Docs\n\n## Rules\n- DOC-1: the guide stays current\n";

  /** The done-check fixture, answering Done when and with these rules judged. */
  const judged = (rules: Array<[string, string, string]>, criterion: "met" | "unmet" = "met") => fixture("done-check")
    .replace('"result":"met"', `"result":"${criterion}"`)
    .replace('"outcome_markdown"', `"standards":${JSON.stringify(rules.map(([label, result, evidence]) => ({ label, result, evidence })))},"outcome_markdown"`);

  async function done(rules: Array<[string, string, string]>, o: { config?: string; criterion?: "met" | "unmet"; record?: string; marker?: object | null; plan?: string; standards?: Record<string, string> } = {}) {
    const dir = fixtureDir({ "done-check": judged(rules, o.criterion) });
    return withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
      const s = await merged({ config: o.config });
      mkdirSync(join(s.repo.path, "loopstra", "standards"), { recursive: true });
      for (const [name, text] of Object.entries(o.standards ?? { soc2: SOC2, secrets: SECRETS })) await Bun.write(join(s.repo.path, "loopstra", "standards", `${name}.md`), text);
      if (o.plan) await Bun.write(join(s.repo.path, "intent", "add-numbers", "plan.md"), o.plan);
      if (o.record) await Bun.write(join(s.repo.path, "intent", "add-numbers", "standards.md"), o.record);
      await new Git(s.repo.path).commitAll("standards");
      await s.ctx.reload();
      if (o.marker !== null) writeMarker(s.ctx, STANDARDS_APPLIED, JSON.stringify(o.marker ?? { commit: "x", applying: [{ name: "soc2", why: "every", files: [] }, { name: "secrets", why: "files", files: ["src/add.ts"] }] }));
      s.trace.gate("add-numbers", "merge", "check:secrets", "pass", "ok");
      await runVerifyStep(s.ctx);
      dir.cleanup();
      return s;
    });
  }
  const note = async (repo: string) => (await readIntent(repo, "add-numbers")).file.frontmatter.note;

  test("outcome.md has the runtime's Standards section", async () => {
    const s = await done([["SOC-1", "met", "the pull request was reviewed"], ["SEC-1", "met", "no log line prints a token"]], { record: EXCEPTION, standards: { soc2: SOC2, secrets: SECRETS, docs: DOCS } });
    const outcome = await outcomeOf(s.repo.path);
    const sha = (await s.ctx.readCommit()).slice(0, 7);
    const section = outcome.slice(outcome.indexOf("## Standards"));
    expect(section).toBe([
      "## Standards",
      `The engineering rules this change was checked against (the standards as of commit ${sha}):`,
      "",
      "- SOC-1 (SOC 2): met: the pull request was reviewed",
      "- SEC-1 (Secrets): met: no log line prints a token",
      "- SEC-2 (Secrets): exception, approved by J. at the plan: tokens are issued elsewhere",
      "- Check of Secrets: passed at merge",
      "- Docs was added to this change by J.: the guide changes too",
      "",
    ].join("\n"));
    // The owner's sections come first, and the lines read back.
    expect(outcome.indexOf("## Evidence")).toBeLessThan(outcome.indexOf("## Standards"));
    expect(readOutcomeStandards(outcome).map((l) => `${l.label}:${l.result}`)).toEqual(["SOC-1:met", "SEC-1:met", "SEC-2:exception"]);
    expect(s.trace.lastGate("add-numbers", "done", "standards")).toMatchObject({ result: "pass" });
    expect((await readIntent(s.repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    s.trace.close(); s.repo.cleanup();
  });

  test("a rule the judge leaves out is needs-person, not judged; a label that did not apply is ignored; no marker falls back to the plan's files", async () => {
    const s = await done([["SOC-1", "met", "reviewed"], ["NOPE-1", "unmet", "not a rule here"]], { marker: null, plan: "# Plan\n\n## Files that change\n- src/add.ts (new)\n\n## Order of work\n1. Go.\n" });
    const outcome = await outcomeOf(s.repo.path);
    // The plan lists src/add.ts, so Secrets applies by the fallback.
    expect(outcome).toContain("- SEC-1 (Secrets): needs-person: not judged");
    expect(outcome).not.toContain("NOPE-1 (");
    expect(outcome).toContain("## For a person to confirm\n- SEC-1 not judged\n- SEC-2 not judged");
    expect(await note(s.repo.path)).toBe(NEEDS_PERSON_DONE_NOTE);
    s.trace.close(); s.repo.cleanup();
  });

  test("an unmet rule blocks, with the standards-only note", async () => {
    const s = await done([["SOC-1", "met", "reviewed"], ["SEC-1", "unmet", "a log line prints a token"], ["SEC-2", "met", "expiry is set"]]);
    const i = await readIntent(s.repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe(STANDARDS_UNMET_NOTE);
    expect(STANDARDS_UNMET_NOTE).toBe("The change merged, but the final check found engineering rules it does not keep. The details are in outcome.md. An engineer should decide whether to open a follow-up change, then set this one to done or closed.");
    expect(await outcomeOf(s.repo.path)).toContain("- SEC-1 (Secrets): unmet: a log line prints a token");
    expect(s.trace.lastGate("add-numbers", "done", "standards")).toMatchObject({ result: "fail" });
    s.trace.close(); s.repo.cleanup();
  });

  test("an unmet rule and an unmet criterion block with the existing note, naming the rules", async () => {
    const s = await done([["SOC-1", "unmet", "no review"], ["SEC-1", "met", "x"], ["SEC-2", "met", "y"]], { criterion: "unmet" });
    expect(await note(s.repo.path)).toBe(UNMET_NOTE.replace("Done when criteria that", "Done when criteria and engineering rules that"));
    s.trace.close(); s.repo.cleanup();
  });

  test("a rule judged with no evidence gets a line that still reads back", async () => {
    const s = await done([["SOC-1", "met", "  "], ["SEC-1", "met", "x"], ["SEC-2", "met", "y"]]);
    const outcome = await outcomeOf(s.repo.path);
    expect(outcome).toContain("- SOC-1 (SOC 2): met: no detail given\n");
    expect(readOutcomeStandards(outcome).find((l) => l.label === "SOC-1")).toEqual({ label: "SOC-1", title: "SOC 2", result: "met", evidence: "no detail given" });
    s.trace.close(); s.repo.cleanup();
  });

  test("a needs-person rule goes under For a person to confirm with its label", async () => {
    const s = await done([["SOC-1", "needs-person", "the alert exists in the monitoring system"], ["SEC-1", "met", "x"], ["SEC-2", "met", "y"]]);
    const outcome = await outcomeOf(s.repo.path);
    expect(outcome).toContain("## For a person to confirm\n- SOC-1 the alert exists in the monitoring system\n");
    expect(outcome).toContain("- SOC-1 (SOC 2): needs-person: the alert exists in the monitoring system");
    expect(await note(s.repo.path)).toBe(NEEDS_PERSON_DONE_NOTE);
    s.trace.close(); s.repo.cleanup();
  });

  test("gates.done.agent: false lists the rules as not checked automatically", async () => {
    const s = await done([], { config: "gates:\n  done:\n    agent: false\n" });
    const outcome = await outcomeOf(s.repo.path);
    expect(outcome).toContain("- SOC-1 (SOC 2): not checked automatically\n- SEC-1 (Secrets): not checked automatically\n- SEC-2 (Secrets): not checked automatically\n- Check of Secrets: passed at merge\n");
    expect(readOutcomeStandards(outcome).map((l) => l.result)).toEqual(["not-checked", "not-checked", "not-checked"]);
    expect(s.trace.phases("add-numbers").some((p) => p.name === "done-check")).toBe(false);
    s.trace.close(); s.repo.cleanup();
  });

  test("the done-check is given the applying standards with the instructions; a repository without standards is told nothing", async () => {
    const s = await done([["SOC-1", "met", "x"], ["SEC-1", "met", "x"], ["SEC-2", "met", "x"]], { marker: { commit: "x", applying: [{ name: "soc2", why: "every", files: [] }] } });
    const p = s.trace.phases("add-numbers").find((x) => x.name === "done-check")!;
    const prompt = await promptOf(s.ctx.runDir, p);
    expect(prompt).toContain("Standards this repository holds every change to:");
    expect(prompt).toContain("`standards`");
    expect(prompt).toContain("SOC-1");
    expect(prompt).not.toContain("SEC-1");
    s.trace.close(); s.repo.cleanup();
    const plain = await merged();
    await runVerifyStep(plain.ctx);
    expect(await outcomeOf(plain.repo.path)).not.toContain("## Standards");
    expect(plain.trace.gates("add-numbers").map((g) => g.gate)).toEqual(["done"]);
    plain.trace.close(); plain.repo.cleanup();
  });
});
