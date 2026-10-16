/**
 * Everything that lets more than one change run a step at the same time (speed.max_parallel_changes):
 * the locks, the claimed changes, and the count of running lanes. It is the only place that holds
 * this state, and it imports nothing from the rest of Loopstra. The locks live in memory, which is
 * right because one loop process runs per repository; they go away with the process.
 *
 * Two locks, always taken in this order:
 * - the merge lock (oneMerge): one merge at a time;
 * - the main lock (onMain), one per main checkout: git in the main checkout runs one command at a
 *   time, and a few sequences that are only correct if main does not move in between run as one unit.
 * No work runs side by side inside either lock: child promises would all think they hold it. So an
 * `alongside` group asserts it holds no lock, and an agent session asserts it holds no main lock.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The locks the current async context holds (by name). Re-entering one it holds goes straight in. */
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** The names this context holds. */
function heldNames(): ReadonlySet<string> {
  return held.getStore() ?? new Set();
}

/** Main locks are named with this prefix, then the checkout's key. */
const MAIN = "main:";

/** True when this context holds a main lock (of any checkout). */
function holdsMainLock(): boolean {
  return [...heldNames()].some((n) => n.startsWith(MAIN));
}

/** A first-come, first-served lock, re-entrant within one async context. */
export interface Lock {
  readonly name: string;
  /** Runs `fn` once every earlier caller is done (at once when this context holds the lock already). `who` is recorded as the holder. */
  run<T>(fn: () => Promise<T>, who?: string): Promise<T>;
  /** Like run, but gives null at once, without running `fn`, when anyone else holds or waits for the lock. */
  tryRun<T>(fn: () => Promise<T>, who?: string): Promise<T | null>;
  /** True when the current context holds it. */
  heldHere(): boolean;
  /** True while anyone holds or waits for it. */
  busy(): boolean;
  /** Who holds it now (the `who` given to run), or null when nobody does. */
  holder(): string | null;
}

/** A first-come, first-served lock. Re-entrant within one async context. Released when `fn` ends, however it ends. */
function lock(name: string): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  let holder: string | null = null;
  let pending = 0;
  const heldHere = () => heldNames().has(name);
  const run = <T>(fn: () => Promise<T>, who = ""): Promise<T> => {
    if (heldHere()) return fn();
    const mine = new Set([...heldNames(), name]);
    pending++;
    const go = tail.then(() => { holder = who; return held.run(mine, fn); });
    const done = () => { holder = null; pending--; };
    tail = go.then(done, done);
    return go;
  };
  const tryRun = <T>(fn: () => Promise<T>, who = ""): Promise<T | null> => {
    if (!heldHere() && pending > 0) return Promise.resolve(null);
    return run(fn, who);
  };
  return { name, run, tryRun, heldHere, busy: () => pending > 0, holder: () => holder };
}

/**
 * A folder's real path as one string to compare: links and 8.3 names resolved, forward slashes, no
 * trailing slash, and lower case on Windows.
 */
export function realPathKey(path: string): string {
  let real: string;
  try { real = realpathSync.native(path); } catch { real = resolve(path); }
  const key = real.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/**
 * The key of a folder's main lock: its real path (see realPathKey), or null for a folder inside a
 * `.loopstra` folder (a change's worktree, the done-check and health copies of main). A worktree's
 * index and branch belong to one change, and a change runs one step at a time, so they need no lock.
 */
export function mainLockKey(cwd: string): string | null {
  const key = realPathKey(cwd);
  return key.split("/").includes(".loopstra") ? null : key;
}

const mainLocks = new Map<string, Lock>();

/** The main lock of the checkout with this key. */
function mainLock(key: string): Lock {
  let l = mainLocks.get(key);
  if (!l) { l = lock(`${MAIN}${key}`); mainLocks.set(key, l); }
  return l;
}

/**
 * Runs `fn` under the main lock of the checkout at `root`: its index and files, refs, `.git/config`,
 * the worktree list and the remote refs. No agent session or merge check runs inside it. A folder
 * with no key (inside `.loopstra`) runs `fn` without a lock.
 */
export function onMain<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = mainLockKey(root);
  return key === null ? fn() : onMainKey(key, fn);
}

/** onMain for a key already worked out (Git works its key out once). */
export function onMainKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return mainLock(key).run(fn);
}

const merge = lock("merge");

/** Throws when taking the merge lock here would break the lock order (merge lock, then main lock). */
function assertMergeLockOrder(): void {
  if (!merge.heldHere() && holdsMainLock()) throw new Error("The merge lock was asked for while holding a main lock: take the merge lock first (a programming error).");
}

/**
 * The merge lock: one merge at a time. Without a remote it covers the merge checks through the
 * merge; with one, the up-to-date check through the merge on GitHub. `who` is the change's slug.
 */
export const oneMerge: Lock = {
  name: merge.name,
  run: (fn, who) => { assertMergeLockOrder(); return merge.run(fn, who); },
  tryRun: (fn, who) => { assertMergeLockOrder(); return merge.tryRun(fn, who); },
  heldHere: merge.heldHere,
  busy: merge.busy,
  holder: merge.holder,
};

/** True when the current context holds any lock (the merge lock or a main lock). */
export function holdsLock(): boolean {
  return heldNames().size > 0;
}

/** Throws a programming error when the current context holds any lock: `where` must not run inside one. */
export function assertNoLock(where: string): void {
  if (holdsLock()) throw new Error(`${where} ran while holding a lock (${[...heldNames()].join(", ")}), a programming error.`);
}

/** Throws a programming error when the current context holds a main lock: `where` must not run inside one. */
export function assertNoMainLock(where: string): void {
  if (holdsMainLock()) throw new Error(`${where} ran while holding a main lock, a programming error.`);
}

/** The changes running a step now (a lane's, or the between-phases merge's). */
const claimed = new Set<string>();

/** Claims a change for one step: false when it is claimed already. */
export function claim(slug: string): boolean {
  if (claimed.has(slug)) return false;
  claimed.add(slug);
  return true;
}

/** Releases a change's claim once its step has ended. */
export function release(slug: string): void {
  claimed.delete(slug);
}

/** How many claimed changes there are besides this one. */
export function othersRunning(slug: string): number {
  return claimed.size - (claimed.has(slug) ? 1 : 0);
}

let lanes = 0;

/** A lane started running steps. */
export function laneStarted(): void { lanes++; }
/** A lane ended. */
export function laneEnded(): void { lanes = Math.max(0, lanes - 1); }
/** How many lanes are running now. */
export function lanesRunning(): number { return lanes; }
