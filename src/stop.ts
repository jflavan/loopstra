/**
 * Graceful stop. The first Ctrl-C (or SIGTERM, or SIGBREAK on Windows) asks the loop to stop: no new
 * agent session or project command starts, one in flight is killed, and the step is left in its
 * in-progress status so the next start resumes it. A second signal exits at once.
 *
 * This is process-wide state by nature (a signal reaches the whole process), so it lives here and
 * nowhere else.
 */

/** Thrown where work would start (or was running) after a stop was requested. Never blocks an intent. */
export class StopRequested extends Error {
  constructor() {
    super("stop requested");
    this.name = "StopRequested";
  }
}

let requested = false;
let resolveStop: () => void = () => {};
let stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
const listeners = new Set<() => void>();

export function requestStop(): void {
  if (requested) return;
  requested = true;
  resolveStop();
  for (const l of [...listeners]) { try { l(); } catch { /* a listener must never stop the others */ } }
}

/**
 * Calls `fn` when a stop is requested (at once if one already was). Returns the unsubscribe
 * function; callers unsubscribe when their child process ends, so nothing accumulates.
 */
export function onStop(fn: () => void): () => void {
  if (requested) { fn(); return () => {}; }
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function stopRequested(): boolean {
  return requested;
}

/** Resolves when a stop is requested. Race it against anything that waits. */
export function stopPromise(): Promise<void> {
  return stopping;
}

/** Throws StopRequested when a stop was requested. Call before starting a process. */
export function throwIfStopping(): void {
  if (requested) throw new StopRequested();
}

/** Clears a stop request (tests, and a fresh `start` in the same process). */
export function resetStop(): void {
  requested = false;
  listeners.clear();
  stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
}

/** What a signal does: the first asks for a stop, a second exits with 130. */
export function onStopSignal(exit: (code: number) => void = (code) => process.exit(code), say: (s: string) => void = (s) => console.log(s)): void {
  if (requested) {
    say("Stopping now.");
    exit(130);
    return;
  }
  requestStop();
  say("\nStopping. The current step is interrupted and resumes on the next start. Press Ctrl-C again to exit at once.");
}

const SIGNALS: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

/** Installs the stop handlers once. Returns a function that removes them. */
export function installStopSignals(): () => void {
  const handler = () => onStopSignal();
  for (const s of SIGNALS) process.on(s, handler);
  return () => { for (const s of SIGNALS) process.off(s, handler); };
}
