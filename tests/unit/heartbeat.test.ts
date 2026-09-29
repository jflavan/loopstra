import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderStatus } from "../../src/commands/status";
import { configPath } from "../../src/config";
import {
  activePause, clearPause, heartbeatState, loopStatusLine, pauseAfterUnavailable, readHeartbeat, readPause, startHeartbeat, writeHeartbeat, type Heartbeat,
} from "../../src/heartbeat";
import { start } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { setupRepo, tempDir } from "../helpers";

afterEach(() => resetStop());

const NOW = new Date("2026-09-28T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

/** A heartbeat written by this (live) process. */
function hb(over: Partial<Heartbeat> = {}): Heartbeat {
  return { pid: process.pid, startedAt: ago(3600), lastTickAt: ago(20), lastBeatAt: ago(2), current: null, stopping: false, stopped: false, ...over };
}

describe("heartbeatState", () => {
  test("a fresh heartbeat is running, with the time of the last check", () => {
    expect(heartbeatState(hb(), 60, NOW)).toMatchObject({ state: "running", text: "Running — last check 20s ago" });
  });

  test("names the change being worked on", () => {
    const s = heartbeatState(hb({ current: { slug: "add-numbers" } }), 60, NOW);
    expect(s.state).toBe("running");
    expect(s.text).toBe("Running — working on add-numbers, last check 20s ago");
    expect(s.current).toEqual({ slug: "add-numbers" });
  });

  test("no heartbeat, or a clean stop, is stopped", () => {
    expect(heartbeatState(null, 60, NOW)).toMatchObject({ state: "stopped", text: "Stopped" });
    expect(heartbeatState(hb({ stopped: true, lastTickAt: ago(300), lastBeatAt: ago(300) }), 60, NOW))
      .toMatchObject({ state: "stopped", text: "Stopped — last check 5 min ago" });
  });

  test("a heartbeat older than three polls is not responding", () => {
    const s = heartbeatState(hb({ lastTickAt: ago(14 * 60), lastBeatAt: ago(14 * 60) }), 60, NOW);
    expect(s).toMatchObject({ state: "not-responding", text: "Not responding (last check 14 min ago)" });
    // Just inside three polls is still running.
    expect(heartbeatState(hb({ lastBeatAt: ago(179) }), 60, NOW).state).toBe("running");
  });

  test("a long step keeps the loop running as long as the process keeps beating", () => {
    const s = heartbeatState(hb({ lastTickAt: ago(25 * 60), lastBeatAt: ago(3), current: { slug: "big" } }), 60, NOW);
    expect(s.state).toBe("running");
    expect(s.text).toBe("Running — working on big, last check 25 min ago");
  });

  test("a stale heartbeat whose process is gone did not shut down cleanly; a live one is not responding", () => {
    const stale = { lastTickAt: ago(8 * 3600), lastBeatAt: ago(8 * 3600) };
    expect(heartbeatState(hb({ ...stale, pid: 999_999 }), 60, NOW))
      .toMatchObject({ state: "stopped", text: "Stopped — it did not shut down cleanly (last check 8 h ago)", current: null });
    expect(heartbeatState(hb(stale), 60, NOW, { alive: () => true })).toMatchObject({ state: "not-responding", text: "Not responding (last check 8 h ago)" });
    expect(heartbeatState(hb(stale), 60, NOW, { alive: () => false }).state).toBe("stopped");
  });

  test("stopped with a pause pending says when the next start will try", () => {
    const until = new Date(NOW.getTime() + 10 * 60_000);
    const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    const pause = { until: until.toISOString(), reason: "r", failures: 2 };
    const wait = `The assistant was unavailable; the next start waits until ${hhmm}.`;
    expect(heartbeatState(hb({ stopped: true, lastTickAt: ago(300) }), 60, NOW, { pause }).text).toBe(`Stopped — last check 5 min ago. ${wait}`);
    expect(heartbeatState(null, 60, NOW, { pause }).text).toBe(`Stopped. ${wait}`);
    expect(heartbeatState(hb({ lastTickAt: ago(3600), lastBeatAt: ago(3600), pid: 999_999 }), 60, NOW, { pause }).text)
      .toBe(`Stopped — it did not shut down cleanly (last check 1 h ago). ${wait}`);
    // A pause that has run out says nothing more.
    expect(heartbeatState(null, 60, NOW, { pause: { ...pause, until: ago(1) } }).text).toBe("Stopped");
  });

  test("a requested stop shows as stopping while the step winds down", () => {
    expect(heartbeatState(hb({ stopping: true }), 60, NOW).text).toBe("Stopping — last check 20s ago");
  });
});

describe("pause after the assistant was unavailable", () => {
  test("backs off 1, 2, 4, 8, 16, then 30 minutes, says when it retries, and ends when cleared", () => {
    const t = tempDir();
    try {
      expect(readPause(t.path)).toBeNull();
      const minutes = [1, 2, 3, 4, 5, 6, 7].map(() => {
        const p = pauseAfterUnavailable(t.path, NOW);
        return (Date.parse(p.until) - NOW.getTime()) / 60_000;
      });
      expect(minutes).toEqual([1, 2, 4, 8, 16, 30, 30]);
      const p = readPause(t.path)!;
      expect(p.failures).toBe(7);
      const at = new Date(p.until);
      const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      expect(p.reason).toBe(`The assistant is unavailable (sign-in, usage limit, or network). Retrying at ${hhmm}.`);
      expect(activePause(t.path, NOW)).not.toBeNull();
      expect(activePause(t.path, new Date(Date.parse(p.until) + 1))).toBeNull();
      clearPause(t.path);
      expect(readPause(t.path)).toBeNull();
      expect((Date.parse(pauseAfterUnavailable(t.path, NOW).until) - NOW.getTime()) / 60_000).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("the pause names the change, phase, and matched line, and counts pauses in a row for the same one", () => {
    const t = tempDir();
    try {
      const same = { slug: "add-numbers", phase: "intake", line: "Please run /login" };
      expect(pauseAfterUnavailable(t.path, NOW, same)).toMatchObject({ ...same, repeats: 1, failures: 1 });
      expect(pauseAfterUnavailable(t.path, NOW, same)).toMatchObject({ repeats: 2, failures: 2 });
      expect(readPause(t.path)).toMatchObject({ ...same, repeats: 2 });
      // A different line (or phase, or change) starts the count again; the back-off keeps going.
      expect(pauseAfterUnavailable(t.path, NOW, { ...same, line: "API Error: 529 Overloaded" })).toMatchObject({ repeats: 1, failures: 3 });
      expect(pauseAfterUnavailable(t.path, NOW, { ...same, line: "API Error: 529 Overloaded", phase: "design" })).toMatchObject({ repeats: 1, failures: 4 });
      expect(pauseAfterUnavailable(t.path, NOW)).toMatchObject({ slug: null, phase: null, line: null, repeats: 1, failures: 5 });
    } finally {
      t.cleanup();
    }
  });

  test("a paused loop says so and when it retries; the heartbeat carries it", () => {
    const reason = "The assistant is unavailable (sign-in, usage limit, or network). Retrying at 12:05.";
    const paused = heartbeatState(hb({ pausedUntil: new Date(NOW.getTime() + 300_000).toISOString(), pauseReason: reason }), 60, NOW);
    expect(paused).toMatchObject({ state: "paused", text: `Paused — ${reason}` });
    // A pause that has run out is running again.
    expect(heartbeatState(hb({ pausedUntil: ago(1), pauseReason: reason }), 60, NOW).state).toBe("running");

    const t = tempDir();
    const beat = startHeartbeat(t.path, 60_000);
    try {
      const p = pauseAfterUnavailable(t.path);
      beat.tickEnded();
      expect(readHeartbeat(t.path)).toMatchObject({ pausedUntil: p.until, pauseReason: p.reason });
      clearPause(t.path);
      beat.tickStarted();
      expect(readHeartbeat(t.path)).toMatchObject({ pausedUntil: null, pauseReason: null });
    } finally {
      beat.stopped();
      t.cleanup();
    }
  });
});

describe("heartbeat file", () => {
  test("round-trips, and an unreadable file reads as none", async () => {
    const t = tempDir();
    try {
      expect(readHeartbeat(t.path)).toBeNull();
      writeHeartbeat(t.path, hb());
      expect(readHeartbeat(t.path)).toEqual(hb());
      await Bun.write(join(t.path, ".loopstra", "heartbeat.json"), "{not json");
      expect(readHeartbeat(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("the loop beat marks ticks, a stop request, and the final stop", () => {
    const t = tempDir();
    const beat = startHeartbeat(t.path, 60_000);
    try {
      const first = readHeartbeat(t.path)!;
      expect(first).toMatchObject({ pid: process.pid, lastTickAt: null, stopping: false, stopped: false, current: null });
      beat.tickStarted();
      expect(readHeartbeat(t.path)!.lastTickAt).not.toBeNull();
      beat.workingOn("add-numbers");
      expect(readHeartbeat(t.path)!.current).toEqual({ slug: "add-numbers" });
      requestStop();
      expect(readHeartbeat(t.path)).toMatchObject({ stopping: true, stopped: false });
      beat.tickEnded();
      expect(readHeartbeat(t.path)!.current).toBeNull();
    } finally {
      beat.stopped();
      expect(readHeartbeat(t.path)).toMatchObject({ stopping: false, stopped: true, current: null });
      t.cleanup();
    }
  });

  test("status prints one line for the loop", async () => {
    const t = tempDir();
    try {
      expect(await loopStatusLine(t.path)).toBe("Loop: Stopped\n");
      mkdirSync(join(t.path, "loopstra"), { recursive: true });
      await Bun.write(configPath(t.path), "version: 1\ncommands:\n  test: echo ok\npoll_seconds: 10\n");
      writeHeartbeat(t.path, { ...hb(), lastTickAt: new Date(Date.now() - 45_000).toISOString(), lastBeatAt: new Date(Date.now() - 45_000).toISOString() });
      // 45s is more than three 10 second polls.
      expect(await loopStatusLine(t.path)).toMatch(/^Loop: Not responding \(last check 4\ds ago\)\n$/);
      expect(await renderStatus(t.path)).toMatch(/^Loop: Not responding \(last check 4\ds ago\)\n\nNothing needs you right now\.\n\nNo intents yet/);
      const reason = "The assistant is unavailable (sign-in, usage limit, or network). Retrying at 12:05.";
      writeHeartbeat(t.path, { ...hb(), lastBeatAt: new Date().toISOString(), lastTickAt: new Date().toISOString(), pausedUntil: new Date(Date.now() + 60_000).toISOString(), pauseReason: reason });
      expect(await loopStatusLine(t.path)).toBe(`Loop: Paused — ${reason}\n`);
    } finally {
      t.cleanup();
    }
  });
});

describe("the scheduler writes the heartbeat", () => {
  test("start once leaves a stopped heartbeat with a last check", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      await start(repo.path, { once: true, installSignals: false });
      const h = readHeartbeat(repo.path)!;
      expect(h.pid).toBe(process.pid);
      expect(h.stopped).toBe(true);
      expect(h.lastTickAt).not.toBeNull();
      expect(heartbeatState(h, 60, new Date()).text).toMatch(/^Stopped — last check \d+s ago$/);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a stop request shows as stopping before the loop ends", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      let seen: Heartbeat | null = null;
      setTimeout(() => { requestStop(); seen = readHeartbeat(repo.path); }, 300);
      await start(repo.path, { once: false, installSignals: false });
      expect(seen).toMatchObject({ stopping: true, stopped: false });
      expect(readHeartbeat(repo.path)).toMatchObject({ stopping: false, stopped: true });
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);
});
