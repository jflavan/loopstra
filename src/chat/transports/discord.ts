import { join } from "node:path";
import type { DiscordTransportConfig } from "../../config";
import type { OnMessage, Transport } from "../service";
import { chatDir, readJson, writeJson } from "../threads";
import { chunkText, mentionList, Reconnector } from "./shared";

/** The Discord REST API; tests point it at a stub server (which also hands out the gateway address). */
export const DISCORD_API_ENV = "LOOPSTRA_DISCORD_API";
const DISCORD_MAX = 1900;
/** GUILD_MESSAGES and MESSAGE_CONTENT (privileged: turn it on for the bot in the developer portal). */
export const DISCORD_INTENTS = (1 << 9) | (1 << 15);

interface DiscordMessage { id: string; channel_id: string; content?: string; author?: { id: string; username?: string; global_name?: string | null; bot?: boolean } }
interface GatewayFrame { op: number; d?: unknown; s?: number | null; t?: string | null }

/**
 * A bot in one Discord channel, over the gateway (an outbound websocket). Each top-level message in
 * the channel gets a thread of its own; messages in that thread continue the conversation. Needs a
 * bot token (in the environment variable the config names) with the Message Content intent on, and
 * permission to read, send messages, and create public threads in the channel.
 */
export class DiscordTransport implements Transport {
  readonly name = "discord";
  readonly via = "Discord";
  readonly announceFrom = "kept" as const;
  private readonly api: string;
  private token = "";
  private botUser = "";
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private onMessage: OnMessage | null = null;
  private readonly reconnect: Reconnector;
  private warnedEmpty = false;

  constructor(private readonly cfg: DiscordTransportConfig, private readonly opts: { root: string; env?: Record<string, string | undefined>; log?: (line: string) => void }) {
    this.api = (opts.env ?? process.env)[DISCORD_API_ENV] ?? "https://discord.com/api/v10";
    this.reconnect = new Reconnector(() => this.connect(), (e) => this.log(`Discord connection failed, retrying: ${e}`));
  }

  private log(line: string): void { (this.opts.log ?? ((l) => console.error(l)))(line); }

  /** Threads this bot started, kept across restarts so a conversation carries on. */
  private threadsPath(): string { return join(chatDir(this.opts.root), "discord-threads.json"); }
  private knownThreads(): string[] { return readJson<string[]>(this.threadsPath()) ?? []; }
  private remember(thread: string): void {
    const all = [...this.knownThreads().filter((t) => t !== thread), thread].slice(-1000);
    writeJson(this.threadsPath(), all);
  }

  /** One REST call, waiting out a rate limit once or twice. Throws on any other failure. */
  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.api}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, "content-type": "application/json", "user-agent": "DiscordBot (loopstra, 1)" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 2) {
        const j = await res.json().catch(() => ({})) as { retry_after?: number };
        await Bun.sleep(Math.min(30, j.retry_after ?? 1) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`Discord ${method} ${path} failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return await res.json().catch(() => ({})) as Record<string, unknown>;
    }
  }

  async start(onMessage: OnMessage): Promise<void> {
    this.token = (this.opts.env ?? process.env)[this.cfg.token_env] ?? "";
    if (!this.token) throw new Error(`Discord needs its bot token in the environment variable ${this.cfg.token_env}.`);
    this.onMessage = onMessage;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.onMessage) return;
    const gw = await this.call("GET", "/gateway/bot");
    const ws = new WebSocket(`${String(gw.url)}/?v=10&encoding=json`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("the gateway connection failed")), { once: true });
    });
    ws.addEventListener("message", (ev) => { this.onFrame(ws, String(ev.data)).catch((e) => this.log(`Discord message failed: ${e instanceof Error ? e.message : String(e)}`)); });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.stopBeat();
      if (this.onMessage) this.reconnect.schedule();
    });
    this.reconnect.succeeded();
  }

  private stopBeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  private async onFrame(ws: WebSocket, data: string): Promise<void> {
    let f: GatewayFrame;
    try { f = JSON.parse(data); } catch { return; }
    if (typeof f.s === "number") this.seq = f.s;
    switch (f.op) {
      case 10: { // hello: start the heartbeat, then identify
        const every = (f.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250;
        this.stopBeat();
        this.beat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: this.seq })); } catch { /* closing */ } }, every);
        ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "loopstra", device: "loopstra" } } }));
        return;
      }
      case 1: ws.send(JSON.stringify({ op: 1, d: this.seq })); return;
      case 7: case 9: ws.close(); return; // reconnect, or a session that is no longer valid: start over
      case 0:
        if (f.t === "READY") this.botUser = String((f.d as { user?: { id?: string } })?.user?.id ?? "");
        if (f.t === "MESSAGE_CREATE") await this.onDiscordMessage(f.d as DiscordMessage);
        return;
    }
  }

  /** The text without mentions of this bot; other people's mentions are part of what was asked. */
  private withoutBotMention(content: string): string {
    return (this.botUser ? content.replace(new RegExp(`<@!?${this.botUser}>`, "g"), "") : content).trim();
  }

  async onDiscordMessage(m: DiscordMessage): Promise<void> {
    if (!this.onMessage || !m?.author || m.author.bot || m.author.id === this.botUser) return;
    if (this.cfg.allow.length && !this.cfg.allow.includes(m.author.id)) return;
    let thread: string;
    if (m.channel_id === this.cfg.channel) {
      const name = this.withoutBotMention(m.content ?? "").slice(0, 80) || "Loopstra chat";
      try {
        const t = await this.call("POST", `/channels/${m.channel_id}/messages/${m.id}/threads`, { name, auto_archive_duration: 1440 });
        thread = String(t.id);
      } catch (e) {
        this.log(e instanceof Error ? e.message : String(e));
        return;
      }
      this.remember(thread);
    } else if (this.knownThreads().includes(m.channel_id)) {
      thread = m.channel_id;
    } else {
      return;
    }
    const text = this.withoutBotMention(m.content ?? "");
    if (!text) {
      if (!this.warnedEmpty) this.log("Discord delivered a message with no text: turn on the Message Content intent for the bot.");
      this.warnedEmpty = true;
      return;
    }
    await this.onMessage({
      thread, authorId: m.author.id, authorName: m.author.global_name || m.author.username || m.author.id, text,
      canAccept: this.cfg.acceptors.includes(m.author.id),
      acceptors: mentionList(this.cfg.acceptors.map((id) => `<@${id}>`), "chat.transports.discord.acceptors"),
    });
  }

  async send(thread: string, text: string): Promise<void> {
    for (const part of chunkText(text, DISCORD_MAX)) {
      try { await this.call("POST", `/channels/${thread}/messages`, { content: part, allowed_mentions: { parse: [] } }); } catch (e) { this.log(e instanceof Error ? e.message : String(e)); return; }
    }
  }

  async announce(text: string): Promise<void> {
    if (!this.cfg.announce_to) return;
    // A failure is thrown so the service tries it again.
    for (const part of chunkText(text, DISCORD_MAX)) await this.call("POST", `/channels/${this.cfg.announce_to}/messages`, { content: part, allowed_mentions: { parse: [] } });
  }

  async stop(): Promise<void> {
    this.onMessage = null;
    this.reconnect.cancel();
    this.stopBeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
