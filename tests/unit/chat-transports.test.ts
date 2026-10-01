import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { ChatService } from "../../src/chat/service";
import { DashboardTransport } from "../../src/chat/transports/dashboard";
import { DISCORD_INTENTS, DiscordTransport } from "../../src/chat/transports/discord";
import { chunkText } from "../../src/chat/transports/shared";
import { SlackTransport } from "../../src/chat/transports/slack";
import { TerminalTransport } from "../../src/chat/transports/terminal";
import { buildState, serveUi } from "../../src/commands/ui";
import { chatRepo, turn } from "../chat-helpers";

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
    const server = serveUi(r.root, 0, { chat: dash });
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
      // Everything else stays read-only, and the page is told it has a chat panel.
      expect((await fetch(`${base}/api/state`, { method: "POST" })).status).toBe(405);
      expect((await (await fetch(`${base}/api/state`)).json() as { chat: boolean }).chat).toBe(true);
      expect(await (await fetch(`${base}/`)).text()).toContain('id="chat-section"');
    } finally {
      server.stop(true);
      await service.stop();
      r.cleanup();
    }
  });

  test("without chat, /api/chat is not there and the totals include what chat spent", async () => {
    const r = await chatRepo();
    try {
      await r.answer("orchestrator", 1, turn("hi"), { cost: 0.25 });
      const { Orchestrator } = await import("../../src/chat/orchestrator");
      await new Orchestrator(r.root).handle({ transport: "terminal", via: "t", thread: "l", authorId: "a", authorName: "a", text: "hi", canAccept: true, acceptors: "you" }, async () => {});
      const state = await buildState(r.root, 0);
      expect(state.chat).toBe(false);
      expect(state.totals.todayUsd).toBeCloseTo(0.25);
      const server = serveUi(r.root, 0);
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
    const r = await chatRepo();
    const stub = slackStub();
    const env = { LOOPSTRA_SLACK_API: `http://127.0.0.1:${stub.server.port}/api`, APP: "xapp-1", BOT: "xoxb-1" };
    const slack = new SlackTransport({ token_env: "APP", bot_token_env: "BOT", channel: "C1", allow: ["U1", "U2"], acceptors: ["U1"], announce_to: "C9" }, { env, log: () => {} });
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
      expect(ps[0]!.prompt).toContain("From: ana, who may ask you to start drafts");
      expect(ps[1]!.prompt).toContain("From: Someone, who may not start drafts (<@U1> may)");
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

  test("a missing token is a plain error at start", async () => {
    const slack = new SlackTransport({ token_env: "NOPE_APP", bot_token_env: "NOPE_BOT", channel: "C1", allow: [], acceptors: [] }, { env: {} });
    await expect(slack.start(async () => {})).rejects.toThrow("Slack needs its app-level token in the environment variable NOPE_APP.");
  });
});

/** A stub Discord: the REST calls Loopstra makes, and a gateway that says hello and checks identify. */
function discordStub() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string }> = [];
  const frames: Array<{ op: number; d: unknown }> = [];
  let socket: { send: (s: string) => void } | null = null;
  let threadN = 100;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/gw")) return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      const body = req.method === "POST" ? await req.json().catch(() => null) as Record<string, unknown> | null : null;
      const path = url.pathname.replace("/api", "");
      calls.push({ method: req.method, path, body, auth: req.headers.get("authorization") ?? "" });
      if (path === "/gateway/bot") return Response.json({ url: `ws://127.0.0.1:${server.port}/gw` });
      if (/\/threads$/.test(path)) return Response.json({ id: String(threadN++) });
      return Response.json({ id: "m" });
    },
    websocket: {
      open(ws) { socket = ws; ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })); },
      message(ws, data) {
        const f = JSON.parse(String(data));
        frames.push(f);
        if (f.op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { user: { id: "42" } } }));
      },
    },
  });
  const message = (d: Record<string, unknown>) => socket!.send(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d }));
  return { server, calls, frames, message, ready: () => frames.some((f) => f.op === 2) };
}

describe("Discord", () => {
  test("identifies with the message intents, gives each new request a thread, and carries on in it", async () => {
    const r = await chatRepo();
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
      expect(ps[0]!.prompt).toContain("From: ana, who may ask you to start drafts");
      expect(ps[1]!.prompt).toContain("From: Bo, who may not start drafts (<@7> may)");
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

  test("the allow list is checked before anything is done", async () => {
    const r = await chatRepo();
    try {
      const discord = new DiscordTransport({ token_env: "T", channel: "500", allow: ["1"], acceptors: [] }, { root: r.root, env: { LOOPSTRA_DISCORD_API: "http://127.0.0.1:9/none" }, log: () => {} });
      let called = false;
      (discord as unknown as { onMessage: unknown }).onMessage = async () => { called = true; };
      await discord.onDiscordMessage({ id: "m", channel_id: "500", content: "hi", author: { id: "2" } });
      expect(called).toBe(false);
    } finally { r.cleanup(); }
  });
});
