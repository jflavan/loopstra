import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { pauseAfterUnavailable, readPause } from "../../src/heartbeat";
import { AUDIT_EVERY, FIRST_NEEDS, judgeReport, runJudge, templateSha } from "../../src/judges";
import { claim, release } from "../../src/lanes";
import { templatePath } from "../../src/package";
import type { AgentPhaseSpec } from "../../src/phases";
import { AssistantUnavailable, requestStop, resetStop, StopRequested } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { fixture, fixtureDir, judgeNotes, seedCaught, setupRepo, withEnv } from "../helpers";

const SHADOW = "speed:\n  cheap_judges: shadow\n";
const FIRST = "speed:\n  cheap_judges: first\n";
const SPEC_CHECK: AgentPhaseSpec & { name: "spec-check" } = { name: "spec-check", permissionMode: "default", tools: "read", vars: { intent: "add numbers", spec: "# Spec" } };

/** A LOOPSTRA_FAKE_FIXTURE_DIR holding these fixtures (name without .jsonl → text), plus the calls and prompts files. */
function fakeDir(files: Record<string, string>) {
  const dir = fixtureDir(files);
  const calls = join(dir.path, "calls.jsonl");
  const prompts = join(dir.path, "prompts.jsonl");
  return {
    env: { LOOPSTRA_FAKE_FIXTURE_DIR: dir.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts },
    /** The --model of each session, in the order they started. */
    models: () => readLines(calls).map((args: string[]) => args[args.indexOf("--model") + 1]),
    prompts: () => readLines(prompts) as Array<{ args: string[]; prompt: string }>,
    cleanup: dir.cleanup,
  };
}

function readLines(path: string) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function phase(trace: Trace, name: string) {
  return trace.phases("add-numbers").find((p) => p.name === name);
}

/** A repo set up with `config`, the fake fixtures `files`, run with `fn`; everything is cleaned up after. */
async function withRepo(config: string, files: Record<string, string>, fn: (s: Awaited<ReturnType<typeof setupRepo>> & { fake: ReturnType<typeof fakeDir> }) => Promise<void>, env: Record<string, string> = {}) {
  const fake = fakeDir(files);
  const s = await setupRepo("designing", { config });
  try {
    await withEnv({ ...fake.env, ...env }, () => fn({ ...s, fake }));
  } finally {
    s.trace.close(); s.repo.cleanup(); fake.cleanup();
  }
}

describe("runJudge off, or not applicable", () => {
  test("off: one session on the strong model and no judges row", async () => {
    await withRepo("", {}, async ({ ctx, trace, fake }) => {
      const r = await runJudge(ctx, SPEC_CHECK);
      expect(r).toMatchObject({ ok: true, decidedBy: "strong" });
      expect(fake.models()).toEqual(["opus"]);
      expect(trace.judgeRows()).toEqual([]);
    });
  });

  for (const [what, config, spec] of [
    ["the cheaper model is the strong one", `${SHADOW}claude:\n  models:\n    default: opus\n`, SPEC_CHECK],
    ["the judge runs on the default model (stages.design.steps.spec-check: default)", `${SHADOW}stages:\n  design:\n    steps:\n      spec-check: default\n`, SPEC_CHECK],
  ] as const) {
    test(`not applicable when ${what}: one session and no row under shadow`, async () => {
      await withRepo(config, {}, async ({ ctx, trace, fake }) => {
        expect(await runJudge(ctx, spec)).toMatchObject({ ok: true, decidedBy: "strong" });
        expect(fake.models()).toHaveLength(1);
        expect(trace.judgeRows()).toEqual([]);
        expect(judgeNotes(trace)).toEqual([]);
      });
    });
  }

  for (const [mode, config] of [["shadow", SHADOW], ["first", FIRST]] as const) {
    test(`${mode}: a judge on max gets no cheaper judge`, async () => {
      await withRepo(`${config}stages:\n  design:\n    steps:\n      spec-check: max\n`, {}, async ({ repo, ctx, trace, fake }) => {
        // Even a cheaper judge that has earned first does not stand in for one a person put on max.
        if (mode === "first") seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
        expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true, decidedBy: "strong" });
        expect(fake.models()).toEqual(["fable"]);
        expect(trace.phases("add-numbers").map((p) => p.name)).toEqual(["spec-check"]);
        expect(trace.judgeRows().filter((r) => r.slug === "add-numbers")).toEqual([]);
        const why = judgeReport(ctx.cfg, [], {}).judges.find((j) => j.judge === "spec-check")!.why;
        expect(why).toContain("already runs on fable");
      });
    });
  }

  test("with no repository prompt, the judge uses the shipped one and its sha", async () => {
    await withRepo(SHADOW, {}, async ({ repo, ctx, trace }) => {
      rmSync(join(repo.path, "loopstra", "prompts", "spec-check.md"));
      expect(templateSha(repo.path, "spec-check")).toBe(createHash("sha256").update(readFileSync(templatePath("prompts", "spec-check.md"), "utf8")).digest("hex"));
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true });
      const rows = trace.judgeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.template_sha).toBe(templateSha(repo.path, "spec-check")!);
    });
  });
});

