import { join } from "node:path";
import { z } from "zod";
import type { DiscordTransportConfig } from "../../config";
import type { OnMessage, Transport } from "../service";
import { writeJson } from "../../fsutil";
import { readStateFile, StateFileUnavailable } from "../statefile";
import { chatDir } from "../threads";
import { chunked, fetchJson, fromPerson, LiveAccess, openSocket, prefixOf, Reconnector } from "./shared";

/** The Discord REST API; tests point it at a stub server (which also hands out the gateway address). */
export const DISCORD_API_ENV = "LOOPSTRA_DISCORD_API";
const DISCORD_MAX = 1900;
/** GUILD_MESSAGES and MESSAGE_CONTENT (privileged: turn it on for the bot in the developer portal). */
export const DISCORD_INTENTS = (1 << 9) | (1 << 15);

/**
 * Gateway close codes a retry cannot fix, and what to do (4004: the token; 4010-4013: how the bot
 * connects; 4014: a portal setting). The gateway closes with them after IDENTIFY.
 */
function refusal(code: number, tokenEnv: string): string | null {
  if (code === 4004) return `the bot token was not accepted. Check the token in ${tokenEnv}`;
  if (code === 4014) return "the Message Content intent is off. Turn it on for the bot in the Discord Developer Portal (Bot, Privileged Gateway Intents)";
  if (code >= 4010 && code <= 4013) return "it did not accept how the bot connects. An engineer should look";
  return null;
}

/** A REST call Discord answered with an error, and its HTTP status. */
class DiscordHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface DiscordMessage { id: string; channel_id: string; content?: string; author?: { id: string; username?: string; global_name?: string | null; bot?: boolean } }
const GatewayFrame = z.object({ op: z.number(), d: z.unknown().optional(), s: z.number().nullable().optional(), t: z.string().nullable().optional() });

