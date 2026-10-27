import { MIN_SESSION_USD, USD_PER_MINUTE } from "./budget";
import { lastLine, spawnBounded, withBunOnPath, type StdinWriter, withoutGitHookEnv } from "./shell";
import { Cancelled, SessionStopped, StopRequested, stopRequested } from "./stop";
import { MEANWHILE_HEADING } from "./console/steerable";

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

interface Collected {
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
  /** The HTTP status of the API call that failed, when the result event says (CLI 2.x's api_error_status); else null. */
  apiErrorStatus: number | null;
  /** The models the session ran on: the init event's, then the result's modelUsage keys, without duplicates. Empty when the CLI named none. */
  models: string[];
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
function answersNotification(e: StreamEvent): boolean {
  return e.type === "result" && (e as { origin?: { kind?: unknown } }).origin?.kind === "task-notification";
}

/** True for a parsed stream line that is an event: an object with a string `type`. */
function isStreamEvent(v: unknown): v is StreamEvent {
  return typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";
}

/** The result event's fields the runner reads. Each is checked where it is used: the CLI's shape is not Loopstra's to trust. */
interface ResultEvent extends StreamEvent {
  structured_output?: unknown; total_cost_usd?: number; usage?: unknown; result?: string; is_error?: boolean;
  permission_denials?: Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>; api_error_status?: unknown; modelUsage?: unknown;
}

/** Accumulates `--output-format stream-json` lines into one result. A notification's result is not the result. */
export class StreamCollector {
  private sessionId: string | null = null;
  private result: ResultEvent | null = null;
  private initModel: string | null = null;
  readonly events: StreamEvent[] = [];

  push(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return null; }
    // Only an event (an object with a type) counts: a hook or an MCP server may print other JSON to stdout.
    if (!isStreamEvent(parsed)) return null;
    const e = parsed;
    this.events.push(e);
    if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
    if (e.type === "system" && e.subtype === "init" && this.initModel === null && typeof e.model === "string" && e.model) this.initModel = e.model;
    if (e.type === "result" && !answersNotification(e)) this.result = e;
    return e;
  }

