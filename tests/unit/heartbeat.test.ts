import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderStatus } from "../../src/commands/status";
import { configPath } from "../../src/config";
import {
  activePause, clearPause, dropLoopLock, heartbeatDoneWith, heartbeatState, heartbeatWorkingOn, holdLoop, loopAlreadyRunning, loopHoldText, loopLockPath, loopStatusLine, pauseAfterUnavailable, readHeartbeat, readLoopHold, readPause, releaseLoop, runningLoopPid, startHeartbeat, takeLoopLock, thisHost, writeHeartbeat, type Heartbeat, type LinkFile,
} from "../../src/heartbeat";
import { start } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { touchWake, wakeStamp } from "../../src/wake";
import { setupRepo, tempDir } from "../helpers";

afterEach(() => resetStop());

const NOW = new Date("2026-09-28T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

/** The pid of a process that ran and has exited: gone on every system (a made-up number might be in use). */
const DEAD_PID = await (async () => {
  const p = Bun.spawn({ cmd: [process.execPath, "-e", ""], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return p.pid;
})();

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
    expect(s.working).toEqual([{ slug: "add-numbers" }]);
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
    expect(heartbeatState(hb({ ...stale, pid: DEAD_PID }), 60, NOW))
      .toMatchObject({ state: "stopped", text: "Stopped — it did not shut down cleanly (last check 8 h ago)", working: [] });
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
    expect(heartbeatState(hb({ lastTickAt: ago(3600), lastBeatAt: ago(3600), pid: DEAD_PID }), 60, NOW, { pause }).text)
      .toBe(`Stopped — it did not shut down cleanly (last check 1 h ago). ${wait}`);
    // A pause that has run out says nothing more.
    expect(heartbeatState(null, 60, NOW, { pause: { ...pause, until: ago(1) } }).text).toBe("Stopped");
  });

  test("names every change being worked on, in the order they started", () => {
    const two = heartbeatState(hb({ current: { slug: "add-numbers" }, working: ["add-numbers", "say-goodbye"] }), 60, NOW);
    expect(two.text).toBe("Running — working on add-numbers and say-goodbye, last check 20s ago");
    expect(two.working).toEqual([{ slug: "add-numbers" }, { slug: "say-goodbye" }]);
    expect(heartbeatState(hb({ current: { slug: "a" }, working: ["a", "b", "c"] }), 60, NOW).text)
      .toBe("Running — working on a, b and c, last check 20s ago");
    // An empty list is working on nothing, whatever an older field says.
    expect(heartbeatState(hb({ working: [] }), 60, NOW)).toMatchObject({ text: "Running — last check 20s ago", working: [] });
  });

  test("an older heartbeat with only the current change still shows it", () => {
    const s = heartbeatState(hb({ current: { slug: "add-numbers" } }), 60, NOW);
    expect(s.working).toEqual([{ slug: "add-numbers" }]);
    expect(s.text).toBe("Running — working on add-numbers, last check 20s ago");
    expect(heartbeatState(hb({ current: { slug: "big" }, stopping: true }), 60, NOW).working).toEqual([{ slug: "big" }]);
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

  test("the pause names the model that failed; a success on another model leaves it as it is", () => {
    const t = tempDir();
    try {
      const cause = { slug: "add-numbers", phase: "design", line: "API Error: 529 Overloaded", model: "opus" };
      pauseAfterUnavailable(t.path, NOW, cause);
      const before = pauseAfterUnavailable(t.path, NOW, cause);
      expect(before).toMatchObject({ ...cause, repeats: 2, failures: 2 });
      // The change's cheap intake got through, or another change's: opus may still be out.
      clearPause(t.path, "add-numbers", NOW, "haiku");
      expect(readPause(t.path)).toEqual({ ...before, gotThrough: ["haiku"] });
      clearPause(t.path, "say-goodbye", NOW, "haiku");
      expect(readPause(t.path)).toEqual({ ...before, gotThrough: ["haiku"] });
      // The same words from another model start the count again.
      expect(pauseAfterUnavailable(t.path, NOW, { ...cause, model: "sonnet" })).toMatchObject({ model: "sonnet", repeats: 1, failures: 3 });
      // A success on the model that failed ends the pause as before.
      clearPause(t.path, "add-numbers", NOW, "sonnet");
      expect(readPause(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a model that got through while another's pause stayed starts its own outage at one minute", () => {
    const t = tempDir();
    try {
      const opus = { slug: "add-numbers", phase: "design", line: "You've reached your Fable limit", model: "opus" };
      for (let i = 0; i < 4; i++) pauseAfterUnavailable(t.path, NOW, opus);
      // opus never runs again (its change was dropped); haiku keeps getting through, then has an outage of its own.
      clearPause(t.path, "say-goodbye", NOW, "haiku");
      const haiku = { slug: "say-goodbye", phase: "intake", line: "API Error: 529 Overloaded", model: "haiku" };
      const p = pauseAfterUnavailable(t.path, NOW, haiku);
      expect(p).toMatchObject({ model: "haiku", failures: 1, repeats: 1 });
      expect(p.gotThrough).toBeUndefined();
      expect((Date.parse(p.until) - NOW.getTime()) / 60_000).toBe(1);
      // Models that fail in turn with nothing getting through between (the network is down) keep backing off.
      expect(pauseAfterUnavailable(t.path, NOW, opus)).toMatchObject({ model: "opus", failures: 2 });
      expect(pauseAfterUnavailable(t.path, NOW, haiku)).toMatchObject({ model: "haiku", failures: 3 });
    } finally {
      t.cleanup();
    }
  });

  test("another change getting through ends the wait and the back-off, but keeps the cause and its repeats", () => {
    const t = tempDir();
    try {
      const cause = { slug: "add-numbers", phase: "build", line: "Claude usage limit reached" };
      pauseAfterUnavailable(t.path, NOW, cause);
      pauseAfterUnavailable(t.path, NOW, cause);
      clearPause(t.path, "say-goodbye", NOW);
      const kept = readPause(t.path)!;
      expect(kept).toMatchObject({ ...cause, repeats: 2, failures: 0 });
      expect(activePause(t.path, NOW)).toBeNull();
      // The next pause for the same cause counts on, and the back-off starts again at one minute.
      const next = pauseAfterUnavailable(t.path, NOW, cause);
      expect(next).toMatchObject({ repeats: 3, failures: 1 });
      expect((Date.parse(next.until) - NOW.getTime()) / 60_000).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("the paused change itself getting through, or a pause with no cause, clears the pause completely", () => {
    const t = tempDir();
    try {
      const cause = { slug: "add-numbers", phase: "build", line: "Claude usage limit reached" };
      pauseAfterUnavailable(t.path, NOW, cause);
      pauseAfterUnavailable(t.path, NOW, cause);
      clearPause(t.path, "add-numbers", NOW);
      expect(readPause(t.path)).toBeNull();
      expect(pauseAfterUnavailable(t.path, NOW, cause)).toMatchObject({ repeats: 1, failures: 1 });
      // Without a recorded cause, any change getting through clears it.
      clearPause(t.path);
      pauseAfterUnavailable(t.path, NOW);
      clearPause(t.path, "say-goodbye", NOW);
      expect(readPause(t.path)).toBeNull();
      // Nothing to clear is fine.
      clearPause(t.path, "say-goodbye", NOW);
      expect(readPause(t.path)).toBeNull();
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
      expect(readHeartbeat(t.path)).toMatchObject({ current: null, working: [] });
    } finally {
      beat.stopped();
      expect(readHeartbeat(t.path)).toMatchObject({ stopping: false, stopped: true, current: null, working: [] });
      t.cleanup();
    }
  });

  test("the loop beat lists every change being worked on, and drops each one when its step ends", () => {
    const t = tempDir();
    const beat = startHeartbeat(t.path, 60_000);
    try {
      beat.tickStarted();
      beat.workingOn("a");
      beat.workingOn("b");
      // Older readers still see the first change.
      expect(readHeartbeat(t.path)).toMatchObject({ working: ["a", "b"], current: { slug: "a" } });
      expect(heartbeatState(readHeartbeat(t.path), 60).text).toMatch(/^Running — working on a and b, last check \d+s ago$/);
      beat.workingOn("a"); // listed once
      expect(readHeartbeat(t.path)!.working).toEqual(["a", "b"]);
      beat.doneWith("a");
      expect(readHeartbeat(t.path)).toMatchObject({ working: ["b"], current: { slug: "b" } });
      beat.doneWith("b");
      expect(readHeartbeat(t.path)).toMatchObject({ working: [], current: null });
      beat.workingOn("c");
      beat.tickEnded();
      expect(readHeartbeat(t.path)).toMatchObject({ working: [], current: null });
      beat.workingOn("d");
      beat.tickStarted();
      expect(readHeartbeat(t.path)).toMatchObject({ working: [], current: null });
      // The scheduler's lanes reach the same beat by the repository's folder.
      heartbeatWorkingOn(t.path, "e");
      heartbeatWorkingOn(t.path, "f");
      heartbeatDoneWith(t.path, "e");
      expect(readHeartbeat(t.path)!.working).toEqual(["f"]);
    } finally {
      beat.stopped();
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

const HEARTBEAT_SRC = pathToFileURL(fileURLToPath(new URL("../../src/heartbeat.ts", import.meta.url))).href;
const SCHEDULER_SRC = pathToFileURL(fileURLToPath(new URL("../../src/scheduler.ts", import.meta.url))).href;

/** Runs `code` in a child bun process with `env` added; its exit code and output. */
async function child(code: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  const p = Bun.spawn({ cmd: [process.execPath, "-e", code], env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).trim() };
}

/** A lock as another process wrote it. */
function writeLock(root: string, lock: Record<string, unknown>): void {
  mkdirSync(join(root, ".loopstra"), { recursive: true });
  writeFileSync(loopLockPath(root), JSON.stringify(lock));
}

describe("the loop lock", () => {
  test("says, in plain words, which process runs the loop and the way out when none does", () => {
    expect(loopAlreadyRunning(4242)).toBe("A loop is already running in this repository (process 4242). Stop it (Ctrl-C in its terminal) before starting another. If no loop is running here, delete .loopstra/loop.lock and .loopstra/heartbeat.json, then start again.");
  });

  test("a second take is refused while a live process holds it; dropping it frees it", async () => {
    const t = tempDir();
    try {
      expect(await takeLoopLock(t.path)).toBeNull();
      const held = JSON.parse(readFileSync(loopLockPath(t.path), "utf8"));
      expect(held).toMatchObject({ pid: process.pid, host: thisHost() });
      expect(typeof held.startedAt).toBe("string");
      expect(await takeLoopLock(t.path)).toBe(loopAlreadyRunning(process.pid));
      dropLoopLock(t.path);
      expect(existsSync(loopLockPath(t.path))).toBe(false);
      expect(await takeLoopLock(t.path)).toBeNull();
      dropLoopLock(t.path);
      // No temp file is left beside it.
      expect(readdirSync(join(t.path, ".loopstra"))).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a lock left behind on this machine (process gone), an older one without its machine, or a damaged one is taken over", async () => {
    const t = tempDir();
    try {
      for (const left of [{ pid: DEAD_PID, host: thisHost() }, { pid: DEAD_PID }]) {
        writeLock(t.path, { ...left, startedAt: ago(60) });
        expect(await takeLoopLock(t.path)).toBeNull();
        expect(JSON.parse(readFileSync(loopLockPath(t.path), "utf8")).pid).toBe(process.pid);
      }
      // Damaged, and not changed for a while.
      writeFileSync(loopLockPath(t.path), "not json");
      const old = new Date(Date.now() - 60_000);
      utimesSync(loopLockPath(t.path), old, old);
      expect(await takeLoopLock(t.path)).toBeNull();
      expect(JSON.parse(readFileSync(loopLockPath(t.path), "utf8")).pid).toBe(process.pid);
      dropLoopLock(t.path);
    } finally {
      t.cleanup();
    }
  });

  test("a lock that cannot be read yet counts as held: it may be another start's, still being written", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, ".loopstra"), { recursive: true });
      writeFileSync(loopLockPath(t.path), "");
      expect(await takeLoopLock(t.path)).toBe(loopAlreadyRunning(null));
      expect(loopAlreadyRunning(null)).toStartWith("A loop is already running in this repository. Stop it");
      expect(readFileSync(loopLockPath(t.path), "utf8")).toBe("");
    } finally {
      t.cleanup();
    }
  });

  test("where hard links are not available, the lock is made with an exclusive create", async () => {
    const t = tempDir();
    try {
      for (const code of ["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]) {
        const noLinks = () => { throw Object.assign(new Error(`${code}: no hard links here`), { code }); };
        expect(await takeLoopLock(t.path, 60, noLinks)).toBeNull();
        expect(JSON.parse(readFileSync(loopLockPath(t.path), "utf8"))).toMatchObject({ pid: process.pid, host: thisHost() });
        // No temp file is left beside it.
        expect(readdirSync(join(t.path, ".loopstra"))).toEqual(["loop.lock"]);
        expect(await takeLoopLock(t.path, 60, noLinks)).toBe(loopAlreadyRunning(process.pid));
        dropLoopLock(t.path);
        expect(existsSync(loopLockPath(t.path))).toBe(false);
      }
      // A lock left behind is taken over the same way.
      writeLock(t.path, { pid: DEAD_PID, host: thisHost(), startedAt: ago(60) });
      expect(await takeLoopLock(t.path, 60, () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); })).toBeNull();
      expect(JSON.parse(readFileSync(loopLockPath(t.path), "utf8")).pid).toBe(process.pid);
      dropLoopLock(t.path);
    } finally {
      t.cleanup();
    }
  });

  test("another machine's lock is taken over only when its heartbeat says no loop runs", async () => {
    const t = tempDir();
    try {
      writeLock(t.path, { pid: DEAD_PID, host: "elsewhere", startedAt: ago(60) });
      writeHeartbeat(t.path, hb({ pid: DEAD_PID, host: "elsewhere", lastBeatAt: new Date().toISOString() }));
      expect(await takeLoopLock(t.path, 60)).toBe(loopAlreadyRunning(DEAD_PID));
      writeHeartbeat(t.path, hb({ pid: DEAD_PID, host: "elsewhere", stopped: true }));
      expect(await takeLoopLock(t.path, 60)).toBeNull();
      dropLoopLock(t.path);
    } finally {
      t.cleanup();
    }
  });

  test("a problem making the lock refuses in plain words", async () => {
    const t = tempDir();
    try {
      // A file where the folder should be.
      writeFileSync(join(t.path, ".loopstra"), "");
      expect(await takeLoopLock(t.path)).toMatch(/^Could not make the loop's lock, \.loopstra\/loop\.lock \(.+\)\. Check that the folder can be written, then start again\.$/);
    } finally {
      t.cleanup();
    }
  });

  test("dropping leaves another process's lock alone", () => {
    const t = tempDir();
    try {
      writeLock(t.path, { pid: DEAD_PID, host: thisHost(), startedAt: ago(60) });
      dropLoopLock(t.path);
      expect(existsSync(loopLockPath(t.path))).toBe(true);
      // The same process id on another machine is another process.
      writeLock(t.path, { pid: process.pid, host: "elsewhere", startedAt: ago(60) });
      dropLoopLock(t.path);
      expect(existsSync(loopLockPath(t.path))).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("starts in separate processes at the same moment: exactly one gets the lock, fresh or taken over, with hard links or without", async () => {
    const dirs = Array.from({ length: 8 }, () => tempDir());
    const results = tempDir();
    const release = join(results.path, "release");
    try {
      // Fresh folders, and locks left by a process that is gone; the last four without hard links.
      for (const d of [dirs[2]!, dirs[3]!, dirs[6]!, dirs[7]!]) writeLock(d.path, { pid: DEAD_PID, host: thisHost(), startedAt: ago(60) });
      const go = String(Date.now() + 4000);
      // Each child says how it did in a file, then holds on until every child has: a winner gone
      // early would leave a lock that a slow child could take over, fairly.
      const code = `const { existsSync, writeFileSync } = await import("node:fs");
        const { takeLoopLock } = await import(${JSON.stringify(HEARTBEAT_SRC)});
        const noLinks = () => { throw Object.assign(new Error("no hard links here"), { code: "EPERM" }); };
        await Bun.sleep(Math.max(0, Number(process.env.LOCK_GO) - Date.now()));
        const r = await takeLoopLock(process.env.LOCK_ROOT, 60, process.env.LOCK_NO_LINKS ? noLinks : undefined);
        const said = r === null ? "won" : r.startsWith("A loop is already running") ? "refused" : r;
        writeFileSync(process.env.LOCK_OUT, said);
        console.log(said);
        const until = Date.now() + 55_000;
        while (!existsSync(process.env.LOCK_RELEASE) && Date.now() < until) await Bun.sleep(50);`;
      const outs = dirs.map((_, i) => Array.from({ length: 4 }, (_, j) => join(results.path, `${i}-${j}`)));
      const running = dirs.map((d, i) => Promise.all(outs[i]!.map((out) =>
        child(code, { LOCK_ROOT: d.path, LOCK_GO: go, LOCK_OUT: out, LOCK_RELEASE: release, ...(i >= 4 ? { LOCK_NO_LINKS: "1" } : {}) }))));
      const until = Date.now() + 50_000;
      while (!outs.flat().every((o) => existsSync(o)) && Date.now() < until) await Bun.sleep(100);
      writeFileSync(release, "");
      const rounds = await Promise.all(running);
      for (const [i, round] of rounds.entries()) {
        const said = round.map((r) => r.out).sort();
        expect({ round: i, said }).toEqual({ round: i, said: ["refused", "refused", "refused", "won"] });
      }
    } finally {
      writeFileSync(release, "");
      for (const d of [...dirs, results]) d.cleanup();
    }
  }, 60_000);

  test("a start keeps a lock it made only while the lock still names it", async () => {
    const t = tempDir();
    try {
      // A stalled start, which read a lock left behind earlier, removes this one just made and makes its own.
      const replaced: LinkFile = (existing, path) => {
        linkSync(existing, path);
        rmSync(path);
        writeFileSync(path, JSON.stringify({ pid: DEAD_PID, host: thisHost(), startedAt: ago(0) }));
      };
      expect(await takeLoopLock(t.path, 60, replaced)).toBe(loopAlreadyRunning(DEAD_PID));
      expect(JSON.parse(readFileSync(loopLockPath(t.path), "utf8")).pid).toBe(DEAD_PID);
    } finally {
      t.cleanup();
    }
  });
});

describe("runningLoopPid", () => {
  test("a heartbeat this machine wrote whose process is gone is no loop at once; another machine's waits to go stale", () => {
    const t = tempDir();
    try {
      expect(runningLoopPid(t.path, 60)).toBeNull();
      const fresh = { lastBeatAt: new Date().toISOString() };
      writeHeartbeat(t.path, hb({ ...fresh, host: thisHost() }));
      expect(runningLoopPid(t.path, 60)).toBe(process.pid);
      writeHeartbeat(t.path, hb({ ...fresh, pid: DEAD_PID, host: thisHost() }));
      expect(runningLoopPid(t.path, 60)).toBeNull();
      // Another machine's process, or an older heartbeat without its machine: its process id says nothing here.
      writeHeartbeat(t.path, hb({ ...fresh, pid: DEAD_PID, host: "elsewhere" }));
      expect(runningLoopPid(t.path, 60)).toBe(DEAD_PID);
      writeHeartbeat(t.path, hb({ ...fresh, pid: DEAD_PID }));
      expect(runningLoopPid(t.path, 60)).toBe(DEAD_PID);
      writeHeartbeat(t.path, hb({ pid: DEAD_PID, host: "elsewhere", lastBeatAt: new Date(Date.now() - 3_600_000).toISOString() }));
      expect(runningLoopPid(t.path, 60)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a stale heartbeat from another machine is no loop here, even when its process id is a live process on this machine", () => {
    const t = tempDir();
    try {
      const stale = new Date(Date.now() - 3_600_000).toISOString();
      writeHeartbeat(t.path, hb({ pid: process.pid, host: "elsewhere", lastBeatAt: stale }));
      expect(runningLoopPid(t.path, 60)).toBeNull();
      // An older heartbeat without its machine is taken as this machine's: its live process is a loop not responding.
      writeHeartbeat(t.path, hb({ pid: process.pid, lastBeatAt: stale }));
      expect(runningLoopPid(t.path, 60)).toBe(process.pid);
    } finally {
      t.cleanup();
    }
  });
});

describe("the scheduler writes the heartbeat", () => {
  test("start refuses while another loop holds the lock, and leaves its heartbeat alone", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      writeHeartbeat(repo.path, hb({ lastBeatAt: new Date().toISOString() }));
      const before = readFileSync(join(repo.path, ".loopstra", "heartbeat.json"), "utf8");
      expect(await takeLoopLock(repo.path)).toBeNull();
      expect(await start(repo.path, { once: true, installSignals: false })).toBe(loopAlreadyRunning(process.pid));
      expect(readFileSync(join(repo.path, ".loopstra", "heartbeat.json"), "utf8")).toBe(before);
      expect(existsSync(loopLockPath(repo.path))).toBe(true);
      dropLoopLock(repo.path);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("start once leaves a stopped heartbeat with a last check, and no lock", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      const exits = process.listenerCount("exit");
      expect(await start(repo.path, { once: true, installSignals: false })).toBeNull();
      expect(existsSync(loopLockPath(repo.path))).toBe(false);
      expect(process.listenerCount("exit")).toBe(exits);
      // The lock was let go: the next start runs.
      expect(await start(repo.path, { once: true, installSignals: false })).toBeNull();
      const h = readHeartbeat(repo.path)!;
      expect(h.pid).toBe(process.pid);
      expect(h.stopped).toBe(true);
      expect(h.lastTickAt).not.toBeNull();
      expect(heartbeatState(h, 60, new Date()).text).toMatch(/^Stopped — last check \d+s ago$/);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a second Ctrl-C exits at once, and the lock goes and the heartbeat says stopped on the way out", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      // The loop's start in another process, ended the way a second Ctrl-C ends it once it runs.
      const code = `const { existsSync } = await import("node:fs");
        const { start } = await import(${JSON.stringify(SCHEDULER_SRC)});
        const root = process.env.LOCK_ROOT;
        const t = setInterval(() => {
          if (existsSync(root + "/.loopstra/loop.lock") && existsSync(root + "/.loopstra/heartbeat.json")) { clearInterval(t); setTimeout(() => process.exit(130), 200); }
        }, 50);
        await start(root, { once: false, installSignals: false });`;
      const r = await child(code, { LOCK_ROOT: repo.path });
      expect(r.code).toBe(130);
      expect(existsSync(loopLockPath(repo.path))).toBe(false);
      expect(readHeartbeat(repo.path)).toMatchObject({ stopped: true, host: thisHost() });
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a stop request shows as stopping before the loop ends", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      let seen: Heartbeat | null = null;
      setTimeout(() => { requestStop(); seen = readHeartbeat(repo.path); }, 300);
      await start(repo.path, { once: false, installSignals: false });
      expect(seen).toMatchObject({ stopping: true, stopped: false });
      expect(readHeartbeat(repo.path)).toMatchObject({ stopping: false, stopped: true });
      expect(existsSync(loopLockPath(repo.path))).toBe(false);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);
});

describe("the loop's pause by a person", () => {
  test("hold, read, release; releasing twice is fine", () => {
    const t = tempDir();
    try {
      expect(readLoopHold(t.path)).toBeNull();
      const h = holdLoop(t.path, "John");
      expect(readLoopHold(t.path)).toEqual(h);
      expect(h.by).toBe("John");
      expect(loopHoldText(h)).toBe("Paused by John: running steps finish, nothing new starts.");
      expect(releaseLoop(t.path)).toBe(true);
      expect(releaseLoop(t.path)).toBe(false);
      expect(readLoopHold(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a hold file that cannot be read, or lacks who or when, still pauses the loop", () => {
    const t = tempDir();
    try {
      const path = join(t.path, ".loopstra", "hold.json");
      mkdirSync(join(t.path, ".loopstra"), { recursive: true });
      const mtime = new Date("2026-10-17T08:00:00.000Z");
      for (const text of ["", "not json", "{}", "null", "[1]"]) {
        writeFileSync(path, text);
        utimesSync(path, mtime, mtime);
        expect(readLoopHold(t.path)).toEqual({ by: "someone", at: mtime.toISOString() });
      }
      writeFileSync(path, JSON.stringify({ by: "John" }));
      utimesSync(path, mtime, mtime);
      expect(readLoopHold(t.path)).toEqual({ by: "John", at: mtime.toISOString() });
      writeFileSync(path, JSON.stringify({ by: 3, at: "2026-10-17T09:00:00.000Z" }));
      expect(readLoopHold(t.path)).toEqual({ by: "someone", at: "2026-10-17T09:00:00.000Z" });
      expect(releaseLoop(t.path)).toBe(true);
      expect(readLoopHold(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("a running loop that is held reads paused and still lists what it works on; a stopped one says what its next start does", () => {
    const now = new Date("2026-10-17T10:00:00Z");
    const beat = { pid: process.pid, startedAt: "2026-10-17T09:00:00Z", lastTickAt: "2026-10-17T09:59:50Z", lastBeatAt: "2026-10-17T09:59:58Z", current: { slug: "a" }, working: ["a"], stopping: false, stopped: false };
    const hold = { by: "John", at: "2026-10-17T09:59:00Z" };
    const held = heartbeatState(beat, 60, now, { pause: null, hold });
    expect(held).toEqual({ state: "paused", text: "Paused by John: running steps finish, nothing new starts.", working: [{ slug: "a" }] });
    const stopped = heartbeatState({ ...beat, stopped: true }, 60, now, { pause: null, hold });
    expect(stopped.state).toBe("stopped");
    expect(stopped.text).toEndWith("Paused by John: the next start starts nothing until it is resumed.");
  });

  test("an outage pause and a person's hold at once: the outage is what the line says, and a stopped loop names the outage first", () => {
    const until = new Date(NOW.getTime() + 10 * 60_000);
    const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    const pause = { until: until.toISOString(), reason: `The assistant is unavailable. Retrying at ${hhmm}.`, failures: 1 };
    const hold = { by: "John", at: ago(60) };
    const running = heartbeatState(hb({ pausedUntil: pause.until, pauseReason: pause.reason, current: { slug: "a" }, working: ["a"] }), 60, NOW, { pause, hold });
    expect(running).toEqual({ state: "paused", text: `Paused — The assistant is unavailable. Retrying at ${hhmm}.`, working: [] });
    const stopped = heartbeatState(hb({ stopped: true, lastTickAt: ago(300) }), 60, NOW, { pause, hold });
    expect(stopped.state).toBe("stopped");
    expect(stopped.text).toBe(`Stopped — last check 5 min ago. The assistant was unavailable; the next start waits until ${hhmm}. Paused by John: the next start starts nothing until it is resumed.`);
  });
});

describe("the wake file", () => {
  test("each touch changes the stamp; no file is an empty stamp", () => {
    const t = tempDir();
    try {
      expect(wakeStamp(t.path)).toBe("");
      touchWake(t.path);
      const a = wakeStamp(t.path);
      touchWake(t.path);
      expect(a).not.toBe("");
      expect(wakeStamp(t.path)).not.toBe(a);
    } finally {
      t.cleanup();
    }
  });
});
