import type { SlackTransportConfig } from "../../config";
import type { OnMessage, Transport } from "../service";
import { chunkText, Reconnector, mentionList } from "./shared";

/** The Slack Web API; tests point it at a stub server. */
export const SLACK_API_ENV = "LOOPSTRA_SLACK_API";
const SLACK_MAX = 3500;

/**
 * Text as Slack shows it, without `<!channel>`, `<!here>`, `<!everyone>` or `<!subteam^...>` pinging
 * anyone: replies carry the agent's words, which a person in the channel can steer. People's own
 * mentions (`<@U...>`) stay, like Discord's, which shows them without pinging.
 */
export function noBroadcast(text: string): string {
  return text.replace(/<!/g, "&lt;!");
}

interface SlackEvent { type?: string; subtype?: string; bot_id?: string; user?: string; channel?: string; text?: string; ts?: string; thread_ts?: string }

/**
 * A bot in one Slack channel, over Socket Mode (an outbound websocket, so no public address is
 * needed). Each top-level message starts a thread; replies in the thread continue that conversation.
 * Needs an app-level token (connections:write) and a bot token (chat:write, channels:history,
 * users:read), each in the environment variable the config names.
 */
export class SlackTransport implements Transport {
  readonly name = "slack";
  readonly via = "Slack";
  readonly announceFrom = "kept" as const;
  private readonly api: string;
  private appToken = "";
  private botToken = "";
  private botUser = "";
  private ws: WebSocket | null = null;
  private onMessage: OnMessage | null = null;
  private readonly seen: string[] = [];
  private readonly names = new Map<string, string>();
  private readonly reconnect: Reconnector;

  constructor(private readonly cfg: SlackTransportConfig, private readonly opts: { env?: Record<string, string | undefined>; log?: (line: string) => void } = {}) {
    this.api = (opts.env ?? process.env)[SLACK_API_ENV] ?? "https://slack.com/api";
    this.reconnect = new Reconnector(() => this.connect(), (e) => this.log(`Slack connection failed, retrying: ${e}`));
  }

  private log(line: string): void { (this.opts.log ?? ((l) => console.error(l)))(line); }

  /** Calls one Web API method. Throws with Slack's error code when it says ok: false. */
  async call(method: string, body: Record<string, unknown>, token = this.botToken): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.api}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 2) {
        await Bun.sleep(Math.min(30, Number(res.headers.get("retry-after") ?? 1)) * 1000);
        continue;
      }
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as Record<string, unknown>;
      if (json.ok !== true) throw new Error(`Slack ${method} failed: ${String(json.error ?? res.status)}`);
      return json;
    }
  }

  async start(onMessage: OnMessage): Promise<void> {
    const env = this.opts.env ?? process.env;
    this.appToken = env[this.cfg.token_env] ?? "";
    this.botToken = env[this.cfg.bot_token_env] ?? "";
    if (!this.appToken) throw new Error(`Slack needs its app-level token in the environment variable ${this.cfg.token_env}.`);
    if (!this.botToken) throw new Error(`Slack needs its bot token in the environment variable ${this.cfg.bot_token_env}.`);
    this.onMessage = onMessage;
    const me = await this.call("auth.test", {});
    this.botUser = String(me.user_id ?? "");
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.onMessage) return;
    const open = await this.call("apps.connections.open", {}, this.appToken);
    const ws = new WebSocket(String(open.url));
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("the Socket Mode connection failed")), { once: true });
    });
    ws.addEventListener("message", (ev) => { this.onFrame(ws, String(ev.data)).catch((e) => this.log(`Slack message failed: ${e instanceof Error ? e.message : String(e)}`)); });
    ws.addEventListener("close", () => { if (this.ws === ws && this.onMessage) this.reconnect.schedule(); });
    this.reconnect.succeeded();
  }

  private async onFrame(ws: WebSocket, data: string): Promise<void> {
    let frame: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } };
    try { frame = JSON.parse(data); } catch { return; }
    // Every envelope is acknowledged at once, or Slack sends it again.
    if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    if (frame.type === "disconnect") { ws.close(); return; }
    if (frame.type !== "events_api" || !frame.payload?.event) return;
    await this.onEvent(frame.payload.event);
  }

  /** Whether an event is a person's message in the configured channel, from someone allowed to chat. */
  private wanted(ev: SlackEvent): ev is Required<Pick<SlackEvent, "user" | "channel" | "ts">> & SlackEvent {
    if (ev.type !== "message" && ev.type !== "app_mention") return false;
    if (ev.subtype || ev.bot_id || !ev.user || !ev.ts || ev.user === this.botUser) return false;
    if (ev.channel !== this.cfg.channel) return false;
    if (this.cfg.allow.length && !this.cfg.allow.includes(ev.user)) return false;
    return true;
  }

  async onEvent(ev: SlackEvent): Promise<void> {
    if (!this.wanted(ev)) return;
    // A mention arrives twice (as a message and as app_mention): once is enough.
    if (this.seen.includes(ev.ts)) return;
    this.seen.push(ev.ts);
    if (this.seen.length > 500) this.seen.splice(0, 100);
    const text = (ev.text ?? "").replace(new RegExp(`<@${this.botUser}>`, "g"), "").trim();
    if (!text || !this.onMessage) return;
    const thread = `${ev.channel}:${ev.thread_ts ?? ev.ts}`;
    await this.onMessage({
      thread, authorId: ev.user, authorName: await this.nameOf(ev.user), text,
      canAccept: this.cfg.acceptors.includes(ev.user),
      acceptors: mentionList(this.cfg.acceptors.map((id) => `<@${id}>`), "chat.transports.slack.acceptors"),
    });
  }

  private async nameOf(user: string): Promise<string> {
    const known = this.names.get(user);
    if (known) return known;
    let name = user;
    try {
      const r = await this.call("users.info", { user });
      const u = r.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
      name = u?.profile?.display_name || u?.real_name || u?.name || user;
    } catch { /* the id will do */ }
    this.names.set(user, name);
    return name;
  }

  async send(thread: string, text: string): Promise<void> {
    const [channel, ts] = thread.split(":");
    for (const part of chunkText(noBroadcast(text), SLACK_MAX)) {
      try { await this.call("chat.postMessage", { channel, thread_ts: ts, text: part }); } catch (e) { this.log(String(e instanceof Error ? e.message : e)); return; }
    }
  }

  async announce(text: string): Promise<void> {
    if (!this.cfg.announce_to) return;
    // Long like any reply (a note can be), and a failure is thrown so the service tries it again.
    for (const part of chunkText(noBroadcast(text), SLACK_MAX)) await this.call("chat.postMessage", { channel: this.cfg.announce_to, text: part });
  }

  async stop(): Promise<void> {
    this.onMessage = null;
    this.reconnect.cancel();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
