import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionCost } from "./budget";
import { runPhase, type FailureReason, type RunPhaseInput, type RunPhaseResult, type StreamEvent } from "./claude";
import { errorText } from "./shell";
import { Cancelled, SessionStopped, StopRequested } from "./stop";
import type { Trace } from "./trace";

/**
 * How a session's report is read: its value, or why it cannot be used. `endAs: "asked"`: the session asked a
 * person `note` (see src/questions.ts); its row ends asked, and the question is traced as an event of its own.
 */
export type ReportRead<T> =
  | { ok: true; value: T; endAs?: "asked"; note?: string }
  | { ok: false; reason: "invalid-envelope" | "agent-fail"; detail: string };

/**
 * One traced agent session, for the loop's phases (src/phases.ts) and chat (src/chat/agents.ts) alike.
 * The caller starts the phase row (each holds its budget its own way) and says how to read the report
 * and what a failure that is not the session's own means to it.
 */
export interface TracedSession<T> {
  trace: Trace;
  slug: string;
  /** The phase row, already started. */
  seq: number;
  /** The phase folder: prompt.md, raw.jsonl and envelope.json are written there. */
  dir: string;
  /** What runPhase is given, but onEvent. */
  run: Omit<RunPhaseInput, "onEvent">;
  /** The session's cap, to work out what a session that never reported its cost spent (see sessionCost). */
  capUsd: number;
  /** Reads the session's structured output. */
  read: (output: unknown) => ReportRead<T>;
  /** Each event of the session, besides raw.jsonl (the loop traces a summary of each). */
  onEvent?: (e: StreamEvent) => void;
  /**
   * For a failed session: when the failure is not the session's own (the assistant unavailable, the
   * loop's day spent), what to throw and the row's error; the row then ends interrupted. Null: an
   * ordinary failure.
   */
  interrupt?: (r: Extract<RunPhaseResult, { ok: false }>) => { error: Error; note: string } | null;
  /** The row's error when a stop request ends the session. */
  stoppedNote?: string;
}

/** What one traced session gave. `denied`: the commands it was not allowed to run. */
export type SessionOutcome<T> =
  | { ok: true; value: T; sessionId: string | null; costUsd: number; denied: string[] }
  | { ok: false; reason: FailureReason; detail: string; sessionId: string | null; costUsd: number; denied: string[] };

/**
 * Runs one traced session: the prompt, the raw events and the report go in its phase folder, and its
 * row always ends (never left running), with what it cost and the commands it was refused, so an
 * engineer can add allow rules. Never throws for the session's own failure; a stop request (or a
 * cancel, or a person stopping the session) ends the row interrupted, with what the killed session
 * must have spent, and is thrown on, and so is what `interrupt` gives.
 */
export async function tracedSession<T>(s: TracedSession<T>): Promise<SessionOutcome<T>> {
  const started = Date.now();
  let raw: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  // What the session cost, once it ended (null until then): kept if it fails after that.
  let costUsd: number | null = null;
  let denied: string[] = [];
  let ended = false;
  const end = (status: "success" | "fail" | "interrupted" | "asked", cost: number, sessionId: string | null, error?: string) => {
    ended = true;
    s.trace.phaseEnd(s.slug, s.seq, { status, costUsd: cost, sessionId: sessionId ?? undefined, error, denied });
  };
  const failed = (reason: FailureReason, detail: string, sessionId: string | null, cost: number): SessionOutcome<T> => {
    end("fail", cost, sessionId, `${reason}: ${detail}${denied.length ? `; not allowed: ${denied.join(", ")}` : ""}`);
    return { ok: false, reason, detail, sessionId, costUsd: cost, denied };
  };
  try {
    mkdirSync(s.dir, { recursive: true });
    await Bun.write(join(s.dir, "prompt.md"), s.run.prompt);
    const writer = Bun.file(join(s.dir, "raw.jsonl")).writer();
    raw = writer;
    const r = await runPhase({ ...s.run, onEvent: (e) => { void writer.write(JSON.stringify(e) + "\n"); s.onEvent?.(e); } });
    denied = r.denied;
    costUsd = sessionCost(r, r.durationMs, s.capUsd);
    if (!r.ok) {
      const stop = s.interrupt?.(r);
      if (stop) {
        end("interrupted", costUsd, r.sessionId, stop.note);
        throw stop.error;
      }
      return failed(r.reason, r.detail, r.sessionId, costUsd);
    }
    const read = s.read(r.structuredOutput);
    const valid = read.ok || read.reason === "agent-fail";
    await Bun.write(join(s.dir, "envelope.json"), JSON.stringify({ valid, output: r.structuredOutput }, null, 2));
    if (!read.ok) return failed(read.reason, read.detail, r.sessionId, costUsd);
    end(read.endAs ?? "success", costUsd, r.sessionId);
    if (read.endAs === "asked" && read.note) s.trace.event(s.slug, "question", { question: read.note }, s.seq);
    return { ok: true, value: read.value, sessionId: r.sessionId, costUsd, denied };
  } catch (e) {
    if (ended) throw e; // what `interrupt` gave: its row is already ended
    if (e instanceof StopRequested || e instanceof Cancelled || e instanceof SessionStopped) {
      // A session the stop (or a cancel, or a person's stop) killed never reported its cost.
      const spent = costUsd ?? sessionCost({ costUsd: 0, costReported: false }, Date.now() - started, s.capUsd);
      end("interrupted", spent, null, e instanceof StopRequested ? s.stoppedNote ?? "stopped by request" : e.message);
      throw e;
    }
    return failed("crash", `runtime error: ${errorText(e)}`, null, costUsd ?? 0);
  } finally {
    if (raw) { try { await raw.end(); } catch { /* already closed */ } }
  }
}

/** A schema's problems in one line, for a report that could not be read. */
export function issuesText(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
}
