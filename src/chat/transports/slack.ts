import type { SlackTransportConfig } from "../../config";
import type { OnMessage, Transport } from "../service";
import { chunked, fetchJson, fromPerson, LiveAccess, openSocket, Reconnector } from "./shared";

/** The Slack Web API; tests point it at a stub server. */
export const SLACK_API_ENV = "LOOPSTRA_SLACK_API";
const SLACK_MAX = 3500;
/**
 * How long a Socket Mode connection may go without a frame before it is taken for dead and opened
 * again. Slack sends frames of its own now and then (a disconnect notice before it refreshes the
 * link), so a healthy quiet connection is opened again at most this often, which costs nothing.
 */
const SLACK_QUIET_MS = 10 * 60_000;

/**
 * Text as Slack shows it, without pinging anyone: replies carry the agent's words, which a person in
 * the channel can steer. `<!channel>`, `<!here>`, `<!everyone>` and `<!subteam^...>` are shown as text,
 * and so is a mention of anyone but the people in `keep` (the acceptors: the agent is meant to point
 * at them). Discord needs none of this: its replies are sent with mentions turned off.
 */
export function noBroadcast(text: string, keep: readonly string[] = []): string {
  return text.replace(/<!/g, "&lt;!").replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (m, id: string) => (keep.includes(id) ? m : `&lt;${m.slice(1)}`));
}

/** Errors from apps.connections.open that mean the app-level token is no good until a person replaces it. */
const TOKEN_REFUSED = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired"]);

/** A Web API method Slack answered with ok: false, and its error code. */
class SlackApiError extends Error {
  constructor(method: string, readonly code: string) { super(`Slack ${method} failed: ${code}`); }
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
  private readonly access: LiveAccess;
  /** The watchdog: fires after SLACK_QUIET_MS without a frame (see dropSocket). */
  private quiet: ReturnType<typeof setTimeout> | null = null;
  /** The refusal last logged (an error code), so a lasting one is one line. */
  private refusedCode: string | null = null;

  constructor(private readonly cfg: SlackTransportConfig, private readonly opts: { root: string; env?: Record<string, string | undefined>; log?: (line: string) => void; quietMs?: number }) {
    this.api = (opts.env ?? process.env)[SLACK_API_ENV] ?? "https://slack.com/api";
    this.reconnect = new Reconnector(() => this.connect(), (e) => this.log(`Slack connection failed, retrying: ${e}`));
    this.access = new LiveAccess(opts.root, "slack", cfg, (l) => this.log(l));
  }

  private log(line: string): void { (this.opts.log ?? ((l) => console.error(l)))(line); }

