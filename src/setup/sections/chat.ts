import { DISCORD_API_ENV } from "../../chat/transports/discord";
import { SLACK_API_ENV } from "../../chat/transports/slack";
import { ENV_NAME } from "../../config";
import { errorText } from "../../shell";
import { DEFAULTS } from "../defaults";
import type { Check, Section, SetupContext } from "../types";

const PLACES = ["terminal", "dashboard", "slack", "discord"] as const;
const BOTS = ["slack", "discord"] as const;
type Bot = (typeof BOTS)[number];

const envName = (s: string) => (ENV_NAME.test(s) ? null : "Answer the name of an environment variable, like LOOPSTRA_SLACK_BOT_TOKEN, not the token itself.");

const { slack: SLACK, discord: DISCORD } = DEFAULTS.chat.transports;

/** Each bot's token variables: [key, question, default]. */
const TOKENS: Record<Bot, [string, string, string][]> = {
  slack: [
    ["token_env", "Variable that holds the app-level token (xapp-...)", SLACK!.token_env],
    ["bot_token_env", "Variable that holds the bot token (xoxb-...)", SLACK!.bot_token_env],
  ],
  discord: [["token_env", "Variable that holds the bot token", DISCORD!.token_env]],
};

const LABEL: Record<Bot, string> = { slack: "Slack", discord: "Discord" };

/** A problem with one channel or user id, in words, or null: Discord ids are numbers; Slack ids are not names. */
function idProblem(bot: Bot, kind: "channel" | "user", id: string): string | null {
  if (bot === "discord") return /^\d+$/.test(id) ? null : `Discord ids are numbers: turn on Developer Mode, then right-click the ${kind} and choose Copy ID.`;
  return /^[#@]/.test(id) || /\s/.test(id) ? `Use the ${kind} id (${kind === "channel" ? "C..." : "U..."}), not its name.` : null;
}

/** The first problem with any id in a comma-separated answer. */
const idList = (bot: Bot) => (answer: string) => answer.split(",").map((s) => s.trim()).filter(Boolean).map((id) => idProblem(bot, "user", id)).find(Boolean) ?? null;

/** Slack errors that mean the token itself was refused; any other is Slack having trouble. */
const SLACK_REFUSED = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked"]);
const LATER = "try loopstra setup --check again later.";

/** Asks one bot's settings. Ids are kept as strings, so long numeric ones (Discord's) stay exact. */
async function askBot(ctx: SetupContext, bot: Bot): Promise<void> {
  const at = (k: string) => ["chat", "transports", bot, k];
  const str = (k: string) => { const v = ctx.doc.get(at(k)); return v === undefined || v === null ? undefined : String(v); };
  const ids = (k: string) => { const v = ctx.doc.get(at(k)); return Array.isArray(v) && v.length ? v.map(String).join(", ") : undefined; };
  ctx.ask.say(`${LABEL[bot]}: the config holds only the names of the environment variables with the tokens, never the tokens.`);
  for (const [k, question, fallback] of TOKENS[bot]) {
    ctx.doc.put(at(k), await ctx.ask.text(question, { suggestion: str(k) ?? fallback, check: envName }), fallback);
  }
  const channel = (id: string) => idProblem(bot, "channel", id);
  ctx.doc.set(at("channel"), await ctx.ask.text(`${LABEL[bot]} channel id where people talk to it`, { suggestion: str("channel"), check: channel }));
  const lists: [string, string][] = [
    ["allow", "User ids who may chat, separated by commas (- for anyone in the channel)"],
    ["acceptors", "User ids who may also start drafts, separated by commas (- for nobody)"],
  ];
  for (const [k, question] of lists) {
    const list = (await ctx.ask.text(question, { suggestion: ids(k), optional: true, check: idList(bot) })).split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) ctx.doc.set(at(k), list);
    else ctx.doc.clear(at(k));
  }
  const announce = await ctx.ask.text("Channel id where blocked, waiting and merged changes are announced (- for none)", { suggestion: str("announce_to"), optional: true, check: channel });
  if (announce) ctx.doc.set(at("announce_to"), announce);
  else ctx.doc.clear(at("announce_to"));
}

