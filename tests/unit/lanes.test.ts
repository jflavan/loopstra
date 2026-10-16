import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoLock, assertNoMainLock, claim, holdsLock, laneEnded, lanesRunning, laneStarted, mainLockKey, onMain, oneMerge, othersRunning, release,
} from "../../src/lanes";
import { StopRequested } from "../../src/stop";
import { tempDir } from "../helpers";

/** A promise and the function that resolves it, to hold a lock open until a test says so. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

/** Lets every queued callback run. */
const settle = () => Bun.sleep(5);

let dirs: Array<{ cleanup: () => void }> = [];
function folder(): string {
  const d = tempDir();
  dirs.push(d);
  return d.path;
}
afterEach(() => {
  for (const d of dirs) d.cleanup();
  dirs = [];
});

describe("the main lock", () => {
  test("serves callers in the order they arrived", async () => {
    const root = folder();
    const order: number[] = [];
    // The first caller sleeps longest: without the lock the last one would finish first.
    await Promise.all([0, 1, 2, 3, 4].map((i) => onMain(root, async () => {
      await Bun.sleep(10 - 2 * i);
      order.push(i);
    })));
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("five callers never overlap: every entry is followed by its own exit", async () => {
    const root = folder();
    const log: string[] = [];
    await Promise.all([0, 1, 2, 3, 4].map((i) => onMain(root, async () => {
      log.push(`in ${i}`);
      await Bun.sleep(Math.floor(Math.random() * 6));
      log.push(`out ${i}`);
    })));
    expect(log).toHaveLength(10);
    for (let k = 0; k < log.length; k += 2) expect(log[k + 1]).toBe(log[k]!.replace("in", "out"));
  });

  test("a nested call in the same context goes straight in", async () => {
    const root = folder();
    expect(await onMain(root, () => onMain(root, async () => "inside"))).toBe("inside");
  });

  test("a parallel context waits until the holder is done", async () => {
    const root = folder();
    const g = gate();
    const log: string[] = [];
    const first = onMain(root, async () => { log.push("first in"); await g.opened; log.push("first out"); });
    const second = onMain(root, async () => { log.push("second in"); });
    await settle();
    expect(log).toEqual(["first in"]);
    g.open();
    await Promise.all([first, second]);
    expect(log).toEqual(["first in", "first out", "second in"]);
  });

  test("two different main checkouts have locks of their own", async () => {
    const a = folder();
    const b = folder();
    const g = gate();
    const held = onMain(a, () => g.opened);
    expect(await onMain(b, async () => "free")).toBe("free");
    g.open();
    await held;
  });

  test("a throw, a stop request among them, releases the lock and reaches the caller", async () => {
    const root = folder();
    await expect(onMain(root, async () => { throw new Error("broken"); })).rejects.toThrow("broken");
    await expect(onMain(root, async () => { throw new StopRequested(); })).rejects.toBeInstanceOf(StopRequested);
    expect(await onMain(root, async () => "after")).toBe("after");
  });

  test("the key is the folder's real path, and folders inside .loopstra have none", () => {
    const root = folder();
    expect(mainLockKey(root)).toBe(mainLockKey(`${root}/`));
    expect(mainLockKey(root)).toBe(mainLockKey(join(root, "x", "..")));
    if (process.platform === "win32") expect(mainLockKey(root)).toBe(mainLockKey(root.toUpperCase()));
    const wt = join(root, ".loopstra", "worktrees", "x");
    mkdirSync(wt, { recursive: true });
    expect(mainLockKey(wt)).toBeNull();
    expect(mainLockKey(join(root, ".loopstra", "health"))).toBeNull();
  });

  test("a folder inside .loopstra runs without waiting for anyone", async () => {
    const root = folder();
    const g = gate();
    const held = onMain(root, () => g.opened);
    expect(await onMain(join(root, ".loopstra", "worktrees", "x"), async () => "free")).toBe("free");
    g.open();
    await held;
  });
});

describe("the merge lock", () => {
  test("holder() names the change holding it, and nobody once it is free", async () => {
    expect(oneMerge.holder()).toBeNull();
    let inside: string | null = null;
    await oneMerge.run(async () => { inside = oneMerge.holder(); }, "add-numbers");
    expect(inside as string | null).toBe("add-numbers");
    expect(oneMerge.holder()).toBeNull();
  });

  test("tryRun gives null without waiting while another change holds it, and runs once it is free", async () => {
    const g = gate();
    const held = oneMerge.run(() => g.opened, "add-numbers");
    await settle();
    expect(oneMerge.busy()).toBe(true);
    let ran = false;
    expect(await oneMerge.tryRun(async () => { ran = true; return 1; }, "say-goodbye")).toBeNull();
    expect(ran).toBe(false);
    g.open();
    await held;
    expect(oneMerge.busy()).toBe(false);
    expect(await oneMerge.tryRun(async () => 2, "say-goodbye")).toBe(2);
  });

  test("the holder's own tryRun goes straight in", async () => {
    expect(await oneMerge.run(() => oneMerge.tryRun(async () => "again", "a"), "a")).toBe("again");
  });

  test("taking it while holding a main lock is a programming error; the other order is fine", async () => {
    const root = folder();
    await expect(onMain(root, () => oneMerge.run(async () => 1, "a"))).rejects.toThrow(/main lock/);
    await expect(onMain(root, () => oneMerge.tryRun(async () => 1, "a"))).rejects.toThrow(/main lock/);
    expect(await oneMerge.run(() => onMain(root, async () => "ok"), "a")).toBe("ok");
    expect(oneMerge.busy()).toBe(false);
  });
});

describe("the lock assertions", () => {
  test("assertNoLock throws under either lock, assertNoMainLock only under a main lock", async () => {
    const root = folder();
    expect(() => assertNoLock("alongside")).not.toThrow();
    expect(() => assertNoMainLock("a session")).not.toThrow();
    await expect(onMain(root, async () => assertNoLock("alongside"))).rejects.toThrow(/alongside/);
    await expect(onMain(root, async () => assertNoMainLock("a session"))).rejects.toThrow(/a session/);
    await expect(oneMerge.run(async () => assertNoLock("alongside"), "a")).rejects.toThrow(/alongside/);
    await oneMerge.run(async () => assertNoMainLock("a session"), "a");
  });

  test("holdsLock is true only inside a section, and the caller holds nothing once it has ended", async () => {
    const root = folder();
    expect(holdsLock()).toBe(false);
    expect(await onMain(root, async () => holdsLock())).toBe(true);
    expect(await oneMerge.run(async () => holdsLock(), "a")).toBe(true);
    await oneMerge.run(() => onMain(root, async () => { await Bun.sleep(1); }), "a");
    expect(holdsLock()).toBe(false);
    expect(() => assertNoLock("after the sections")).not.toThrow();
  });
});

describe("claims and lanes", () => {
  test("a change is claimed once until it is released; othersRunning counts the rest", () => {
    expect(claim("a")).toBe(true);
    expect(claim("a")).toBe(false);
    expect(claim("b")).toBe(true);
    expect(othersRunning("a")).toBe(1);
    expect(othersRunning("c")).toBe(2);
    release("a");
    expect(othersRunning("c")).toBe(1);
    expect(claim("a")).toBe(true);
    release("a");
    release("b");
    expect(othersRunning("a")).toBe(0);
  });

  test("lanesRunning counts lanes started and not yet ended", () => {
    expect(lanesRunning()).toBe(0);
    laneStarted();
    laneStarted();
    expect(lanesRunning()).toBe(2);
    laneEnded();
    expect(lanesRunning()).toBe(1);
    laneEnded();
    expect(lanesRunning()).toBe(0);
  });
});
