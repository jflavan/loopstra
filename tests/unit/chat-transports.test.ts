import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { ChatService } from "../../src/chat/service";
import { chatDir, writeJson } from "../../src/chat/threads";
import { configPath } from "../../src/config";
import { DashboardTransport } from "../../src/chat/transports/dashboard";
import { DISCORD_INTENTS, DiscordTransport } from "../../src/chat/transports/discord";
import { chunkText } from "../../src/chat/transports/shared";
import { SlackTransport } from "../../src/chat/transports/slack";
import { TerminalTransport } from "../../src/chat/transports/terminal";
import { Hub } from "../../src/console/hub";
import { serveConsole } from "../../src/console/server";
import { chatRepo, turn } from "../chat-helpers";
import { model, sseFrames } from "../console-helpers";

/** A bot's section of loopstra/config.yaml, as YAML under chat.transports. */
const SLACK = (allow: string[], acceptors: string[], more = "") =>
  `chat:\n  transports:\n    slack:\n      token_env: APP\n      bot_token_env: BOT\n      channel: C1\n      allow: ${JSON.stringify(allow)}\n      acceptors: ${JSON.stringify(acceptors)}\n${more}`;
const DISCORD = (allow: string[], acceptors: string[], more = "") =>
  `chat:\n  transports:\n    discord:\n      token_env: TOKEN\n      channel: "500"\n      allow: ${JSON.stringify(allow)}\n      acceptors: ${JSON.stringify(acceptors)}\n${more}`;

/** Rewrites a chat repository's config with `chat` after its commands (see chatRepo). */
function setChat(root: string, chat: string): Promise<number> {
  return Bun.write(configPath(root), `version: 1\ncommands:\n  test: echo ok\n${chat}`);
}

