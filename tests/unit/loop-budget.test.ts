import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { attention } from "../../src/attention";
import { CHAT_SLUG, loopDayNote, loopDaySpent, loopDayUsedUp, startOfToday } from "../../src/budget";
import { FAKE_CLAUDE_ENV } from "../../src/claude";
import { loadConfig } from "../../src/config";
import { readPause } from "../../src/heartbeat";
import { readIntent } from "../../src/intents";
import { agentPhase } from "../../src/phases";
import { tick } from "../../src/scheduler";
import { AssistantUnavailable, LoopBudgetReached } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { FAKE_CLAUDE, setupRepo, tempDir, withEnv } from "../helpers";

function spent(trace: Trace, slug: string, usd: number): void {
  const seq = trace.phaseStart(slug, "build", "agent");
  trace.phaseEnd(slug, seq, { status: "success", costUsd: usd });
}

/** A phase still running that holds `usd` of the loop's day. */
function held(trace: Trace, slug: string, usd: number): void {
  trace.phaseStartWithin(slug, "build", "agent", { since: new Date(Date.now() - 60_000).toISOString(), limitUsd: usd, capUsd: Infinity, floorUsd: 0.01, pool: { except: CHAT_SLUG } });
}

const INTAKE = { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} } as const;
const FIXTURES = join(import.meta.dir, "..", "fake-claude", "fixtures");
const SLUG = "add-numbers";

/** A fixture folder: each named phase's own fixture, reporting the given cost. */
async function costs(dir: string, perPhase: Record<string, number>): Promise<void> {
  for (const [phase, usd] of Object.entries(perPhase)) {
    const text = await Bun.file(join(FIXTURES, `${phase}.jsonl`)).text();
    await Bun.write(join(dir, `${phase}.jsonl`), text.replace(/"total_cost_usd":[0-9.]+/, `"total_cost_usd":${usd}`));
  }
}