  finish(): Collected {
    const r = this.result;
    const usage = r?.modelUsage;
    const used = typeof usage === "object" && usage !== null && !Array.isArray(usage) ? Object.keys(usage) : [];
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
      apiErrorStatus: typeof r?.api_error_status === "number" ? r.api_error_status : null,
      models: [...new Set([...(this.initModel ? [this.initModel] : []), ...used])],
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
 * - model: Claude Code does not accept the model name (see MODEL_PATTERN); a setting to change, not an outage
 * - setup: the step's agent setup is not complete on this machine (see RunPhaseInput.checkInit); not an outage
 */
export type FailureReason = "not-started" | "timeout" | "budget" | "no-session" | "crash" | "invalid-envelope" | "agent-fail" | "missing-prompt" | "environment" | "model" | "setup";

/**
 * Text that means the assistant itself could not be used, so a failed session is the environment's
 * problem, not the agent's. Matched only when the session failed: always against the error result's
 * text, and against stderr only when the session never answered (no assistant event), since a
 * session that worked may print such words itself (a command it ran). The one list; each entry says
 * what it catches.
 */
export const ENVIRONMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; catches: string }> = [
  { pattern: /invalid api key|please run \/login|not logged in|login required|oauth token (has )?(expired|revoked)|token refresh failed|authentication[_ ]error|API Error: 40[13]\b/i, catches: "signed out, or the sign-in expired" },
  { pattern: /usage limit|(hit|reached) your (\w+ )*limit|spend limit|shared budget|requires usage credits|out of (usage |extra usage )?credits|credit balance is too low|rate[_ ]limit|too many requests|API Error: 429\b/i, catches: "a usage, spend or rate limit was reached, or the credits ran out" },
  { pattern: /overloaded|service unavailable|API Error: 5\d\d\b/i, catches: "the service is overloaded or down" },
  { pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed|unable to connect|network error|connection error/i, catches: "the network is down or the service cannot be reached" },
];

/** Text of a model name Claude Code does not accept: a typo or a model the person has no access to. Matched like the environment patterns, and first. */
const MODEL_PATTERN = /issue with the selected model|model[_ ]not[_ ]found|not_found_error[^\n]*model/i;

/**
 * Whether an error result's API status means the assistant could not be used: signed out (401, 403), a limit
 * (429), or the service down (5xx, 529 overloaded). Read when the result carries one, so new wording is caught too.
 */
function environmentStatus(status: number | null): boolean {
  return status === 401 || status === 403 || status === 429 || (status !== null && status >= 500);
}

/** The first line of `text` that names a model Claude Code does not accept, or null. */
function modelLine(text: string): string | null {
  return text.split(/\r?\n/).find((line) => MODEL_PATTERN.test(line))?.trim() ?? null;
}

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
  /** Extra Claude Code settings for this session, as JSON (`claude --settings`): the test hook. */
  settings?: string;
  /** Subagents defined for this session only, by name (`claude --agents`); none when empty. */
  agents?: Record<string, object>;
  /** The agent the session itself runs as (`claude --agent`). */
  agent?: string;
  /** Which settings Claude Code loads (`claude --setting-sources`, e.g. "user,project"). */
  settingSources?: string;
  /** More directories the session's tools may reach (`claude --add-dir`, once per directory). */
  addDirs?: string[];
  /** Subagents' text is forwarded into the session's stream (`claude --forward-subagent-text`). */
  forwardSubagentText?: boolean;
  /**
   * Judges the session's first init event that lists its agents or skills (never one that lists neither, and
   * not again once one passed): a string ends the session at once as a "setup" failure, with it as the detail.
   */
  checkInit?: (init: { agents?: string[]; skills?: string[] }) => string | null;
  timeoutMs: number;
  /** The session's spending cap. Absent or Infinity: no --max-budget-usd, and the timeout is the only stop. */
  maxBudgetUsd?: number;
  resume?: string;
  env?: Record<string, string>;
  /** Names of this process's environment variables the session must not inherit (a chat session: the bot tokens). `env` is added after. */
  dropEnv?: string[];
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

/** A user message as one stream-json input line. */
function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/**
 * The state a live session's control acts on: the process running now (its stdin, what was written
 * to it and what it echoed), and what a person asked of it.
 */
class LiveSession {
  writer: StdinWriter | null = null;
  /** The messages written to the running process, in the order written. */
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
    return this.sent.length - Math.max(0, this.replays - 1);
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
const ENVELOPE_NUDGE = "You finished without returning your result. Return it now by calling the StructuredOutput tool (a tool call, not text) with the result you reached; do not redo the work.";

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
 * Each of the three carries the session's id when it has one, so the interrupted row names its transcript.
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

/** What spawnBounded gave for one process of the session. */
type SpawnResult = Awaited<ReturnType<typeof spawnBounded>>;

/**
 * What the earlier sends of one session cost and were refused, and what a further send may spend. A
 * session may be sent more than once (see the resends in runSession); each send is a run of its own,
 * with a cap of its own, and a later one may spend only what the earlier ones left of maxBudgetUsd.
 */
class Sends {
  /** What the earlier sends cost. */
  private costUsd = 0;
  /** What they were refused, each once. */
  private denied: string[] = [];
  private readonly capped: boolean;

  constructor(private readonly maxBudgetUsd: number | undefined) {
    this.capped = maxBudgetUsd !== undefined && Number.isFinite(maxBudgetUsd);
  }

  /**
   * The cap to send again with, after the earlier sends and `moreUsd` besides: [] with no cap, and null
   * when too little is left to send again.
   */
  budgetArgs(moreUsd = 0): string[] | null {
    if (!this.capped) return [];
    const left = Math.round((this.maxBudgetUsd! - (this.costUsd + moreUsd)) * 1e6) / 1e6;
    return left < MIN_SESSION_USD ? null : ["--max-budget-usd", String(left)];
  }

  /** What the next process may spend: what the earlier sends left of the cap (Infinity with no cap). */
  leftUsd(): number {
    return this.capped ? Math.max(0, this.maxBudgetUsd! - this.costUsd) : Infinity;
  }

