import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { CHAT_SLUG, limitOf, MIN_SESSION_USD, sessionCost, staleBefore, startOfToday } from "../budget";
import { runPhase, type FailureReason } from "../claude";
import { modelFor, type Config, type ModelRef } from "../config";
import { jsonSchemaOf } from "../envelopes";
import { errorText } from "../shell";
import { StopRequested } from "../stop";
import type { Trace } from "../trace";

export { CHAT_SLUG, MIN_SESSION_USD, startOfToday };

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

/**
 * Read-only tools for both chat agents: look at the repository and the trace, and run `loopstra
 * status`. No git: `git show <rev>:<path>` and `git log -p` would read any file's content, past or
 * present, around the Read rules below; the runtime puts recent history in the context instead.
 */
export const CHAT_TOOLS = ["Read", "Glob", "Grep", "Bash(loopstra status)", "Bash(loopstra status *)"];
/**
 * Chat agents take instructions from whoever is in a chat channel, so on top of the write tools,
 * reading the usual places secrets are kept is denied (Read rules also cover Grep and Glob), and so
 * is git's own folder. This is a guard, not a sandbox: keep `allow` lists tight.
 */
export const CHAT_DENIED = [
  "Edit", "Write", "NotebookEdit", "PowerShell",
  ...["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/.git/**", "~/.ssh/**", "~/.aws/**", "~/.config/**", "~/.claude/**", "~/.gnupg/**", "~/.netrc", "~/.npmrc", "~/.git-credentials"].map((p) => `Read(${p})`),
  // Other people's conversations (other threads, other platforms) and the chat sessions' own prompts.
  ...["**/.loopstra/chat/**", "**/.loopstra/runs/_chat/**"].map((p) => `Read(${p})`),
];

export type ChatAgentResult<T> =
  | { ok: true; value: T; sessionId: string | null; costUsd: number }
  | { ok: false; reason: FailureReason; detail: string; sessionId: string | null; costUsd: number;
      /** Why no session started: the day's budget is spent ("today"), or what is left is held by sessions still running ("held"). */
      budgetUsedUp?: "today" | "held" };

export interface ChatAgentInput<T> {
  root: string;
  cfg: Config;
  trace: Trace;
  name: ChatPhase;
  prompt: string;
  schema: z.ZodType<T>;
  model: ModelRef;
  /** The most this one session may spend (Infinity: no cap of its own); it also never holds more than is left of the day's chat budget. */
  capUsd: number;
  resume?: string | null;
}

/**
 * One traced chat session (a turn or a writer run), under the `_chat` slug: its cost counts in the
 * dashboard and `loopstra tail _chat` shows it. Before it starts, it holds its share of the day's chat
 * budget in the trace, so sessions running at once (other threads, other processes) never spend
 * more than the day allows together. Never throws for the session's own failure; a stop request is
 * passed on.
 */
export async function runChatAgent<T>(o: ChatAgentInput<T>): Promise<ChatAgentResult<T>> {
  const day = limitOf(o.cfg.chat.max_budget_usd_per_day);
  const held = o.trace.phaseStartWithin(CHAT_SLUG, o.name, "agent", {
    since: startOfToday(), limitUsd: day,
    capUsd: Math.min(o.capUsd, limitOf(o.cfg.claude.max_budget_usd), limitOf(o.cfg.chat.max_budget_usd_per_session)), floorUsd: MIN_SESSION_USD,
    // A chat process killed mid-turn leaves its row running; its hold stops counting once stale.
    runningSince: staleBefore(o.cfg),
  });
  if (!held) {
    const why = day - chatSpentToday(o.trace) < MIN_SESSION_USD ? "today" : "held";
    return { ok: false, reason: "budget", detail: why === "today" ? "the day's chat budget is used up" : "what is left of the day's chat budget is held by sessions still running", sessionId: null, costUsd: 0, budgetUsedUp: why };
  }
  const seq = held.seq;
  const started = Date.now();
  const dir = join(o.root, ".loopstra", "runs", CHAT_SLUG, "phases", `${seq}-${o.name}`);
  let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  // What the session cost, once it ended (null until then): kept if the turn fails after it.
  let costUsd: number | null = null;
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
      maxBudgetUsd: held.heldUsd,
      resume: o.resume ?? undefined,
      env: { LOOPSTRA_PHASE: o.name, LOOPSTRA_SLUG: CHAT_SLUG },
      onEvent: (e) => { raw.write(JSON.stringify(e) + "\n"); },
    });
    costUsd = sessionCost(r, r.durationMs, held.heldUsd);
    if (!r.ok) {
      o.trace.phaseEnd(CHAT_SLUG, seq, { status: "fail", costUsd, sessionId: r.sessionId ?? undefined, error: `${r.reason}: ${r.detail}`, denied: r.denied });
      return { ok: false, reason: r.reason, detail: r.detail, sessionId: r.sessionId, costUsd };
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
      // A session the stop killed never reported its cost.
      const spent = costUsd ?? sessionCost({ costUsd: 0, costReported: false }, Date.now() - started, held.heldUsd);
      o.trace.phaseEnd(CHAT_SLUG, seq, { status: "interrupted", costUsd: spent, error: "stopped by request" });
      throw e;
    }
    o.trace.phaseEnd(CHAT_SLUG, seq, { status: "fail", costUsd: costUsd ?? 0, error: `crash: runtime error: ${errorText(e)}` });
    return { ok: false, reason: "crash", detail: errorText(e), sessionId: null, costUsd: costUsd ?? 0 };
  } finally {
    if (writer) { try { await writer.end(); } catch { /* already closed */ } }
  }
}

/** What chat has spent since local midnight, in sessions that have ended (not what running ones hold). */
export function chatSpentToday(trace: Trace, now = new Date()): number {
  return trace.costSince(CHAT_SLUG, startOfToday(now), { endedOnly: true });
}
