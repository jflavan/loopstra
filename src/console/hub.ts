import { readdirSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { heartbeatPath } from "../heartbeat";
import { intentRoot, scanRepo, type Scan } from "../intents";
import { errorText } from "../shell";
import { Trace } from "../trace";
import { activityItem, phaseNamer } from "./describe";
import { buildModel, type Model } from "./model";
import { SECTION_NAMES, type SectionName, type StreamMessage } from "./types";

/** Writes one frame to a page; false when the page is gone. */
export type Send = (text: string) => boolean;

/** An SSE frame carrying `msg` as JSON, with an id when given. */
export function frame(msg: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(msg)}\n\n`;
}

/** Sent while nothing else is, so a page can tell a quiet stream from a dead one (comments do not reach its code). */
export const PING = "event: ping\ndata: {}\n\n";

export interface HubOptions {
  chat?: boolean;
  /** How often it looks for changes (ms). */
  intervalMs?: number;
  /** The least time between a watched file changing and the rebuild it causes (ms). */
  minRebuildMs?: number;
  pingMs?: number;
  /** Reads the intent folder (what the hub keeps until a file there changes); tests count its calls. */
  scan?: (root: string) => Promise<Scan>;
}

/** The most events read at once, and the most a page coming back is sent. */
const CATCH_UP = 500;
/** The most reads of new events one look makes, so a flood of them cannot hold a look forever. */
const EVENT_READS = 10;

/** When a file was last written and how big it is; "-" when it is missing. */
function stamp(path: string): string {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; }
}

/**
 * The console's live stream: one per server, shared by every open page. While any page is connected
 * it looks for changes (every `intervalMs`, and soon after a watched file changes), rebuilds the
 * model when anything did, and sends each page the sections that differ and the new events in plain
 * words. With no page connected it holds nothing open and does nothing.
 */
export class Hub {
  private readonly clients = new Set<Send>();
  private connecting = 0;
  private trace: Trace | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private soon: ReturnType<typeof setTimeout> | null = null;
  private watchers: FSWatcher[] = [];
  private model: Model | null = null;
  private readonly sent = new Map<SectionName, string>();
  private signature = "";
  /** The intent folder as last read, with the fingerprint of the files it was read from. */
  private scanned: { key: string; scan: Scan } | null = null;
  private lastEventId = 0;
  private lastBuild = 0;
  private running: Promise<void> | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private readonly noted = new Set<string>();
  private name: ((slug: string, seq: number) => string | undefined) | undefined;

  constructor(private readonly root: string, private readonly opts: HubOptions = {}) {}

  /** The newest model, or null while no page is connected. */
  latest(): Model | null {
    return this.model;
  }

  /** Resolves once the hub has let go of everything after its last page left. */
  whenStopped(): Promise<void> {
    return this.stopping;
  }

  /**
   * Adds a page. A page coming back (`lastEventId` above 0) first gets the events it missed, or
   * `gap` when it missed too many; every page then gets a snapshot whose id is the newest event the
   * hub has sent, so its next reconnect continues from there. Gives the function that removes the
   * page. Throws what `send` throws; the hub is then left stopped if no other page is open.
   */
  async connect(send: Send, lastEventId = 0): Promise<() => Promise<void>> {
    this.connecting++;
    let added = false;
    try {
      // The last page may have just left (a reload): the hub lets go of everything first, so the
      // look below builds from the trace this start opens, not from the one being closed.
      await this.stopping;
      this.start();
      await this.look(true);
      if (lastEventId > 0) this.catchUp(send, lastEventId);
      if (this.model) send(this.snapshot(this.model));
      this.clients.add(send);
      added = true;
    } finally {
      this.connecting--;
      // A page that failed while connecting must not leave the hub running for nobody.
      if (!added && !this.clients.size && !this.connecting) await this.stop();
    }
    return () => this.remove(send);
  }

  private snapshot(model: Model): string {
    return frame({ type: "snapshot", meta: model.meta, sections: model.sections } satisfies StreamMessage, this.lastEventId);
  }

  /**
   * The events after `afterId` that a returning page missed, up to the newest one the hub has sent:
   * any after that go to every page with the next look, so none comes twice.
   */
  private catchUp(send: Send, afterId: number): void {
    if (!this.trace || afterId >= this.lastEventId) return;
    const rows = this.trace.eventsAfter(afterId, CATCH_UP + 1).filter((e) => e.id <= this.lastEventId);
    if (rows.length > CATCH_UP) {
      send(frame({ type: "gap" } satisfies StreamMessage));
      return;
    }
    for (const e of rows) {
      const item = activityItem(e, this.name);
      if (item.text !== null) send(frame({ type: "event", item } satisfies StreamMessage, item.id));
    }
  }

  private remove(send: Send): Promise<void> {
    this.clients.delete(send);
    return this.clients.size || this.connecting ? Promise.resolve() : this.stop();
  }

  private start(): void {
    if (this.trace) return;
    this.trace = Trace.open(this.root);
    this.name = phaseNamer(this.trace);
    this.lastEventId = this.trace.lastEventId();
    this.timers = [
      setInterval(() => void this.look(), this.opts.intervalMs ?? 500),
      setInterval(() => this.broadcast(PING), this.opts.pingMs ?? 15_000),
    ];
    // Watching only makes a change show sooner; the timer finds it anyway where watching does not work.
    for (const [dir, recursive] of [[intentRoot(this.root), true], [join(this.root, ".loopstra"), false]] as const) {
      try {
        const w = watch(dir, { recursive }, () => this.lookSoon());
        w.on("error", () => { /* polling still runs */ });
        this.watchers.push(w);
      } catch { /* the folder is missing, or this system cannot watch it */ }
    }
  }

  private stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const trace = this.trace;
    this.trace = null;
    this.model = null;
    this.sent.clear();
    this.signature = "";
    this.scanned = null;
    this.noted.clear();
    // A look still running uses the trace; it is closed once that look ends. The promise never
    // fails: every later connect waits on it.
    this.stopping = (this.running ?? Promise.resolve()).finally(() => {
      try { trace?.close(); } catch { /* already closed */ }
    });
    return this.stopping;
  }

  private lookSoon(): void {
    if (this.soon || !this.trace) return;
    const wait = Math.max(0, (this.opts.minRebuildMs ?? 250) - (Date.now() - this.lastBuild));
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.look();
    }, wait);
  }

  /**
   * Rebuilds and sends what changed, when anything did (always, when forced). One look at a time,
   * and a look asked for while one runs joins it: several pages connecting together share one
   * rebuild. (A look under way cannot be for a closed trace: connect waits for the hub to let go
   * of it first.)
   */
  private look(force = false): Promise<void> {
    if (this.running) return this.running;
    const trace = this.trace;
    if (!trace) return Promise.resolve();
    // Cleared from `finally`, not inside: a look that finds nothing returns before its first await,
    // and would clear the mark before it is set.
    this.running = (async () => {
      try {
        const key = this.intentsKey();
        const signature = this.signatureOf(trace, key);
        if (!force && this.model && signature === this.signature) return;
        this.signature = signature;
        this.lastBuild = Date.now();
        const model = await buildModel(this.root, trace, new Date(), { chat: this.opts.chat, scan: await this.intents(key) });
        if (this.trace !== trace) return;
        // Everything is recorded before anything is sent: a send can drop the last page and stop
        // the hub, which must then stay cleared.
        // A page was added without a snapshot when the build before this one failed, so it has
        // nothing to apply section diffs to.
        const first = this.model === null;
        this.model = model;
        const changed = SECTION_NAMES.filter((name) => {
          const json = JSON.stringify(model.sections[name]);
          const before = this.sent.get(name);
          this.sent.set(name, json);
          return before !== undefined && before !== json;
        });
        if (first) this.broadcast(this.snapshot(model));
        else for (const name of changed) this.broadcast(frame({ type: "section", name, value: model.sections[name] } satisfies StreamMessage));
        this.sendNewEvents(trace);
      } catch (e) {
        this.note(errorText(e));
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /**
   * A cheap fingerprint of what the model reads: the newest event, the heartbeat, the pause, the
   * config and the intent files (`key`). The ten-second bucket keeps "last check 20s ago" and the ages fresh.
   */
  private signatureOf(trace: Trace, key: string): string {
    const parts = [String(trace.lastEventId()), String(Math.floor(Date.now() / 10_000))];
    for (const p of [heartbeatPath(this.root), join(this.root, ".loopstra", "paused.json"), join(this.root, "loopstra", "config.yaml")]) parts.push(stamp(p));
    parts.push(key);
    return parts.join("|");
  }

  /**
   * A fingerprint of everything reading the intent folder looks at (see scanRepo): what is in intent/,
   * which files each change folder holds (the documents present) and when its intent.md was written.
   */
  private intentsKey(): string {
    const dir = intentRoot(this.root);
    const parts: string[] = [];
    let entries: Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* no intent folder yet */ }
    for (const e of entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (e.isFile()) { parts.push(e.name); continue; }
      let files = "";
      try { files = readdirSync(join(dir, e.name)).sort().join(","); } catch { /* not a folder */ }
      // The plan too: the files it names decide which changes wait for each other.
      parts.push(`${e.name}[${files}]${stamp(join(dir, e.name, "intent.md"))}${stamp(join(dir, e.name, "plan.md"))}`);
    }
    return parts.join("|");
  }

  /** The intent folder, read again only when `key` is not the one it was last read at. Undefined when it cannot be read: the model then reads it itself and says why. */
  private async intents(key: string): Promise<Scan | undefined> {
    if (this.scanned?.key !== key) {
      try {
        this.scanned = { key, scan: await (this.opts.scan ?? scanRepo)(this.root) };
      } catch {
        this.scanned = null;
        return undefined;
      }
    }
    return this.scanned.scan;
  }

  /**
   * Sends every page the new events in plain words, and moves the hub's mark past them. Past
   * EVENT_READS x CATCH_UP new events the rest arrive with a later look (at most the next
   * ten-second bucket away, since the newest event id is part of the signature).
   */
  private sendNewEvents(trace: Trace): void {
    for (let read = 0; read < EVENT_READS && this.trace === trace; read++) {
      const rows = trace.eventsAfter(this.lastEventId, CATCH_UP);
      if (rows.length) this.lastEventId = rows.at(-1)!.id;
      for (const e of rows) {
        const item = activityItem(e, this.name);
        if (item.text !== null) this.broadcast(frame({ type: "event", item } satisfies StreamMessage, item.id));
      }
      if (rows.length < CATCH_UP) return;
    }
  }

  private broadcast(text: string): void {
    for (const send of [...this.clients]) {
      let ok = false;
      // A page whose write throws is as gone as one that says so.
      try { ok = send(text); } catch { /* gone */ }
      if (!ok) void this.remove(send);
    }
  }

  /** Traces a problem once, not on every look. */
  private note(what: string): void {
    if (this.noted.has(what)) return;
    // Problems whose text differs each time must not pile up for as long as a page stays open.
    if (this.noted.size >= 100) this.noted.clear();
    this.noted.add(what);
    try { this.trace?.event("_loop", "error", { where: "console", what }); } catch { /* the console never stops over its own trace */ }
  }
}
