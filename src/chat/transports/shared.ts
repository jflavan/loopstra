import { userInfo } from "node:os";
import { loadConfig, type Config } from "../../config";
import type { OnMessage } from "../service";
import { andList } from "../../text";

/** Who may chat with a bot (empty: anyone in its channel), and who may also start drafts. */
interface Access { allow: string[]; acceptors: string[] }

/**
 * A bot's `allow` and `acceptors`, read from the config for each message, so a change counts from the
 * next message without a restart (the token and the channel need one). Null when the bot's section is
 * gone from the config: its messages are ignored, and that is logged once. A config that cannot be
 * read (a half-saved edit) keeps the lists last read.
 */
export class LiveAccess {
  private gone = false;

  constructor(private readonly root: string, private readonly name: "slack" | "discord", private last: Access, private readonly log: (line: string) => void) {}

  async read(): Promise<Access | null> {
    let cfg: Config;
    try { cfg = await loadConfig(this.root); } catch { return this.last; }
    const section = cfg.chat.transports[this.name];
    if (!section) {
      if (!this.gone) this.log(`${this.name === "slack" ? "Slack" : "Discord"}: chat.transports.${this.name} is no longer in loopstra/config.yaml, so messages to this bot are ignored. Put it back, or stop loopstra chat.`);
      this.gone = true;
      return null;
    }
    this.gone = false;
    this.last = { allow: section.allow, acceptors: section.acceptors };
    return this.last;
  }
}

/** A person's message as the service takes it: whether they may accept, and who may, from the bot's access lists. */
export function fromPerson(m: { thread: string; authorId: string; authorName: string; text: string }, access: Access, setting: string): Parameters<OnMessage>[0] {
  return {
    ...m,
    canAccept: access.acceptors.includes(m.authorId),
    acceptors: mentionList(access.acceptors.map((id) => `<@${id}>`), setting),
  };
}

/** True when the UTF-16 unit at `i` is the first half of a character written as two (an emoji, say). */
function firstHalf(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * Where to end a part of `text` of at most `max` UTF-16 units: `max`, or one less when that would
 * cut a character written as two in half (a lone half shows as a broken character, and a platform
 * may refuse it). Never 0 while there is text: a first character wider than `max` is kept whole.
 */
function cutAt(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const cut = max > 0 && firstHalf(text, max - 1) ? max - 1 : max;
  return cut > 0 ? cut : Math.min(text.length, firstHalf(text, 0) ? 2 : 1);
}

/** The start of `text`, at most `max` UTF-16 units, never ending inside a character (see cutAt). */
export function prefixOf(text: string, max: number): string {
  return text.slice(0, cutAt(text, max));
}

/** Splits a message into parts of at most `max` characters, at line breaks where it can, and never inside a character. */
export function chunkText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = cutAt(rest, max);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [""];
}

/** Posts a message in parts of at most `max` characters (see chunkText), one call of `post` each, in order. */
export async function chunked(text: string, max: number, post: (part: string) => Promise<void>): Promise<void> {
  for (const part of chunkText(text, max)) await post(part);
}

/** "a, b and c" for the people who may start drafts, or who to ask when there are none. */
function mentionList(people: string[], setting: string): string {
  if (!people.length) return `nobody here yet (an engineer can add people to ${setting})`;
  return andList(people);
}

/** A JSON object as a response body gave it. */
type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * How long to wait after a rate limit, in seconds, from what the platform said (Slack's Retry-After
 * header, Discord's retry_after field): a second when it said nothing usable, and never more than 30.
 */
export function retryAfterSeconds(said: unknown): number {
  const s = Number(said);
  return Number.isFinite(s) && s > 0 ? Math.min(30, s) : 1;
}

/** How long one HTTP call (its answer and its body) may take: Bun's fetch has no limit of its own. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * One HTTP call with a JSON answer, waiting out a rate limit (429) up to twice: `retryAfter` reads
 * how long from the response. Gives the response, its text, and the text as a JSON object (null when
 * it is not one). Throws only when the call itself fails (no connection), or gets no whole answer
 * within `timeoutMs`: one call that never answers must not hold up the chat service's poll, which
 * waits for it, for good.
 */
export async function fetchJson(url: string, init: RequestInit, retryAfter: (res: Response, json: JsonObject | null) => unknown, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ res: Response; text: string; json: JsonObject | null }> {
  const timedOut = () => new Error(`no answer from ${new URL(url).host} within ${timeoutMs / 1000} seconds`);
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try { res = await fetch(url, { ...init, signal }); } catch (e) {
      if (signal.aborted) throw timedOut();
      throw e;
    }
    const text = await res.text().catch(() => "");
    if (signal.aborted) throw timedOut();
    let json: JsonObject | null = null;
    try { const v: unknown = JSON.parse(text); if (isObject(v)) json = v; } catch { /* not JSON: the caller reads the status */ }
    if (res.status === 429 && attempt < 2) {
      await Bun.sleep(retryAfterSeconds(retryAfter(res, json)) * 1000);
      continue;
    }
    return { res, text, json };
  }
}

/** How long a websocket gets to open before it is given up on (and tried again, see Reconnector). */
const OPEN_TIMEOUT_MS = 20_000;

/**
 * A websocket to `url`, once it is open. A handshake that fails, is closed, or takes longer than
 * `timeoutMs` throws instead (the socket is closed first), so a connection that never completes
 * cannot hang the caller forever.
 */
export function openSocket(url: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`the connection did not open within ${Math.round(timeoutMs / 1000)} seconds`)); }, timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("the connection failed")); }, { once: true });
    ws.addEventListener("close", () => { clearTimeout(timer); reject(new Error("the connection was closed before it opened")); }, { once: true });
  });
}

/** How long a refusal a retry cannot fix waits between tries (see Reconnector.slowly). */
const REFUSED_WAIT_MS = 5 * 60_000;

/**
 * Reconnects a dropped connection, waiting 1, 2, 4 ... up to 30 seconds between tries, until one
 * succeeds: a connection that opens and is closed again backs off like one that does not open.
 * Once cancelled (the transport is stopping) it never tries again, and `connect` can ask it so
 * after each of its own waits, to let go of what it opened meanwhile.
 */
export class Reconnector {
  private delay = 1_000;
  private longest = 30_000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly connect: () => Promise<void>, private readonly onError: (e: string) => void) {}

  /** True once cancelled: nothing opened after this should stay open. */
  get cancelled(): boolean { return this.stopped; }

  succeeded(): void { this.delay = 1_000; this.longest = 30_000; }

  /** Tries wait REFUSED_WAIT_MS until one succeeds: a person can fix the cause (a token, a setting) without a restart. */
  slowly(): void { this.delay = this.longest = REFUSED_WAIT_MS; }

  schedule(): void {
    if (this.stopped || this.timer) return;
    const wait = this.delay;
    this.delay = Math.min(this.longest, this.delay * 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      void this.connect().catch((e: unknown) => {
        // Cancelled while it was connecting: what failed no longer matters, and nothing is tried again.
        if (this.stopped) return;
        this.onError(e instanceof Error ? e.message : String(e));
        this.schedule();
      });
    }, wait);
  }

  cancel(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The person at this machine (the terminal and the dashboard), by their login name. */
export function localUser(): string {
  try { return userInfo().username || "you"; } catch { return "you"; }
}
