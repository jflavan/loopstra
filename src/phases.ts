import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SLUG, limitOf, MIN_SESSION_USD, staleBefore, startOfToday } from "./budget";
import { runPhase, unavailable, type FailureReason, type PermissionMode } from "./claude";
import { modelFor, type Config } from "./config";
import type { Trace } from "./trace";
import { GitTimeout } from "./git";
import { CRASH_NOTE, TIMEOUT_NOTE, type StepContext } from "./context";
import { Envelopes, jsonSchemaFor, type Envelope, type PhaseName } from "./envelopes";
import { renderPrompt, type PromptVars } from "./prompts";
import { commandTimeoutMs, errorText, runCommand, type CommandResult } from "./shell";
import { clearPause } from "./heartbeat";
import { AssistantUnavailable, LoopBudgetReached, StopRequested, throwIfStopping } from "./stop";

/**
 * read: look only. read+git: look, plus read-only git (the reviewer). read+commands: look, the
 * configured project commands except install, and read-only git (verify, done-check). build:
 * `claude.allowed_tools` plus every configured project command, install included.
 */
export type ToolSet = "read" | "read+git" | "read+commands" | "build";

export interface AgentPhaseSpec {
  name: PhaseName;
  /** Name used in the trace and the phase directory. Defaults to `name` (e.g. fix-1 for the fix phase). */
  traceName?: string;
  model: "default" | "cheap" | "strong";
  permissionMode: PermissionMode;
  tools: ToolSet;
  vars: PromptVars;
  /** Run in this directory (the worktree for build phases). Defaults to the repo root. */
  cwd?: string;
  /** Resume this session id. */
  resume?: string;
  /** Extra environment for the claude process (e.g. LOOPSTRA_PHASE=fix). */
  env?: Record<string, string>;
  /** Names of skills to mention at the top of the prompt. */
  skills?: string[];
}

export type AgentPhaseResult<N extends PhaseName> =
  | { ok: true; envelope: Envelope<N>; sessionId: string | null; costUsd: number }
  | { ok: false; reason: FailureReason; note: string; sessionId: string | null };

const READ_TOOLS = ["Read", "Glob", "Grep"];
/** Git commands that only read, so a judge can see the change it is judging. */
const GIT_READ = ["git diff", "git log", "git show", "git status"].map((c) => `Bash(${c} *)`);
/** Removed from read-only sessions outright (a bare name in --disallowedTools removes the tool). */
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];
/**
 * Removed from every session: on Windows the CLI also offers a PowerShell tool, which the Bash(...)
 * allow rules do not cover. Without it the agent uses Bash, where the rules apply.
 */
const NO_POWERSHELL = ["PowerShell"];

/**
 * The parts of a chained command (`a && b || c; d`), split outside quotes. A command without a
 * chain operator is its own single part. Pipes are not split: a pipe's right side (`| tee out.log`)
 * would let judges, which are read-only, write files.
 */
export function commandParts(cmd: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const op = ["&&", "||", ";"].find((o) => cmd.startsWith(o, i));
    if (!op) continue;
    parts.push(cmd.slice(start, i));
    i += op.length - 1;
    start = i + 1;
  }
  parts.push(cmd.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p);
}

/** Tools a session may use without asking. Always a fresh array. */
export function toolsFor(ctx: StepContext, set: ToolSet): string[] {
  if (set === "read") return [...READ_TOOLS];
  if (set === "read+git") return [...READ_TOOLS, ...GIT_READ];
  const { test, lint, build, run, install } = ctx.cfg.commands;
  // `Bash(<cmd> *)` matches the command alone and with arguments. Claude Code checks each part of
  // `a && b` against the rules on its own, so a chained command also allows each of its parts.
  const rules = (cmds: Array<string | undefined>) =>
    cmds.filter((c): c is string => !!c).flatMap((c) => [...new Set([c, ...commandParts(c)])]).map((c) => `Bash(${c} *)`);
  // A build session runs the project's own commands (tests, install) whatever the allow list says.
  if (set === "build") return [...new Set([...ctx.cfg.claude.allowed_tools, ...rules([test, lint, build, run, install])])];
  // The install command is not for judges.
  return [...new Set([...READ_TOOLS, ...rules([test, lint, build, run]), ...GIT_READ])];
}

