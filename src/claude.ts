import { MIN_SESSION_USD, USD_PER_MINUTE } from "./budget";
import { lastLine, spawnBounded, withBunOnPath, type StdinWriter } from "./shell";
import { Cancelled, SessionStopped, StopRequested } from "./stop";
import { MEANWHILE_HEADING } from "./console/steerable";

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface Collected {
  sessionId: string | null;
  subtype: string;
  structuredOutput: unknown;
  costUsd: number;
  /** A result event said what the session cost. False when it ended without one (killed at its deadline, or it crashed): costUsd is then only what earlier sends of it reported. */
  costReported: boolean;
  usage: unknown;
  /** The result event's text; an error result says there why the session failed. */
  resultText: string;
  events: StreamEvent[];
  isError: boolean;
  /** What the session tried and was not allowed (the result event's permission_denials), as allow-rule text, e.g. `Bash(git tag v1)`. */
  denied: string[];
}

/** One permission denial as allow-rule text: the command for Bash, the path for file tools, else the tool name. */
function deniedText(d: { tool_name?: string; tool_input?: Record<string, unknown> }): string {
  const input = d.tool_input ?? {};
  const what = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.pattern;
  return typeof what === "string" && what ? `${d.tool_name ?? "?"}(${what})` : d.tool_name ?? "?";
}

/**
 * A result event that answers a background task's notification, not the prompt. A resumed session
 * with a task still pending delivers the notification first and answers it with a turn of its own.
 */
export function answersNotification(e: StreamEvent): boolean {
  return e.type === "result" && (e as { origin?: { kind?: unknown } }).origin?.kind === "task-notification";
}

/** Accumulates `--output-format stream-json` lines into one result. A notification's result is not the result. */
export class StreamCollector {
  private sessionId: string | null = null;
  private result: StreamEvent | null = null;
  readonly events: StreamEvent[] = [];

  push(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let e: StreamEvent;
    try { e = JSON.parse(trimmed) as StreamEvent; } catch { return null; }
    this.events.push(e);
    if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
    if (e.type === "result" && !answersNotification(e)) this.result = e;
    return e;
  }

  finish(): Collected {
    const r = this.result as (StreamEvent & {
      structured_output?: unknown; total_cost_usd?: number; usage?: unknown; result?: string; is_error?: boolean;
      permission_denials?: Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>;
    }) | null;
    return {
      sessionId: this.sessionId ?? r?.session_id ?? null,
      subtype: r?.subtype ?? "missing_result",
      structuredOutput: r?.structured_output,
      costUsd: r?.total_cost_usd ?? 0,
      costReported: typeof r?.total_cost_usd === "number",
      usage: r?.usage,
      resultText: r?.result ?? "",
      events: this.events,
      isError: r?.is_error ?? r === null,
      denied: Array.isArray(r?.permission_denials) ? r.permission_denials.map(deniedText) : [],
    };
  }
}

export const FAKE_CLAUDE_ENV = "LOOPSTRA_CLAUDE_EXECUTABLE";

// The CLI accepts "default" as an alias of the documented "manual" permission mode.
export type PermissionMode = "default" | "manual" | "plan" | "acceptEdits" | "dontAsk" | "auto";

/**
 * Why a phase failed, as a machine-readable code. Stages decide on this, never on note text.
 * - not-started: the executable could not be found or spawned
 * - timeout: the deadline passed before a result arrived
 * - budget: the session hit --max-budget-usd
 * - no-session: --resume named a session the CLI could not find
 * - crash: the process ended without a usable result, or with an error result
 * - invalid-envelope: a result arrived but its structured output is missing or the wrong shape
 * - agent-fail: the agent answered, and its envelope says status "fail"
 * - missing-prompt: the phase's prompt file is missing (raised by agentPhase)
 * - environment: the assistant could not be used at all (see ENVIRONMENT_PATTERNS); not the agent's doing
 */