describe("runJudge shadow", () => {
  test("both judges run together on the same prompt; the strong verdict is returned and the comparison recorded", async () => {
    await withRepo(SHADOW, { "spec-check@sonnet": fixture("spec-check"), "spec-check@opus": fixture("spec-check-reject") }, async ({ ctx, trace, fake }) => {
      const r = await runJudge(ctx, SPEC_CHECK);
      expect(r).toMatchObject({ ok: true, decidedBy: "strong", envelope: { approved: false } });
      expect(fake.models().sort()).toEqual(["opus", "sonnet"]);
      const [a, b] = fake.prompts();
      expect(a!.prompt).toBe(b!.prompt);
      // Judged by start order: on a slow machine the two sessions need not overlap in time.
      const [strong, cheap] = [phase(trace, "spec-check")!, phase(trace, "spec-check-cheap")!];
      expect(cheap.started < strong.ended! && strong.started < cheap.ended!).toBe(true);
      expect(trace.judgeRows()).toMatchObject([{ slug: "add-numbers", judge: "spec-check", trace_name: "spec-check", mode: "shadow", how: "shadow", cheap_model: "sonnet", strong_model: "opus", cheap: "pass", strong: "reject", cheap_usd: 0.03, strong_usd: 0.03 }]);
      const row = trace.judgeRows()[0]!;
      expect(row.template_sha).toBe(templateSha(ctx.root, "spec-check")!);
      expect(row.prompt_sha).toMatch(/^[0-9a-f]{64}$/);
      expect(row.cheap_ms).toBeGreaterThan(0);
      expect(judgeNotes(trace)).toEqual(["the cheaper judge (sonnet) passed what the strong judge (opus) rejected; the strong judge decided"]);
    }, { LOOPSTRA_FAKE_DELAY_MS: "600" });
  });

  test("a cheaper judge whose report cannot be read is recorded as failed; the strong judge decides", async () => {
    const invalid = fixture("spec-check").replace("\"approved\":true,", "");
    await withRepo(SHADOW, { "spec-check@sonnet": invalid }, async ({ ctx, trace }) => {
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true, decidedBy: "strong", envelope: { approved: true } });
      expect(trace.judgeRows()).toMatchObject([{ cheap: "failed", strong: "pass", cheap_usd: null }]);
      expect(phase(trace, "spec-check-cheap")?.status).toBe("fail");
      expect(phase(trace, "spec-check-cheap-retry")).toBeUndefined();
    });
  });

  test("a cheaper judge that crashes is never retried: it is recorded as failed and the strong judge decides", async () => {
    await withRepo(SHADOW, { "spec-check@sonnet": fixture("crash") }, async ({ ctx, trace }) => {
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true, decidedBy: "strong", envelope: { approved: true } });
      expect(trace.judgeRows()).toMatchObject([{ cheap: "failed", strong: "pass" }]);
      expect(phase(trace, "spec-check-cheap")?.status).toBe("fail");
      expect(phase(trace, "spec-check-cheap-retry")).toBeUndefined();
    });
  });

  test("a cheaper judge that cannot reach the assistant is dropped with no row; the strong verdict stands", async () => {
    await withRepo(SHADOW, { "spec-check@sonnet": fixture("outage") }, async ({ ctx, trace }) => {
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true, decidedBy: "strong" });
      expect(trace.judgeRows()).toEqual([]);
      const dropped = trace.events("add-numbers").filter((e) => e.type === "command").map((e) => JSON.parse(e.payload) as { command: string; note: string });
      expect(dropped.find((d) => d.command === "spec-check-cheap")?.note).toStartWith("dropped: ");
    });
  });

  test("a strong judge that cannot reach the assistant cancels the cheaper one at once and throws; no row", async () => {
    // The cheaper judge would take 30 seconds: it is cancelled, not waited for.
    await withRepo(SHADOW, { "spec-check@opus": fixture("outage") }, async ({ ctx, trace }) => {
      const started = Date.now();
      expect(await runJudge(ctx, SPEC_CHECK).catch((e) => e)).toBeInstanceOf(AssistantUnavailable);
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(phase(trace, "spec-check-cheap")).toMatchObject({ status: "interrupted", error: "cancelled: its result was no longer needed" });
      expect(trace.judgeRows()).toEqual([]);
    }, { LOOPSTRA_FAKE_DELAY_MS: "spec-check@sonnet=30000" });
  });

  for (const mode of ["shadow", "first"] as const) {
    test(`${mode}: a cheaper judge that gets through does not end the pause while the strong model is still out`, async () => {
      const files = { "spec-check@opus": fixture("outage"), "spec-check@sonnet": fixture("spec-check-reject") };
      await withRepo(mode === "shadow" ? SHADOW : FIRST, files, async ({ repo, ctx, trace }) => {
        if (mode === "first") seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
        pauseAfterUnavailable(ctx.root);
        pauseAfterUnavailable(ctx.root);
        expect(await runJudge(ctx, SPEC_CHECK).catch((e) => e)).toBeInstanceOf(AssistantUnavailable);
        expect(phase(trace, "spec-check-cheap")?.status).toBe("success");
        // The back-off keeps climbing: the next pause is the third in a row.
        expect(readPause(ctx.root)?.failures).toBe(2);
        expect(pauseAfterUnavailable(ctx.root).failures).toBe(3);
      // In shadow the strong judge's outage comes late, so the cheaper judge has got through before it.
      }, { LOOPSTRA_FAKE_DELAY_MS: "spec-check@opus=2000" });
    });
  }

  test("each review round is its own question: the commit under review is part of the prompt's sha", async () => {
    const files = { "review@sonnet": fixture("review-reject"), "review@opus": fixture("review-reject") };
    await withRepo(SHADOW, files, async ({ repo, ctx, trace }) => {
      const review: AgentPhaseSpec & { name: "review" } = {
        name: "review", model: "strong", permissionMode: "default", tools: "read+git", cwd: repo.path, vars: { spec: "# Spec", plan: "# Plan", test_result: "TESTS_PASSED" },
      };
      await runJudge(ctx, review);
      await runJudge(ctx, review);
      await Bun.write(join(repo.path, "revised.txt"), "revised");
      await new Git(repo.path).commitAll("revise");
      await runJudge(ctx, review);
      const [a, b, c] = trace.judgeRows().map((r) => r.prompt_sha);
      expect(a).toBe(b);
      expect(c).not.toBe(a);
    });
  });

  test("a stop while both run ends both rows interrupted and writes no row", async () => {
    await withRepo(SHADOW, {}, async ({ repo, ctx, trace }) => {
      await Bun.write(join(repo.path, "loopstra", "prompts", "spec-check.md"), "{{spec}} FIXTURE:hang");
      const running = () => trace.phases("add-numbers").filter((p) => p.status === "running").length;
      const watch = setInterval(() => { if (running() === 2) requestStop(); }, 50);
      try {
        expect(await runJudge(ctx, SPEC_CHECK).catch((e) => e)).toBeInstanceOf(StopRequested);
        expect(trace.phases("add-numbers").map((p) => `${p.name}:${p.status}`).sort()).toEqual(["spec-check-cheap:interrupted", "spec-check:interrupted"]);
        expect(trace.judgeRows()).toEqual([]);
      } finally {
        clearInterval(watch);
        resetStop();
      }
    });
  });

  test("with no room in the day's budget for another session, only the strong judge runs and the trace says so", async () => {
    await withRepo(`${SHADOW}claude:\n  max_budget_usd_per_day: 10\n`, {}, async ({ ctx, trace, fake }) => {
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true, decidedBy: "strong" });
      expect(fake.models()).toEqual(["opus"]);
      expect(trace.judgeRows()).toEqual([]);
      expect(judgeNotes(trace)).toEqual(["not compared: today's budget has no room for another session"]);
    });
  });

  test("another change running a step counts: it keeps room for its own next session", async () => {
    await withRepo(`${SHADOW}claude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n`, {}, async ({ ctx, trace, fake }) => {
      claim("say-goodbye");
      try {
        await runJudge(ctx, SPEC_CHECK);
      } finally {
        release("say-goodbye");
      }
      expect(fake.models()).toEqual(["opus"]);
      expect(judgeNotes(trace)).toEqual(["not compared: today's budget has no room for another session"]);
    });
  });

  test("a due audit waits while another change running a step leaves no room for both judges", async () => {
    // Room for two sessions (an audit alone) but not three (an audit beside another change's session).
    await withRepo(`${FIRST}claude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n`, {}, async ({ repo, ctx, trace, fake }) => {
      seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
      const ask = (i: number) => runJudge(ctx, { ...SPEC_CHECK, vars: { ...SPEC_CHECK.vars, spec: `# Spec ${i}` } });
      for (let i = 1; i < AUDIT_EVERY; i++) expect(await ask(i)).toMatchObject({ decidedBy: "cheap" });
      claim("say-goodbye");
      try {
        expect(await ask(AUDIT_EVERY)).toMatchObject({ decidedBy: "strong" });
      } finally {
        release("say-goodbye");
      }
      expect(fake.models()).toEqual([...Array(AUDIT_EVERY - 1).fill("sonnet"), "opus"]);
      expect(judgeNotes(trace).at(-1)).toBe("not compared: today's budget has no room for another session");
    });
  });

  test("work already running alongside counts: room for two is not room for three", async () => {
    await withRepo(`${SHADOW}claude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n`, {}, async ({ ctx, trace, fake }) => {
      await runJudge(ctx, SPEC_CHECK, { alongside: 1 });
      expect(fake.models()).toEqual(["opus"]);
      expect(judgeNotes(trace)).toEqual(["not compared: today's budget has no room for another session"]);
      await runJudge(ctx, SPEC_CHECK);
      expect(fake.models()).toHaveLength(3);
      expect(trace.judgeRows()).toHaveLength(1);
    });
  });
});