/**
 * The shell commands a tool set lets a session run, for the prompt's `{{commands}}`: "`bun test`,
 * `git diff`" (each with any arguments), "any command" for a bare Bash rule, "none" without Bash.
 */
export function commandsFor(ctx: StepContext, set: ToolSet): string {
  const tools = toolsFor(ctx, set);
  if (tools.includes("Bash")) return "any command";
  const cmds = tools.map((t) => /^Bash\((.+?)(?: \*|:\*)?\)$/.exec(t)?.[1]).filter((c): c is string => !!c);
  return cmds.length ? [...new Set(cmds)].map((c) => `\`${c}\``).join(", ") : "none";
}

/** Every prompt ends with these two lines. agentPhase appends them, so a template need not. */
export const CONTRACT_LINES = [
  "Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.",
  "Respond only through the structured output.",
] as const;

/**
 * The rendered prompt with the contract lines at the end. A prompt that already ends with them
 * (a copy stamped by an older `loopstra init`) loses that copy first, so they never appear twice.
 */
export function withContract(rendered: string): string {
  const lines = rendered.trimEnd().split("\n");
  for (const line of [...CONTRACT_LINES].reverse()) {
    while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
    if (lines.at(-1)?.trim() === line) lines.pop();
  }
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
  return `${lines.join("\n")}\n\n${CONTRACT_LINES.join("\n\n")}\n`;
}

/** Tools a session must not have. Read-only sessions lose every file-writing tool; no session has PowerShell. */
export function disallowedFor(set: ToolSet): string[] {
  return set === "build" ? [...NO_POWERSHELL] : [...WRITE_TOOLS, ...NO_POWERSHELL];
}

/** Failures that block the change; an unavailable assistant pauses the loop instead (see unavailable). */
type BlockingReason = Exclude<FailureReason, "environment" | "not-started">;

/** One plain sentence per failure reason, for the owner. The raw detail goes to the trace. */
export function ownerNote(reason: BlockingReason): string {
  switch (reason) {
    case "timeout": return `${TIMEOUT_NOTE} An engineer can allow longer with claude.timeout_minutes in loopstra/config.yaml.`;
    case "budget": return "This step hit its spending limit (claude.max_budget_usd). An engineer can raise or remove it with `loopstra setup budgets`.";
    case "crash": return CRASH_NOTE;
    case "no-session": return "The assistant could not pick up its earlier work.";
    case "invalid-envelope": return "The assistant's report could not be read.";
    case "missing-prompt": return "A prompt file for this step is missing.";
    // The agent's own summary is not written for the owner; it goes to the trace.
    case "agent-fail": return "The assistant reported it could not finish this step.";
  }
}

/** Failures worth one automatic retry (spec §15). Budget failures are not retried. */
const RETRIED: ReadonlySet<FailureReason> = new Set(["timeout", "crash"]);

