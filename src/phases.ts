import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runPhase, type PermissionMode } from "./claude";
import { modelFor } from "./config";
import type { StepContext } from "./context";
import { Envelopes, jsonSchemaFor, type Envelope, type PhaseName } from "./envelopes";
import { renderPrompt, type PromptVars } from "./prompts";

export type ToolSet = "read" | "read+commands" | "build";

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
  | { ok: false; note: string; sessionId: string | null };

const READ_TOOLS = ["Read", "Glob", "Grep", "LS"];

export function toolsFor(ctx: StepContext, set: ToolSet): string[] {
  if (set === "read") return READ_TOOLS;
  if (set === "build") return ctx.cfg.claude.allowed_tools;
  const cmds = Object.values(ctx.cfg.commands).filter((c): c is string => !!c);
  return [...READ_TOOLS, ...cmds.map((c) => `Bash(${c})`)];
}

export async function agentPhase<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }): Promise<AgentPhaseResult<N>> {
  const promptPath = join(ctx.root, "loopstra", "prompts", `${spec.name}.md`);
  if (!existsSync(promptPath)) {
    return { ok: false, note: `The prompt file loopstra/prompts/${spec.name}.md is missing. Run \`loopstra init\` to restore it.`, sessionId: null };
  }
  const skillsLine = (spec.skills ?? []).length ? `Use these skills: ${(spec.skills ?? []).map((s) => `\`${s}\``).join(", ")}.\n\n` : "";
  const prompt = skillsLine + renderPrompt(await Bun.file(promptPath).text(), { slug: ctx.slug, ...spec.vars });

  const seq = ctx.trace.phaseStart(ctx.slug, spec.traceName ?? spec.name, "agent");
  const dir = join(ctx.runDir, "phases", `${seq}-${spec.traceName ?? spec.name}`);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "prompt.md"), prompt);
  const raw = Bun.file(join(dir, "raw.jsonl")).writer();

  const r = await runPhase({
    cwd: spec.cwd ?? ctx.root,
    prompt,
    schema: jsonSchemaFor(spec.name),
    model: modelFor(ctx.cfg, spec.model),
    permissionMode: spec.permissionMode,
    allowedTools: toolsFor(ctx, spec.tools),
    timeoutMs: ctx.cfg.claude.timeout_minutes * 60_000,
    maxBudgetUsd: ctx.cfg.claude.max_budget_usd,
    resume: spec.resume,
    env: { LOOPSTRA_PHASE: spec.name, LOOPSTRA_SLUG: ctx.slug, ...(spec.env ?? {}) },
    onEvent: (e) => {
      raw.write(JSON.stringify(e) + "\n");
      if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e), seq);
    },
  });
  await raw.end();

  if (!r.ok) {
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: r.reason });
    return { ok: false, note: `The ${spec.name} step could not finish: ${r.reason}.`, sessionId: r.sessionId };
  }
  const parsed = Envelopes[spec.name].safeParse(r.structuredOutput);
  await Bun.write(join(dir, "envelope.json"), JSON.stringify({ valid: parsed.success, output: r.structuredOutput }, null, 2));
  if (!parsed.success) {
    const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: `invalid envelope: ${err}` });
    return { ok: false, note: `The ${spec.name} step returned an answer in the wrong shape. Details are in the trace.`, sessionId: r.sessionId };
  }
  const envelope = parsed.data as Envelope<N>;
  if (envelope.status === "fail") {
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: envelope.summary });
    return { ok: false, note: `The ${spec.name} step reported a problem: ${envelope.summary}`, sessionId: r.sessionId };
  }
  ctx.trace.phaseEnd(ctx.slug, seq, { status: "success", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined });
  return { ok: true, envelope, sessionId: r.sessionId, costUsd: r.costUsd };
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

/** Runs deterministic work as a traced phase. Exceptions become a failed phase, never a crash. */
export async function codePhase<T extends object>(ctx: StepContext, name: string, fn: () => Promise<{ ok: true } & T>): Promise<CodePhaseResult<T>> {
  const seq = ctx.trace.phaseStart(ctx.slug, name, "code");
  try {
    const r = await fn();
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success" });
    return r;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: msg });
    return { ok: false, note: `The ${name} step failed: ${msg.split("\n")[0]}` };
  }
}
