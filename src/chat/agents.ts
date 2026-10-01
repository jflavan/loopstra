import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { runPhase, type FailureReason } from "../claude";
import { modelFor, type Config, type ModelRef } from "../config";
import { jsonSchemaOf } from "../envelopes";
import { errorText } from "../shell";
import { StopRequested } from "../stop";
import type { Trace } from "../trace";

/** The trace slug every chat turn and writer run is recorded under. */
export const CHAT_SLUG = "_chat";

export type ChatPhase = "orchestrator" | "write-intent";

/** Every variable a chat prompt template may use. A variable with no value renders as `(none)`. */
export const CHAT_PROMPT_VARS = ["main_branch", "brief", "existing", "template", "updates", "problems"] as const;
export type ChatPromptVars = Partial<Record<(typeof CHAT_PROMPT_VARS)[number], string>>;

const BUNDLED = join(import.meta.dir, "..", "..", "templates", "prompts");

/**
 * The prompt template for a chat phase: the repository's own copy in loopstra/prompts/ (an engineer
 * may tune it), else the one shipped with Loopstra, so a repository set up before chat existed works.
 */
export async function chatTemplate(root: string, name: ChatPhase): Promise<string> {
  const own = join(root, "loopstra", "prompts", `${name}.md`);
  return Bun.file(existsSync(own) ? own : join(BUNDLED, `${name}.md`)).text();
}

export function renderChatPrompt(template: string, vars: ChatPromptVars): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) => {
    if (!(CHAT_PROMPT_VARS as readonly string[]).includes(name)) return match;
    const v = (vars as Record<string, string | undefined>)[name];
    return v === undefined || v === "" ? "(none)" : v;
  });
}

/** Read-only tools for both chat agents: look at the repository and the trace, run `loopstra status`, read git history. */
export const CHAT_TOOLS = ["Read", "Glob", "Grep", "Bash(loopstra status)", "Bash(loopstra status *)", "Bash(git log *)", "Bash(git show *)"];
/**
 * Chat agents take instructions from whoever is in a chat channel, so on top of the write tools:
 * `git log`/`git show --output=<file>` (it writes a file), and reading the usual places secrets are
 * kept (Read rules also cover Grep and Glob). This is a guard, not a sandbox: keep `allow` lists tight.
 */
export const CHAT_DENIED = [
  "Edit", "Write", "NotebookEdit", "PowerShell", "Bash(git log *--output*)", "Bash(git show *--output*)",
  ...["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "~/.ssh/**", "~/.aws/**", "~/.config/**", "~/.claude/**", "~/.gnupg/**", "~/.netrc", "~/.npmrc", "~/.git-credentials"].map((p) => `Read(${p})`),
];

export type ChatAgentResult<T> =
  | { ok: true; value: T; sessionId: string | null; costUsd: number }
  | { ok: false; reason: FailureReason; detail: string; sessionId: string | null; costUsd: number };

export interface ChatAgentInput<T> {
  root: string;
  cfg: Config;
  trace: Trace;
  name: ChatPhase;
  prompt: string;
  schema: z.ZodType<T>;
  model: ModelRef;
  maxBudgetUsd: number;
  resume?: string | null;
}

/**
 * One traced chat session (a turn or a writer run), under the `_chat` slug: its cost counts in the
 * dashboard and `loopstra tail _chat` shows it. Never throws for the session's own failure; a stop
 * request is passed on.
 */
export async function runChatAgent<T>(o: ChatAgentInput<T>): Promise<ChatAgentResult<T>> {
  const seq = o.trace.phaseStart(CHAT_SLUG, o.name, "agent");
  const dir = join(o.root, ".loopstra", "runs", CHAT_SLUG, "phases", `${seq}-${o.name}`);
  let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "prompt.md"), o.prompt);
    const raw = Bun.file(join(dir, "raw.jsonl")).writer();
    writer = raw;
    const r = await runPhase({
      cwd: o.root,
      prompt: o.prompt,
      schema: jsonSchemaOf(o.schema),
      model: modelFor(o.cfg, o.model),
      permissionMode: "default",
      allowedTools: CHAT_TOOLS,
      disallowedTools: CHAT_DENIED,
      timeoutMs: o.cfg.claude.timeout_minutes * 60_000,
      maxBudgetUsd: o.maxBudgetUsd,
      resume: o.resume ?? undefined,
      env: { LOOPSTRA_PHASE: o.name, LOOPSTRA_SLUG: CHAT_SLUG },
      onEvent: (e) => { raw.write(JSON.stringify(e) + "\n"); },
    });
    if (!r.ok) {
      o.trace.phaseEnd(CHAT_SLUG, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: `${r.reason}: ${r.detail}`, denied: r.denied });
      return { ok: false, reason: r.reason, detail: r.detail, sessionId: r.sessionId, costUsd: r.costUsd };
    }
    const parsed = o.schema.safeParse(r.structuredOutput);
    await Bun.write(join(dir, "envelope.json"), JSON.stringify({ valid: parsed.success, output: r.structuredOutput }, null, 2));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      o.trace.phaseEnd(CHAT_SLUG, seq, { status: "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: `invalid-envelope: ${detail}` });
      return { ok: false, reason: "invalid-envelope", detail, sessionId: r.sessionId, costUsd: r.costUsd };
    }
    o.trace.phaseEnd(CHAT_SLUG, seq, { status: "success", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, denied: r.denied });
    return { ok: true, value: parsed.data, sessionId: r.sessionId, costUsd: r.costUsd };
  } catch (e) {
    if (e instanceof StopRequested) {
      o.trace.phaseEnd(CHAT_SLUG, seq, { status: "interrupted", error: "stopped by request" });
      throw e;
    }
    o.trace.phaseEnd(CHAT_SLUG, seq, { status: "fail", error: `crash: runtime error: ${errorText(e)}` });
    return { ok: false, reason: "crash", detail: errorText(e), sessionId: null, costUsd: 0 };
  } finally {
    if (writer) { try { await writer.end(); } catch { /* already closed */ } }
  }
}

/** Local midnight today, as an ISO time: the start of the chat's daily budget. */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** What chat has spent since local midnight. */
export function chatSpentToday(trace: Trace, now = new Date()): number {
  return trace.costSince(CHAT_SLUG, startOfToday(now));
}