export async function agentPhase<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }): Promise<AgentPhaseResult<N>> {
  const promptPath = join(ctx.root, "loopstra", "prompts", `${spec.name}.md`);
  if (!existsSync(promptPath)) {
    ctx.trace.event(ctx.slug, "error", { where: spec.traceName ?? spec.name, reason: "missing-prompt", detail: `loopstra/prompts/${spec.name}.md is missing; \`loopstra init\` restores it` });
    return { ok: false, reason: "missing-prompt", note: `${ownerNote("missing-prompt")} An engineer needs to restore it.`, sessionId: null };
  }
  const skillsLine = (spec.skills ?? []).length ? `Use these skills: ${(spec.skills ?? []).map((s) => `\`${s}\``).join(", ")}.\n\n` : "";
  const vars = { slug: ctx.slug, main_branch: ctx.cfg.main_branch, commands: commandsFor(ctx, spec.tools), ...spec.vars };
  const prompt = withContract(skillsLine + renderPrompt(await Bun.file(promptPath).text(), vars));

  const traceName = spec.traceName ?? spec.name;
  const first = await attempt(ctx, spec, prompt, traceName);
  if (first.ok || !RETRIED.has(first.reason)) return first;
  ctx.trace.event(ctx.slug, "error", { where: traceName, retry: true, reason: first.reason });
  return attempt(ctx, spec, prompt, `${traceName}-retry`);
}

/**
 * Starts a loop phase's row. With claude.max_budget_usd_per_day set, the phase holds what it may
 * spend of what is left of the loop's day (every change together, not chat), and does not start when
 * too little is left. `capUsd` is the session's cap (Infinity: none).
 */
function startPhase(ctx: StepContext, traceName: string): { seq: number; capUsd: number } {
  const c = ctx.cfg.claude;
  if (c.max_budget_usd_per_day === undefined) return { seq: ctx.trace.phaseStart(ctx.slug, traceName, "agent"), capUsd: limitOf(c.max_budget_usd) };
  const held = ctx.trace.phaseStartWithin(ctx.slug, traceName, "agent", {
    since: startOfToday(), limitUsd: c.max_budget_usd_per_day, capUsd: limitOf(c.max_budget_usd), floorUsd: MIN_SESSION_USD,
    pool: { except: CHAT_SLUG }, runningSince: staleBefore(ctx.cfg),
  });
  if (!held) throw new LoopBudgetReached();
  return { seq: held.seq, capUsd: held.heldUsd };
}

/** One traced run of a phase. The phase row always ends (never left running) and the raw log is always closed. */
async function attempt<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }, prompt: string, traceName: string): Promise<AgentPhaseResult<N>> {
  throwIfStopping();
  const { seq, capUsd } = startPhase(ctx, traceName);
  // Commands the session was not allowed to run: on the phase in the trace, so an engineer can add allow rules.
  let denied: string[] = [];
  const failed = (reason: BlockingReason, detail: string, sessionId: string | null, costUsd = 0): AgentPhaseResult<N> => {
    const refused = denied.length ? `; not allowed: ${denied.join(", ")}` : "";
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd, sessionId: sessionId ?? undefined, error: `${reason}: ${detail}${refused}`, denied });
    return { ok: false, reason, note: ownerNote(reason), sessionId };
  };
  let raw: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  try {
    const dir = join(ctx.runDir, "phases", `${seq}-${traceName}`);
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "prompt.md"), prompt);
    const writer = Bun.file(join(dir, "raw.jsonl")).writer();
    raw = writer;

    const r = await runPhase({
      cwd: spec.cwd ?? ctx.root,
      prompt,
      schema: jsonSchemaFor(spec.name),
      model: modelFor(ctx.cfg, spec.model),
      permissionMode: spec.permissionMode,
      allowedTools: toolsFor(ctx, spec.tools),
      disallowedTools: disallowedFor(spec.tools),
      timeoutMs: ctx.cfg.claude.timeout_minutes * 60_000,
      maxBudgetUsd: capUsd,
      resume: spec.resume,
      env: { LOOPSTRA_PHASE: spec.name, LOOPSTRA_SLUG: ctx.slug, ...(spec.env ?? {}) },
      onEvent: (e) => {
        writer.write(JSON.stringify(e) + "\n");
        if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e), seq);
      },
    });

    denied = r.denied;
    if (!r.ok) {
      if (unavailable(r.reason)) {
        // Not this phase's failure: it is interrupted, and the scheduler pauses the loop.
        ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", sessionId: r.sessionId ?? undefined, error: `${r.reason}: ${r.detail}`, denied });
        throw new AssistantUnavailable(r.detail, { phase: spec.name, line: r.matched ?? r.detail });
      }
      return failed(r.reason, r.detail, r.sessionId, r.costUsd);
    }
    const parsed = Envelopes[spec.name].safeParse(r.structuredOutput);
    await Bun.write(join(dir, "envelope.json"), JSON.stringify({ valid: parsed.success, output: r.structuredOutput }, null, 2));
    if (!parsed.success) {
      const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return failed("invalid-envelope", err, r.sessionId, r.costUsd);
    }
    const envelope = parsed.data as Envelope<N>;
    if (envelope.status === "fail") return failed("agent-fail", envelope.summary, r.sessionId, r.costUsd);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, denied });
    clearPause(ctx.root); // the assistant is back: the next outage starts the back-off afresh
    return { ok: true, envelope, sessionId: r.sessionId, costUsd: r.costUsd };
  } catch (e) {
    if (e instanceof AssistantUnavailable) throw e;
    if (e instanceof StopRequested) {
      ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", error: "stopped by request; the step resumes on the next start" });
      throw e;
    }
    return failed("crash", `runtime error: ${errorText(e)}`, null);
  } finally {
    if (raw) { try { await raw.end(); } catch { /* already closed */ } }
  }
}

const PROBE_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const PROBE_PROMPT = "This is only a check that you can be reached. Do not use any tools. Answer with ok set to true.";
/** At most this long, and never longer than a phase may take. */
const PROBE_TIMEOUT_MS = 2 * 60_000;

/**
 * One tiny session (cheap model, $0.05, no tools, a trivial prompt) to tell an outage from a phase
 * that keeps failing with words that look like one. Traced as a `probe` phase of the change.
 * `reached`: the assistant answered; otherwise `detail` says why not.
 */
export async function probeAssistant(root: string, cfg: Config, trace: Trace, slug: string): Promise<{ reached: boolean; detail: string }> {
  const seq = trace.phaseStart(slug, "probe", "agent");
  let r: Awaited<ReturnType<typeof runPhase>>;
  try {
    r = await runPhase({
      cwd: root, prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, model: modelFor(cfg, "cheap"), permissionMode: "default",
      allowedTools: [], disallowedTools: ["Bash", ...WRITE_TOOLS, ...NO_POWERSHELL],
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, cfg.claude.timeout_minutes * 60_000), maxBudgetUsd: 0.05,
      env: { LOOPSTRA_PHASE: "probe", LOOPSTRA_SLUG: slug },
    });
  } catch (e) {
    trace.phaseEnd(slug, seq, { status: e instanceof StopRequested ? "interrupted" : "fail", error: errorText(e) });
    throw e;
  }
  const reached = r.ok && (r.structuredOutput as { ok?: unknown } | undefined)?.ok === true;
  const detail = reached ? "the assistant answered the probe" : r.ok ? "the probe's answer was not ok: true" : `${r.reason}: ${r.detail}`;
  trace.phaseEnd(slug, seq, { status: reached ? "success" : "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: reached ? undefined : detail });
  return { reached, detail };
}

function summarize(e: Record<string, unknown>): Record<string, unknown> {
  if (e.type === "assistant") {
    const content = (e as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content ?? [];
    return { type: "assistant", items: content.map((c) => c.type === "tool_use" ? `tool:${c.name}` : c.type === "text" ? `text:${(c.text ?? "").slice(0, 120)}` : c.type) };
  }
  if (e.type === "result") return { type: "result", subtype: e.subtype, cost: e.total_cost_usd };
  return { type: e.type, subtype: e.subtype };
}

/**
 * Runs a configured project command in `cwd` with the configured time limit, and traces it as a
 * `command` event of `on.slug` (under phase `seq` when given). `env` defaults to LOOPSTRA_SLUG.
 */
export async function projectCommand(
  on: { trace: Trace; cfg: Config; slug: string }, command: string, cwd: string,
  opts: { env?: Record<string, string>; seq?: number; where?: string } = {},
): Promise<CommandResult> {
  const r = await runCommand(command, cwd, { env: opts.env ?? { LOOPSTRA_SLUG: on.slug }, timeoutMs: commandTimeoutMs(on.cfg) });
  on.trace.event(on.slug, "command", { command, code: r.code, lastLine: r.lastLine, durationMs: r.durationMs, ...(opts.where ? { where: opts.where } : {}) }, opts.seq);
  return r;
}

/** `detail`: what went wrong, for the trace (the caller words the owner's note). */
export type CodePhaseResult<T> = ({ ok: true } & T) | { ok: false; detail: string };

/** Runs deterministic work as a traced phase. Exceptions become a failed phase, never a crash; a stop request is marked interrupted and passed on. */
export async function codePhase<T extends object>(ctx: StepContext, name: string, fn: (seq: number) => Promise<{ ok: true } & T>): Promise<CodePhaseResult<T>> {
  const seq = ctx.trace.phaseStart(ctx.slug, name, "code");
  try {
    const r = await fn(seq);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success" });
    return r;
  } catch (e) {
    if (e instanceof StopRequested) {
      ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", error: "stopped by request; the step resumes on the next start" });
      throw e;
    }
    const msg = errorText(e);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: msg });
    // A hung git command is reported the same way wherever it happens (see the scheduler).
    if (e instanceof GitTimeout) throw e;
    return { ok: false, detail: `The ${name} step failed: ${msg.split("\n")[0]}` };
  }
}
