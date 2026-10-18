import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { writeFileAtomic } from "./fsutil";
import { onStop } from "./stop";
import { andList } from "./text";

/**
 * The loop's heartbeat, `.loopstra/heartbeat.json`. The scheduler writes it on start, at the start
 * and end of every tick, when a stop is asked for, and when it stops. While the process is alive it
 * is also refreshed every few seconds (`lastBeatAt`), so a long step does not look like a dead loop.
 * Each write also carries the pause, if one is running (see Pause), or else the tick's wait for the
 * loop's daily budget (see heartbeatDayPause).
 */
export interface Heartbeat {
  pid: number;
  /** The machine it was written on (see thisHost); missing in older heartbeats. */
  host?: string;
  startedAt: string;
  /** The start or end of the newest tick; null before the first one. Shown as "last check". */
  lastTickAt: string | null;
  /** Refreshed every few seconds while the process runs. Staleness is judged from this. */
  lastBeatAt: string;
  /** The first change in `working`, if any: written for older readers, which know only this field. */
  current: { slug: string } | null;
  /** The changes the current tick is working on, in the order their steps started. Missing in older heartbeats. */
  working?: string[];
  stopping: boolean;
  stopped: boolean;
  /** While the loop waits (the assistant was unavailable, or the day's budget): until when, and why in plain words. */
  pausedUntil?: string | null;
  pauseReason?: string | null;
}

export type LoopState = "running" | "paused" | "stopped" | "not-responding";

export interface LoopStatus {
  state: LoopState;
  /** Plain words for the owner, e.g. "Running — last check 20s ago". */
  text: string;
  /** The changes being worked on, in the order their steps started; the dashboard adds each one's running phase. */
  working: Array<{ slug: string; phase?: string | null }>;
}

/** The changes a heartbeat says are being worked on; an older heartbeat has only `current`. */
function workingOf(hb: Heartbeat): Array<{ slug: string }> {
  const slugs = hb.working ?? (hb.current ? [hb.current.slug] : []);
  return slugs.map((slug) => ({ slug }));
}


/** How often a live loop refreshes `lastBeatAt`. */
export const BEAT_MS = 5_000;

export function heartbeatPath(root: string): string {
  return join(root, ".loopstra", "heartbeat.json");
}

/** Writes the heartbeat whole (temp file, then rename), so a reader never sees half of it. Never throws. */
export function writeHeartbeat(root: string, hb: Heartbeat): void {
  try {
    writeFileAtomic(heartbeatPath(root), JSON.stringify(hb, null, 2));
  } catch {
    /* The heartbeat is for display only; it must never stop the loop. */
  }
}

/** The heartbeat, or null when there is none or it cannot be read. */
export function readHeartbeat(root: string): Heartbeat | null {
  try {
    const hb = JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as Heartbeat;
    if (typeof hb?.pid !== "number" || typeof hb.startedAt !== "string") return null;
    return hb;
  } catch {
    return null;
  }
}

/** "20s", "14 min", "3 h", "2 days". */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** True when a process with this id exists (a process owned by someone else counts). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string })?.code === "EPERM";
  }
}

/**
 * Running, paused, stopped, or not responding. A heartbeat older than three polls (never less than
 * three beats) whose process is gone is a loop that did not shut down cleanly (killed, crashed);
 * with the process still there it is not responding (hung, or the machine slept). A stopped loop
 * with a pause still running says when the next start will try. `pause` defaults to the one the
 * heartbeat carries; `hold` is a person's pause (see LoopHold); `alive` is for tests.
 */
