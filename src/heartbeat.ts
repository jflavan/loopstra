import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { onStop } from "./stop";

/**
 * The loop's heartbeat, `.loopstra/heartbeat.json`. The scheduler writes it on start, at the start
 * and end of every tick, when a stop is asked for, and when it stops. While the process is alive it
 * is also refreshed every few seconds (`lastBeatAt`), so a long step does not look like a dead loop.
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
}

export type LoopState = "running" | "stopped" | "not-responding";

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
  const working = hb.current ? `working on ${hb.current.slug}, ` : "";
  return { state: "running", text: `Running — ${working}${lastCheck}`, current: hb.current };
}

/** "Loop: Running — last check 20s ago" plus a newline, for `status`. */
export async function loopStatusLine(root: string): Promise<string> {
  const poll = await loadConfig(root).then((c) => c.poll_seconds, () => 60);
  return `Loop: ${heartbeatState(readHeartbeat(root), poll).text}\n`;
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
  const write = () => { hb.lastBeatAt = at(); writeHeartbeat(root, hb); };
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