  /** Calls one Web API method, waiting out a rate limit once or twice. Throws with Slack's error code when it says ok: false. */
  async call(method: string, body: Record<string, unknown>, token = this.botToken): Promise<Record<string, unknown>> {
    const { res, json } = await fetchJson(`${this.api}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    }, (r) => r.headers.get("retry-after"));
    if (json?.ok !== true) throw new SlackApiError(method, typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
    return json;
  }

  async start(onMessage: OnMessage): Promise<void> {
    const env = this.opts.env ?? process.env;
    this.appToken = env[this.cfg.token_env] ?? "";
    this.botToken = env[this.cfg.bot_token_env] ?? "";
    if (!this.appToken) throw new Error(`Slack needs its app-level token in the environment variable ${this.cfg.token_env}.`);
    if (!this.botToken) throw new Error(`Slack needs its bot token in the environment variable ${this.cfg.bot_token_env}.`);
    this.onMessage = onMessage;
    const me = await this.call("auth.test", {});
    this.botUser = typeof me.user_id === "string" ? me.user_id : "";
    await this.connect(true);
  }

  /**
   * Opens the Socket Mode connection. `starting`: a token Slack refuses is an error for start to
   * throw, not a refusal to wait out. A stop that comes during one of its waits is honoured after
   * it: nothing opened then is kept.
   */
  private async connect(starting = false): Promise<void> {
    if (this.reconnect.cancelled) return;
    let open: Record<string, unknown>;
    try {
      open = await this.call("apps.connections.open", {}, this.appToken);
    } catch (e) {
      if (!(e instanceof SlackApiError) || !TOKEN_REFUSED.has(e.code)) throw e;
      const why = `the app-level token was not accepted. Check the token in ${this.cfg.token_env}`;
      if (starting) throw new Error(`Slack refused the app (${e.code}): ${why}.`);
      this.refused(e.code, why);
      this.reconnect.schedule();
      return;
    }
    if (this.reconnect.cancelled) return;
    const ws = await openSocket(String(open.url));
    if (this.reconnect.cancelled) { ws.close(); return; }
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      this.touch(ws);
      this.onFrame(ws, String(ev.data)).catch((e: unknown) => this.log(`Slack message failed: ${e instanceof Error ? e.message : String(e)}`));
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopWatchdog();
      this.reconnect.schedule();
    });
    this.touch(ws);
    this.reconnect.succeeded();
    this.refusedCode = null;
  }

  /** A refusal a retry cannot fix: said once while it lasts, and tried again only every 5 minutes. */
  private refused(code: string, why: string): void {
    if (this.refusedCode !== code) this.log(`Slack refused the app (${code}): ${why}. Trying again every 5 minutes.`);
    this.refusedCode = code;
    this.reconnect.slowly();
  }

  /** A frame came on `ws`: the watchdog starts over. */
  private touch(ws: WebSocket): void {
    this.stopWatchdog();
    this.quiet = setTimeout(() => this.dropSocket(ws, "Slack has been silent too long; the connection may be dead, so it is opened again."), this.opts.quietMs ?? SLACK_QUIET_MS);
  }

  private stopWatchdog(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }

  /**
   * Lets go of a connection taken for dead and opens another. Not left to the close event: a
   * half-open socket (the machine slept, the network changed) may never deliver one.
   */
  private dropSocket(ws: WebSocket, why: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopWatchdog();
    this.log(why);
    try { ws.close(4000, "no frames"); } catch { /* already gone */ }
    this.reconnect.schedule();
  }

  private async onFrame(ws: WebSocket, data: string): Promise<void> {
    let frame: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } };
    try {
      const v: unknown = JSON.parse(data);
      // Only an object is a frame; its fields are read as they are, each checked where it is used.
      if (typeof v !== "object" || v === null) return;
      frame = v;
    } catch { return; }
    // Every envelope is acknowledged at once, or Slack sends it again.
    if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    if (frame.type === "disconnect") { ws.close(); return; }
    if (frame.type !== "events_api" || !frame.payload?.event) return;
    await this.onEvent(frame.payload.event);
  }

  /** Whether an event is a person's message in the configured channel (who may chat is read after). */
  private wanted(ev: SlackEvent): ev is Required<Pick<SlackEvent, "user" | "channel" | "ts">> & SlackEvent {
    if (ev.type !== "message" && ev.type !== "app_mention") return false;
    if (ev.subtype || ev.bot_id || !ev.user || !ev.ts || ev.user === this.botUser) return false;
    return ev.channel === this.cfg.channel;
  }

  async onEvent(ev: SlackEvent): Promise<void> {
    // The config is read only for a message to this bot: the workspace's other events are not.
    if (!this.wanted(ev)) return;
    const access = await this.access.read();
    if (!access || (access.allow.length && !access.allow.includes(ev.user))) return;
    // A mention arrives twice (as a message and as app_mention): once is enough.
    if (this.seen.includes(ev.ts)) return;
    this.seen.push(ev.ts);
    if (this.seen.length > 500) this.seen.splice(0, 100);
    const text = (ev.text ?? "").replace(new RegExp(`<@${this.botUser}>`, "g"), "").trim();
    if (!text || !this.onMessage) return;
    const thread = `${ev.channel}:${ev.thread_ts ?? ev.ts}`;
    await this.onMessage(fromPerson({ thread, authorId: ev.user, authorName: await this.nameOf(ev.user), text }, access, "chat.transports.slack.acceptors"));
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

  /** The people a reply may mention: the acceptors as the config has them now. */
  private async keepMentions(): Promise<string[]> {
    return (await this.access.read())?.acceptors ?? [];
  }

  async send(thread: string, text: string): Promise<void> {
    const [channel, ts] = thread.split(":");
    const keep = await this.keepMentions();
    try {
      await chunked(noBroadcast(text, keep), SLACK_MAX, (part) => this.call("chat.postMessage", { channel, thread_ts: ts, text: part }).then(() => {}));
    } catch (e) { this.log(e instanceof Error ? e.message : String(e)); }
  }

  async announce(text: string): Promise<void> {
    if (!this.cfg.announce_to) return;
    // Long like any reply (a note can be), and a failure is thrown so the service tries it again.
    const keep = await this.keepMentions();
    await chunked(noBroadcast(text, keep), SLACK_MAX, (part) => this.call("chat.postMessage", { channel: this.cfg.announce_to, text: part }).then(() => {}));
  }

  async stop(): Promise<void> {
    this.onMessage = null;
    this.reconnect.cancel();
    this.stopWatchdog();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