export function heartbeatState(
  hb: Heartbeat | null, pollSeconds: number, now: Date = new Date(),
  opts: { pause?: Pause | null; hold?: LoopHold | null; alive?: (pid: number) => boolean } = {},
): LoopStatus {
  const t = now.getTime();
  const until = opts.pause !== undefined ? opts.pause?.until : hb?.pausedUntil;
  const waits = until && Date.parse(until) > t ? ` The assistant was unavailable; the next start waits until ${clockText(new Date(until))}.` : "";
  const holds = opts.hold ? ` Paused by ${opts.hold.by}: the next start starts nothing until it is resumed.` : "";
  const stopped = (text: string): LoopStatus => ({ state: "stopped", text: waits || holds ? `${text}.${waits}${holds}` : text, working: [] });
  if (!hb) return stopped("Stopped");
  const lastCheck = `last check ${agoText(t - Date.parse(hb.lastTickAt ?? hb.startedAt))} ago`;
  if (hb.stopped) return stopped(hb.lastTickAt ? `Stopped — ${lastCheck}` : "Stopped");
  const staleMs = Math.max(3 * pollSeconds * 1000, 3 * BEAT_MS);
  const beat = Date.parse(hb.lastBeatAt ?? hb.lastTickAt ?? hb.startedAt);
  if (t - beat > staleMs) {
    if (!(opts.alive ?? pidAlive)(hb.pid)) return stopped(`Stopped — it did not shut down cleanly (${lastCheck})`);
    return { state: "not-responding", text: `Not responding (${lastCheck})`, working: workingOf(hb) };
  }
  if (hb.stopping) return { state: "running", text: `Stopping — ${lastCheck}`, working: workingOf(hb) };
  if (hb.pausedUntil && Date.parse(hb.pausedUntil) > t) return { state: "paused", text: `Paused — ${hb.pauseReason ?? ""}`.trimEnd(), working: [] };
  // A person's pause: the steps already running go on, so they are still listed.
  if (opts.hold) return { state: "paused", text: loopHoldText(opts.hold), working: workingOf(hb) };
  const working = workingOf(hb);
  const on = working.length ? `working on ${andList(working.map((w) => w.slug))}, ` : "";
  return { state: "running", text: `Running — ${on}${lastCheck}`, working };
}

/** "Loop: Running — last check 20s ago" plus a newline, for `status`. */
export async function loopStatusLine(root: string): Promise<string> {
  const poll = await loadConfig(root).then((c) => c.poll_seconds, () => 60);
  return `Loop: ${heartbeatState(readHeartbeat(root), poll, new Date(), { pause: readPause(root), hold: readLoopHold(root) }).text}\n`;
}

/** What start says when a loop is already running in the repository; `pid` is its process, when known. */
export function loopAlreadyRunning(pid: number | null): string {
  return `A loop is already running in this repository${pid === null ? "" : ` (process ${pid})`}. Stop it (Ctrl-C in its terminal) before starting another. If no loop is running here, delete .loopstra/loop.lock and .loopstra/heartbeat.json, then start again.`;
}

/**
 * This machine, as the heartbeat and the loop's lock record it, so a process id is only checked
 * where it means something. The platform is part of it: WSL takes the Windows machine's name, and
 * a folder both share would otherwise look like one machine. On Linux the machine id and the
 * process id namespace (`pid:[4026531836]`) tell WSL distributions and containers on one machine
 * apart: each sees the others' processes as gone.
 */
export function thisHost(): string {
  const parts = [process.platform, hostname()];
  if (process.platform === "linux") {
    try { parts.push(readFileSync("/etc/machine-id", "utf8").trim().slice(0, 12)); } catch { /* none */ }
    try { parts.push(readlinkSync("/proc/self/ns/pid")); } catch { /* none */ }
  }
  return parts.filter(Boolean).join("/");
}

/**
 * The process of the loop running in this repository, by its heartbeat, or null when none is:
 * running, paused, or not responding. A heartbeat written on this machine whose process is gone is
 * a loop that ended (closed window, killed, crashed) at once; one from another machine sharing the
 * folder, or an older one without its machine, counts as running until it goes stale. Another
 * machine's process id means nothing here, so once its heartbeat is stale it is a loop that ended,
 * even when a process on this machine happens to have the same id; an older heartbeat without its
 * machine is taken as this machine's.
 */
export function runningLoopPid(root: string, pollSeconds: number): number | null {
  const hb = readHeartbeat(root);
  if (!hb || (hb.host === thisHost() && !pidAlive(hb.pid))) return null;
  const here = hb.host === undefined || hb.host === thisHost();
  return heartbeatState(hb, pollSeconds, new Date(), { alive: here ? pidAlive : () => false }).state === "stopped" ? null : hb.pid;
}

/**
 * The loop's lock, `.loopstra/loop.lock` (`{ pid, host, startedAt }`): one loop per repository. Two
 * starts can both pass the heartbeat check before either writes a heartbeat; the lock is linked into
 * place whole and only when no file is there, so only one of them gets it.
 */
export function loopLockPath(root: string): string {
  return join(root, ".loopstra", "loop.lock");
}

interface LoopLock { pid: number; host?: string; startedAt?: string }

/** Links `existing` to `path`; `linkSync`, unless a test passes its own. */
export type LinkFile = (existing: string, path: string) => void;

/**
 * Makes the lock for this process: written to a temp file, then hard-linked into place, which fails
 * when the lock is there, so a reader never sees it half-written. Where hard links are not
 * available (FAT, some network shares) it is an exclusive create, then the write: a reader in
 * between sees an empty lock, which counts as held while it is young (see LOCK_WRITE_MS). False
 * when the lock was already there.
 */