export type FailureReason = "not-started" | "timeout" | "budget" | "no-session" | "crash" | "invalid-envelope" | "agent-fail" | "missing-prompt" | "environment";

/**
 * Text that means the assistant itself could not be used, so a failed session is the environment's
 * problem, not the agent's. Matched only when the session failed: always against the error result's
 * text, and against stderr only when the session never answered (no assistant event), since a
 * session that worked may print such words itself (a command it ran). The one list; each entry says
 * what it catches.
 */
export const ENVIRONMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; catches: string }> = [
  { pattern: /invalid api key|please run \/login|not logged in|login required|oauth token (has )?expired|authentication[_ ]error|API Error: 40[13]\b/i, catches: "signed out, or the sign-in expired" },
  { pattern: /usage limit|rate[_ ]limit|too many requests|API Error: 429\b/i, catches: "a usage or rate limit was reached" },
  { pattern: /overloaded|service unavailable|API Error: 5\d\d\b/i, catches: "the service is overloaded or down" },
  { pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed|unable to connect|network error|connection error/i, catches: "the network is down or the service cannot be reached" },
];

/** The first line of `text` that an environment pattern matches, or null. */
function environmentLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (ENVIRONMENT_PATTERNS.some((p) => p.pattern.test(line))) return line.trim();
  }
  return null;
}

/** Failures that mean the assistant was unavailable (outage, sign-in, limits, not installed): the loop pauses instead of blocking. */
export function unavailable(reason: FailureReason): reason is "environment" | "not-started" {
  return reason === "environment" || reason === "not-started";
}

export interface RunPhaseInput {
  cwd: string;
  prompt: string;
  schema: object;
  model: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  /** Deny rules (--disallowedTools). A bare tool name removes the tool from the session. */
  disallowedTools?: string[];
  timeoutMs: number;
  /** The session's spending cap. Absent or Infinity: no --max-budget-usd, and the timeout is the only stop. */
  maxBudgetUsd?: number;
  resume?: string;
  env?: Record<string, string>;
  /** Override the executable (tests). Defaults to $LOOPSTRA_CLAUDE_EXECUTABLE or `claude` on PATH. */
  executable?: string;
  onEvent?: (e: StreamEvent) => void;
  /** How long the process gets to exit after its result event (and after a kill). Defaults to EXIT_GRACE_MS (tests shorten it). */
  exitGraceMs?: number;
  /** Aborting it kills the session; runPhase then throws Cancelled. */
  signal?: AbortSignal;
  /**
   * A live session: stream-json input, kept open, with every message echoed back (see the spike in
   * docs/decisions.md). `attach` gets the control once the session runs, and gives back what ends its watching
   * (awaited before the phase ends, so what it records lands first).
   */
  live?: {
    attach: (ctl: SessionControl) => () => void | Promise<void>;
    /** false leaves out --replay-user-messages (tests: a CLI that never echoes). Default true. */
    replay?: boolean;
    /** How long a result waits for a message's echo before stdin is closed (see ECHO_WAIT_MS). Tests shorten it. */
    echoWaitMs?: number;
  };
}

/** What the runner of a live session may do to it while it runs (see RunPhaseInput.live). */
export interface SessionControl {
  /** Writes a message to the running session; false while no process can take one (a redirect is resuming it, or it has ended). */
  message(text: string): boolean;
  /** Ends the session now; runPhase then throws SessionStopped. False once the session's final result was taken: it has finished. */
  stop(by: string): boolean;
  /**
   * Ends the running process and resumes the session at once with `text` as its prompt (sent by `by`); false
   * until the session has an id, and while it cannot take one.
   */
  redirect(text: string, by?: string): boolean;
}

/** How a message and a redirect wrapped by the runner start, so their echoes read as a person's (not the prompt's). Shared with the page. */
export { MESSAGE_LEAD, REDIRECT_LEAD } from "./console/steerable";

