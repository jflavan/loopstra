import { DETACHED, killTree, within } from "./shell";
import { onStop, StopRequested, throwIfStopping } from "./stop";

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface ToolUse { name: string; input: unknown }

export interface Collected {
  sessionId: string | null;
  subtype: string;
  structuredOutput: unknown;
  costUsd: number;
  usage: unknown;
  toolUses: ToolUse[];
  resultText: string;
  events: StreamEvent[];
  isError: boolean;
}

/** Accumulates `--output-format stream-json` lines into one result. */
export class StreamCollector {
  private sessionId: string | null = null;
  private result: StreamEvent | null = null;
  private toolUses: ToolUse[] = [];
  readonly events: StreamEvent[] = [];

  push(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let e: StreamEvent;
    try { e = JSON.parse(trimmed) as StreamEvent; } catch { return null; }
    this.events.push(e);
    if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
    if (e.type === "assistant") {
      const content = (e as { message?: { content?: Array<{ type: string; name?: string; input?: unknown }> } }).message?.content ?? [];
      for (const c of content) if (c.type === "tool_use" && c.name) this.toolUses.push({ name: c.name, input: c.input });
    }
    if (e.type === "result") this.result = e;
    return e;
  }

  finish(): Collected {
    const r = this.result as (StreamEvent & {
      structured_output?: unknown; total_cost_usd?: number; usage?: unknown; result?: string; is_error?: boolean;
    }) | null;
    return {
      sessionId: this.sessionId ?? r?.session_id ?? null,
      subtype: r?.subtype ?? "missing_result",
      structuredOutput: r?.structured_output,
      costUsd: r?.total_cost_usd ?? 0,
      usage: r?.usage,
      toolUses: this.toolUses,
      resultText: r?.result ?? "",
      events: this.events,
      isError: r?.is_error ?? r === null,
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
 */
export type FailureReason = "not-started" | "timeout" | "budget" | "no-session" | "crash" | "invalid-envelope" | "agent-fail" | "missing-prompt";

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
  maxBudgetUsd: number;
  resume?: string;
  env?: Record<string, string>;
  /** Override the executable (tests). Defaults to $LOOPSTRA_CLAUDE_EXECUTABLE or `claude` on PATH. */
  executable?: string;
  onEvent?: (e: StreamEvent) => void;
}

export type RunPhaseResult = Collected & {
  exitCode: number | null;
  durationMs: number;
  stderr: string;
} & ({ ok: true; reason: null; detail: "" } | { ok: false; reason: FailureReason; detail: string });

/** After the result event, how long the process gets to exit on its own before its tree is killed. */
const EXIT_GRACE_MS = 2_000;

export function resolveClaude(override?: string): string | null {
  if (override) return override;
  const fromEnv = process.env[FAKE_CLAUDE_ENV];
  if (fromEnv) return fromEnv;
  return Bun.which("claude");
}

/**
 * Runs one `claude -p` session. Everything it awaits is bounded by the deadline (`timeoutMs`)
 * plus a short grace: it stops reading stdout at the result event, never waits on pipes a
 * leftover grandchild may hold, and kills the process tree if it does not exit by itself.
 * After a stop request it does not start, or it kills the running session, and throws StopRequested.
 */
export async function runPhase(input: RunPhaseInput): Promise<RunPhaseResult> {
  const started = Date.now();
  const collector = new StreamCollector();
  const fail = (reason: FailureReason, detail: string, exitCode: number | null = null, stderr = ""): RunPhaseResult => ({
    ...collector.finish(), ok: false, reason, detail, exitCode, durationMs: Date.now() - started, stderr,
  });

  const exe = resolveClaude(input.executable);
  if (!exe) return fail("not-started", "could not start claude: not found on PATH. Install Claude Code or set LOOPSTRA_CLAUDE_EXECUTABLE.");

  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--model", input.model,
    "--permission-mode", input.permissionMode,
    "--max-budget-usd", String(input.maxBudgetUsd),
  ];
  if (input.allowedTools.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.disallowedTools?.length) args.push("--disallowedTools", input.disallowedTools.join(","));
  if (input.resume) args.push("--resume", input.resume);

  // A .ts fake must be run through bun; the real CLI is a native executable.
  const cmd = exe.endsWith(".ts") ? [process.execPath, exe, ...args] : [exe, ...args];

  throwIfStopping();
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd, cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...(input.env ?? {}) }, detached: DETACHED,
    });
  } catch (e) {
    return fail("not-started", `could not start claude: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A stop request kills the session's tree; its stdout then closes and the waits below end.
  let stopped = false;
  const unsubscribe = onStop(() => { stopped = true; void killTree(proc); });

  try {
    proc.stdin.write(input.prompt);
    void Promise.resolve(proc.stdin.end()).catch(() => {});
  } catch { /* the process already exited; the missing result reports it */ }

  // stderr is drained in the background and read as-is at the end; it is never awaited unbounded.
  let stderr = "";
  const stderrDone = (async () => {
    const dec = new TextDecoder();
    try { for await (const chunk of proc.stderr) stderr += dec.decode(chunk, { stream: true }); } catch { /* closed */ }
  })();

  const emit = (line: string) => {
    const e = collector.push(line);
    if (e && input.onEvent) { try { input.onEvent(e); } catch { /* tracing must never stop the phase */ } }
    return e;
  };

  const reader = proc.stdout.getReader();
  const readUntilResult = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const e = emit(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (e?.type === "result") return;
        }
      }
      if (buffer.trim()) emit(buffer);
    } catch { /* stream cancelled or broken; what was collected stands */ }
  })();

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => { deadlineTimer = setTimeout(() => resolve("deadline"), input.timeoutMs); });
  const first = await Promise.race([readUntilResult.then(() => "read" as const), deadline]);
  clearTimeout(deadlineTimer);
  const timedOut = first === "deadline";
  void reader.cancel().catch(() => {});

  let exitCode: number | null = timedOut ? null : await within(proc.exited, EXIT_GRACE_MS, null);
  if (exitCode === null) {
    await killTree(proc);
    exitCode = await within(proc.exited, EXIT_GRACE_MS, null);
  }
  await within(stderrDone, 250, undefined);
  unsubscribe();
  if (stopped) throw new StopRequested();

  const collected = collector.finish();
  if (timedOut) return fail("timeout", `claude timed out after ${Math.round(input.timeoutMs / 1000)}s`, exitCode, stderr);
  const lastErr = stderr.trim().split("\n").pop()?.trim() ?? "";
  if (collected.subtype === "missing_result") {
    if (input.resume && /no conversation found|session.*not found/i.test(stderr)) return fail("no-session", lastErr || "the session to resume was not found", exitCode, stderr);
    return fail("crash", `claude exited ${exitCode} without a result${lastErr ? `: ${lastErr}` : ""}`, exitCode, stderr);
  }
  if (/budget/i.test(collected.subtype)) return fail("budget", `claude ended with ${collected.subtype}`, exitCode, stderr);
  if (/structured_output/i.test(collected.subtype)) return fail("invalid-envelope", `claude ended with ${collected.subtype}`, exitCode, stderr);
  if (collected.subtype !== "success" || collected.isError) return fail("crash", `claude ended with ${collected.subtype}`, exitCode, stderr);
  if (collected.structuredOutput === undefined) return fail("invalid-envelope", "claude finished without structured output", exitCode, stderr);
  return { ...collected, ok: true, reason: null, detail: "", exitCode, durationMs: Date.now() - started, stderr };
}
