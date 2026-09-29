import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderStatus } from "../../src/commands/status";
import { configPath } from "../../src/config";
import { heartbeatState, loopStatusLine, readHeartbeat, startHeartbeat, writeHeartbeat, type Heartbeat } from "../../src/heartbeat";
import { start } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { setupRepo, tempDir } from "../helpers";

afterEach(() => resetStop());

const NOW = new Date("2026-09-28T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function hb(over: Partial<Heartbeat> = {}): Heartbeat {
  return { pid: 1234, startedAt: ago(3600), lastTickAt: ago(20), lastBeatAt: ago(2), current: null, stopping: false, stopped: false, ...over };
}

describe("heartbeatState", () => {
  test("a fresh heartbeat is running, with the time of the last check", () => {
    expect(heartbeatState(hb(), 60, NOW)).toMatchObject({ state: "running", text: "Running — last check 20s ago" });
  });

  test("names the change being worked on", () => {
    const s = heartbeatState(hb({ current: { slug: "add-numbers", phase: null } }), 60, NOW);
    expect(s.state).toBe("running");
    expect(s.text).toBe("Running — working on add-numbers, last check 20s ago");
    expect(s.current).toEqual({ slug: "add-numbers", phase: null });
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
    const s = heartbeatState(hb({ lastTickAt: ago(25 * 60), lastBeatAt: ago(3), current: { slug: "big", phase: null } }), 60, NOW);
    expect(s.state).toBe("running");
    expect(s.text).toBe("Running — working on big, last check 25 min ago");
  });

  test("a requested stop shows as stopping while the step winds down", () => {
    expect(heartbeatState(hb({ stopping: true }), 60, NOW).text).toBe("Stopping — last check 20s ago");
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
      expect(readHeartbeat(t.path)!.current).toEqual({ slug: "add-numbers", phase: null });
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
      expect(await renderStatus(t.path)).toMatch(/^Loop: Not responding \(last check 4\ds ago\)\n\nNo intents yet/);
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
