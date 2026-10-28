/**
 * Graceful stop. The first Ctrl-C (or SIGTERM; SIGHUP on POSIX, SIGBREAK on Windows) asks the loop
 * to stop: no new agent session or project command starts, one in flight is killed, and the step is
 * left in its in-progress status so the next start resumes it. A second signal exits at once, and
 * every child still running is killed with its tree on the way out (see spawnBounded).
 *
 * This is process-wide state by nature (a signal reaches the whole process), so it lives here and
 * nowhere else.
 */

/**
 * Thrown where work would start (or was running) after a stop was requested. Never blocks an intent.
 * `sessionId`, on one that ended an agent session (see runPhase), is that session's, so its
 * interrupted phase row still names the transcript; null for any other work.
 */
export class StopRequested extends Error {
  constructor(public readonly sessionId: string | null = null) {
    super("stop requested");
    this.name = "StopRequested";
  }
}

/**
 * Thrown by work whose result stopped being wanted while it ran (see alongside in phases): its
 * session or command was killed. Not a failure; it never gets past the work that cancelled it.
 * `sessionId` as for StopRequested.
 */
export class Cancelled extends Error {
  constructor(public readonly sessionId: string | null = null) {
    super("cancelled: its result was no longer needed");
    this.name = "Cancelled";
  }
}

/**
 * A person stopped this one session (Stop in the console). Not the step's failure: the phase ends
 * interrupted with who stopped it, the change keeps its status, and the hold sent with the stop keeps
 * it from starting again. Only this step ends; the loop goes on. `sessionId` as for StopRequested
 * (null when the stop came between phases, see throwIfChangeStopped in src/phases.ts).
 */
export class SessionStopped extends Error {
  constructor(public readonly by: string, public readonly sessionId: string | null = null) {
    super(`stopped by ${by}`);
    this.name = "SessionStopped";
  }
}

/**
 * An agent asked a person a question (see src/questions.ts). The question is recorded and the change
 * waits for the answer; the step ends here without blocking or advancing.
 */
export class QuestionAsked extends Error {
  constructor(public readonly phase: string, public readonly text: string) {
    super(`the ${phase} session asked: ${text}`);
    this.name = "QuestionAsked";
  }
}

/** A stopped session or a question: the step ends quietly, the change keeps its status. Passed through like a stop request. */
export function endsStepQuietly(e: unknown): e is SessionStopped | QuestionAsked {
  return e instanceof SessionStopped || e instanceof QuestionAsked;
}

/** Throws Cancelled when `signal` was aborted. Call before starting a process. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Cancelled();
}

/**
 * The assistant could not be used (signed out, a usage limit, an outage, the network, not
 * installed). Like a stop, it is not the intent's fault: the step ends, the intent keeps its
 * status, and the loop pauses and tries again later. `detail` is for the trace; `phase` and `line`
 * (the phase that could not reach the assistant, and the text that said so) let the loop notice the
 * same failure repeating, and `model` (the model it asked) which model to probe.
 */
export class AssistantUnavailable extends Error {
  readonly phase: string | null;
  readonly line: string;
  readonly model: string | null;
  constructor(public readonly detail: string, where: { phase: string; line: string; model?: string } | null = null) {
    super(`the assistant is unavailable: ${detail}`);
    this.name = "AssistantUnavailable";
    this.phase = where?.phase ?? null;
    this.line = where?.line ?? detail;
    this.model = where?.model ?? null;
  }
}

/**
 * The loop's daily budget (claude.max_budget_usd_per_day) is used up. Like an unavailable assistant,
 * it is not the change's fault: the step ends, the change keeps its status, and the loop waits until
 * local midnight (or a raised limit).
 */
export class LoopBudgetReached extends Error {
  constructor() {
    super("the loop's daily budget is used up");
    this.name = "LoopBudgetReached";
  }
}

/**
 * Main moved twice while a record was being committed (see commitRecord in src/context.ts). Not the
 * step's fault: the step ends, the change keeps its status, and the step runs again on the next tick.
 */
export class RecordRaced extends Error {
  constructor(slug: string) {
    super(`main moved twice while a record of ${slug} was being committed; it is tried again on the next tick`);
    this.name = "RecordRaced";
  }
}

/**
 * A record a kill cut short could not be finished yet, so commitRecord committed nothing over it.
 * Not the step's fault: the step ends, the change keeps its status, and it is tried again.
 */
export class RecordUnsettled extends Error {
  constructor() {
    super("a record a kill cut short could not be finished yet; it is tried again");
    this.name = "RecordUnsettled";
  }
}

/**
 * A standard file at the step's commit cannot be read (main moved between the tick's read and the
 * step's). Not the step's fault: it ends, the change keeps its status, and it runs again. The step
 * never runs without the rules. `message` is the problems as plain sentences.
 */
export class StandardsUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandardsUnreadable";
  }
}

/** A record that could not be committed this time (RecordRaced, RecordUnsettled): it is tried again on the next tick. */
export function recordNotYet(e: unknown): e is RecordRaced | RecordUnsettled {
  return e instanceof RecordRaced || e instanceof RecordUnsettled;
}

/**
 * A stop request, an unavailable assistant, the loop's used-up day, unreadable standards, or a record that could not be
 * committed this time (see recordNotYet): none is the step's own failure. The step ends, the change
 * keeps its status, and the scheduler handles each. The one list.
 */
export function notTheStepsFault(e: unknown): boolean {
  return e instanceof StopRequested || e instanceof AssistantUnavailable || e instanceof LoopBudgetReached || e instanceof StandardsUnreadable || recordNotYet(e);
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

/** What the first signal says the loop does. */
const LOOP_STOPPING = "Stopping. The current step is interrupted and resumes on the next start.";

/** What a signal does: the first asks for a stop and says `stopping`, a second exits with 130. */
export function onStopSignal(exit: (code: number) => void = (code) => process.exit(code), say: (s: string) => void = (s) => console.log(s), stopping = LOOP_STOPPING): void {
  if (requested) {
    say("Stopping now.");
    exit(130);
    return;
  }
  requestStop();
  say(`\n${stopping} Press Ctrl-C again to exit at once.`);
}

// SIGHUP (the terminal closed) stops like SIGTERM on POSIX; Windows has no such signal to catch.
export const STOP_SIGNALS: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];

/** Installs the stop handlers once; `stopping` is what the first signal says. Returns a function that removes them. */
export function installStopSignals(stopping?: string): () => void {
  const handler = () => onStopSignal(undefined, undefined, stopping);
  for (const s of STOP_SIGNALS) process.on(s, handler);
  return () => { for (const s of STOP_SIGNALS) process.off(s, handler); };
}