describe("runJudge first", () => {
  test("not earned yet: both run as shadow, and the event says how many rejections were caught", async () => {
    await withRepo(FIRST, {}, async ({ repo, ctx, trace, fake }) => {
      seedCaught(repo.path, trace, "spec-check", 12);
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ ok: true, decidedBy: "strong" });
      expect(fake.models().sort()).toEqual(["opus", "sonnet"]);
      expect(judgeNotes(trace)[0]).toBe("first: running as shadow; the cheaper judge decides alone only after it has also rejected the last 30 things the strong judge rejected (12 so far)");
      expect(trace.judgeRows().at(-1)).toMatchObject({ slug: "add-numbers", mode: "first", how: "shadow" });
    });
  });

  test("earned: a clean cheaper pass decides alone, with no strong session", async () => {
    await withRepo(FIRST, {}, async ({ repo, ctx, trace, fake }) => {
      seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
      const r = await runJudge(ctx, SPEC_CHECK);
      expect(r).toMatchObject({ ok: true, decidedBy: "cheap", envelope: { approved: true } });
      expect(fake.models()).toEqual(["sonnet"]);
      expect(trace.judgeRows().at(-1)).toMatchObject({ slug: "add-numbers", mode: "first", how: "alone", cheap: "pass", strong: null, strong_usd: null });
      expect(judgeNotes(trace).at(-1)).toBe("decided by the cheaper judge (sonnet): passed");
    });
  });

  const unsure = fixture("spec-check").replace("\"met\":true", "\"met\":false");
  for (const [what, cheap, verdict] of [
    ["rejects", fixture("spec-check-reject"), "reject"],
    ["is unsure", unsure, "unsure"],
    ["gives a report that cannot be read", fixture("spec-check").replace("\"approved\":true,", ""), "failed"],
    ["cannot reach the assistant", fixture("outage"), "failed"],
    ["crashes (and is not retried)", fixture("crash"), "failed"],
  ] as const) {
    test(`earned, but the cheaper judge ${what}: the strong judge runs after it and decides, and the loop is not paused`, async () => {
      await withRepo(FIRST, { "spec-check@sonnet": cheap, "spec-check@opus": fixture("spec-check-reject") }, async ({ repo, ctx, trace, fake }) => {
        seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
        const r = await runJudge(ctx, SPEC_CHECK);
        expect(r).toMatchObject({ ok: true, decidedBy: "strong", envelope: { approved: false } });
        expect(fake.models()).toEqual(["sonnet", "opus"]);
        expect(phase(trace, "spec-check")!.started >= phase(trace, "spec-check-cheap")!.ended!).toBe(true);
        expect(trace.judgeRows().at(-1)).toMatchObject({ mode: "first", how: "escalated", cheap: verdict, strong: "reject" });
      });
    });
  }

  test("earned and escalated: each session's time is its own, so the two one after the other fit in the call's wall time", async () => {
    await withRepo(FIRST, { "spec-check@sonnet": fixture("spec-check-reject"), "spec-check@opus": fixture("spec-check-reject") }, async ({ repo, ctx, trace }) => {
      seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
      const started = Date.now();
      expect(await runJudge(ctx, SPEC_CHECK)).toMatchObject({ decidedBy: "strong" });
      const wall = Date.now() - started;
      const row = trace.judgeRows().at(-1)!;
      expect(row).toMatchObject({ how: "escalated" });
      expect(row.cheap_ms!).toBeGreaterThan(0);
      expect(row.strong_ms!).toBeGreaterThan(0);
      expect(row.cheap_ms! + row.strong_ms!).toBeLessThanOrEqual(wall + 50);
    });
  });

  test("earned, with a daily budget and no session cap: no audit can ever run, so the cheaper judge never decides alone", async () => {
    await withRepo(`${FIRST}claude:\n  max_budget_usd_per_day: 50\n`, {}, async ({ repo, ctx, trace, fake }) => {
      seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
      const before = trace.judgeRows().length;
      for (let i = 1; i <= AUDIT_EVERY + 1; i++) {
        expect(await runJudge(ctx, { ...SPEC_CHECK, vars: { ...SPEC_CHECK.vars, spec: `# Spec ${i}` } })).toMatchObject({ decidedBy: "strong" });
      }
      expect(fake.models()).toEqual(Array(AUDIT_EVERY + 1).fill("opus"));
      expect(trace.judgeRows()).toHaveLength(before);
      expect(new Set(judgeNotes(trace))).toEqual(new Set(["not compared: today's budget has no room for another session"]));
    });
  });

  test("earned, an audit is due and today's budget has no room for it: the strong judge decides alone until one runs", async () => {
    // Room for two sessions (an audit alone) but not three (an audit beside other work).
    await withRepo(`${FIRST}claude:\n  max_budget_usd_per_day: 2.5\n  max_budget_usd: 1\n`, {}, async ({ repo, ctx, trace, fake }) => {
      seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
      const ask = (i: number, alongside: number) => runJudge(ctx, { ...SPEC_CHECK, vars: { ...SPEC_CHECK.vars, spec: `# Spec ${i}` } }, { alongside });
      for (let i = 1; i < AUDIT_EVERY; i++) expect(await ask(i, 1)).toMatchObject({ decidedBy: "cheap" });
      // The audit is due, and beside other work there is no room for it: the cheaper judge does not decide alone.
      expect(await ask(AUDIT_EVERY, 1)).toMatchObject({ decidedBy: "strong" });
      expect(await ask(AUDIT_EVERY + 1, 1)).toMatchObject({ decidedBy: "strong" });
      expect(fake.models()).toEqual([...Array(AUDIT_EVERY - 1).fill("sonnet"), "opus", "opus"]);
      expect(judgeNotes(trace).at(-1)).toBe("not compared: today's budget has no room for another session");
      // With room again, the audit runs, and after it the cheaper judge decides alone again.
      expect(await ask(AUDIT_EVERY + 2, 0)).toMatchObject({ decidedBy: "strong" });
      expect(trace.judgeRows().at(-1)).toMatchObject({ mode: "first", how: "shadow" });
      expect(await ask(AUDIT_EVERY + 3, 1)).toMatchObject({ decidedBy: "cheap" });
    });
  });

  test(`earned: every ${AUDIT_EVERY}th call runs both as an audit; a miss there sends the next call back to shadow`, async () => {
    await withRepo(FIRST, { "spec-check@sonnet": fixture("spec-check"), "spec-check@opus-1": fixture("spec-check-reject") }, async ({ repo, ctx, trace, fake }) => {
      seedCaught(repo.path, trace, "spec-check", FIRST_NEEDS);
      for (let i = 1; i < AUDIT_EVERY; i++) expect(await runJudge(ctx, { ...SPEC_CHECK, vars: { ...SPEC_CHECK.vars, spec: `# Spec ${i}` } })).toMatchObject({ decidedBy: "cheap" });
      expect(fake.models()).toEqual(["sonnet", "sonnet", "sonnet", "sonnet"]);
      // The 5th: both run, the strong judge decides (it rejects, the cheaper judge passed: a miss).
      expect(await runJudge(ctx, { ...SPEC_CHECK, vars: { ...SPEC_CHECK.vars, spec: "# Spec 5" } })).toMatchObject({ decidedBy: "strong", envelope: { approved: false } });
      expect(fake.models()).toHaveLength(6);
      expect(trace.judgeRows().at(-1)).toMatchObject({ mode: "first", how: "shadow", cheap: "pass", strong: "reject" });
      // The next call runs as shadow again.
      expect(await runJudge(ctx, { ...SPEC_CHECK, vars: { ...SPEC_CHECK.vars, spec: "# Spec 6" } })).toMatchObject({ decidedBy: "strong" });
      expect(fake.models()).toHaveLength(8);
      expect(judgeNotes(trace).at(-2)).toStartWith("first: running as shadow; it passed something the strong judge rejected on ");
    });
  });
});
