import { describe, expect, test } from "bun:test";
import { CHAT_SLUG, lanesFor, limitOf, roomBeside, roomFor, sessionCost, staleBefore, startOfTomorrow, USD_PER_MINUTE } from "../../src/budget";
import { claim, release } from "../../src/lanes";
import { validateConfig } from "../../src/config";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

function withTrace(fn: (trace: Trace, since: string) => void): void {
  const t = tempDir();
  const trace = Trace.open(t.path);
  try { fn(trace, new Date(Date.now() - 60_000).toISOString()); } finally { trace.close(); t.cleanup(); }
}

function spent(trace: Trace, slug: string, usd: number): void {
  const seq = trace.phaseStart(slug, "x", "agent");
  trace.phaseEnd(slug, seq, { status: "success", costUsd: usd });
}

describe("budget pools", () => {
  test("a pool is one slug's phases, or every slug's but one", () => {
    withTrace((trace, since) => {
      spent(trace, "a", 1);
      spent(trace, "b", 2);
      spent(trace, CHAT_SLUG, 4);
      expect(trace.costIn({ slug: "a" }, since)).toBe(1);
      expect(trace.costIn({ except: CHAT_SLUG }, since)).toBe(3);
      expect(trace.costSince("b", since)).toBe(2);
    });
  });

  test("a running hold older than runningSince does not count (a killed process left it)", () => {
    withTrace((trace, since) => {
      trace.phaseStart("a", "x", "agent", 2);
      const later = new Date(Date.now() + 60_000).toISOString();
      expect(trace.costIn({ except: CHAT_SLUG }, since)).toBe(2);
      expect(trace.costIn({ except: CHAT_SLUG }, since, { runningSince: later })).toBe(0);
      const day = { since, limitUsd: 3, capUsd: Infinity, floorUsd: 0.01, pool: { except: CHAT_SLUG } };
      expect(trace.phaseStartWithin("b", "x", "agent", { ...day, runningSince: later })!.heldUsd).toBe(3);
    });
  });

  test("a hold goes stale after the session timeout and a grace period", () => {
    const cfg = validateConfig({ version: 1, commands: { test: "x" }, claude: { timeout_minutes: 30 } });
    const now = new Date("2026-10-02T12:00:00Z");
    expect(staleBefore(cfg, now)).toBe("2026-10-02T11:20:00.000Z");
  });

  test("with no limit and no cap, a phase starts holding nothing", () => {
    withTrace((trace, since) => {
      const held = trace.phaseStartWithin("a", "x", "agent", { since, limitUsd: Infinity, capUsd: Infinity, floorUsd: 0.01 })!;
      expect(held.heldUsd).toBe(Infinity);
      expect(trace.phases("a")[0]!.cost_usd).toBe(0);
    });
  });

  test("the loop's pool counts every change's holds and spending, not chat's", () => {
    withTrace((trace, since) => {
      const day = { since, limitUsd: 3, capUsd: 2, floorUsd: 0.01, pool: { except: CHAT_SLUG } };
      expect(trace.phaseStartWithin("a", "x", "agent", day)!.heldUsd).toBe(2);
      trace.phaseStart(CHAT_SLUG, "orchestrator", "agent", 10);
      expect(trace.phaseStartWithin("b", "x", "agent", day)!.heldUsd).toBe(1);
      expect(trace.phaseStartWithin("c", "x", "agent", day)).toBeNull();
    });
  });

  test("a session that reported its cost counts at it", () => {
    expect(sessionCost({ costUsd: 1.5, costReported: true }, 60 * 60_000, 2)).toBe(1.5);
  });

  test("under a cap, a session that never reported its cost counts at about its minutes, at least what it reported, never more than the cap", () => {
    const minutes = (m: number) => m * 60_000;
    expect(sessionCost({ costUsd: 0, costReported: false }, minutes(10), 20)).toBeCloseTo(10 * USD_PER_MINUTE);
    expect(sessionCost({ costUsd: 5, costReported: false }, minutes(10), 20)).toBe(5);
    expect(sessionCost({ costUsd: 0, costReported: false }, minutes(30), 4)).toBe(4);
  });

  test("with no cap, a session that never reported its cost counts at what it reported", () => {
    expect(sessionCost({ costUsd: 0, costReported: false }, 30 * 60_000, Infinity)).toBe(0);
  });

  test("tomorrow starts at local midnight", () => {
    const t = startOfTomorrow(new Date(2026, 9, 4, 15, 30));
    expect([t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes()]).toEqual([2026, 9, 5, 0, 0]);
  });

  test("a budget that is not set is no limit", () => {
    expect(limitOf(undefined)).toBe(Infinity);
    expect(limitOf(4)).toBe(4);
  });
});