/** What heads, in a redirect's prompt, the messages the killed process had not taken up yet. */
export { MEANWHILE_HEADING };

/** A user message as one stream-json input line. */
export function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/**
 * The state a live session's control acts on: the process running now (its stdin, what was written
 * to it and what it echoed), and what a person asked of it.
 */
class LiveSession {
  writer: StdinWriter | null = null;
  /** Messages written to the running process. */
  written = 0;
  /** Their texts, in the order written. */
  sent: string[] = [];
  /** User messages the running process echoed; the first is its prompt. */
  replays = 0;
  kill = new AbortController();
  sessionId: string | null;
  stoppedBy: string | null = null;
  redirectTo: string | null = null;
  /** Who sent the newest redirect. */
  redirectBy: string | null = null;
  /** The final result was taken (stdin closed at it): the session has finished, and a stop comes too late. */
  finished = false;

  constructor(resume: string | undefined) {
    this.sessionId = resume ?? null;
  }

  /** A new process starts: nothing written to it yet, and a kill of its own. */
  next(): AbortSignal {
    this.writer = null;
    this.written = 0;
    this.sent = [];
    this.replays = 0;
    this.finished = false;
    this.kill = new AbortController();
    return this.kill.signal;
  }

  /** Stdin closes, and nothing more can be sent to the process (its final result came, or the wait for an echo ran out). */
  done(): void {
    this.writer?.end();
    this.writer = null;
  }

  /** How many messages written to the running process it has not echoed yet (its first echo is the prompt). */
  unechoed(): number {
    return this.written - Math.max(0, this.replays - 1);
  }

  /** A message written but not echoed yet: the session takes it after this result, with a turn and a result of its own. */
  waiting(): boolean {
    return this.unechoed() > 0;
  }

  /** The texts written to the running process that it has not echoed yet, oldest first. */
  meanwhile(): string[] {
    const n = this.unechoed();
    return n > 0 ? this.sent.slice(-n) : [];
  }

  readonly control: SessionControl = {
    message: (text) => {
      if (!this.writer || this.redirectTo !== null || this.stoppedBy !== null || !this.writer.write(userLine(text))) return false;
      this.written++;
      this.sent.push(text);
      return true;
    },
    stop: (by) => {
      if (this.finished) return false;
      this.stoppedBy ??= by;
      this.kill.abort();
      return true;
    },
    redirect: (text, by) => {
      if (!this.writer || this.sessionId === null || this.redirectTo !== null || this.stoppedBy !== null) return false;
      // What was written to this process but not taken up yet goes to the resumed one, after the redirect.
      const meanwhile = this.meanwhile();
      this.redirectTo = meanwhile.length ? `${text}\n\n${MEANWHILE_HEADING}\n\n${meanwhile.join("\n\n")}` : text;
      this.redirectBy = by ?? null;
      this.writer = null;
      this.kill.abort();
      return true;
    },
  };
}

export type RunPhaseResult = Collected & {
  exitCode: number | null;
  durationMs: number;
  stderr: string;
  /** For an environment failure, the line that matched ENVIRONMENT_PATTERNS; else null. */
  matched: string | null;
} & ({ ok: true; reason: null; detail: "" } | { ok: false; reason: FailureReason; detail: string });

/** After the result event, how long the process gets to exit on its own before its tree is killed. */
const EXIT_GRACE_MS = 2_000;
/**
 * How long a live session's result waits for the echo of a message written to it (see LiveSession.waiting)
 * before stdin is closed: the CLI then ends after any turn it queued, and the newest result is the phase's.
 * Any event of the process starts the wait again.
 */
const ECHO_WAIT_MS = 60_000;
/** How many times a session that ended having answered only notifications gets the prompt again. */
const NOTIFICATION_RESENDS = 2;
/**
 * Sent once, on the same session, when a session finishes without structured output (for example
 * it wrote its report as text). Cheaper than a new session, which would redo the whole phase.
 */