function createLoopLock(path: string, link: LinkFile): boolean {
  const text = JSON.stringify({ pid: process.pid, host: thisHost(), startedAt: new Date().toISOString() });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    link(tmp, path);
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === "EEXIST") return false;
  } finally {
    // On Windows a virus scanner or the indexer can hold it a moment; it must not undo a lock that was made.
    try { rmSync(tmp, { force: true }); } catch { /* a leftover temp file is harmless */ }
  }
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as { code?: string })?.code === "EEXIST") return false;
    throw e;
  }
  try { writeSync(fd, text); } finally { closeSync(fd); }
  return true;
}

/** The lock file's text, or null when there is none. */
function lockText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** The lock in `text`, or null when it cannot be read (a damaged file, or one still being written). */
function parseLock(text: string | null): LoopLock | null {
  try {
    const lock = JSON.parse(text ?? "") as LoopLock;
    return typeof lock?.pid === "number" ? lock : null;
  } catch {
    return null;
  }
}

/** How long a lock that cannot be read counts as one still being written (see createLoopLock). */
const LOCK_WRITE_MS = 5_000;

/** True when the file was changed within the last LOCK_WRITE_MS. */
function young(path: string): boolean {
  try { return Date.now() - statSync(path).mtimeMs < LOCK_WRITE_MS; } catch { return false; }
}

/** How long a start that made the lock waits before reading it back. */
const TAKEOVER_SETTLE_MS = 50;

/**
 * Takes the loop's lock for this process. Returns null when it has it, or the refusal. A live
 * process on this machine holding it refuses, and so does one that cannot be read yet (see
 * LOCK_WRITE_MS). A lock left behind is taken over: its process is gone (on this machine), it is
 * damaged, or it is from another machine whose loop the heartbeat says is not running
 * (`pollSeconds` judges that). Two starts taking over the same lock can each remove it and make
 * their own (one of them may even remove a lock a third start just made), and two that make it
 * without a hard link can both think they did, so the lock is always read back after a moment and
 * kept only when it still names this process. Only a problem making the file at all refuses with
 * that problem. `link` is for tests.
 */
export async function takeLoopLock(root: string, pollSeconds = 60, link: LinkFile = linkSync): Promise<string | null> {
  const path = loopLockPath(root);
  try {
    mkdirSync(join(root, ".loopstra"), { recursive: true });
    if (!createLoopLock(path, link)) {
      const seen = lockText(path);
      const lock = parseLock(seen);
      if (lock) {
        const here = (lock.host ?? thisHost()) === thisHost();
        if (here ? pidAlive(lock.pid) : runningLoopPid(root, pollSeconds) !== null) return loopAlreadyRunning(lock.pid);
      } else if (young(path)) {
        return loopAlreadyRunning(null);
      }
      // Another start may have taken it over since it was read.
      if (lockText(path) !== seen) return loopAlreadyRunning(parseLock(lockText(path))?.pid ?? null);
      rmSync(path, { force: true });
      if (!createLoopLock(path, link)) return loopAlreadyRunning(parseLock(lockText(path))?.pid ?? null);
    }
    // Even a lock made fresh: a start that read the one left behind earlier may still remove it.
    await Bun.sleep(TAKEOVER_SETTLE_MS);
    const mine = parseLock(lockText(path));
    if (mine?.pid === process.pid && mine.host === thisHost()) return null;
    return loopAlreadyRunning(mine?.pid ?? null);
  } catch (e) {
    return `Could not make the loop's lock, .loopstra/loop.lock (${(e as Error)?.message ?? String(e)}). Check that the folder can be written, then start again.`;
  }
}

/** Lets go of the loop's lock, when this process holds it. Never throws. */
export function dropLoopLock(root: string): void {
  const path = loopLockPath(root);
  try {
    const lock = parseLock(lockText(path));
    if (lock?.pid === process.pid && lock.host === thisHost()) rmSync(path, { force: true });
  } catch { /* the next start on this machine finds this process gone and takes it over */ }
}

/**
 * The loop's pause after the assistant was unavailable, `.loopstra/paused.json`. It is on disk, not
 * in the process, so a restart keeps backing off. `failures` counts unavailable sessions in a row.
 */
export interface Pause {
  until: string;
  /** Plain words for the owner, with the time of the next try. */
  reason: string;
  failures: number;
  /** The change and phase that could not reach the assistant, and the line that said so (null when unknown). */
  slug?: string | null;
  phase?: string | null;
  line?: string | null;
  /** The model that phase asked (null when unknown): another model getting through does not end the pause. */
  model?: string | null;
  /** Pauses in a row for the same change, phase, line, and model (see PROBE_AFTER in the scheduler). */
  repeats?: number;
  /** Other models that got through since this pause was written (it stayed, since it names another model). */
  gotThrough?: string[];
}

