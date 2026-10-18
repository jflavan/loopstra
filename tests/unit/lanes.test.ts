import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoCheckoutLock, assertNoLock, checkoutKey, claim, holdsLock, onCheckout, onCheckoutKey, oneMerge, oneSync, onRemoteKey, othersRunning, othersRunningCommands, release, runsNoCommands, slotEnv,
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

/** A folder that looks like a linked worktree: its `.git` is a file. */
function linkedWorktree(root: string, name: string): string {
  const dir = join(root, ".loopstra", "worktrees", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), "gitdir: elsewhere\n");
  return dir;
}

describe("the checkout lock", () => {
  test("serves callers in the order they arrived", async () => {
    const root = folder();
    const order: number[] = [];
    // The first caller sleeps longest: without the lock the last one would finish first.
    await Promise.all([0, 1, 2, 3, 4].map((i) => onCheckout(root, async () => {
      await Bun.sleep(10 - 2 * i);
      order.push(i);
    })));
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("five callers never overlap: every entry is followed by its own exit", async () => {
    const root = folder();
    const log: string[] = [];
    await Promise.all([0, 1, 2, 3, 4].map((i) => onCheckout(root, async () => {
      log.push(`in ${i}`);
      await Bun.sleep(Math.floor(Math.random() * 6));
      log.push(`out ${i}`);
    })));
    expect(log).toHaveLength(10);
    for (let k = 0; k < log.length; k += 2) expect(log[k + 1]).toBe(log[k]!.replace("in", "out"));
  });

  test("a nested call in the same context goes straight in", async () => {
    const root = folder();
    expect(await onCheckout(root, () => onCheckout(root, async () => "inside"))).toBe("inside");
  });

  test("a parallel context waits until the holder is done", async () => {
    const root = folder();
    const g = gate();
    const log: string[] = [];
    const first = onCheckout(root, async () => { log.push("first in"); await g.opened; log.push("first out"); });
    const second = onCheckout(root, async () => { log.push("second in"); });
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
    const held = onCheckout(a, () => g.opened);
    expect(await onCheckout(b, async () => "free")).toBe("free");
    g.open();
    await held;
  });

  test("a throw, a stop request among them, releases the lock and reaches the caller", async () => {
    const root = folder();
    await expect(onCheckout(root, async () => { throw new Error("broken"); })).rejects.toThrow("broken");
    await expect(onCheckout(root, async () => { throw new StopRequested(); })).rejects.toBeInstanceOf(StopRequested);
    expect(await onCheckout(root, async () => "after")).toBe("after");
  });

  test("the key is the folder's real path; a linked worktree (its .git is a file) has none", () => {
    const root = folder();
    expect(checkoutKey(root)).toBe(checkoutKey(`${root}/`));
    expect(checkoutKey(root)).toBe(checkoutKey(join(root, "x", "..")));
    if (process.platform === "win32") expect(checkoutKey(root)).toBe(checkoutKey(root.toUpperCase()));
    expect(checkoutKey(linkedWorktree(root, "x"))).toBeNull();
  });

  test("a repository inside a folder named .loopstra still locks its main checkout", async () => {
    const root = join(folder(), ".loopstra", "repos", "app");
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(checkoutKey(root)).not.toBeNull();
    let overlap = 0;
    let most = 0;
    await Promise.all([0, 1, 2].map(() => onCheckout(root, async () => {
      most = Math.max(most, ++overlap);
      await Bun.sleep(3);
      overlap--;
    })));
    expect(most).toBe(1);
  });

  test("a linked worktree runs without waiting for anyone", async () => {
    const root = folder();
    const g = gate();
    const held = onCheckout(root, () => g.opened);
    expect(await onCheckout(linkedWorktree(root, "x"), async () => "free")).toBe("free");
    g.open();
    await held;
  });

  test("the remote lock is its own: a fetch never waits for a records section, nor a records section for a fetch", async () => {
    const key = checkoutKey(folder())!;
    const g = gate();
    const records = onCheckoutKey(key, () => g.opened);
    expect(await onRemoteKey(key, async () => "fetched")).toBe("fetched");
    g.open();
    await records;
    const h = gate();
    const fetching = onRemoteKey(key, () => h.opened);
    expect(await onCheckoutKey(key, async () => "committed")).toBe("committed");
    h.open();
    await fetching;
  });
});

describe("the merge and sync locks", () => {
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

  test("locks are taken in the order merge, sync, checkout, remote; any other order is a programming error", async () => {
    const root = folder();
    const key = checkoutKey(root)!;
    await expect(onCheckout(root, async () => oneMerge.run(async () => 1, "a"))).rejects.toThrow(/order/);
    await expect(onCheckout(root, async () => oneSync.run(async () => 1))).rejects.toThrow(/order/);
    await expect(onRemoteKey(key, async () => onCheckout(root, async () => 1))).rejects.toThrow(/order/);
    await expect(oneSync.run(async () => oneMerge.run(async () => 1, "a"))).rejects.toThrow(/order/);
    const inOrder = await oneMerge.run(() => oneSync.run(() => onCheckout(root, () => onRemoteKey(key, async () => "ok"))), "a");
    expect(inOrder).toBe("ok");
    expect(oneMerge.busy()).toBe(false);
  });
});

describe("the lock assertions", () => {
  test("assertNoLock throws under any lock, assertNoCheckoutLock only under a checkout lock", async () => {
    const root = folder();
    expect(() => assertNoLock("alongside")).not.toThrow();
    expect(() => assertNoCheckoutLock("a session")).not.toThrow();
    await expect(onCheckout(root, async () => assertNoLock("alongside"))).rejects.toThrow(/alongside/);
    await expect(onCheckout(root, async () => assertNoCheckoutLock("a session"))).rejects.toThrow(/a session/);
    await expect(oneMerge.run(async () => assertNoLock("alongside"), "a")).rejects.toThrow(/alongside/);
    await oneMerge.run(async () => assertNoCheckoutLock("a session"), "a");
  });

  test("holdsLock is true only inside a section, and the caller holds nothing once it has ended", async () => {
    const root = folder();
    expect(holdsLock()).toBe(false);
    expect(await onCheckout(root, async () => holdsLock())).toBe(true);
    expect(await oneMerge.run(async () => holdsLock(), "a")).toBe(true);
    await oneMerge.run(() => onCheckout(root, async () => { await Bun.sleep(1); }), "a");
    expect(holdsLock()).toBe(false);
    expect(() => assertNoLock("after the sections")).not.toThrow();
  });
});

describe("claims", () => {
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

  test("a step that runs no commands counts in othersRunning but not in othersRunningCommands, until it is released", () => {
    expect(claim("a")).toBe(true);
    expect(claim("b")).toBe(true);
    runsNoCommands("b");
    expect(othersRunning("c")).toBe(2);
    expect(othersRunningCommands("c")).toBe(1);
    expect(othersRunningCommands("a")).toBe(0);
    release("b");
    // Claimed again, its next step may run commands.
    expect(claim("b")).toBe(true);
    expect(othersRunningCommands("c")).toBe(2);
    release("a");
    release("b");
    expect(othersRunningCommands("c")).toBe(0);
  });

  test("each claimed change gets the lowest slot no other claimed change holds, kept until it is released", () => {
    expect(slotEnv("a")).toEqual({});
    claim("a");
    claim("b");
    expect(slotEnv("b")).toEqual({ LOOPSTRA_SLOT: "0" });
    expect(slotEnv("a")).toEqual({ LOOPSTRA_SLOT: "1" });
    expect(slotEnv("b")).toEqual({ LOOPSTRA_SLOT: "0" });
    release("b");
    claim("c");
    // The slot b let go of is taken again, and a keeps its own.
    expect(slotEnv("c")).toEqual({ LOOPSTRA_SLOT: "0" });
    expect(slotEnv("a")).toEqual({ LOOPSTRA_SLOT: "1" });
    release("a");
    release("c");
    claim("a");
    expect(slotEnv("a")).toEqual({ LOOPSTRA_SLOT: "0" });
    release("a");
  });
});