describe("room for several sessions at once", () => {
  const cfgWith = (claude: Record<string, number>) => validateConfig({ version: 1, commands: { test: "x" }, claude });

  test("with no daily budget there is always room, however many sessions", () => {
    withTrace((trace) => {
      expect(roomFor(cfgWith({}), trace, 2)).toBe(true);
      expect(roomFor(cfgWith({ max_budget_usd: 2 }), trace, 3)).toBe(true);
    });
  });

  test("with a daily budget and no session cap, the first session holds the rest of the day: no room for two or three", () => {
    withTrace((trace) => {
      const cfg = cfgWith({ max_budget_usd_per_day: 100 });
      expect(roomFor(cfg, trace, 2)).toBe(false);
      expect(roomFor(cfg, trace, 3)).toBe(false);
    });
  });

  test("with both limits, there is room while what is left covers that many whole sessions", () => {
    withTrace((trace) => {
      const cfg = cfgWith({ max_budget_usd_per_day: 10, max_budget_usd: 2 });
      spent(trace, "a", 3);
      // $7 left: two sessions of $2 and three of $2 fit, four do not.
      expect(roomFor(cfg, trace, 2)).toBe(true);
      expect(roomFor(cfg, trace, 3)).toBe(true);
      expect(roomFor(cfg, trace, 4)).toBe(false);
      trace.phaseStart("b", "x", "agent", 2);
      // A running session holds its cap: $5 left fits two, not three.
      expect(roomFor(cfg, trace, 2)).toBe(true);
      expect(roomFor(cfg, trace, 3)).toBe(false);
    });
  });

  test("one session (or none) always has room: it is what the step runs anyway", () => {
    withTrace((trace) => {
      const cfg = cfgWith({ max_budget_usd_per_day: 1 });
      spent(trace, "a", 1);
      expect(roomFor(cfg, trace, 1)).toBe(true);
      expect(roomFor(cfg, trace, 0)).toBe(true);
    });
  });
});

describe("lanes the day has room for", () => {
  const cfgWith = (claude: Record<string, number>, n = 2) => validateConfig({ version: 1, commands: { test: "x" }, claude, speed: { max_parallel_changes: n } });

  test("with no daily budget, every configured lane", () => {
    withTrace((trace) => {
      expect(lanesFor(cfgWith({}, 3), trace)).toBe(3);
      expect(lanesFor(cfgWith({ max_budget_usd: 2 }, 4), trace)).toBe(4);
    });
  });

  test("with a daily budget and no session cap, one lane: the first session would hold the rest of the day", () => {
    withTrace((trace) => expect(lanesFor(cfgWith({ max_budget_usd_per_day: 100 }, 3), trace)).toBe(1));
  });

  test("as many lanes as what is left covers whole sessions, never more than configured", () => {
    withTrace((trace) => {
      expect(lanesFor(cfgWith({ max_budget_usd_per_day: 10, max_budget_usd: 4 }, 3), trace)).toBe(2);
      expect(lanesFor(cfgWith({ max_budget_usd_per_day: 10, max_budget_usd: 1 }, 3), trace)).toBe(3);
    });
  });

  test("day $10 with $7 spent and a $2 cap gives one lane", () => {
    withTrace((trace) => {
      spent(trace, "a", 7);
      expect(lanesFor(cfgWith({ max_budget_usd_per_day: 10, max_budget_usd: 2 }, 2), trace)).toBe(1);
    });
  });

  test("spending and a running hold of another change lower the count, never below 1", () => {
    withTrace((trace) => {
      const cfg = cfgWith({ max_budget_usd_per_day: 10, max_budget_usd: 2 }, 4);
      expect(lanesFor(cfg, trace)).toBe(4);
      spent(trace, "a", 5);
      expect(lanesFor(cfg, trace)).toBe(2);
      trace.phaseStart("b", "x", "agent", 2);
      expect(lanesFor(cfg, trace)).toBe(1);
      spent(trace, "c", 3);
      expect(lanesFor(cfg, trace)).toBe(1);
    });
  });

  test("one configured lane is always one", () => {
    withTrace((trace) => {
      expect(lanesFor(cfgWith({}, 1), trace)).toBe(1);
      expect(lanesFor(cfgWith({ max_budget_usd_per_day: 100, max_budget_usd: 1 }, 1), trace)).toBe(1);
      expect(lanesFor(cfgWith({ max_budget_usd_per_day: 100 }, 1), trace)).toBe(1);
    });
  });

  test("an overlap leaves a session's room for each other change running a step: with one other, three caps", () => {
    withTrace((trace) => {
      const cfg = cfgWith({ max_budget_usd_per_day: 6, max_budget_usd: 2 });
      expect(roomBeside(cfg, trace, "a", 2)).toBe(true);
      claim("a");
      claim("b");
      try {
        // Two of a's own plus one for b: three caps, $6.
        expect(roomBeside(cfg, trace, "a", 2)).toBe(true);
        spent(trace, "x", 1);
        expect(roomBeside(cfg, trace, "a", 2)).toBe(false);
        expect(roomFor(cfg, trace, 2)).toBe(true);
      } finally {
        release("a");
        release("b");
      }
    });
  });
});