  /** A send ended and the session goes on: what it cost and was refused counts with the earlier sends. */
  add(costUsd: number, denied: string[]): void {
    this.costUsd += costUsd;
    this.denied = [...new Set([...this.denied, ...denied])];
  }

  /** The newest send's result with the earlier sends': what they all cost, and every refusal (the phase's report names each). */
  total(c: Collected): Collected {
    return { ...c, costUsd: c.costUsd + this.costUsd, denied: [...new Set([...this.denied, ...c.denied])] };
  }
}

/** The command that starts a session: the CLI and its flags (each send adds its cap and --resume). */
function claudeCommand(exe: string, input: RunPhaseInput): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--model", input.model,
    "--permission-mode", input.permissionMode,
  ];
  if (input.allowedTools.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
  if (input.agents && Object.keys(input.agents).length) args.push("--agents", JSON.stringify(input.agents));
  if (input.agent) args.push("--agent", input.agent);
  if (input.settingSources !== undefined) args.push("--setting-sources", input.settingSources);
  for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);
  if (input.forwardSubagentText) args.push("--forward-subagent-text");
  if (input.settings) args.push("--settings", input.settings);
  // Every user message the session takes is echoed, so the runner knows which result answers it.
  if (input.live) args.push("--input-format", "stream-json", ...(input.live.replay === false ? [] : ["--replay-user-messages"]));
  // A .ts fake must be run through bun; the real CLI is a native executable.
  return exe.endsWith(".ts") ? [process.execPath, exe, ...args] : [exe, ...args];
}