describe("the loop's daily budget", () => {
  test("a phase past it does not start; chat's spending does not count", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      spent(trace, CHAT_SLUG, 5);
      expect((await agentPhase(ctx, INTAKE)).ok).toBe(true);
      spent(trace, "other", 1);
      await expect(agentPhase(ctx, INTAKE)).rejects.toBeInstanceOf(LoopBudgetReached);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a session holds what is left of the day as its cap", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 3\n" });
    try {
      const argsFile = join(repo.path, ".loopstra", "args.json");
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      spent(trace, "other", 1);
      await agentPhase(ctx, { ...INTAKE, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
      const args: string[] = (await Bun.file(argsFile).json()).args;
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a session whose cap came from the day ends interrupted with its cost, and the loop pauses instead of blocking", async () => {
    // No claude.max_budget_usd: the session's cap is what is left of the day.
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 10\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:budget");
      await expect(agentPhase(ctx, INTAKE)).rejects.toBeInstanceOf(LoopBudgetReached);
      expect(trace.phases(SLUG)).toMatchObject([
        { name: "intake", status: "interrupted", cost_usd: 5.01, error: "budget: the loop's daily budget ran out during this session" },
      ]);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a session capped by less of the day than claude.max_budget_usd also pauses", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd: 5\n  max_budget_usd_per_day: 6\n" });
    try {
      spent(trace, "other", 4);
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:budget");
      await expect(agentPhase(ctx, INTAKE)).rejects.toBeInstanceOf(LoopBudgetReached);
      expect(trace.phases(SLUG)[0]).toMatchObject({ status: "interrupted", cost_usd: 5.01 });
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a session capped by claude.max_budget_usd itself still blocks the step", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd: 5\n  max_budget_usd_per_day: 50\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:budget");
      const r = await agentPhase(ctx, INTAKE);
      expect(r).toMatchObject({ ok: false, reason: "budget" });
      expect(!r.ok && r.note).toContain("claude.max_budget_usd");
      expect(trace.phases(SLUG)[0]).toMatchObject({ status: "fail", cost_usd: 5.01 });
    } finally { trace.close(); repo.cleanup(); }
  });

  test("an unavailable session's cost counts toward the day", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 10\n" });
    const dir = tempDir();
    try {
      const fixture = join(dir.path, "limit.jsonl");
      await Bun.write(fixture, (await Bun.file(join(FIXTURES, "usage-limit.jsonl")).text()).replace(/"total_cost_usd":[0-9.]+/, '"total_cost_usd":0.5'));
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x");
      await expect(withEnv({ LOOPSTRA_FAKE_FIXTURE: fixture }, () => agentPhase(ctx, INTAKE))).rejects.toBeInstanceOf(AssistantUnavailable);
      expect(trace.phases(SLUG)[0]).toMatchObject({ status: "interrupted", cost_usd: 0.5 });
      expect(trace.costIn({ except: CHAT_SLUG }, startOfToday(), { endedOnly: true })).toBe(0.5);
    } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
  });

  test("a session that ran but whose phase then crashed keeps its cost", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 10\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      // The envelope cannot be saved: a folder is in its place.
      mkdirSync(join(ctx.runDir, "phases", "1-intake", "envelope.json"), { recursive: true });
      await agentPhase(ctx, INTAKE);
      const first = trace.phases(SLUG)[0]!;
      expect(first).toMatchObject({ status: "fail" });
      expect(first.error).toStartWith("crash:");
      expect(first.cost_usd).toBeGreaterThan(0);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("the tick waits without picking a change, traces the pause once, and the attention list says why", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      spent(trace, "other", 1);
      const cfg = await loadConfig(repo.path);
      const out = await tick(repo.path);
      expect(out.paused).toBe(loopDayNote(cfg, true));
      expect(out.paused).toContain("resumes after midnight");
      expect(out.picked).toBeNull();
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("accepted");
      const items = await attention(repo.path, cfg, trace);
      expect(items.find((i) => i.kind === "paused")?.what).toBe(loopDayNote(cfg, true));
      // The next poll pauses for the same reason: `tail` shows it once.
      expect((await tick(repo.path)).paused).toBe(loopDayNote(cfg, true));
      const pauses = trace.events("_loop").filter((e) => e.type === "pause");
      expect(pauses.map((e) => JSON.parse(e.payload).reason)).toEqual([loopDayNote(cfg, true)]);
    } finally { trace.close(); repo.cleanup(); }
  });

  // The day runs out partway through a step: its next agent phase cannot start. The step is not
  // blocked; it keeps its status and resumes when there is budget again. The design phase is
  // reached straight from the step; the spec check through the gate, which passes errors on.
  for (const [what, perPhase, notStarted] of [
    ["the step's next phase", { intake: 1 }, "design"],
    ["a gate's judge", { design: 1 }, "spec-check"],
  ] as const) {
    test(`used up partway through a step, ${what} does not start and the loop pauses without blocking`, async () => {
      const { repo, trace } = await setupRepo("designing", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
      const dir = tempDir();
      try {
        await costs(dir.path, perPhase);
        const cfg = await loadConfig(repo.path);
        const out = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, () => tick(repo.path));
        expect(out.crashed).toBeUndefined();
        expect(out.picked).toBe(SLUG);
        expect(out.paused).toBe(loopDayNote(cfg, true));
        expect(out.paused).toContain("resumes after midnight");
        expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
        expect(trace.phases(SLUG).some((p) => p.name === notStarted)).toBe(false);
        // Not a failed check (which would rewrite the spec): the gate never recorded one.
        expect(trace.gates(SLUG).filter((g) => g.result !== "pass")).toEqual([]);
        expect(trace.phases(SLUG).filter((p) => p.name === "design")).toHaveLength(notStarted === "design" ? 0 : 1);
        const pause = trace.events(SLUG).filter((e) => e.type === "pause");
        expect(pause.map((e) => JSON.parse(e.payload).reason)).toEqual([loopDayNote(cfg, true)]);
      } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
    }, 60_000);
  }

  describe("a step that runs out partway on two days in a row", () => {
    /** Moves today's trace (phases and the change's pauses) to yesterday, as if the step had run then. */
    function yesterday(trace: Trace, status?: string): void {
      const db = (trace as unknown as { db: { run(sql: string, args: unknown[]): void } }).db;
      const iso = new Date(Date.now() - 36 * 3600_000).toISOString();
      db.run("UPDATE phases SET started = ?, ended = ?", [iso, iso]);
      db.run("UPDATE events SET ts = ? WHERE slug = ? AND type = 'pause'", [iso, SLUG]);
      if (status) db.run("UPDATE events SET payload = json_set(payload, '$.status', ?) WHERE slug = ? AND type = 'pause'", [status, SLUG]);
    }

    async function designing(): Promise<Awaited<ReturnType<typeof setupRepo>>> {
      const r = await setupRepo("designing", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
      const path = join(r.repo.path, "intent", SLUG, "intent.md");
      await Bun.write(path, (await Bun.file(path).text()).replace("status: designing\n", "status: designing\nresume_from: accepted\n"));
      return r;
    }

    test("the pause records the change's status; the second day blocks it with a plain note and how to resume", async () => {
      const { repo, trace } = await designing();
      const dir = tempDir();
      try {
        await costs(dir.path, { intake: 1 });
        const run = () => withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, () => tick(repo.path));
        expect((await run()).paused).toContain("resumes after midnight");
        const pause = trace.lastEvent(SLUG, "pause")!;
        expect(JSON.parse(pause.payload)).toMatchObject({ dayBudget: true, status: "designing" });
        yesterday(trace);
        const out = await run();
        expect(out.paused).toBeUndefined();
        const intent = (await readIntent(repo.path, SLUG)).file.frontmatter;
        expect(intent.status).toBe("blocked");
        expect(intent.note).toBe("This step needs more than the loop's daily budget (claude.max_budget_usd_per_day, $1.00): it ran out partway on two days in a row. Raise or remove the limit with `loopstra setup budgets`. When that is sorted out, set status to accepted to try again.");
        expect(out.result).toMatchObject({ ok: false, note: intent.note });
      } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
    }, 60_000);

    test("a step that got further since (another status) only pauses again", async () => {
      const { repo, trace } = await designing();
      const dir = tempDir();
      try {
        await costs(dir.path, { intake: 1 });
        const run = () => withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, () => tick(repo.path));
        await run();
        yesterday(trace, "accepted");
        expect((await run()).paused).toContain("resumes after midnight");
        expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
      } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
    }, 60_000);
  });

  test("an outage that repeats while the day is spent keeps backing off without a probe session", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    const dir = tempDir();
    try {
      // The assistant is out (the outage fixture). On the third tick, while intake runs, another
      // change spends the day, as another process could: the probe would come next.
      const wrapper = join(dir.path, "claude.ts");
      await Bun.write(wrapper, [
        `import { Trace } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "trace.ts"))};`,
        "if (process.env.LOOPSTRA_TEST_SPEND) {",
        "  const t = Trace.open(process.env.LOOPSTRA_TEST_SPEND);",
        '  t.phaseEnd("other", t.phaseStart("other", "build", "agent"), { status: "success", costUsd: 1 });',
        "  t.close();",
        "}",
        `await import(${JSON.stringify(FAKE_CLAUDE)});`,
        "",
      ].join("\n"));
      const env = { [FAKE_CLAUDE_ENV]: wrapper, LOOPSTRA_FAKE_FIXTURE: join(FIXTURES, "outage.jsonl") };
      for (const n of [1, 2, 3]) {
        const out = await withEnv(n === 3 ? { ...env, LOOPSTRA_TEST_SPEND: repo.path } : env, () => tick(repo.path));
        expect(out.paused).toMatch(/^The assistant is unavailable/);
        const p = readPause(repo.path)!;
        expect(p).toMatchObject({ repeats: n });
        await Bun.write(join(repo.path, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
      }
      expect(loopDaySpent(await loadConfig(repo.path), trace)).toBe(true);
      expect(trace.phases(SLUG).map((p) => p.name)).toEqual(["intake", "intake", "intake"]);
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
    } finally { trace.close(); repo.cleanup(); dir.cleanup(); }
  }, 60_000);

  test("a day only held by a running phase says so to the tick, needs no person, and the loop goes on when it ends", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      const cfg = await loadConfig(repo.path);
      held(trace, "other", 1);
      expect(loopDayUsedUp(cfg, trace)).toBe(true);
      expect(loopDayNote(cfg, false)).toContain("is held by a phase still running");
      expect(loopDayNote(cfg, false)).toContain("within 40 minutes");
      expect(loopDaySpent(cfg, trace)).toBe(false);
      // The loop is simply working: nothing for a person on the attention list.
      expect((await attention(repo.path, cfg, trace)).filter((i) => i.kind === "paused")).toEqual([]);
      trace.phaseEnd("other", 1, { status: "success", costUsd: 0.5 });
      expect(loopDayUsedUp(cfg, trace)).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a stale hold (a killed process's) does not count", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  timeout_minutes: 1\n  max_budget_usd_per_day: 1\n" });
    try {
      const cfg = await loadConfig(repo.path);
      held(trace, "other", 1);
      expect(loopDayUsedUp(cfg, trace)).toBe(true);
      // timeout_minutes plus the 10-minute grace later, the hold no longer counts.
      expect(loopDayUsedUp(cfg, trace, new Date(Date.now() + 12 * 60_000))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a hold is not spending: the change's cost leaves a running phase out", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 5\n" });
    try {
      trace.upsertIntent(SLUG, "building", "normal");
      spent(trace, SLUG, 1);
      held(trace, SLUG, 5);
      expect(trace.intentSummary(SLUG)!.costUsd).toBe(1);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("tomorrow it starts again", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      const cfg = await loadConfig(repo.path);
      spent(trace, "other", 1);
      expect(loopDayUsedUp(cfg, trace)).toBe(true);
      expect(loopDayUsedUp(cfg, trace, new Date(Date.now() + 36 * 3600_000))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("without a daily cap the day is never used up", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      spent(trace, "other", 1000);
      expect(loopDayUsedUp(await loadConfig(repo.path), trace)).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });
});