/** Waits until `check` holds (or fails after a few seconds). */
async function until(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

describe("chunkText", () => {
  test("splits long messages at line breaks, then spaces", () => {
    expect(chunkText("short", 10)).toEqual(["short"]);
    expect(chunkText("aaaa bbbb\ncccc dddd", 12)).toEqual(["aaaa bbbb", "cccc dddd"]);
    expect(chunkText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("the terminal", () => {
  test("reads a line, answers it, prints announcements, and ends with the input", async () => {
    const r = await chatRepo();
    try {
      await r.answer("orchestrator", 1, turn("All quiet.\nNothing needs you."));
      const input = new PassThrough();
      const output = new PassThrough();
      let printed = "";
      output.on("data", (d) => { printed += String(d); });
      const term = new TerminalTransport({ input, output, user: "ana" });
      const service = new ChatService(r.root, [term], { announce: false, pollMs: 60_000 });
      await service.start();
      input.write("how are things?\n");
      await until(() => printed.includes("Nothing needs you."));
      expect(printed).toContain("loopstra> All quiet.\n          Nothing needs you.");
      await term.announce("Blocked: x.");
      expect(printed).toContain("[loopstra] Blocked: x.");
      input.end();
      await term.closed;
      await service.stop();
      const t = service.orchestrator.store.get("terminal", "local");
      expect(t.messages.map((m) => [m.from, m.author ?? null])).toEqual([["person", "ana"], ["loopstra", null]]);
    } finally { r.cleanup(); }
  });
});

describe("the dashboard panel", () => {
  test("posts need the page's own origin; the reply is read back from the thread", async () => {
    const r = await chatRepo();
    const dash = new DashboardTransport(r.root, "ana");
    const service = new ChatService(r.root, [dash], { announce: false, pollMs: 60_000 });
    await service.start();
    const hub = new Hub(r.root, { chat: true });
    const server = serveConsole(r.root, 0, { chat: dash, hub });
    try {
      await r.answer("orchestrator", 1, turn("Hello from Loopstra."));
      const base = `http://127.0.0.1:${server.port}`;
      const post = (body: unknown, headers: Record<string, string> = { origin: base, "content-type": "application/json" }) =>
        fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
      const thread = "tab-abcdefgh";
      expect((await post({ thread, text: "hi" }, { "content-type": "application/json" })).status).toBe(403);
      expect((await post({ thread, text: "hi" }, { origin: "http://evil.test", "content-type": "application/json" })).status).toBe(403);
      expect((await post({ thread, text: "hi" }, { origin: base, "content-type": "text/plain" })).status).toBe(415);
      expect((await post({ thread: "../x", text: "hi" })).status).toBe(400);
      expect((await post({ thread, text: "hi" })).status).toBe(202);
      // While it answers, a second message is refused rather than queued behind it.
      const second = await post({ thread, text: "again" });
      expect([202, 409]).toContain(second.status);
      await until(async () => {
        const j = await (await fetch(`${base}/api/chat?thread=${thread}&after=0`)).json() as { messages: Array<{ text: string }>; busy: boolean };
        return !j.busy && j.messages.some((m) => m.text === "Hello from Loopstra.");
      });
      const page = await (await fetch(`${base}/api/chat?thread=${thread}&after=1&announcementsAfter=-1`)).json() as { messages: Array<{ id: number; from: string }>; lastAnnouncementId: number; announcements: unknown[] };
      expect(page.messages[0]).toMatchObject({ id: 2, from: "loopstra" });
      expect(page.announcements).toEqual([]);
      expect((await fetch(`${base}/api/chat?thread=bad`)).status).toBe(400);
      // A page on another host name that resolves here (DNS rebinding) gets nothing.
      expect((await fetch(`${base}/api/chat?thread=${thread}`, { headers: { host: "evil.test" } })).status).toBe(403);
      // Everything else stays read-only, and the page is told it has chat.
      expect((await fetch(`${base}/api/spend`, { method: "POST" })).status).toBe(405);
      const [first] = await sseFrames(`${base}/api/stream`, 1);
      expect(first!.data).toMatchObject({ type: "snapshot", meta: { chat: true } });
    } finally {
      server.stop(true);
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      await service.stop();
      r.cleanup();
    }
  });

  test("a post's about is passed on; a bad one is dropped, not refused", async () => {
    const r = await chatRepo();
    try {
      const dash = new DashboardTransport(r.root, "ana");
      const got: unknown[] = [];
      await dash.start(async (m) => { got.push(m.about ?? null); });
      const base = "http://127.0.0.1:4000";
      const post = (thread: string, about: unknown) => dash.handle(
        new Request(`${base}/api/chat`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ thread, text: "what is wrong?", about }) }),
        new URL(`${base}/api/chat`),
      );
      const abouts: unknown[] = [{ slug: "csv-export", seq: 3 }, { slug: "csv-export" }, { slug: "Not A Slug" }, { slug: "csv-export", seq: "3" }, { slug: "csv-export", seq: 0 }, "csv-export"];
      for (const [i, about] of abouts.entries()) expect((await post(`tab-abcdefg${i}`, about)).status).toBe(202);
      await until(() => got.length === abouts.length);
      expect(got).toEqual([{ slug: "csv-export", seq: 3 }, { slug: "csv-export" }, null, null, null, null]);
    } finally { r.cleanup(); }
  });

  test("without chat, /api/chat is not there and the totals include what chat spent", async () => {
    const r = await chatRepo();
    try {
      await r.answer("orchestrator", 1, turn("hi"), { cost: 0.25 });
      const { Orchestrator } = await import("../../src/chat/orchestrator");
      await new Orchestrator(r.root).handle({ transport: "terminal", via: "t", thread: "l", authorId: "a", authorName: "a", text: "hi", canAccept: true, acceptors: "you" }, async () => {});
      const m = await model(r.root);
      expect(m.meta.chat).toBe(false);
      expect(m.sections.totals.todayUsd).toBeCloseTo(0.25);
      const server = serveConsole(r.root, 0);
      try {
        expect((await fetch(`http://127.0.0.1:${server.port}/api/chat?thread=tab-abcdefgh`)).status).toBe(404);
      } finally { server.stop(true); }
    } finally { r.cleanup(); }
  });
});

/** A stub Slack: the Web API methods Loopstra calls, and a Socket Mode websocket. */
function slackStub() {
  const calls: Array<{ method: string; body: Record<string, unknown>; auth: string }> = [];
  const acks: string[] = [];
  let socket: { send: (s: string) => void } | null = null;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === "/socket") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      const method = url.pathname.replace("/api/", "");
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      calls.push({ method, body, auth: req.headers.get("authorization") ?? "" });
      if (method === "apps.connections.open") return Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}/socket` });
      if (method === "auth.test") return Response.json({ ok: true, user_id: "UBOT" });
      if (method === "users.info") return Response.json({ ok: true, user: { real_name: body.user === "U1" ? "Ana Real" : "Someone", profile: { display_name: body.user === "U1" ? "ana" : "" } } });
      if (method === "chat.postMessage") return Response.json({ ok: true, ts: "9.9" });
      return Response.json({ ok: false, error: "unknown_method" });
    },
    websocket: {
      open(ws) { socket = ws; ws.send(JSON.stringify({ type: "hello" })); },
      message(_ws, data) { acks.push(JSON.parse(String(data)).envelope_id); },
    },
  });
  const event = (id: string, ev: Record<string, unknown>) => socket!.send(JSON.stringify({ envelope_id: id, type: "events_api", payload: { event: ev } }));
  return { server, calls, acks, event, connected: () => socket !== null };
}

describe("Slack", () => {
  test("acknowledges events, answers people in the channel in a thread, ignores everyone else, and announces", async () => {
    const r = await chatRepo({ config: SLACK(["U1", "U2"], ["U1"], "      announce_to: C9\n") });
    const stub = slackStub();
    const env = { LOOPSTRA_SLACK_API: `http://127.0.0.1:${stub.server.port}/api`, APP: "xapp-1", BOT: "xoxb-1" };
    const slack = new SlackTransport({ token_env: "APP", bot_token_env: "BOT", channel: "C1", allow: ["U1", "U2"], acceptors: ["U1"], announce_to: "C9" }, { root: r.root, env, log: () => {} });
    const service = new ChatService(r.root, [slack], { announce: false, pollMs: 60_000 });
    try {
      await r.answer("orchestrator", 1, turn("Hi Ana."));
      await r.answer("orchestrator", 2, turn("Still here."));
      await service.start();
      await until(() => stub.connected());
      expect(stub.calls.find((c) => c.method === "apps.connections.open")!.auth).toBe("Bearer xapp-1");
      stub.event("e1", { type: "message", user: "U1", channel: "C1", text: "<@UBOT> hello", ts: "1.0" });
      // The same message as a mention, a bot, another channel, someone not allowed, an edit: none of these.
      stub.event("e2", { type: "app_mention", user: "U1", channel: "C1", text: "<@UBOT> hello", ts: "1.0" });
      stub.event("e3", { type: "message", bot_id: "B1", user: "U9", channel: "C1", text: "bot", ts: "2.0" });
      stub.event("e4", { type: "message", user: "U1", channel: "C2", text: "elsewhere", ts: "3.0" });
      stub.event("e5", { type: "message", user: "U3", channel: "C1", text: "not allowed", ts: "4.0" });
      stub.event("e6", { type: "message", subtype: "message_changed", user: "U1", channel: "C1", text: "edit", ts: "5.0" });
      await until(() => stub.calls.some((c) => c.method === "chat.postMessage"));
      stub.event("e7", { type: "message", user: "U2", channel: "C1", text: "and me", ts: "6.0", thread_ts: "1.0" });
      await until(() => stub.calls.filter((c) => c.method === "chat.postMessage").length === 2);
      expect(stub.acks).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
      const posts = stub.calls.filter((c) => c.method === "chat.postMessage");
      expect(posts.map((p) => [p.body.channel, p.body.thread_ts, p.body.text, p.auth])).toEqual([
        ["C1", "1.0", "Hi Ana.", "Bearer xoxb-1"],
        ["C1", "1.0", "Still here.", "Bearer xoxb-1"],
      ]);
      const ps = r.prompts();
      expect(ps.length).toBe(2);
      expect(ps[0]!.prompt).toContain("<message from=\"ana\">\nhello\n</message>");
      expect(ps[0]!.prompt).toContain("From: ana, who may ask you to start drafts and to act on changes");
      expect(ps[1]!.prompt).toContain("From: Someone, who may not start drafts or act on changes (<@U1> may)");
      expect(service.orchestrator.store.get("slack", "C1:1.0").messages.length).toBe(4);
      await slack.announce("Blocked: x.");
      expect(stub.calls.at(-1)!.body).toEqual({ channel: "C9", text: "Blocked: x." });
      // A long one is split like a reply, rather than refused by Slack.
      const before = stub.calls.length;
      await slack.announce(`Blocked: y. ${"word ".repeat(1000)}`);
      expect(stub.calls.slice(before).filter((c) => c.method === "chat.postMessage").length).toBe(2);
    } finally {
      await service.stop();
      stub.server.stop(true);
      r.cleanup();
    }
  });

  test("allow and acceptors are read from the config for each message; a bot taken out of it ignores messages", async () => {
    const r = await chatRepo({ config: SLACK(["U1"], []) });
    try {
      const logged: string[] = [];
      const slack = new SlackTransport({ token_env: "APP", bot_token_env: "BOT", channel: "C1", allow: ["U1"], acceptors: [] }, { root: r.root, env: { LOOPSTRA_SLACK_API: "http://127.0.0.1:9/none" }, log: (l) => logged.push(l) });
      const got: Array<[string, boolean]> = [];
      (slack as unknown as { onMessage: unknown }).onMessage = async (m: { authorId: string; canAccept: boolean }) => { got.push([m.authorId, m.canAccept]); };
      let ts = 0;
      const say = (user: string) => slack.onEvent({ type: "message", user, channel: "C1", text: "hi", ts: String(++ts) });
      await setChat(r.root, SLACK(["U2"], ["U2"]));
      await say("U1");
      await say("U2");
      expect(got).toEqual([["U2", true]]);
      await setChat(r.root, "");
      await say("U2");
      await say("U2");
      expect(got).toEqual([["U2", true]]);
      expect(logged).toEqual(["Slack: chat.transports.slack is no longer in loopstra/config.yaml, so messages to this bot are ignored. Put it back, or stop loopstra chat."]);
    } finally { r.cleanup(); }
  });

  test("the config is read only for a person's message in the bot's channel", async () => {
    const r = await chatRepo({ config: SLACK([], []) });
    try {
      const logged: string[] = [];
      const slack = new SlackTransport({ token_env: "APP", bot_token_env: "BOT", channel: "C1", allow: [], acceptors: [] }, { root: r.root, env: { LOOPSTRA_SLACK_API: "http://127.0.0.1:9/none" }, log: (l) => logged.push(l) });
      (slack as unknown as { onMessage: unknown }).onMessage = async () => {};
      // Taken out of the config: a read of it says so in the log.
      await setChat(r.root, "");
      await slack.onEvent({ type: "message", user: "U1", channel: "C2", text: "elsewhere", ts: "1" });
      await slack.onEvent({ type: "message", bot_id: "B1", user: "U9", channel: "C1", text: "a bot", ts: "2" });
      await slack.onEvent({ type: "reaction_added", user: "U1", channel: "C1", ts: "3" });
      expect(logged).toEqual([]);
      await slack.onEvent({ type: "message", user: "U1", channel: "C1", text: "hi", ts: "4" });
      expect(logged).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test("a missing token is a plain error at start", async () => {
    const slack = new SlackTransport({ token_env: "NOPE_APP", bot_token_env: "NOPE_BOT", channel: "C1", allow: [], acceptors: [] }, { root: ".", env: {} });
    await expect(slack.start(async () => {})).rejects.toThrow("Slack needs its app-level token in the environment variable NOPE_APP.");
  });
});

/**
 * A stub Discord: the REST calls Loopstra makes, and a gateway that says hello and checks identify.
 * `closeOnIdentify`: the gateway closes with this code instead of answering READY.
 */
function discordStub(closeOnIdentify?: number) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string }> = [];
  const frames: Array<{ op: number; d: unknown }> = [];
  let socket: { send: (s: string) => void; close: (code?: number) => void } | null = null;
  let threadN = 100;
  /** What GET /gateway/bot answers: 200, or 401 for a token Discord does not accept. */
  let gatewayStatus = 200;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/gw")) return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      const body = req.method === "POST" ? await req.json().catch(() => null) as Record<string, unknown> | null : null;
      const path = url.pathname.replace("/api", "");
      calls.push({ method: req.method, path, body, auth: req.headers.get("authorization") ?? "" });
      if (path === "/gateway/bot") return gatewayStatus === 200 ? Response.json({ url: `ws://127.0.0.1:${server.port}/gw` }) : Response.json({ message: "401: Unauthorized", code: 0 }, { status: gatewayStatus });
      if (/\/threads$/.test(path)) return Response.json({ id: String(threadN++) });
      return Response.json({ id: "m" });
    },
    websocket: {
      open(ws) { socket = ws; ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })); },
      message(ws, data) {
        const f = JSON.parse(String(data));
        frames.push(f);
        if (f.op === 2 && closeOnIdentify) ws.close(closeOnIdentify, "closed by the stub");
        else if (f.op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "42" } } }));
      },
    },
  });
  const message = (d: Record<string, unknown>) => socket!.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d }));
  return {
    server, calls, frames, message, ready: () => frames.some((f) => f.op === 2), identifies: () => frames.filter((f) => f.op === 2).length,
    /** From now on the token is refused: GET /gateway/bot answers `status`. */
    refuseToken: (status = 401) => { gatewayStatus = status; },
    /** The gateway drops the connection, as it does now and then. */
    drop: () => socket!.close(4000),
    gatewayLooks: () => calls.filter((c) => c.path === "/gateway/bot").length,
  };
}

