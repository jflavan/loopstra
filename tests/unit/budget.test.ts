import { describe, expect, test } from "bun:test";
import { CHAT_SLUG, limitOf, staleBefore } from "../../src/budget";
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

  test("a budget that is not set is no limit", () => {
    expect(limitOf(undefined)).toBe(Infinity);
    expect(limitOf(4)).toBe(4);
  });
});
