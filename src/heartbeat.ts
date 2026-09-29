import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { onStop } from "./stop";

/**
 * The loop's heartbeat, `.loopstra/heartbeat.json`. The scheduler writes it on start, at the start
 * and end of every tick, when a stop is asked for, and when it stops. While the process is alive it
 * is also refreshed every few seconds (`lastBeatAt`), so a long step does not look like a dead loop.
 * Each write also carries the pause, if one is running (see Pause).
 */
export interface Heartbeat {
  pid: number;
  startedAt: string;
  /** The start or end of the newest tick; null before the first one. Shown as "last check". */
  lastTickAt: string | null;
  /** Refreshed every few seconds while the process runs. Staleness is judged from this. */
  lastBeatAt: string;
  /** The change the current tick is working on, if any. */
  current: { slug: string; phase: string | null } | null;
  stopping: boolean;
  stopped: boolean;
  /** While the loop waits because the assistant was unavailable: until when, and why in plain words. */
  pausedUntil?: string | null;
  pauseReason?: string | null;
}

export type LoopState = "running" | "paused" | "stopped" | "not-responding";

export interface LoopStatus {
  state: LoopState;
  /** Plain words for the owner, e.g. "Running — last check 20s ago". */
  text: string;
  current: { slug: string; phase: string | null } | null;
}

/** How often a live loop refreshes `lastBeatAt`. */
export const BEAT_MS = 5_000;

export function heartbeatPath(root: string): string {
  return join(root, ".loopstra", "heartbeat.json");
}

/** Writes the heartbeat whole (temp file, then rename), so a reader never sees half of it. Never throws. */
export function writeHeartbeat(root: string, hb: Heartbeat): void {
  const path = heartbeatPath(root);
  const text = JSON.stringify(hb, null, 2);
  try {
    mkdirSync(join(root, ".loopstra"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    try {
      renameSync(tmp, path);
    } catch {
      // Windows refuses the rename while a reader has the file open; a plain write is fine then.
      writeFileSync(path, text);
    }
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

/**
 * Running, stopped, or not responding. Not responding means the heartbeat is older than three
 * polls (never less than three beats), and the loop did not stop cleanly: it was killed, crashed,
 * or the machine slept.
 */
export function heartbeatState(hb: Heartbeat | null, pollSeconds: number, now: Date = new Date()): LoopStatus {
  if (!hb) return { state: "stopped", text: "Stopped", current: null };
  const t = now.getTime();
  const lastCheck = `last check ${agoText(t - Date.parse(hb.lastTickAt ?? hb.startedAt))} ago`;
  if (hb.stopped) return { state: "stopped", text: hb.lastTickAt ? `Stopped — ${lastCheck}` : "Stopped", current: null };
  const staleMs = Math.max(3 * pollSeconds * 1000, 3 * BEAT_MS);
  const beat = Date.parse(hb.lastBeatAt ?? hb.lastTickAt ?? hb.startedAt);
  if (t - beat > staleMs) return { state: "not-responding", text: `Not responding (${lastCheck})`, current: hb.current };
  if (hb.stopping) return { state: "running", text: `Stopping — ${lastCheck}`, current: hb.current };
  if (hb.pausedUntil && Date.parse(hb.pausedUntil) > t) return { state: "paused", text: `Paused — ${hb.pauseReason ?? ""}`.trimEnd(), current: null };
  const working = hb.current ? `working on ${hb.current.slug}, ` : "";
  return { state: "running", text: `Running — ${working}${lastCheck}`, current: hb.current };
}

/** "Loop: Running — last check 20s ago" plus a newline, for `status`. */
export async function loopStatusLine(root: string): Promise<string> {
  const poll = await loadConfig(root).then((c) => c.poll_seconds, () => 60);
  return `Loop: ${heartbeatState(readHeartbeat(root), poll).text}\n`;
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
  /** Pauses in a row for the same change, phase, and line (see PROBE_AFTER in the scheduler). */
  repeats?: number;
}

/** What made the loop pause: the change, its phase, and the line that matched. */
export interface PauseCause { slug: string; phase: string; line: string }

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
 * caused it. `repeats` counts pauses in a row for the same change, phase, and line. Never throws.
 */
export function pauseAfterUnavailable(root: string, now: Date = new Date(), cause: PauseCause | null = null): Pause {
  const last = readPause(root);
  const failures = (last?.failures ?? 0) + 1;
  const same = !!cause && !!last && last.slug === cause.slug && last.phase === cause.phase && last.line === cause.line;
  const repeats = same ? (last?.repeats ?? 1) + 1 : 1;
  const minutes = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1]!;
  const until = new Date(now.getTime() + minutes * 60_000);
  const pause: Pause = {
    until: until.toISOString(), reason: `The assistant is unavailable (sign-in, usage limit, or network). Retrying at ${clockText(until)}.`, failures,
    slug: cause?.slug ?? null, phase: cause?.phase ?? null, line: cause?.line ?? null, repeats,
  };
  try {
    mkdirSync(join(root, ".loopstra"), { recursive: true });
    writeFileSync(pausePath(root), JSON.stringify(pause, null, 2));
  } catch { /* without the file the next tick simply tries again */ }
  return pause;
}

/** "14:32", local time. */
export function clockText(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Ends the pause and its back-off (a phase got through to the assistant). */
export function clearPause(root: string): void {
  try { rmSync(pausePath(root), { force: true }); } catch { /* nothing to clear */ }
}

export interface LoopBeat {
  tickStarted(): void;
  tickEnded(): void;
  workingOn(slug: string): void;
  stopped(): void;
}

/** The running loops in this process, by root, so `tick` can say what it picked. */
const active = new Map<string, LoopBeat>();

/** Records the change the current tick picked. Does nothing when no loop is running for `root`. */
export function heartbeatWorkingOn(root: string, slug: string): void {
  active.get(resolve(root))?.workingOn(slug);
}

/**
 * Starts the heartbeat for a loop in this process: writes it now, refreshes it every `beatMs`,
 * and marks `stopping` as soon as a stop is requested. Call `stopped()` when the loop ends.
 */
export function startHeartbeat(root: string, beatMs = BEAT_MS): LoopBeat {
  const at = () => new Date().toISOString();
  const hb: Heartbeat = { pid: process.pid, startedAt: at(), lastTickAt: null, lastBeatAt: at(), current: null, stopping: false, stopped: false };
  const write = () => {
    hb.lastBeatAt = at();
    const pause = activePause(root);
    hb.pausedUntil = pause?.until ?? null;
    hb.pauseReason = pause?.reason ?? null;
    writeHeartbeat(root, hb);
  };
  write();
  const timer = setInterval(write, beatMs);
  (timer as { unref?: () => void }).unref?.();
  const unsubscribe = onStop(() => { hb.stopping = true; write(); });
  const beat: LoopBeat = {
    tickStarted: () => { hb.lastTickAt = at(); hb.current = null; write(); },
    tickEnded: () => { hb.lastTickAt = at(); hb.current = null; write(); },
    workingOn: (slug) => { hb.current = { slug, phase: null }; write(); },
    stopped: () => {
      clearInterval(timer);
      unsubscribe();
      active.delete(resolve(root));
      Object.assign(hb, { current: null, stopping: false, stopped: true });
      write();
    },
  };
  active.set(resolve(root), beat);
  return beat;
}
