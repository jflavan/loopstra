import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { pauseAfterUnavailable, readPause } from "../../src/heartbeat";
import { readIntent, writeIntent } from "../../src/intents";
import { NEEDS_PERSON_DONE_NOTE, runVerifyStep } from "../../src/stages/verify";
import { AssistantUnavailable } from "../../src/stop";
import type { PhaseRow, Trace } from "../../src/trace";
import { setEnv, setupRepo, tempDir, withEnv } from "../helpers";

async function merged(opts: { config?: string; doneCheck?: string } = {}) {
  const s = await setupRepo("merged", { config: opts.config });
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
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "600" });
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
  });

  test("with a daily budget, lessons runs alongside only when the day has room for two whole sessions", async () => {
    const restore = setEnv({ LOOPSTRA_FAKE_DELAY_MS: "600" });
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

  test("the done-check runs in a throwaway copy of main, so what it builds never reaches the owner's checkout", async () => {
    const { repo, ctx, trace } = await merged({ doneCheck: "done-check-writes" });
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(existsSync(join(repo.path, "built-by-done-check.txt"))).toBe(false);
    expect(existsSync(join(repo.path, ".loopstra", "verify", "add-numbers"))).toBe(false);
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

    await writeIntent(ctx.intent, { status: "done", note: "" });
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

  test("verifying with nobody on the done gate finishes as done", async () => {
    const { repo, ctx, trace } = await merged();
    await Bun.write(join(repo.path, "intent", "add-numbers", "outcome.md"), "# Outcome\n");
    await writeIntent(ctx.intent, { status: "verifying" });
    await new Git(repo.path).commitAll("verifying");
    await ctx.reload();
    await runVerifyStep(ctx);
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("done");
    expect(trace.phases("add-numbers")).toHaveLength(0);
    trace.close(); repo.cleanup();
  });
});