/** runPhase's work; `live` is the live session's state, or null. */
async function runSession(input: RunPhaseInput, live: LiveSession | null): Promise<RunPhaseResult> {
  const started = Date.now();
  const exe = resolveClaude(input.executable);
  if (!exe) {
    return failure(new StreamCollector().finish(), { started, nudged: false }, "not-started", "could not start claude: not found on PATH. Install Claude Code or set LOOPSTRA_CLAUDE_EXECUTABLE.");
  }
  const cmd = claudeCommand(exe, input);
  const echoWaitMs = input.live?.echoWaitMs ?? ECHO_WAIT_MS;
  // No background tasks: one left pending when a session ends is delivered first when it is
  // resumed, and that session may then end without reading the prompt.
  const env = withBunOnPath(withoutGitHookEnv({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !input.dropEnv?.includes(k))), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ...input.env }));

  // A session that ended having answered only notifications (one started before background tasks
  // were turned off) gets the prompt again on the same session, within the same deadline. A session
  // that finished without structured output is asked for it once, the same way. `sends` keeps what
  // the earlier sends cost and were refused.
  const sends = new Sends(input.maxBudgetUsd);
  let collector = new StreamCollector();
  let resume = input.resume;
  let stdin = input.prompt;
  // Whether the session was asked again for its missing structured output.
  let nudged = false;
  // The session's id as far as it is known (the running process's, else the one it resumes), for
  // what a stop throws: the phase row keeps it, so the transcript can still be found.
  const sessionNow = () => collector.finish().sessionId ?? resume ?? null;
  let r: SpawnResult;
  // How many times the session was sent again after it stopped at a notification's result.
  let resends = 0;
  // Whether an init event that lists agents or skills was judged (see checkInit), and what it found missing.
  let initJudged = false;
  let setupProblem: string | null = null;
  for (;;) {
    if (live?.stoppedBy) throw new SessionStopped(live.stoppedBy, sessionNow());
    // spawnBounded checks these too, but what it throws cannot name the session a resend resumes.
    if (stopRequested()) throw new StopRequested(sessionNow());
    if (input.signal?.aborted) throw new Cancelled(sessionNow());
    const resumeArgs = resume ? ["--resume", resume] : [];
    // A live process is killed by its own signal too (a stop or a redirect), as well as by the caller's.
    const kill = live?.next();
    const signal = kill ? (input.signal ? AbortSignal.any([input.signal, kill]) : kill) : input.signal;
    const processStarted = Date.now();
    // What this process may spend: what the earlier ones left of the cap.
    const leftAtStart = sends.leftUsd();
    // The wait for an echo after a result (see ECHO_WAIT_MS). Once it ran out, stdin is closed and reading goes on to the end.
    let echoTimer: ReturnType<typeof setTimeout> | undefined;
    let echoGaveUp = false;
    const awaitEcho = () => {
      clearTimeout(echoTimer);
      echoTimer = setTimeout(() => { echoGaveUp = true; live?.done(); }, echoWaitMs);
    };
    r = await spawnBounded({
      cmd: [...cmd, ...(sends.budgetArgs() ?? []), ...resumeArgs], cwd: input.cwd, env,
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
        if (input.checkInit && !initJudged && e.type === "system" && e.subtype === "init") {
          const lists = initLists(e);
          if (lists) {
            initJudged = true;
            setupProblem = input.checkInit(lists);
            // The session lacks part of its setup: reading ends here, and so does the session.
            if (setupProblem !== null) return true;
          }
        }
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
    if (live?.stoppedBy) throw new SessionStopped(live.stoppedBy, sessionNow());
    // A failed init check ends the session (a stop or a cancel still wins: see below).
    if (setupProblem !== null) break;
    if (live && live.redirectTo !== null && !r.stopped && !input.signal?.aborted && r.started) {
      // What the killed process spent counts toward the cap, as a resend's does: its newest result's
      // running total, or about its minutes when it gave none (never more than it could spend).
      const reported = collector.events.filter((e) => e.type === "result").at(-1)?.total_cost_usd;
      sends.add(typeof reported === "number" ? reported : Math.min(leftAtStart, ((Date.now() - processStarted) / 60_000) * USD_PER_MINUTE), collector.finish().denied);
      resume = live.sessionId ?? resume;
      stdin = live.redirectTo;
      live.redirectTo = null;
      collector = new StreamCollector();
      // Too little is left to resume it: the session ends quietly, as if its sender had stopped it. The change
      // keeps its status, and conversation.md has the redirect for the next session.
      if (sends.budgetArgs() === null) throw new SessionStopped(live.redirectBy ?? "a person", sessionNow());
      continue;
    }
    if (r.stopped || r.cancelled || !r.started || r.timedOut) break;
    const c = collector.finish();
    if (!nudged && c.subtype === "success" && !c.isError && c.structuredOutput === undefined && c.sessionId) {
      if (sends.budgetArgs(c.costUsd) === null) break; // nothing left to ask with
      nudged = true;
      // Kept with what a redirect before it was refused: the phase's report names every refusal.
      sends.add(c.costUsd, c.denied);
      resume = c.sessionId;
      stdin = ENVELOPE_NUDGE;
      collector = new StreamCollector();
      continue;
    }
    if (r.code !== 0 || c.subtype !== "missing_result" || !c.events.some(answersNotification) || !c.sessionId || resends >= NOTIFICATION_RESENDS) break;
    // A result's total_cost_usd is the run's running total, so the last one is what the run cost. (A run
    // with no result of its own reported no refusals: c.denied is empty.)
    const cost = c.events.filter(answersNotification).at(-1)?.total_cost_usd;
    sends.add(typeof cost === "number" ? cost : 0, c.denied);
    if (sends.budgetArgs() === null) break; // nothing left to send it again with
    resume = c.sessionId;
    collector = new StreamCollector();
    resends++;
  }
  if (setupProblem !== null && !r.stopped && !r.cancelled) return failure(sends.total(collector.finish()), { started, nudged }, "setup", setupProblem, r.code, r.err);
  return classify(sends.total(collector.finish()), r, { started, timeoutMs: input.timeoutMs, resume, nudged });
}

/**
 * An init event's agent and skill names, each list only when the event has it; null when it has
 * neither. A list with entries but no names among them (a shape this does not know) cannot tell, so
 * it counts as absent, not as empty.
 */
function initLists(e: StreamEvent): { agents?: string[]; skills?: string[] } | null {
  const names = (v: unknown) => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string");
    return out.length || !v.length ? out : undefined;
  };
  const agents = names(e.agents);
  const skills = names(e.skills);
  if (!agents && !skills) return null;
  return { ...(agents ? { agents } : {}), ...(skills ? { skills } : {}) };
}

