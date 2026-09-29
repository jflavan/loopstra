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

export interface RunPhaseInput {
  cwd: string;
  prompt: string;
  schema: object;
  model: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  timeoutMs: number;
  maxBudgetUsd: number;
  resume?: string;
  env?: Record<string, string>;
  /** Override the executable (tests). Defaults to $LOOPSTRA_CLAUDE_EXECUTABLE or `claude` on PATH. */
  executable?: string;
  onEvent?: (e: StreamEvent) => void;
}

export interface RunPhaseResult extends Collected {
  ok: boolean;
  reason: string;
  exitCode: number | null;
  durationMs: number;
  stderr: string;
}

export function resolveClaude(override?: string): string | null {
  if (override) return override;
  const fromEnv = process.env[FAKE_CLAUDE_ENV];
  if (fromEnv) return fromEnv;
  return Bun.which("claude");
}

export async function runPhase(input: RunPhaseInput): Promise<RunPhaseResult> {
  const started = Date.now();
  const collector = new StreamCollector();
  const fail = (reason: string, exitCode: number | null = null, stderr = ""): RunPhaseResult => ({
    ...collector.finish(), ok: false, reason, exitCode, durationMs: Date.now() - started, stderr,
  });

  const exe = resolveClaude(input.executable);
  if (!exe) return fail("could not start claude: not found on PATH. Install Claude Code or set LOOPSTRA_CLAUDE_EXECUTABLE.");

  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(input.schema),
    "--model", input.model,
    "--permission-mode", input.permissionMode,
    "--max-budget-usd", String(input.maxBudgetUsd),
  ];
  if (input.allowedTools.length) args.push("--allowedTools", input.allowedTools.join(","));
  if (input.resume) args.push("--resume", input.resume);

  // A .ts fake must be run through bun; the real CLI is a native executable.
  const cmd = exe.endsWith(".ts") ? [process.execPath, exe, ...args] : [exe, ...args];

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd, cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...(input.env ?? {}) },
    });
  } catch (e) {
    return fail(`could not start claude: ${(e as Error).message}`);
  }

  proc.stdin.write(input.prompt);
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, input.timeoutMs);

  const stderrPromise = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const e = collector.push(line);
      if (e && input.onEvent) input.onEvent(e);
    }
  }
  if (buffer.trim()) { const e = collector.push(buffer); if (e && input.onEvent) input.onEvent(e); }
  clearTimeout(timer);

  const exitCode = await proc.exited;
  const stderr = await stderrPromise;
  const collected = collector.finish();
  const durationMs = Date.now() - started;

  if (timedOut) return fail(`claude timed out after ${Math.round(input.timeoutMs / 1000)}s`, exitCode, stderr);
  if (collected.subtype === "missing_result") {
    return fail(`claude exited ${exitCode} without a result: ${stderr.trim().split("\n").pop() ?? ""}`.trim(), exitCode, stderr);
  }
  if (collected.subtype !== "success" || collected.isError) {
    return fail(`claude ended with ${collected.subtype}`, exitCode, stderr);
  }
  if (collected.structuredOutput === undefined) {
    return fail("claude finished without structured output", exitCode, stderr);
  }
  return { ...collected, ok: true, reason: "", exitCode, durationMs, stderr };
}
