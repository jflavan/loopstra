/**
 * Everything that lets more than one change run a step at the same time (speed.max_parallel_changes):
 * the locks and the claimed changes. It is the only place that holds this state, and it imports
 * nothing from the rest of Loopstra. The locks live in memory, which is right because one loop
 * process runs per repository; they go away with the process.
 *
 * A lock covers what is written, not where git runs. Four locks, always taken in this order:
 * - the merge lock (oneMerge): one merge at a time;
 * - the sync lock (oneSync): one sync of main with the remote at a time (it has a worktree of its own);
 * - the checkout lock (onCheckout), one per main checkout: what is written there, its index, its
 *   files and its main branch (records, moving main, a local merge);
 * - the remote lock (onRemote), one per main checkout: what fetch and push write, the remote-tracking refs.
 * Worktree administration, branches, and reads of refs and objects take none. No work runs side by
 * side inside a lock: child promises would all think they hold it. So an `alongside` group asserts
 * it holds no lock, and an agent session asserts it holds no checkout lock.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The locks the current async context holds (by name). Re-entering one it holds goes straight in. */
const held = new AsyncLocalStorage<ReadonlyMap<string, number>>();

/** The names this context holds, each with its place in the lock order. */
function heldLocks(): ReadonlyMap<string, number> {
  return held.getStore() ?? new Map();
}

/** The place of each kind of lock in the order they are taken. */
const ORDER = { merge: 0, sync: 1, checkout: 2, remote: 3 } as const;
type Kind = keyof typeof ORDER;

/** A first-come, first-served lock, re-entrant within one async context. */
interface Lock {
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

/**
 * A first-come, first-served lock. Re-entrant within one async context. Released when `fn` ends,
 * however it ends. Taking it while holding a lock that comes later in the order is a programming error.
 */
function lock(name: string, kind: Kind): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  let holder: string | null = null;
  let pending = 0;
  const heldHere = () => heldLocks().has(name);
  const run = <T>(fn: () => Promise<T>, who = ""): Promise<T> => {
    if (heldHere()) return fn();
    const later = [...heldLocks()].filter(([, place]) => place > ORDER[kind]).map(([n]) => n);
    if (later.length) throw new Error(`The ${name} lock was asked for while holding ${later.join(", ")}: locks are taken in the order merge, sync, checkout, remote (a programming error).`);
    const mine = new Map([...heldLocks(), [name, ORDER[kind]]]);
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
 * The key of a checkout's locks: its real path (see realPathKey), or null for a linked worktree (its
 * `.git` is a file: a change's worktree, a snapshot, the done-check, health and sync copies of main),
 * whose index, files and HEAD are its own. A change runs one step at a time, so they need no lock.
 */
export function checkoutKey(cwd: string): string | null {
  try {
    if (statSync(join(cwd, ".git")).isFile()) return null;
  } catch { /* no .git here: not a linked worktree */ }
  return realPathKey(cwd);
}

const keyed = new Map<string, Lock>();

/** The lock of this kind for the checkout with this key. */
function keyedLock(kind: "checkout" | "remote", key: string): Lock {
  const name = `${kind}:${key}`;
  let l = keyed.get(name);
  if (!l) { l = lock(name, kind); keyed.set(name, l); }
  return l;
}

/**
 * Runs `fn` under the checkout lock of the main checkout at `root`: nothing else writes its index,
 * its files or its main branch until it ends. No agent session or merge check runs inside it. A
 * linked worktree (see checkoutKey) runs `fn` without a lock.
 */
export function onCheckout<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = checkoutKey(root);
  return key === null ? fn() : onCheckoutKey(key, fn);
}

/** onCheckout for a key already worked out (Git works its key out once). */
export function onCheckoutKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return keyedLock("checkout", key).run(fn);
}

/** Runs `fn` under the remote lock of the checkout with this key: no other fetch or push of it runs meanwhile. */
export function onRemoteKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return keyedLock("remote", key).run(fn);
}

/**
 * The merge lock: one merge at a time. Without a remote it covers the merge checks through the
 * merge; with one, the up-to-date check through the merge on GitHub. `who` is the change's slug.
 */
export const oneMerge: Lock = lock("merge", "merge");

/** The sync lock: one sync of main with the remote at a time, since each replays main in the same worktree. */
export const oneSync: Lock = lock("sync", "sync");

/** True when the current context holds any lock. */
export function holdsLock(): boolean {
  return heldLocks().size > 0;
}

/** Throws a programming error when the current context holds any lock: `where` must not run inside one. */
export function assertNoLock(where: string): void {
  if (holdsLock()) throw new Error(`${where} ran while holding a lock (${[...heldLocks().keys()].join(", ")}), a programming error.`);
}

/** Throws a programming error when the current context holds a checkout lock: `where` must not run inside one. */
export function assertNoCheckoutLock(where: string): void {
  if ([...heldLocks().keys()].some((n) => n.startsWith("checkout:"))) throw new Error(`${where} ran while holding a checkout lock, a programming error.`);
}

/** The changes running a step now (a lane's, the thinker's, or the pull request watcher's). */
const claimed = new Set<string>();

/** Claims a change for one step: false when it is claimed already. */
export function claim(slug: string): boolean {
  if (claimed.has(slug)) return false;
  claimed.add(slug);
  return true;
}

/** The claimed changes whose step runs none of the project's commands (a design or plan step, in a lane or beside them; see thinkingStep in the scheduler). */
const noCommands = new Set<string>();

/** Marks a claimed change's step as one that runs none of the project's commands, until it is released. */
export function runsNoCommands(slug: string): void {
  if (claimed.has(slug)) noCommands.add(slug);
}

/** The slot of each claimed change that has asked for one (see slotEnv). */
const slots = new Map<string, number>();

/**
 * LOOPSTRA_SLOT for a claimed change's commands and sessions that run them: the lowest number (from 0)
 * no other claimed change holds, the same for the rest of its step. A project picks its ports,
 * database and Docker project names from it, so changes running at the same time never share them.
 * Empty for a change that is not claimed (main's health check runs alone, at a tick's start).
 */
export function slotEnv(slug: string): { LOOPSTRA_SLOT?: string } {
  if (!claimed.has(slug)) return {};
  let slot = slots.get(slug);
  if (slot === undefined) {
    const held = new Set(slots.values());
    for (slot = 0; held.has(slot); slot++);
    slots.set(slug, slot);
  }
  return { LOOPSTRA_SLOT: String(slot) };
}

/** Releases a change's claim once its step has ended. */
export function release(slug: string): void {
  claimed.delete(slug);
  noCommands.delete(slug);
  slots.delete(slug);
}

/** How many claimed changes there are besides this one. */
export function othersRunning(slug: string): number {
  return claimed.size - (claimed.has(slug) ? 1 : 0);
}

/** How many claimed changes besides this one may run the project's commands (see runsNoCommands). */
export function othersRunningCommands(slug: string): number {
  return [...claimed].filter((s) => s !== slug && !noCommands.has(s)).length;
}