/** What classify needs besides the session's result and its last process's. */
interface ClassifyContext {
  /** When runPhase started (Date.now()): durationMs counts from it. */
  started: number;
  /** The session's deadline, for what a timeout says. */
  timeoutMs: number;
  /** The session the last send resumed, if any: only then can stderr mean it was not found. */
  resume: string | undefined;
  /** Whether the session was asked again for its missing structured output (see ENVELOPE_NUDGE). */
  nudged: boolean;
}

/** A failed phase result: what was collected, why it failed, and what the process left. */
function failure(collected: Collected, ctx: Pick<ClassifyContext, "started" | "nudged">, reason: FailureReason, detail: string, exitCode: number | null = null, stderr = "", matched: string | null = null): RunPhaseResult {
  // The work was done; only the report is missing. A nudge that times out or breaks does not make it a crash to rerun.
  if (ctx.nudged && (reason === "timeout" || reason === "crash" || reason === "no-session")) {
    detail = `claude finished without structured output, and asking again failed: ${detail}`;
    reason = "invalid-envelope";
  }
  return { ...collected, ok: false, reason, detail, exitCode, durationMs: Date.now() - ctx.started, stderr, matched };
}

/**
 * What a session's end means as a phase result, from what it collected (every send's, see
 * Sends.total) and its last process. A process killed from outside throws StopRequested or
 * Cancelled, with the session's id (else the one it resumed). It reads nothing else, so each reason
 * can be tested without a process.
 */
export function classify(collected: Collected, r: SpawnResult, ctx: ClassifyContext): RunPhaseResult {
  if (r.stopped) throw new StopRequested(collected.sessionId ?? ctx.resume ?? null);
  if (r.cancelled) throw new Cancelled(collected.sessionId ?? ctx.resume ?? null);
  if (!r.started) return failure(collected, ctx, "not-started", `could not start claude: ${r.err}`);
  const { code: exitCode, err: stderr } = r;
  const fail = (reason: FailureReason, detail: string, matched: string | null = null) => failure(collected, ctx, reason, detail, exitCode, stderr, matched);

  if (r.timedOut) return fail("timeout", `claude timed out after ${Math.round(ctx.timeoutMs / 1000)}s`);
  const lastErr = lastLine(stderr);
  // Before any subtype check: the CLI reports a missing session with an error result as well.
  if (ctx.resume && /no conversation found|session.*not found/i.test(stderr)) return fail("no-session", lastErr || "the session to resume was not found");
  if (/budget/i.test(collected.subtype)) return fail("budget", `claude ended with ${collected.subtype}`);
  if (collected.subtype !== "success" || collected.isError) {
    const answered = collected.events.some((e) => e.type === "assistant");
    const badModel = modelLine(collected.resultText) ?? (answered ? null : modelLine(stderr));
    if (badModel) return fail("model", `Claude Code does not accept the model: ${badModel}`, badModel);
    const outage = environmentLine(collected.resultText) ?? (answered ? null : environmentLine(stderr))
      ?? (environmentStatus(collected.apiErrorStatus) ? `API error ${collected.apiErrorStatus ?? ""}` : null);
    if (outage) return fail("environment", `the assistant is unavailable: ${outage}`, outage);
  }
  if (collected.subtype === "missing_result" && collected.events.some(answersNotification)) {
    return fail("crash", `claude answered only background task notifications and never the prompt${lastErr ? `: ${lastErr}` : ""}`);
  }
  if (collected.subtype === "missing_result") return fail("crash", `claude exited ${exitCode ?? "without an exit code"} without a result${lastErr ? `: ${lastErr}` : ""}`);
  if (/structured_output/i.test(collected.subtype)) return fail("invalid-envelope", `claude ended with ${collected.subtype}`);
  if (collected.subtype !== "success" || collected.isError) return fail("crash", `claude ended with ${collected.subtype}`);
  if (collected.structuredOutput === undefined) return fail("invalid-envelope", "claude finished without structured output");
  return { ...collected, ok: true, reason: null, detail: "", exitCode, durationMs: Date.now() - ctx.started, stderr, matched: null };
}