export const chat: Section = {
  name: "chat",
  title: "Chat",

  async ask(ctx) {
    ctx.ask.say("People talk to the orchestrator to ask about the work and to agree new changes. The terminal and the dashboard need no settings; Slack and Discord bots do.");
    const configured = BOTS.filter((b) => ctx.doc.get(["chat", "transports", b]) !== undefined);
    const places = await ctx.ask.pickMany("Where will people talk to the orchestrator?", PLACES, ["terminal", "dashboard", ...configured]);
    if (places.includes("terminal")) ctx.ask.say("  Terminal: run loopstra chat.");
    if (places.includes("dashboard")) ctx.ask.say("  Dashboard: run loopstra ui and use its chat panel.");
    for (const bot of BOTS) {
      if (places.includes(bot)) await askBot(ctx, bot);
      else ctx.doc.clear(["chat", "transports", bot]);
    }
    if (places.some((p) => p === "slack" || p === "discord")) ctx.ask.say("  Start the bots with loopstra chat --no-terminal, where the token variables are set.");
  },

  async check(ctx, cfg) {
    const { slack, discord } = cfg.chat.transports;
    if (!slack && !discord) return [{ level: "ok", text: "Chat: the terminal and the dashboard only (no bots)." }];
    const checks: Check[] = [];
    if (slack) {
      const missing = [slack.token_env, slack.bot_token_env].filter((n) => !ctx.env[n]);
      if (missing.length) {
        checks.push({ level: "fail", text: `Slack: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.` });
      } else {
        // auth.test checks the bot token; the app-level one is only used to connect, so look at its shape.
        if (!ctx.env[slack.token_env]!.startsWith("xapp-")) checks.push({ level: "warn", text: `Slack: ${slack.token_env} does not look like an app-level token (xapp-...).` });
        checks.push(await slackSignIn(ctx.env, ctx.env[slack.bot_token_env]!));
      }
    }
    if (discord) {
      checks.push(ctx.env[discord.token_env]
        ? await discordSignIn(ctx.env, ctx.env[discord.token_env]!)
        : { level: "fail", text: `Discord: ${discord.token_env} is not set.` });
    }
    return checks;
  },
};

/** Slack's auth.test: whether Slack accepts the bot token, and as whom. */
async function slackSignIn(env: SetupContext["env"], token: string): Promise<Check> {
  try {
    const res = await fetch(`${env[SLACK_API_ENV] ?? "https://slack.com/api"}/auth.test`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; user?: string; team?: string; error?: string };
    if (j.ok) return { level: "ok", text: `Slack: signed in as ${j.user ?? "the bot"}${j.team ? ` in ${j.team}` : ""}.` };
    if (j.error && SLACK_REFUSED.has(j.error)) return { level: "fail", text: `Slack: the bot token was refused (${j.error}).` };
    return { level: "warn", text: `Slack answered ${j.error ?? `HTTP ${res.status}`}; ${LATER}` };
  } catch (e) {
    return { level: "fail", text: `Slack could not be reached: ${errorText(e)}` };
  }
}

/** Discord's GET /users/@me: whether Discord accepts the bot token, and as whom. */
async function discordSignIn(env: SetupContext["env"], token: string): Promise<Check> {
  try {
    const res = await fetch(`${env[DISCORD_API_ENV] ?? "https://discord.com/api/v10"}/users/@me`, {
      headers: { authorization: `Bot ${token}`, "user-agent": "DiscordBot (loopstra, 1)" }, signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { level: "fail", text: `Discord: the bot token was refused (HTTP ${res.status}).` };
    if (!res.ok) return { level: "warn", text: `Discord answered HTTP ${res.status}; ${LATER}` };
    const j = await res.json().catch(() => ({})) as { username?: string };
    return { level: "ok", text: `Discord: signed in as ${j.username ?? "the bot"}.` };
  } catch (e) {
    return { level: "fail", text: `Discord could not be reached: ${errorText(e)}` };
  }
}