/** A Discord transport on `stub`, started; its log lines are kept. */
async function startDiscord(stub: ReturnType<typeof discordStub>, root: string) {
  const logged: string[] = [];
  const env = { LOOPSTRA_DISCORD_API: `http://127.0.0.1:${stub.server.port}/api`, TOKEN: "t-1" };
  const discord = new DiscordTransport({ token_env: "TOKEN", channel: "500", allow: [], acceptors: [] }, { root, env, log: (l) => logged.push(l) });
  await discord.start(async () => {});
  return { discord, logged };
}

describe("Discord", () => {
  test("identifies with the message intents, gives each new request a thread, and carries on in it", async () => {
    const r = await chatRepo({ config: DISCORD([], ["7"], "      announce_to: \"501\"\n") });
    const stub = discordStub();
    const env = { LOOPSTRA_DISCORD_API: `http://127.0.0.1:${stub.server.port}/api`, TOKEN: "t-1" };
    const discord = new DiscordTransport({ token_env: "TOKEN", channel: "500", allow: [], acceptors: ["7"], announce_to: "501" }, { root: r.root, env, log: () => {} });
    const service = new ChatService(r.root, [discord], { announce: false, pollMs: 60_000 });
    try {
      await r.answer("orchestrator", 1, turn("Hi."));
      await r.answer("orchestrator", 2, turn("Go on."));
      await service.start();
      await until(() => stub.ready());
      const identify = stub.frames.find((f) => f.op === 2)!.d as { token: string; intents: number };
      expect(identify).toMatchObject({ token: "t-1", intents: DISCORD_INTENTS });
      stub.message({ id: "m1", channel_id: "500", content: "<@42> I want CSV export", author: { id: "7", username: "ana" } });
      stub.message({ id: "m2", channel_id: "500", content: "a bot", author: { id: "8", username: "b", bot: true } });
      stub.message({ id: "m3", channel_id: "999", content: "not ours", author: { id: "7", username: "ana" } });
      await until(() => stub.calls.some((c) => c.path === "/channels/100/messages"));
      stub.message({ id: "m4", channel_id: "100", content: "<@42> with dates please, and tell <@7>", author: { id: "9", username: "bo", global_name: "Bo" } });
      await until(() => stub.calls.filter((c) => c.path === "/channels/100/messages").length === 2);
      expect(stub.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body?.name ?? c.body?.content])).toEqual([
        ["/channels/500/messages/m1/threads", "I want CSV export"],
        ["/channels/100/messages", "Hi."],
        ["/channels/100/messages", "Go on."],
      ]);
      expect(stub.calls[0]!.auth).toBe("Bot t-1");
      const ps = r.prompts();
      expect(ps[0]!.prompt).toContain("From: ana, who may ask you to start drafts and to act on changes");
      expect(ps[1]!.prompt).toContain("From: Bo, who may not start drafts or act on changes (<@7> may)");
      // Only the bot's own mention is taken out; someone else's is part of what was asked.
      expect(ps[1]!.prompt).toContain("with dates please, and tell <@7>\n</message>");
      // The thread is remembered, so a restarted bot carries on in it.
      const again = new DiscordTransport({ token_env: "TOKEN", channel: "500", allow: [], acceptors: [], announce_to: "501" }, { root: r.root, env, log: () => {} });
      let got = null as string | null;
      (again as unknown as { onMessage: unknown }).onMessage = async (m: { thread: string }) => { got = m.thread; };
      await again.onDiscordMessage({ id: "m5", channel_id: "100", content: "still me", author: { id: "7" } });
      expect(got).toBe("100");
      await discord.announce("Merged: x.");
      expect(stub.calls.at(-1)).toMatchObject({ path: "/channels/501/messages", body: { content: "Merged: x." } });
    } finally {
      await service.stop();
      stub.server.stop(true);
      r.cleanup();
    }
  });

  test("a gateway that closes before READY is tried again less and less often", async () => {
    const r = await chatRepo();
    const stub = discordStub(4000);
    const { discord } = await startDiscord(stub, r.root);
    try {
      // Tries at 0, 1 and 3 seconds, not every second.
      await Bun.sleep(2_500);
      expect(stub.identifies()).toBe(2);
    } finally {
      await discord.stop();
      stub.server.stop(true);
      r.cleanup();
    }
  });

  test("a refusal a retry cannot fix says what to do, once, and is tried again only every 5 minutes", async () => {
    const r = await chatRepo();
    const stub = discordStub(4014);
    const { discord, logged } = await startDiscord(stub, r.root);
    try {
      await until(() => logged.length > 0);
      await Bun.sleep(1_500);
      expect(stub.identifies()).toBe(1);
      expect(logged).toEqual(["Discord refused the bot (4014): the Message Content intent is off. Turn it on for the bot in the Discord Developer Portal (Bot, Privileged Gateway Intents). Trying again every 5 minutes."]);
    } finally {
      await discord.stop();
      stub.server.stop(true);
      r.cleanup();
    }
  });

  test("a token Discord refuses at start is a plain error naming its variable", async () => {
    const r = await chatRepo();
    const stub = discordStub();
    stub.refuseToken();
    try {
      await expect(startDiscord(stub, r.root)).rejects.toThrow(/^Discord refused the bot \(HTTP 401\): the bot token was not accepted\. Check the token in TOKEN\.$/);
    } finally {
      stub.server.stop(true);
      r.cleanup();
    }
  });

  test("a token revoked while the bot runs says what to fix, once, and is tried again only every 5 minutes", async () => {
    const r = await chatRepo();
    const stub = discordStub();
    const { discord, logged } = await startDiscord(stub, r.root);
    try {
      await until(() => stub.ready());
      await Bun.sleep(200);
      stub.refuseToken(403);
      stub.drop();
      // The first try is a second after the drop; without the slow wait, more would follow at 3 seconds.
      await Bun.sleep(3_500);
      expect(stub.gatewayLooks()).toBe(2);
      expect(logged).toEqual(["Discord refused the bot (HTTP 403): the bot token was not accepted. Check the token in TOKEN. Trying again every 5 minutes."]);
    } finally {
      await discord.stop();
      stub.server.stop(true);
      r.cleanup();
    }
  });

  test("the allow list is checked before anything is done", async () => {
    const r = await chatRepo({ config: DISCORD(["1"], []) });
    try {
      const discord = new DiscordTransport({ token_env: "T", channel: "500", allow: ["1"], acceptors: [] }, { root: r.root, env: { LOOPSTRA_DISCORD_API: "http://127.0.0.1:9/none" }, log: () => {} });
      let called = false;
      (discord as unknown as { onMessage: unknown }).onMessage = async () => { called = true; };
      await discord.onDiscordMessage({ id: "m", channel_id: "500", content: "hi", author: { id: "2" } });
      expect(called).toBe(false);
    } finally { r.cleanup(); }
  });

  test("allow and acceptors are read from the config for each message; a bot taken out of it ignores messages", async () => {
    const r = await chatRepo({ config: DISCORD(["1"], []) });
    try {
      const logged: string[] = [];
      const discord = new DiscordTransport({ token_env: "TOKEN", channel: "500", allow: ["1"], acceptors: [] }, { root: r.root, env: { LOOPSTRA_DISCORD_API: "http://127.0.0.1:9/none" }, log: (l) => logged.push(l) });
      const got: Array<[string, boolean]> = [];
      (discord as unknown as { onMessage: unknown }).onMessage = async (m: { authorId: string; canAccept: boolean }) => { got.push([m.authorId, m.canAccept]); };
      writeJson(join(chatDir(r.root), "discord-threads.json"), ["100"]);
      const say = (author: string) => discord.onDiscordMessage({ id: "m", channel_id: "100", content: "hi", author: { id: author } });
      await setChat(r.root, DISCORD(["2"], ["2"]));
      await say("1");
      await say("2");
      expect(got).toEqual([["2", true]]);
      await setChat(r.root, "");
      await say("2");
      await say("2");
      expect(got).toEqual([["2", true]]);
      expect(logged).toEqual(["Discord: chat.transports.discord is no longer in loopstra/config.yaml, so messages to this bot are ignored. Put it back, or stop loopstra chat."]);
    } finally { r.cleanup(); }
  });

  test("the config is read only for a person's message in the bot's channel or threads", async () => {
    const r = await chatRepo({ config: DISCORD([], []) });
    try {
      const logged: string[] = [];
      const discord = new DiscordTransport({ token_env: "TOKEN", channel: "500", allow: [], acceptors: [] }, { root: r.root, env: { LOOPSTRA_DISCORD_API: "http://127.0.0.1:9/none" }, log: (l) => logged.push(l) });
      (discord as unknown as { onMessage: unknown }).onMessage = async () => {};
      writeJson(join(chatDir(r.root), "discord-threads.json"), ["100"]);
      // Taken out of the config: a read of it says so in the log.
      await setChat(r.root, "");
      await discord.onDiscordMessage({ id: "m1", channel_id: "999", content: "elsewhere", author: { id: "1" } });
      await discord.onDiscordMessage({ id: "m2", channel_id: "500", content: "a bot", author: { id: "8", bot: true } });
      expect(logged).toEqual([]);
      await discord.onDiscordMessage({ id: "m3", channel_id: "100", content: "hi", author: { id: "1" } });
      expect(logged).toHaveLength(1);
    } finally { r.cleanup(); }
  });
});