/** What made the loop pause: the change, its phase, the line that matched, and the model it asked. */
export interface PauseCause { slug: string; phase: string; line: string; model?: string | null }

/** Minutes to wait after the 1st, 2nd, ... unavailable session in a row; the last one repeats. */
const BACKOFF_MINUTES = [1, 2, 4, 8, 16, 30];

function pausePath(root: string): string {
  return join(root, ".loopstra", "paused.json");
}

/** The pause on disk (running out or not), or null. */
export function readPause(root: string): Pause | null {
  try {
    const p = JSON.parse(readFileSync(pausePath(root), "utf8")) as Pause;
    return typeof p?.until === "string" && typeof p.failures === "number" ? p : null;
  } catch {
    return null;
  }
}

/** The pause, while it has not run out. */
export function activePause(root: string, now: Date = new Date()): Pause | null {
  const p = readPause(root);
  return p && Date.parse(p.until) > now.getTime() ? p : null;
}

/**
 * Records one more unavailable session in a row and pauses for the next back-off step, with what
 * caused it. `repeats` counts pauses in a row for the same change, phase, line, and model. A model that
 * got through since the last pause starts its own back-off at the first step: the pause it left for
 * another model (one that may never run again) says nothing about it. Never throws.
 */
export function pauseAfterUnavailable(root: string, now: Date = new Date(), cause: PauseCause | null = null): Pause {
  const last = readPause(root);
  const fresh = !!cause?.model && !!last?.gotThrough?.includes(cause.model);
  const failures = fresh ? 1 : (last?.failures ?? 0) + 1;
  const same = !!cause && !!last && last.slug === cause.slug && last.phase === cause.phase && last.line === cause.line
    && (last.model ?? null) === (cause.model ?? null);
  const repeats = same ? (last?.repeats ?? 1) + 1 : 1;
  const minutes = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1]!;
  const until = new Date(now.getTime() + minutes * 60_000);
  const pause: Pause = {
    until: until.toISOString(), reason: `The assistant is unavailable (sign-in, usage limit, or network). Retrying at ${clockText(until)}.`, failures,
    slug: cause?.slug ?? null, phase: cause?.phase ?? null, line: cause?.line ?? null, model: cause?.model ?? null, repeats,
  };
  try {
    // Whole (temp file, then rename): the tick and the dashboard read it while it is written.
    writeFileAtomic(pausePath(root), JSON.stringify(pause, null, 2));
  } catch { /* without the file the next tick simply tries again */ }
  return pause;
}

/**
 * The loop paused by a person, `.loopstra/hold.json` (`{ by, at }`). While it exists the tick
 * starts no new step; running steps and the pull request watcher finish what they are doing. It
 * is not the outage pause (paused.json) and never clears by itself.
 */
export interface LoopHold { by: string; at: string }

function loopHoldPath(root: string): string {
  return join(root, ".loopstra", "hold.json");
}

/**
 * The person's pause, or null when there is no hold file. A file that is there but cannot be read,
 * or lacks who or when, still pauses the loop: "someone", since the file's last change.
 */
export function readLoopHold(root: string): LoopHold | null {
  const path = loopHoldPath(root);
  let since: string;
  try {
    since = statSync(path).mtime.toISOString();
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return null;
    since = new Date().toISOString();
  }
  let h: Partial<Record<keyof LoopHold, unknown>> = {};
  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (read && typeof read === "object") h = read;
  } catch { /* unreadable: it still pauses */ }
  return { by: typeof h.by === "string" ? h.by : "someone", at: typeof h.at === "string" ? h.at : since };
}

/** Pauses the loop for `by` (whole file, temp then rename). */
export function holdLoop(root: string, by: string, now: Date = new Date()): LoopHold {
  const hold: LoopHold = { by, at: now.toISOString() };
  writeFileAtomic(loopHoldPath(root), JSON.stringify(hold, null, 2));
  return hold;
}

/** Ends the person's pause; false when there was none. */
export function releaseLoop(root: string): boolean {
  const had = readLoopHold(root) !== null;
  rmSync(loopHoldPath(root), { force: true });
  return had;
}

/** The loop line while a person has paused it. */
export function loopHoldText(h: LoopHold): string {
  return `Paused by ${h.by}: running steps finish, nothing new starts.`;
}