/** The threads this bot started (see DiscordTransport.knownThreads), as the file keeps them. */
const KnownThreads = z.array(z.string());

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
  /** Whether the last heartbeat sent was acknowledged (op 11); one that was not means the connection is dead. */
  private acked = true;
  private onMessage: OnMessage | null = null;
  private readonly reconnect: Reconnector;
  private readonly access: LiveAccess;
  private warnedEmpty = false;
  /** The refusal last logged (a gateway close code, or an HTTP status), so a lasting one is one line. */
  private refusedCode: number | string | null = null;

  constructor(private readonly cfg: DiscordTransportConfig, private readonly opts: { root: string; env?: Record<string, string | undefined>; log?: (line: string) => void }) {
    this.api = (opts.env ?? process.env)[DISCORD_API_ENV] ?? "https://discord.com/api/v10";
    this.reconnect = new Reconnector(() => this.connect(), (e) => this.log(`Discord connection failed, retrying: ${e}`));
    this.access = new LiveAccess(opts.root, "discord", cfg, (l) => this.log(l));
  }

  private log(line: string): void { (this.opts.log ?? ((l) => console.error(l)))(line); }

  /**
   * Threads this bot started, kept across restarts so a conversation carries on. A damaged file is
   * moved aside and starts over. Null when the file is there but cannot be used now (see
   * readStateFile): it is kept, and nothing is written over it.
   */
  private threadsPath(): string { return join(chatDir(this.opts.root), "discord-threads.json"); }
  private knownThreads(): string[] | null {
    try { return readStateFile(this.threadsPath(), KnownThreads, (l) => this.log(l)) ?? []; } catch (e) {
      if (e instanceof StateFileUnavailable) return null;
      throw e;
    }
  }
  private remember(thread: string): void {
    const known = this.knownThreads();
    if (!known) return;
    writeJson(this.threadsPath(), [...known.filter((t) => t !== thread), thread].slice(-1000));
  }

  /** One REST call, waiting out a rate limit once or twice. Throws on any other failure. */
  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const { res, text, json } = await fetchJson(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bot ${this.token}`, "content-type": "application/json", "user-agent": "DiscordBot (loopstra, 1)" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, (_r, j) => j?.retry_after);
    if (!res.ok) throw new DiscordHttpError(`Discord ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    return json ?? {};
  }

  async start(onMessage: OnMessage): Promise<void> {
    this.token = (this.opts.env ?? process.env)[this.cfg.token_env] ?? "";
    if (!this.token) throw new Error(`Discord needs its bot token in the environment variable ${this.cfg.token_env}.`);
    this.onMessage = onMessage;
    await this.connect(true);
  }

  /**
   * Opens the gateway connection. `starting`: a token Discord refuses is an error for start to
   * throw, not a refusal to wait out. A stop that comes during one of its waits is honoured after
   * it: nothing opened then is kept.
   */
  private async connect(starting = false): Promise<void> {
    if (this.reconnect.cancelled) return;
    let gw: Record<string, unknown>;
    try {
      gw = await this.call("GET", "/gateway/bot");
    } catch (e) {
      // A bad or revoked token is refused here, before the gateway could close with 4004.
      if (!(e instanceof DiscordHttpError) || (e.status !== 401 && e.status !== 403)) throw e;
      const code = `HTTP ${e.status}`;
      const why = refusal(4004, this.cfg.token_env)!;
      if (starting) throw new Error(`Discord refused the bot (${code}): ${why}.`);
      this.refused(code, why);
      this.reconnect.schedule();
      return;
    }
    if (this.reconnect.cancelled) return;
    const ws = await openSocket(`${String(gw.url)}/?v=10&encoding=json`);
    if (this.reconnect.cancelled) { ws.close(); return; }
    this.ws = ws;
    ws.addEventListener("message", (ev) => { this.onFrame(ws, String(ev.data)).catch((e: unknown) => this.log(`Discord message failed: ${e instanceof Error ? e.message : String(e)}`)); });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopBeat();
      const refused = refusal(ev.code, this.cfg.token_env);
      if (refused) this.refused(ev.code, refused);
      this.reconnect.schedule();
    });
  }

  /** A refusal a retry cannot fix: said once while it lasts, and tried again only every 5 minutes. */
  private refused(code: number | string, why: string): void {
    if (this.refusedCode !== code) this.log(`Discord refused the bot (${code}): ${why}. Trying again every 5 minutes.`);
    this.refusedCode = code;
    this.reconnect.slowly();
  }

  private stopBeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  /**
   * Lets go of a connection taken for dead (a heartbeat went unanswered) and opens another. Not
   * left to the close event: a half-open socket (the machine slept, the network changed) may never
   * deliver one.
   */
  private dropSocket(ws: WebSocket, why: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopBeat();
    this.log(why);
    try { ws.close(4000, "no heartbeat ack"); } catch { /* already gone */ }
    this.reconnect.schedule();
  }

  private async onFrame(ws: WebSocket, data: string): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return; }
    const parsed = GatewayFrame.safeParse(raw);
    if (!parsed.success) return;
    const f = parsed.data;
    if (typeof f.s === "number") this.seq = f.s;
    switch (f.op) {
      case 10: { // hello: start the heartbeat, then identify
        const every = (f.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250;
        this.stopBeat();
        this.acked = true;
        this.beat = setInterval(() => {
          // The last beat got no ACK: the socket is dead, however open it looks (see dropSocket).
          if (!this.acked) { this.dropSocket(ws, "Discord did not answer a heartbeat; the connection may be dead, so it is opened again."); return; }
          this.acked = false;
          try { ws.send(JSON.stringify({ op: 1, d: this.seq })); } catch { /* closing */ }
        }, every);
        ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "loopstra", device: "loopstra" } } }));
        return;
      }
      case 1: ws.send(JSON.stringify({ op: 1, d: this.seq })); return;
      case 11: this.acked = true; return; // heartbeat ACK: the connection is alive
      case 7: case 9: ws.close(); return; // reconnect, or a session that is no longer valid: start over
      case 0:
        if (f.t === "READY") {
          // Connected only now: the gateway refuses a bad token or a missing intent after the socket opens.
          this.botUser = String((f.d as { user?: { id?: string } } | undefined)?.user?.id ?? "");
          this.reconnect.succeeded();
          this.refusedCode = null;
        }
        if (f.t === "MESSAGE_CREATE") await this.onDiscordMessage(f.d as DiscordMessage);
        return;
      default: return;
    }
  }

  /** The text without mentions of this bot; other people's mentions are part of what was asked. */
  private withoutBotMention(content: string): string {
    return (this.botUser ? content.replace(new RegExp(`<@!?${this.botUser}>`, "g"), "") : content).trim();
  }

  async onDiscordMessage(m: DiscordMessage): Promise<void> {
    if (!this.onMessage || !m?.author || m.author.bot || m.author.id === this.botUser) return;
    // The config is read only for a message to this bot: the server's other channels are not.
    const isOurs = m.channel_id === this.cfg.channel || (this.knownThreads() ?? []).includes(m.channel_id);
    if (!isOurs) return;
    const access = await this.access.read();
    if (!access || (access.allow.length && !access.allow.includes(m.author.id))) return;
    const text = this.withoutBotMention(m.content ?? "");
    // Checked before a thread is made, so a bot without the Message Content intent does not open an empty thread per message.
    if (!text) {
      if (!this.warnedEmpty) this.log("Discord delivered a message with no text: turn on the Message Content intent for the bot.");
      this.warnedEmpty = true;
      return;
    }
    let thread: string;
    if (m.channel_id === this.cfg.channel) {
      // Cut between characters, never inside one (an emoji is two UTF-16 units).
      const name = prefixOf(text, 80);
      try {
        const t = await this.call("POST", `/channels/${m.channel_id}/messages/${m.id}/threads`, { name, auto_archive_duration: 1440 });
        thread = String(t.id);
      } catch (e) {
        this.log(e instanceof Error ? e.message : String(e));
        return;
      }
      this.remember(thread);
    } else {
      thread = m.channel_id;
    }
    await this.onMessage(fromPerson({ thread, authorId: m.author.id, authorName: m.author.global_name || m.author.username || m.author.id, text }, access, "chat.transports.discord.acceptors"));
  }

  /** Posts one part of a message to a channel, with mentions turned off: the agent's words ping nobody. */
  private post(channel: string, content: string): Promise<void> {
    return this.call("POST", `/channels/${channel}/messages`, { content, allowed_mentions: { parse: [] } }).then(() => {});
  }

  async send(thread: string, text: string): Promise<void> {
    try {
      await this.sendOrThrow(thread, text);
    } catch (e) { this.log(e instanceof Error ? e.message : String(e)); }
  }

  async sendOrThrow(thread: string, text: string): Promise<void> {
    await chunked(text, DISCORD_MAX, (part) => this.post(thread, part));
  }

  async announce(text: string): Promise<void> {
    if (!this.cfg.announce_to) return;
    // A failure is thrown so the service tries it again.
    const to = this.cfg.announce_to;
    await chunked(text, DISCORD_MAX, (part) => this.post(to, part));
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
