import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPhase, type FailureReason, type PermissionMode } from "./claude";
import { modelFor } from "./config";
import { GitTimeout } from "./git";
import type { StepContext } from "./context";
import { Envelopes, jsonSchemaFor, type Envelope, type PhaseName } from "./envelopes";
import { renderPrompt, type PromptVars } from "./prompts";
import { StopRequested, throwIfStopping } from "./stop";

/**
 * read: look only. read+git: look, plus read-only git (the reviewer). read+commands: look, the
 * configured project commands except install, and read-only git (verify, done-check). build: config.
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

/** Tools a session may use without asking. Always a fresh array. */
export function toolsFor(ctx: StepContext, set: ToolSet): string[] {
  if (set === "read") return [...READ_TOOLS];
  if (set === "read+git") return [...READ_TOOLS, ...GIT_READ];
  if (set === "build") return [...ctx.cfg.claude.allowed_tools];
  // The install command is not for judges. `Bash(<cmd> *)` matches the command alone and with arguments.
  const { test, lint, build, run } = ctx.cfg.commands;
  const cmds = [test, lint, build, run].filter((c): c is string => !!c);
  return [...READ_TOOLS, ...cmds.map((c) => `Bash(${c} *)`), ...GIT_READ];
}

/** Tools a session must not have. Read-only sessions lose every file-writing tool. */
export function disallowedFor(set: ToolSet): string[] {
  return set === "build" ? [] : [...WRITE_TOOLS];
}

/** One plain sentence per failure reason, for the owner. The raw detail goes to the trace. */
export function ownerNote(reason: FailureReason): string {
  switch (reason) {
    case "timeout": return "The assistant took too long on this step.";
    case "budget": return "This step hit its spending limit. An engineer may need to raise the limit.";
    case "crash": return "The assistant stopped unexpectedly.";
    case "no-session": return "The assistant could not pick up its earlier work.";
    case "not-started": return "The assistant could not be started. An engineer needs to check that Claude Code is installed.";
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
  const vars = { slug: ctx.slug, main_branch: ctx.cfg.main_branch, skills: (spec.skills ?? []).join(", "), ...spec.vars };
  const prompt = skillsLine + renderPrompt(await Bun.file(promptPath).text(), vars);

  const traceName = spec.traceName ?? spec.name;
  const first = await attempt(ctx, spec, prompt, traceName);
  if (first.ok || !RETRIED.has(first.reason)) return first;
  ctx.trace.event(ctx.slug, "error", { where: traceName, retry: true, reason: first.reason });
  return attempt(ctx, spec, prompt, `${traceName}-retry`);
}

/** One traced run of a phase. The phase row always ends (never left running) and the raw log is always closed. */
async function attempt<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }, prompt: string, traceName: string): Promise<AgentPhaseResult<N>> {
  throwIfStopping();
  const seq = ctx.trace.phaseStart(ctx.slug, traceName, "agent");
  const failed = (reason: FailureReason, detail: string, sessionId: string | null, costUsd = 0): AgentPhaseResult<N> => {
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd, sessionId: sessionId ?? undefined, error: `${reason}: ${detail}` });
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
      maxBudgetUsd: ctx.cfg.claude.max_budget_usd,
      resume: spec.resume,
      env: { LOOPSTRA_PHASE: spec.name, LOOPSTRA_SLUG: ctx.slug, ...(spec.env ?? {}) },
      onEvent: (e) => {
        writer.write(JSON.stringify(e) + "\n");
        if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e), seq);
      },
    });

    if (!r.ok) return failed(r.reason, r.detail, r.sessionId, r.costUsd);
    const parsed = Envelopes[spec.name].safeParse(r.structuredOutput);
    await Bun.write(join(dir, "envelope.json"), JSON.stringify({ valid: parsed.success, output: r.structuredOutput }, null, 2));
    if (!parsed.success) {
      const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return failed("invalid-envelope", err, r.sessionId, r.costUsd);
    }
    const envelope = parsed.data as Envelope<N>;
    if (envelope.status === "fail") return failed("agent-fail", envelope.summary, r.sessionId, r.costUsd);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined });
    return { ok: true, envelope, sessionId: r.sessionId, costUsd: r.costUsd };
  } catch (e) {
    if (e instanceof StopRequested) {
      ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", error: "stopped by request; the step resumes on the next start" });
      throw e;
    }
    return failed("crash", `runtime error: ${errorText(e)}`, null);
  } finally {
    if (raw) { try { await raw.end(); } catch { /* already closed */ } }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function summarize(e: Record<string, unknown>): Record<string, unknown> {
  if (e.type === "assistant") {
    const content = (e as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content ?? [];
    return { type: "assistant", items: content.map((c) => c.type === "tool_use" ? `tool:${c.name}` : c.type === "text" ? `text:${(c.text ?? "").slice(0, 120)}` : c.type) };
  }
  if (e.type === "result") return { type: "result", subtype: e.subtype, cost: e.total_cost_usd };
  return { type: e.type, subtype: e.subtype };
}

export type CodePhaseResult<T> = ({ ok: true } & T) | { ok: false; note: string };

/** Runs deterministic work as a traced phase. Exceptions become a failed phase, never a crash; a stop request is marked interrupted and passed on. */
export async function codePhase<T extends object>(ctx: StepContext, name: string, fn: () => Promise<{ ok: true } & T>): Promise<CodePhaseResult<T>> {
  const seq = ctx.trace.phaseStart(ctx.slug, name, "code");
  try {
    const r = await fn();
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
    return { ok: false, note: `The ${name} step failed: ${msg.split("\n")[0]}` };
  }
}