/** "14:32", local time. */
export function clockText(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A phase of change `slug` got through to the assistant on `model`, so the pause and its back-off end.
 * When the pause names another model, it stays as it is, with only `model` added to `gotThrough`:
 * that model may still be out (the strong model's limit, say, while the cheap intake gets through).
 * When it names another change as its cause, its cause and repeat count stay: that change's own
 * phase may keep failing with words that look like an outage, and it must still reach the probe (see
 * PROBE_AFTER in the scheduler) while other changes get through in between. Without `slug`, or with no cause recorded, the pause is
 * removed completely. Never throws.
 */
export function clearPause(root: string, slug?: string, now: Date = new Date(), model?: string): void {
  const p = readPause(root);
  if (!p) return;
  try {
    if (model && p.model && model !== p.model) {
      // Noted, so that model's own next outage does not start where this one's back-off got to.
      if (!p.gotThrough?.includes(model)) writeFileAtomic(pausePath(root), JSON.stringify({ ...p, gotThrough: [...(p.gotThrough ?? []), model] }, null, 2));
      return;
    }
    if (!slug || !p.slug || p.slug === slug) rmSync(pausePath(root), { force: true });
    else writeFileAtomic(pausePath(root), JSON.stringify({ ...p, until: now.toISOString(), failures: 0 }, null, 2));
  } catch { /* the next pause or success tries again */ }
}

/** The tick waits for the loop's daily budget: why, and until when the loop line says so. */
export interface DayPause { until: string; reason: string }

export interface LoopBeat {
  tickStarted(): void;
  tickEnded(): void;
  /** A step for this change started (it joins the list once). */
  workingOn(slug: string): void;
  /** That change's step ended. */
  doneWith(slug: string): void;
  /** The tick waits for the day's budget (null: it does not). */
  dayPause(p: DayPause | null): void;
  stopped(): void;
}

/** The running loops in this process, by root, so `tick` can say what it picked. */
const active = new Map<string, LoopBeat>();

/** Records that the tick started a step for this change. Does nothing when no loop is running for `root`. */
export function heartbeatWorkingOn(root: string, slug: string): void {
  active.get(resolve(root))?.workingOn(slug);
}

/** Records that this change's step ended. Does nothing when no loop is running for `root`. */
export function heartbeatDoneWith(root: string, slug: string): void {
  active.get(resolve(root))?.doneWith(slug);
}

/**
 * Records that the tick waits for the loop's daily budget (null: it does not), so the loop line says
 * "Paused" instead of "Running". Does nothing when no loop is running for `root`.
 */
export function heartbeatDayPause(root: string, p: DayPause | null): void {
  active.get(resolve(root))?.dayPause(p);
}

/**
 * Starts the heartbeat for a loop in this process: writes it now, refreshes it every `beatMs`,
 * and marks `stopping` as soon as a stop is requested. Call `stopped()` when the loop ends.
 */
export function startHeartbeat(root: string, beatMs = BEAT_MS): LoopBeat {
  const at = () => new Date().toISOString();
  const hb: Heartbeat = { pid: process.pid, host: thisHost(), startedAt: at(), lastTickAt: null, lastBeatAt: at(), current: null, working: [], stopping: false, stopped: false };
  let day: DayPause | null = null;
  const setWorking = (slugs: string[]) => {
    hb.working = slugs;
    hb.current = slugs[0] ? { slug: slugs[0] } : null;
  };
  const write = () => {
    hb.lastBeatAt = at();
    // An unavailable assistant's pause first: the tick checks it first.
    const pause = activePause(root) ?? (day && Date.parse(day.until) > Date.now() ? day : null);
    hb.pausedUntil = pause?.until ?? null;
    hb.pauseReason = pause?.reason ?? null;
    writeHeartbeat(root, hb);
  };
  write();
  const timer = setInterval(write, beatMs);
  (timer as { unref?: () => void }).unref?.();
  const unsubscribe = onStop(() => { hb.stopping = true; write(); });
  const beat: LoopBeat = {
    tickStarted: () => { hb.lastTickAt = at(); setWorking([]); write(); },
    tickEnded: () => { hb.lastTickAt = at(); setWorking([]); write(); },
    workingOn: (slug) => { if (!hb.working?.includes(slug)) setWorking([...(hb.working ?? []), slug]); write(); },
    doneWith: (slug) => { setWorking((hb.working ?? []).filter((s) => s !== slug)); write(); },
    dayPause: (p) => { day = p; write(); },
    stopped: () => {
      clearInterval(timer);
      unsubscribe();
      active.delete(resolve(root));
      // A stopped loop waits for nothing; its line says what the next start does (see heartbeatState).
      day = null;
      setWorking([]);
      Object.assign(hb, { stopping: false, stopped: true });
      write();
    },
  };
  active.set(resolve(root), beat);
  return beat;
}
