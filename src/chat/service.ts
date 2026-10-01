import { join } from "node:path";
import { loadConfig } from "../config";
import { GitHub } from "../github";
import { errorText } from "../shell";
import { Trace } from "../trace";
import { CHAT_SLUG } from "./agents";
import { AnnouncementLog, announce } from "./announcer";
import { Orchestrator, type IncomingMessage } from "./orchestrator";
import { takeResults } from "./requests";
import { chatDir, readJson, writeJson } from "./threads";

/** What a transport hands the service for each message a person sends. */
export type OnMessage = (m: Omit<IncomingMessage, "transport" | "via">) => Promise<void>;

/** One place people chat: the terminal, the dashboard panel, Slack or Discord. */
export interface Transport {
  /** Short and stable: it is part of every thread key (`terminal`, `dashboard`, `slack`, `discord`). */
  readonly name: string;
  /** In words, for prompts and intents: "the terminal", "Slack". */
  readonly via: string;
  start(onMessage: OnMessage): Promise<void>;
  send(thread: string, text: string): Promise<void>;
  /** Posts an announcement where this transport shows them; absent when it shows none. */
  announce?(text: string): Promise<void>;
  /**
   * Where announcements start for this transport: "now" (only while it is open; the terminal and
   * the dashboard) or "kept" (a cursor kept across restarts, so a bot never posts one twice).
   */
  readonly announceFrom?: "now" | "kept";
  stop(): Promise<void>;
}

/** How often pull requests opened from chat are checked on GitHub. */
const PR_CHECK_MS = 60_000;

export class ChatService {
  readonly orchestrator: Orchestrator;
  private readonly log: AnnouncementLog;
  private readonly cursors = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPrCheck = 0;
  private stopped = false;
  private polling: Promise<void> | null = null;

  constructor(private readonly root: string, private readonly transports: Transport[], private readonly opts: { pollMs?: number; announce?: boolean } = {}) {
    this.orchestrator = new Orchestrator(root);
    this.log = new AnnouncementLog(root);
  }

  private transport(name: string): Transport | undefined { return this.transports.find((t) => t.name === name); }

  async start(): Promise<void> {
    for (const t of this.transports) {
      this.cursors.set(t.name, t.announceFrom === "kept" ? this.keptCursor(t.name) : this.log.lastId());
      await t.start((m) => this.orchestrator.handle({ ...m, transport: t.name, via: t.via }, (text) => t.send(m.thread, text)));
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.polling;
    for (const t of this.transports) { try { await t.stop(); } catch { /* stopping anyway */ } }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => {
        this.polling = null;
        void loadConfig(this.root).then((c) => c.poll_seconds * 1000, () => 60_000).then((d) => this.schedule(this.opts.pollMs ?? d));
      });
    }, ms);
  }

  private cursorPath(name: string): string { return join(chatDir(this.root), `announced-${name}.json`); }

  /** A bot's cursor: where it got to, or (first start) the end of the log, so it does not post history. */
  private keptCursor(name: string): number {
    const kept = readJson<{ id: number }>(this.cursorPath(name));
    if (kept && typeof kept.id === "number") return kept.id;
    const id = this.log.lastId();
    writeJson(this.cursorPath(name), { id });
    return id;
  }

  /**
   * One pass: write new announcements (when this process holds the lock), pass them to each
   * surface, pass on what the loop did with chat's requests, and notice pull requests that merged
   * or closed. Never throws.
   */
  async poll(): Promise<void> {
    try {
      if (this.opts.announce !== false) await announce(this.root, this.log);
      for (const t of this.transports) {
        const from = this.cursors.get(t.name) ?? 0;
        const fresh = this.log.since(from);
        if (!fresh.length) continue;
        this.cursors.set(t.name, fresh.at(-1)!.id);
        if (t.announceFrom === "kept") writeJson(this.cursorPath(t.name), { id: fresh.at(-1)!.id });
        if (t.announce) for (const a of fresh) { try { await t.announce(a.text); } catch { /* the transport says why */ } }
      }
      for (const r of takeResults(this.root, new Set(this.transports.map((t) => t.name)))) {
        const t = this.transport(r.transport);
        if (!t) continue;
        try { await this.orchestrator.deliver(t.name, r.thread, r.text, (text) => t.send(r.thread, text)); } catch (e) { this.traceError("chat-result", e); }
      }
      if (Date.now() - this.lastPrCheck >= PR_CHECK_MS) {
        this.lastPrCheck = Date.now();
        await this.checkPullRequests();
      }
    } catch (e) {
      this.traceError("chat-poll", e);
    }
  }

  private traceError(where: string, e: unknown): void {
    try {
      const trace = Trace.open(this.root, () => {});
      try { trace.event(CHAT_SLUG, "error", { where, error: errorText(e) }); } finally { trace.close(); }
    } catch { /* nowhere to record it */ }
  }

  /** Tells each thread when a pull request it opened was merged or closed on GitHub. */
  async checkPullRequests(): Promise<void> {
    const gh = new GitHub(this.root);
    for (const thread of this.orchestrator.store.all()) {
      const t = this.transport(thread.transport);
      if (!t) continue;
      for (const h of thread.handoffs.filter((x) => x.pr?.state === "OPEN")) {
        const r = await gh.lookupPr(h.pr!.branch);
        if (!("pr" in r) || !r.pr || r.pr.state === "OPEN") continue;
        const state = r.pr.state;
        const text = state === "MERGED"
          ? `The pull request for "${h.title}" was merged, so ${h.slugs.join(", ")} ${h.slugs.length > 1 ? "are" : "is"} in the queue as ${h.slugs.length > 1 ? "drafts" : "a draft"}. Ask me to start ${h.slugs.length > 1 ? "one" : "it"} when you are ready.`
          : `The pull request for "${h.title}" was closed without merging, so nothing was added.`;
        await this.orchestrator.withThread(thread.transport, thread.thread, async (cur) => {
          const rec = cur.handoffs.find((x) => x.pr?.branch === h.pr!.branch);
          if (rec?.pr) rec.pr.state = state;
          this.orchestrator.store.save(cur);
        });
        await this.orchestrator.deliver(t.name, thread.thread, text, (s) => t.send(thread.thread, s));
      }
    }
  }
}