export const ENVELOPE_NUDGE = "You finished without returning your result. Return it now by calling the StructuredOutput tool (a tool call, not text) with the result you reached; do not redo the work.";

export function resolveClaude(override?: string): string | null {
  if (override) return override;
  const fromEnv = process.env[FAKE_CLAUDE_ENV];
  if (fromEnv) return fromEnv;
  return Bun.which("claude");
}

/**
 * Runs one `claude -p` session. Everything it awaits is bounded by the deadline (`timeoutMs`)
 * plus a short grace: it stops reading stdout at the prompt's result event, never waits on pipes a
 * leftover grandchild may hold, and kills the process tree if it does not exit by itself.
 * After a stop request it does not start, or it kills the running session, and throws StopRequested;
 * likewise Cancelled for `signal`. A live session (`input.live`) keeps stdin open while it runs, so a
 * person can send it messages, stop it (SessionStopped) or redirect it (resumed with the new direction).
 */
export async function runPhase(input: RunPhaseInput): Promise<RunPhaseResult> {
  if (!input.live) return runSession(input, null);
  const live = new LiveSession(input.resume);
  const detach = input.live.attach(live.control);
  try {
    return await runSession(input, live);
  } finally {
    try { await detach(); } catch { /* watching must never fail the phase */ }
  }
}

