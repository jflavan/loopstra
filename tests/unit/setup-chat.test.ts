import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DISCORD_API_ENV } from "../../src/chat/transports/discord";
import { SLACK_API_ENV } from "../../src/chat/transports/slack";
import { configPath } from "../../src/config";
import { init } from "../../src/init";
import { chat } from "../../src/setup/sections/chat";
import { tempGitRepo } from "../helpers";
import { askSection, checkSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

// A Slack and Discord that accept the token "good" only, and ones having trouble.
let server: ReturnType<typeof Bun.serve>;
let deadPort = 0;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      const url = new URL(req.url);
      if (url.pathname === "/slack/auth.test") return Response.json(auth === "Bearer good" ? { ok: true, user: "loopstra", team: "Acme" } : { ok: false, error: "invalid_auth" });
      if (url.pathname === "/discord/users/@me") return auth === "Bot good" ? Response.json({ username: "loopstra" }) : new Response("401: Unauthorized", { status: 401 });
      if (url.pathname === "/slack-busy/auth.test") return Response.json({ ok: false, error: "ratelimited" }, { status: 429 });
      if (url.pathname === "/slack-down/auth.test") return new Response("<html>oops</html>", { status: 500 });
      if (url.pathname === "/discord-busy/users/@me") return new Response("slow down", { status: 429 });
      if (url.pathname === "/discord-forbidden/users/@me") return new Response("403: Forbidden", { status: 403 });
      return new Response("not found", { status: 404 });
    },
  });
  const dead = Bun.serve({ port: 0, fetch: () => new Response() });
  deadPort = dead.port!;
  dead.stop(true);
});
afterAll(() => server.stop(true));
const api = (slack = "slack", discord = "discord", port = server.port) => ({ [SLACK_API_ENV]: `http://127.0.0.1:${port}/${slack}`, [DISCORD_API_ENV]: `http://127.0.0.1:${port}/${discord}` });
const TOKENS = { LOOPSTRA_SLACK_APP_TOKEN: "xapp-1", LOOPSTRA_SLACK_BOT_TOKEN: "good", LOOPSTRA_DISCORD_TOKEN: "good" };

