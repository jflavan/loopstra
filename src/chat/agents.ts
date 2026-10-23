import { join } from "node:path";
import { runDir } from "../paths";
import type { z } from "zod";
import { CHAT_SLUG, limitOf, MIN_SESSION_USD, staleBefore, startOfToday } from "../budget";
import type { FailureReason } from "../claude";
import { modelFor, type Config } from "../config";
import { jsonSchemaOf } from "../envelopes";
import { stepModel, type StepKey } from "../models";
import { promptPath } from "../prompts";
import { issuesText, tracedSession } from "../sessions";
import type { Trace } from "../trace";

export { CHAT_SLUG, MIN_SESSION_USD };

type ChatPhase = Extract<StepKey, "orchestrator" | "write-intent">;

/** Every variable a chat prompt template may use. A variable with no value renders as `(none)`. */
export const CHAT_PROMPT_VARS = ["main_branch", "brief", "existing", "template", "updates", "problems"] as const;
type ChatPromptVars = Partial<Record<(typeof CHAT_PROMPT_VARS)[number], string>>;

/** The prompt template for a chat phase: the repository's override, else the one shipped with Loopstra. */
export async function chatTemplate(root: string, name: ChatPhase): Promise<string> {
  const path = promptPath(root, name);
  if (!path) throw new Error(`the prompt ${name}.md is missing from the repository and the package; reinstall Loopstra`);
  return Bun.file(path).text();
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
 * present, around the Read rules below; the runtime puts recent history in the context instead. Claude
 * Code allows read-only git by itself, so CHAT_DENIED also denies it.
 */
const CHAT_TOOLS = ["Read", "Glob", "Grep", "Bash(loopstra status)", "Bash(loopstra status *)"];
/**
 * Files that hold secrets wherever they are: denied by their relative glob and by the absolute one
 * (`//` is the file system's root). direnv's .envrc and a project's .npmrc export or hold tokens; the
 * PowerShell profiles (under Documents, which may sit in OneDrive) set them on Windows.
 */
const SECRET_FILES = [".env", ".env.*", ".envrc", ".npmrc", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".git/**", "Documents/PowerShell/*profile*.ps1", "Documents/WindowsPowerShell/*profile*.ps1"];
/**
 * Places in the home folder that hold secrets or sign-ins: the shells' start-up files export them
 * (`.*rc` and .profile, and the login shells' .zshenv, .zprofile, .bash_profile and .bash_login),
 * ~/.claude.json holds Claude Code's own, and on Windows _netrc and the GitHub CLI's folder in
 * %APPDATA% hold sign-ins (elsewhere it is under .config).
 */
const SECRET_HOMES = [".ssh/**", ".aws/**", ".config/**", ".claude/**", ".claude.json", ".gnupg/**", ".netrc", "_netrc", ".npmrc", ".git-credentials", ".*rc", ".profile", ".zshenv", ".zprofile", ".bash_profile", ".bash_login", ".docker/**", ".kube/**", ".azure/**", "AppData/Roaming/GitHub CLI/**"];
/**
 * Chat agents take instructions from whoever is in a chat channel, so on top of the write tools,
 * reading the usual places secrets are kept is denied (Read rules also cover Grep and Glob), and so
 * are git's own folder and git itself (see CHAT_TOOLS). /proc is denied too: /proc/<pid>/environ
 * holds a process's environment (the secrets this process keeps out of a session's, see
 * secretEnvNames, are still in its own). This is a guard, not a sandbox: keep `allow` lists tight.
 */
export const CHAT_DENIED = [
  "Edit", "Write", "NotebookEdit", "PowerShell", "Bash(git)", "Bash(git *)",
  ...SECRET_FILES.flatMap((p) => [`Read(**/${p})`, `Read(//**/${p})`]),
  ...SECRET_HOMES.map((p) => `Read(~/${p})`),
  "Read(//proc/**)",
  // Other people's conversations (other threads, other platforms) and the chat sessions' own prompts.
  ...["**/.loopstra/chat/**", "**/.loopstra/runs/_chat/**"].map((p) => `Read(${p})`),
];

/** An environment variable that looks like a secret, by name. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i;
/**
 * What Claude Code signs in and connects with (an API key or OAuth token, Bedrock's, Vertex's or
 * Microsoft Foundry's credentials, its own settings): kept, or no session could start. A secret
 * that only an apiKeyHelper script reads (a vault token, say) is dropped like any other: that setup
 * needs the helper to find it elsewhere (a file it reads), as the README says.
 */
const CLAUDE_OWN = "^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_|AZURE_)";

/**
 * The names of the environment variables a chat session must not inherit: the bot tokens the
 * config names (`loopstra chat` has them in its environment), and anything else that looks like a
 * secret by name. Everything else (PATH, HOME, the editor's settings) is passed on as usual. On
 * Windows a variable's name is the same whatever its case, so there both the config's names and
 * Claude Code's own are matched without it: `discord_bot` is the variable `DISCORD_BOT` names, and
 * `anthropic_api_key` is Claude Code's key.
 */
export function secretEnvNames(cfg: Config, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const anyCase = platform === "win32";
  const same = (a: string, b: string) => (anyCase ? a.toUpperCase() === b.toUpperCase() : a === b);
  const claudeOwn = new RegExp(CLAUDE_OWN, anyCase ? "i" : "");
  const named = [cfg.chat.transports.slack?.token_env, cfg.chat.transports.slack?.bot_token_env, cfg.chat.transports.discord?.token_env].filter((n): n is string => !!n);
  const keys = Object.keys(env);
  const namedHere = keys.filter((k) => named.some((n) => same(k, n)));
  const looksSecret = keys.filter((k) => SECRET_NAME.test(k) && !claudeOwn.test(k));
  return [...new Set([...named, ...namedHere, ...looksSecret])];
}

type ChatAgentResult<T> =
  | { ok: true; value: T; sessionId: string | null; costUsd: number }
  | { ok: false; reason: FailureReason; detail: string; sessionId: string | null; costUsd: number;
      /** Why no session started: the day's budget is spent ("today"), or what is left is held by sessions still running ("held"). */
      budgetUsedUp?: "today" | "held" };

interface ChatAgentInput<T> {
  root: string;
  cfg: Config;
  trace: Trace;
  name: ChatPhase;
  prompt: string;
  schema: z.ZodType<T>;
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
  const ref = stepModel(o.cfg, o.name);
  const out = await tracedSession({
    trace: o.trace, slug: CHAT_SLUG, seq: held.seq, capUsd: held.heldUsd, ref,
    dir: join(runDir(o.root, CHAT_SLUG), "phases", `${held.seq}-${o.name}`),
    run: {
      cwd: o.root,
      prompt: o.prompt,
      schema: jsonSchemaOf(o.schema),
      // Its step's model (see stepModel): chat loads the config for every message, so a change applies on the next turn.
      model: modelFor(o.cfg, ref),
      permissionMode: "default",
      allowedTools: CHAT_TOOLS,
      disallowedTools: CHAT_DENIED,
      timeoutMs: o.cfg.claude.timeout_minutes * 60_000,
      maxBudgetUsd: held.heldUsd,
      resume: o.resume ?? undefined,
      // It runs in the main checkout: should git run there anyway (git itself is denied, see CHAT_DENIED),
      // it skips the index refresh `git status` writes, so it never holds the lock the loop commits records with.
      env: { LOOPSTRA_PHASE: o.name, LOOPSTRA_SLUG: CHAT_SLUG, GIT_OPTIONAL_LOCKS: "0" },
      // The bot tokens and anything else secret stay out of a session that takes instructions from a chat channel.
      dropEnv: secretEnvNames(o.cfg),
    },
    read: (output) => {
      const parsed = o.schema.safeParse(output);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "invalid-envelope", detail: issuesText(parsed.error.issues) };
    },
  });
  return out.ok
    ? { ok: true, value: out.value, sessionId: out.sessionId, costUsd: out.costUsd }
    : { ok: false, reason: out.reason, detail: out.detail, sessionId: out.sessionId, costUsd: out.costUsd };
}

/** What chat has spent since local midnight, in sessions that have ended (not what running ones hold). */
export function chatSpentToday(trace: Trace, now = new Date()): number {
  return trace.costSince(CHAT_SLUG, startOfToday(now), { endedOnly: true });
}
