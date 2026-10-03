import { DISCORD_API_ENV } from "../../chat/transports/discord";
import { SLACK_API_ENV } from "../../chat/transports/slack";
import { errorText } from "../../shell";
import type { Check, Section, SetupContext } from "../types";

const PLACES = ["terminal", "dashboard", "slack", "discord"] as const;
const BOTS = ["slack", "discord"] as const;
type Bot = (typeof BOTS)[number];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envName = (s: string) => (ENV_NAME.test(s) ? null : "Answer the name of an environment variable, like LOOPSTRA_SLACK_BOT_TOKEN, not the token itself.");

/** Each bot's token variables: [key, question, default]. */
const TOKENS: Record<Bot, [string, string, string][]> = {
  slack: [
    ["token_env", "Variable that holds the app-level token (xapp-...)", "LOOPSTRA_SLACK_APP_TOKEN"],
    ["bot_token_env", "Variable that holds the bot token (xoxb-...)", "LOOPSTRA_SLACK_BOT_TOKEN"],
  ],
  discord: [["token_env", "Variable that holds the bot token", "LOOPSTRA_DISCORD_TOKEN"]],
};

const LABEL: Record<Bot, string> = { slack: "Slack", discord: "Discord" };

/** Asks one bot's settings. Ids are kept as strings, so long numeric ones (Discord's) stay exact. */
async function askBot(ctx: SetupContext, bot: Bot): Promise<void> {
  const at = (k: string) => ["chat", "transports", bot, k];
  const str = (k: string) => { const v = ctx.doc.get(at(k)); return v === undefined || v === null ? undefined : String(v); };
  const ids = (k: string) => { const v = ctx.doc.get(at(k)); return Array.isArray(v) && v.length ? v.map(String).join(", ") : undefined; };
  ctx.ask.say(`${LABEL[bot]}: the config holds only the names of the environment variables with the tokens, never the tokens.`);
  for (const [k, question, fallback] of TOKENS[bot]) {
    ctx.doc.put(at(k), await ctx.ask.text(question, { suggestion: str(k) ?? fallback, check: envName }), fallback);
  }
  ctx.doc.set(at("channel"), await ctx.ask.text(`${LABEL[bot]} channel id where people talk to it`, { suggestion: str("channel") }));
  const lists: [string, string][] = [
    ["allow", "User ids who may chat, separated by commas (- for anyone in the channel)"],
    ["acceptors", "User ids who may also start drafts, separated by commas (- for nobody)"],
  ];
  for (const [k, question] of lists) {
    const list = (await ctx.ask.text(question, { suggestion: ids(k), optional: true })).split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) ctx.doc.set(at(k), list);
    else ctx.doc.clear(at(k));
  }
  const announce = await ctx.ask.text("Channel id where blocked, waiting and merged changes are announced (- for none)", { suggestion: str("announce_to"), optional: true });
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
      checks.push(missing.length
        ? { level: "fail", text: `Slack: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.` }
        : await slackSignIn(ctx.env, ctx.env[slack.bot_token_env]!));
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
    return j.ok
      ? { level: "ok", text: `Slack: signed in as ${j.user ?? "the bot"}${j.team ? ` in ${j.team}` : ""}.` }
      : { level: "fail", text: `Slack: the bot token was refused (${j.error ?? `HTTP ${res.status}`}).` };
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
    if (!res.ok) return { level: "fail", text: `Discord: the bot token was refused (HTTP ${res.status}).` };
    const j = await res.json().catch(() => ({})) as { username?: string };
    return { level: "ok", text: `Discord: signed in as ${j.username ?? "the bot"}.` };
  } catch (e) {
    return { level: "fail", text: `Discord could not be reached: ${errorText(e)}` };
  }
}