/** runPhase's work; `live` is the live session's state, or null. */
async function runSession(input: RunPhaseInput, live: LiveSession | null): Promise<RunPhaseResult> {
  const started = Date.now();
  let collector = new StreamCollector();
  // What earlier sends of the prompt cost, and what they were refused (see the resends below).
  let earlierCostUsd = 0;
  let earlierDenied: string[] = [];
  // Whether the session was asked again for its missing structured output.
  let nudged = false;
  const finish = (): Collected => {
    const c = collector.finish();
    return { ...c, costUsd: c.costUsd + earlierCostUsd, denied: [...new Set([...earlierDenied, ...c.denied])] };
  };
  const fail = (reason: FailureReason, detail: string, exitCode: number | null = null, stderr = "", matched: string | null = null): RunPhaseResult => {
    // The work was done; only the report is missing. A nudge that times out or breaks does not make it a crash to rerun.
    if (nudged && (reason === "timeout" || reason === "crash" || reason === "no-session")) {
      detail = `claude finished without structured output, and asking again failed: ${detail}`;
      reason = "invalid-envelope";
    }
    return { ...finish(), ok: false, reason, detail, exitCode, durationMs: Date.now() - started, stderr, matched };
  };

  const exe = resolveClaude(input.executable);
  if (!exe) return fail("not-started", "could not start claude: not found on PATH. Install Claude Code or set LOOPSTRA_CLAUDE_EXECUTABLE.");

  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--model", input.model,
    "--permission-mode", input.permissionMode,
  ];
  if (input.allowedTools.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
  // Every user message the session takes is echoed, so the runner knows which result answers it.
  if (live) args.push("--input-format", "stream-json", ...(input.live!.replay === false ? [] : ["--replay-user-messages"]));
  const echoWaitMs = input.live?.echoWaitMs ?? ECHO_WAIT_MS;

  // A .ts fake must be run through bun; the real CLI is a native executable.
  const cmd = exe.endsWith(".ts") ? [process.execPath, exe, ...args] : [exe, ...args];
  // No background tasks: one left pending when a session ends is delivered first when it is
  // resumed, and that session may then end without reading the prompt.
  const env = withBunOnPath({ ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ...input.env });

  // A session that ended having answered only notifications (one started before background tasks
  // were turned off) gets the prompt again on the same session, within the same deadline. A session
  // that finished without structured output is asked for it once, the same way.
  let resume = input.resume;
  let stdin = input.prompt;
  // Each send is a run of its own, with a cap of its own: a later one may spend only what the earlier
  // ones left of maxBudgetUsd (null: too little is left to send again).
  const capped = input.maxBudgetUsd !== undefined && Number.isFinite(input.maxBudgetUsd);
  const budgetArgs = (spentUsd: number): string[] | null => {
    if (!capped) return [];
    const left = Math.round((input.maxBudgetUsd! - spentUsd) * 1e6) / 1e6;
    return left < MIN_SESSION_USD ? null : ["--max-budget-usd", String(left)];
  };
  let r: Awaited<ReturnType<typeof spawnBounded>>;
  for (let resends = 0; ; resends++) {
    if (live?.stoppedBy) throw new SessionStopped(live.stoppedBy);
    const resumeArgs = resume ? ["--resume", resume] : [];
    // A live process is killed by its own signal too (a stop or a redirect), as well as by the caller's.
    const kill = live?.next();
    const signal = kill ? (input.signal ? AbortSignal.any([input.signal, kill]) : kill) : input.signal;
    const processStarted = Date.now();
    // What this process may spend: what the earlier ones left of the cap.
    const leftAtStart = capped ? Math.max(0, input.maxBudgetUsd! - earlierCostUsd) : Infinity;
    // The wait for an echo after a result (see ECHO_WAIT_MS). Once it ran out, stdin is closed and reading goes on to the end.
    let echoTimer: ReturnType<typeof setTimeout> | undefined;
    let echoGaveUp = false;
    const awaitEcho = () => {
      clearTimeout(echoTimer);
      echoTimer = setTimeout(() => { echoGaveUp = true; live?.done(); }, echoWaitMs);
    };
    r = await spawnBounded({
      cmd: [...cmd, ...(budgetArgs(earlierCostUsd) ?? []), ...resumeArgs], cwd: input.cwd, env,
      stdin: live ? { open: userLine(stdin) } : stdin,
      onStdin: live ? (w) => { live.writer = w; } : undefined,
      timeoutMs: Math.max(1, started + input.timeoutMs - Date.now()), onStop: "kill", signal, graceMs: input.exitGraceMs ?? EXIT_GRACE_MS,
      // Reading ends at the prompt's result event; the process then gets the grace to exit before it is killed.
      onLine: (line) => {
        const e = collector.push(line);
        if (e && input.onEvent) { try { input.onEvent(e); } catch { /* tracing must never stop the phase */ } }
        if (!e) return false;
        if (live && e.session_id) live.sessionId = e.session_id;
        if (live && e.type === "user" && e.isReplay === true) live.replays++;
        // Any event of the process while it waits for an echo starts the wait again; once nothing waits
        // for one (the echo came), the wait is over, so a quiet stretch later in that turn never closes stdin.
        if (echoTimer !== undefined && !echoGaveUp) {
          if (live?.waiting()) awaitEcho();
          else { clearTimeout(echoTimer); echoTimer = undefined; }
        }
        if (e.type !== "result" || answersNotification(e)) return false;
        if (!live) return true;
        // A message written but not yet taken: its own turn and result follow, and that result is the phase's.
        // Never at an error result; and once the wait for its echo ran out, reading goes on to the end.
        const failed = e.is_error === true || e.subtype !== "success";
        if (!failed && live.waiting()) {
          if (!echoGaveUp) awaitEcho();
          return false;
        }
        clearTimeout(echoTimer);
        live.finished = true;
        live.done();
        return true;
      },
    });
    clearTimeout(echoTimer);
    live?.done();
    if (live?.stoppedBy) throw new SessionStopped(live.stoppedBy);
    if (live && live.redirectTo !== null && !r.stopped && !input.signal?.aborted && r.started) {
      // What the killed process spent counts toward the cap, as a resend's does: its newest result's
      // running total, or about its minutes when it gave none (never more than it could spend).
      const reported = collector.events.filter((e) => e.type === "result").at(-1)?.total_cost_usd;
      earlierCostUsd += typeof reported === "number" ? reported : Math.min(leftAtStart, ((Date.now() - processStarted) / 60_000) * USD_PER_MINUTE);
      earlierDenied = [...new Set([...earlierDenied, ...collector.finish().denied])];
      resume = live.sessionId ?? resume;
      stdin = live.redirectTo;
      live.redirectTo = null;
      collector = new StreamCollector();
      // Too little is left to resume it: the session ends quietly, as if its sender had stopped it. The change
      // keeps its status, and conversation.md has the redirect for the next session.
      if (budgetArgs(earlierCostUsd) === null) throw new SessionStopped(live.redirectBy ?? "a person");
      resends--; // a redirect is not a notification resend
      continue;
    }
    if (r.stopped || r.cancelled || !r.started || r.timedOut) break;
    const c = collector.finish();
    if (!nudged && c.subtype === "success" && !c.isError && c.structuredOutput === undefined && c.sessionId) {
      if (budgetArgs(earlierCostUsd + c.costUsd) === null) break; // nothing left to ask with
      nudged = true;
      earlierCostUsd += c.costUsd;
      earlierDenied = c.denied;
      resume = c.sessionId;
      stdin = ENVELOPE_NUDGE;
      collector = new StreamCollector();
      resends--; // the nudge is not a notification resend
      continue;
    }
    if (r.code !== 0 || c.subtype !== "missing_result" || !c.events.some(answersNotification) || !c.sessionId || resends >= NOTIFICATION_RESENDS) break;
    // A result's total_cost_usd is the run's running total, so the last one is what the run cost.
    const cost = c.events.filter(answersNotification).at(-1)?.total_cost_usd;
    earlierCostUsd += typeof cost === "number" ? cost : 0;
    if (budgetArgs(earlierCostUsd) === null) break; // nothing left to send it again with
    resume = c.sessionId;
    collector = new StreamCollector();
  }
  if (r.stopped) throw new StopRequested();
  if (r.cancelled) throw new Cancelled();
  if (!r.started) return fail("not-started", `could not start claude: ${r.err}`);
  const { code: exitCode, err: stderr, timedOut } = r;

  const collected = finish();
  if (timedOut) return fail("timeout", `claude timed out after ${Math.round(input.timeoutMs / 1000)}s`, exitCode, stderr);
  const lastErr = lastLine(stderr);
  // Before any subtype check: the CLI reports a missing session with an error result as well.
  if (resume && /no conversation found|session.*not found/i.test(stderr)) return fail("no-session", lastErr || "the session to resume was not found", exitCode, stderr);
  if (/budget/i.test(collected.subtype)) return fail("budget", `claude ended with ${collected.subtype}`, exitCode, stderr);
  if (collected.subtype !== "success" || collected.isError) {
    const answered = collected.events.some((e) => e.type === "assistant");
    const outage = environmentLine(collected.resultText) ?? (answered ? null : environmentLine(stderr));
    if (outage) return fail("environment", `the assistant is unavailable: ${outage}`, exitCode, stderr, outage);
  }
  if (collected.subtype === "missing_result" && collected.events.some(answersNotification)) {
    return fail("crash", `claude answered only background task notifications and never the prompt${lastErr ? `: ${lastErr}` : ""}`, exitCode, stderr);
  }
  if (collected.subtype === "missing_result") return fail("crash", `claude exited ${exitCode} without a result${lastErr ? `: ${lastErr}` : ""}`, exitCode, stderr);
  if (/structured_output/i.test(collected.subtype)) return fail("invalid-envelope", `claude ended with ${collected.subtype}`, exitCode, stderr);
  if (collected.subtype !== "success" || collected.isError) return fail("crash", `claude ended with ${collected.subtype}`, exitCode, stderr);
  if (collected.structuredOutput === undefined) return fail("invalid-envelope", "claude finished without structured output", exitCode, stderr);
  return { ...collected, ok: true, reason: null, detail: "", exitCode, durationMs: Date.now() - started, stderr, matched: null };
}