describe("the chat section", () => {
  test("only the bots chosen are asked about; one not chosen is removed", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    discord:\n      channel: "111"\n`);
    try {
      // Places; Slack: app token var, bot token var, channel, allow, acceptors, announce_to.
      const { text, shown } = await askSection(chat, r.root, ["terminal, slack", "", "", "C123", "U1, U2", "-", "C999"]);
      expect(parse(text).chat.transports).toEqual({ slack: { channel: "C123", allow: ["U1", "U2"], announce_to: "C999" } });
      expect(shown).toContain("Terminal: run loopstra chat.");
      expect(shown).not.toContain("Discord channel id");
    } finally { r.cleanup(); }
  });

  test("--defaults keeps the bots there are, as they are", async () => {
    const yaml = `${BASE}chat:\n  transports:\n    discord:\n      channel: "111"\n      acceptors: ["9"]\n`;
    const r = configRepo(yaml);
    try {
      expect((await askSection(chat, r.root, "defaults")).text).toBe(yaml);
    } finally { r.cleanup(); }
  });

  test("a token variable must be a variable name", async () => {
    const r = configRepo(BASE);
    try {
      const { shown } = await askSection(chat, r.root, ["discord", "xoxb-oops", "MY_TOKEN", "222", "", "", ""]);
      expect(shown).toContain("Answer the name of an environment variable");
    } finally { r.cleanup(); }
  });

  test("numeric ids stay quoted strings", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    discord:\n      channel: 111\n`);
    try {
      const { text } = await askSection(chat, r.root, ["discord", "", "1234567890123456789", "1234567890123456780, 42", "", "222"]);
      expect(parse(text).chat.transports.discord).toEqual({ channel: "1234567890123456789", allow: ["1234567890123456780", "42"], announce_to: "222" });
      expect(text).toContain('channel: "1234567890123456789"');
    } finally { r.cleanup(); }
  });

  test("adding a Slack bot to the config init writes keeps its comments", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      const { text } = await askSection(chat, repo.path, ["terminal, dashboard, slack", "", "", "C123", "-", "U1", "-"]);
      const model = before.match(/^ {2}model: default #.*\n/m)![0];
      expect(text).toBe(before.replace(model, `${model}  transports:\n    slack:\n      channel: C123\n      acceptors:\n        - U1\n`));
      // Leaving Slack out again gives back the file init wrote.
      expect((await askSection(chat, repo.path, ["terminal, dashboard"])).text).toBe(before);
    } finally { repo.cleanup(); }
  });

  test("checks: unset variables, a refused token, and a good one", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    slack:\n      channel: C1\n    discord:\n      channel: "1"\n`);
    try {
      const unset = await checkSection(chat, r.root, { ...api() });
      expect(unset).toEqual([
        { level: "fail", text: "Slack: LOOPSTRA_SLACK_APP_TOKEN and LOOPSTRA_SLACK_BOT_TOKEN are not set." },
        { level: "fail", text: "Discord: LOOPSTRA_DISCORD_TOKEN is not set." },
      ]);
      const bad = await checkSection(chat, r.root, { ...api(), ...TOKENS, LOOPSTRA_SLACK_BOT_TOKEN: "bad", LOOPSTRA_DISCORD_TOKEN: "bad" });
      expect(bad).toEqual([
        { level: "fail", text: "Slack: the bot token was refused (invalid_auth)." },
        { level: "fail", text: "Discord: the bot token was refused (HTTP 401)." },
      ]);
      const forbidden = await checkSection(chat, r.root, { ...api("slack", "discord-forbidden"), ...TOKENS });
      expect(forbidden[1]).toEqual({ level: "fail", text: "Discord: the bot token was refused (HTTP 403)." });
      const good = await checkSection(chat, r.root, { ...api(), ...TOKENS });
      expect(good).toEqual([{ level: "ok", text: "Slack: signed in as loopstra in Acme." }, { level: "ok", text: "Discord: signed in as loopstra." }]);
    } finally { r.cleanup(); }
  });

  test("checks: one unset variable, and an app token that does not look like one", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    slack:\n      channel: C1\n`);
    try {
      expect(await checkSection(chat, r.root, { ...api(), LOOPSTRA_SLACK_BOT_TOKEN: "good" })).toEqual([
        { level: "fail", text: "Slack: LOOPSTRA_SLACK_APP_TOKEN is not set." },
      ]);
      expect(await checkSection(chat, r.root, { ...api(), ...TOKENS, LOOPSTRA_SLACK_APP_TOKEN: "xoxb-swapped" })).toEqual([
        { level: "warn", text: "Slack: LOOPSTRA_SLACK_APP_TOKEN does not look like an app-level token (xapp-...)." },
        { level: "ok", text: "Slack: signed in as loopstra in Acme." },
      ]);
    } finally { r.cleanup(); }
  });

  test("checks: a platform having trouble is a warning; one that cannot be reached fails", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    slack:\n      channel: C1\n    discord:\n      channel: "1"\n`);
    try {
      expect(await checkSection(chat, r.root, { ...api("slack-busy", "discord-busy"), ...TOKENS })).toEqual([
        { level: "warn", text: "Slack answered ratelimited; try loopstra setup --check again later." },
        { level: "warn", text: "Discord answered HTTP 429; try loopstra setup --check again later." },
      ]);
      expect((await checkSection(chat, r.root, { ...api("slack-down"), ...TOKENS }))[0]).toEqual(
        { level: "warn", text: "Slack answered HTTP 500; try loopstra setup --check again later." },
      );
      const dead = await checkSection(chat, r.root, { ...api("slack", "discord", deadPort), ...TOKENS });
      expect(dead.map((c) => c.level)).toEqual(["fail", "fail"]);
      expect(dead[0]!.text).toStartWith("Slack could not be reached: ");
      expect(dead[1]!.text).toStartWith("Discord could not be reached: ");
    } finally { r.cleanup(); }
  });

  test("editing a bot: a custom token variable is the suggestion, and - clears a list", async () => {
    const r = configRepo(`${BASE}chat:\n  transports:\n    slack:\n      token_env: MY_APP_TOKEN\n      channel: C1\n      allow: [U1]\n`);
    try {
      // Places; app token var, bot token var, channel, allow, acceptors, announce_to.
      const { text, shown } = await askSection(chat, r.root, ["", "", "", "", "-", "", ""]);
      expect(shown).toContain("[terminal, dashboard, slack]");
      expect(shown).toContain("(xapp-...) [MY_APP_TOKEN]");
      expect(parse(text).chat.transports).toEqual({ slack: { token_env: "MY_APP_TOKEN", channel: "C1" } });
    } finally { r.cleanup(); }
  });

  test("ids are checked: Slack wants ids, not names; Discord ids are numbers", async () => {
    const r = configRepo(BASE);
    try {
      const slack = await askSection(chat, r.root, ["slack", "", "", "#general", "C1", "@ann", "U1", "-", "-"]);
      expect(slack.shown).toContain("Use the channel id (C...), not its name.");
      expect(slack.shown).toContain("Use the user id (U...), not its name.");
      expect(parse(slack.text).chat.transports.slack).toEqual({ channel: "C1", allow: ["U1"] });
      const discord = await askSection(chat, r.root, ["discord", "", "general", "123", "1, ann", "1", "-", "x", "456"]);
      expect(discord.shown).toContain("Discord ids are numbers: turn on Developer Mode, then right-click the channel and choose Copy ID.");
      expect(discord.shown).toContain("right-click the user and choose Copy ID.");
      expect(parse(discord.text).chat.transports.discord).toEqual({ channel: "123", allow: ["1"], announce_to: "456" });
    } finally { r.cleanup(); }
  });

  test("no bots: nothing to check", async () => {
    const r = configRepo(BASE);
    try {
      expect(await checkSection(chat, r.root)).toEqual([{ level: "ok", text: "Chat: the terminal and the dashboard only (no bots)." }]);
    } finally { r.cleanup(); }
  });
});
