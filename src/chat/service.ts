import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config";
import { GitHub } from "../github";
import { errorText, timerMs } from "../shell";
import { AnnouncementLog, announce } from "./announcer";
import { Orchestrator, traceChatError, type IncomingMessage } from "./orchestrator";
import { waitingResults } from "../requests";
import { readJsonAs, writeJson } from "../fsutil";
import { chatDir } from "./threads";

/** What a transport hands the service for each message a person sends. */
export type OnMessage = (m: Omit<IncomingMessage, "transport" | "via">) => Promise<void>;

/** One place people chat: the terminal, the dashboard panel, Slack or Discord. */
export interface Transport {
  /** Short and stable: it is part of every thread key (`terminal`, `dashboard`, `slack`, `discord`). */
  readonly name: string;
  /** In words, for prompts and intents: "the terminal", "Slack". */
  readonly via: string;
  start(onMessage: OnMessage): Promise<void>;
  /** A reply in a conversation; a failure is logged by the transport, never thrown. */
  send(thread: string, text: string): Promise<void>;
  /**
   * A reply that must arrive (what the loop did with a request, a pull request's merge): throws when
   * it could not, so the service keeps it and tries again. Absent where a reply cannot fail (the
   * terminal, the dashboard), and `send` is used. A long one sent in parts may repeat its first parts
   * on the next try.
   */
  sendOrThrow?(thread: string, text: string): Promise<void>;
  /** Posts an announcement where this transport shows them; absent when it shows none. Throws when it could not, so it is tried again. */
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
/**
 * How long a loop result (or a pull request's merge notice) is tried again after its first failed
 * post before it is given up: a thread the bot can no longer post in (deleted, archived, the bot
 * removed) never clears, and each try would repeat the parts of a long message that did post.
 */
const RESULT_GIVE_UP_MS = 60 * 60_000;

/** A bot's announcement cursor file (see ChatService.keptCursor). */
const Cursor = z.object({ id: z.number().int().nonnegative() });

/**
 * Sends to a thread through the transport's sendOrThrow where it has one, so a reply that could not
 * be posted throws and is kept (see Transport.sendOrThrow).
 */
function mustSend(t: Transport, thread: string): (text: string) => Promise<void> {
  return (text) => (t.sendOrThrow ? t.sendOrThrow(thread, text) : t.send(thread, text));
}

export class ChatService {
  readonly orchestrator: Orchestrator;
  private readonly log: AnnouncementLog;
  private readonly cursors = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPrCheck = 0;
  private stopped = false;
  private polling: Promise<void> | null = null;

  constructor(private readonly root: string, private readonly transports: Transport[], private readonly opts: { pollMs?: number; announce?: boolean; resultGiveUpMs?: number } = {}) {
    this.orchestrator = new Orchestrator(root);
    this.log = new AnnouncementLog(root);
  }

  private transport(name: string): Transport | undefined { return this.transports.find((t) => t.name === name); }

  /**
   * When each message that could not be posted first failed, by its key (a result's file, or a
   * thread's pull request): traced once, and given up after RESULT_GIVE_UP_MS (see failedPost).
   */
  private readonly failing = new Map<string, number>();
  /**
   * Result files this process is done with (posted, or given up) whose removal failed: removed
   * again next poll, and never posted again.
   */
  private readonly doneResults = new Set<string>();
  /** Pull requests (`<thread key>#<number>`) whose notice was posted but whose new state is not saved yet: never posted again. */
  private readonly toldPrs = new Set<string>();

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
    // Turns in progress end too (a stop request ends their sessions), so each is traced as ended
    // and holds none of the day's chat budget after the process exits.
    await this.orchestrator.idle();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().finally(() => {
        this.polling = null;
        void loadConfig(this.root).then((c) => c.poll_seconds * 1000, () => 60_000).then((d) => this.schedule(this.opts.pollMs ?? d));
      });
    }, timerMs(ms));
  }

  private cursorPath(name: string): string { return join(chatDir(this.root), `announced-${name}.json`); }

  /**
   * A bot's cursor: where it got to, or (first start) the end of the log, so it does not post
   * history. A cursor file that cannot be read, or is not a cursor, is said in the trace and left for
   * a person to look at; the bot starts from the end of the log (it posts nothing twice) and writes
   * its cursor again once it posts.
   */
  private keptCursor(name: string): number {
    const path = this.cursorPath(name);
    if (existsSync(path)) {
      const kept = readJsonAs(path, Cursor);
      if (kept) return kept.id;
      traceChatError(this.root, `announce-${name}`, new Error(`${path} could not be read as a cursor, so ${name} starts from the newest announcement`));
      return this.log.lastId();
    }
    const id = this.log.lastId();
    writeJson(path, { id });
    return id;
  }

  /**
   * One pass: write new announcements (when this process holds the lock), pass them to each
   * surface, pass on what the loop did with chat's requests, and notice pull requests that merged
   * or closed. Never throws; a part that fails leaves the parts after it to run.
   */
  async poll(): Promise<void> {
    try {
      if (this.opts.announce !== false) {
        try { await announce(this.root, this.log); } catch (e) { traceChatError(this.root, "announce", e); }
      }
      for (const t of this.transports) {
        // The cursor moves past an announcement only once it is posted: one that fails is tried again
        // next poll (it and everything after it), never skipped.
        for (const a of this.log.since(this.cursors.get(t.name) ?? 0)) {
          if (t.announce) {
            try { await t.announce(a.text); } catch (e) { traceChatError(this.root, `announce-${t.name}`, e); break; }
          }
          this.cursors.set(t.name, a.id);
          if (t.announceFrom === "kept") writeJson(this.cursorPath(t.name), { id: a.id });
        }
      }
      await this.passOnResults();
      if (Date.now() - this.lastPrCheck >= PR_CHECK_MS) {
        this.lastPrCheck = Date.now();
        await this.checkPullRequests();
      }
    } catch (e) {
      traceChatError(this.root, "chat-poll", e);
    }
  }

  /**
   * Posts what the loop did with chat's requests. A result is removed once it was passed on, not
   * before: one whose post fails is tried again next poll (deliver posts before it records, so
   * nothing of the failed try is kept), for up to RESULT_GIVE_UP_MS (see postOnce). One that was
   * posted is never posted again, though its file could not be removed then.
   */
  private async passOnResults(): Promise<void> {
    for (const { path, result: r } of waitingResults(this.root, new Set(this.transports.map((t) => t.name)))) {
      const t = this.transport(r.transport);
      if (!t) continue;
      // The agent hears it too, on its next turn: it proposed the request, and would think it still open.
      const post = () => this.orchestrator.deliver(t.name, r.thread, r.text, mustSend(t, r.thread), `The loop answered: ${r.text}`);
      if (!(await this.postOnce(path, this.doneResults, post, "chat-result", `what the loop did with a request to ${t.via}`))) continue;
      try {
        rmSync(path, { force: true });
        this.doneResults.delete(path);
      } catch { /* removed next poll; it is not posted again */ }
    }
  }

  /**
   * Posts a message that must arrive (`key` names it), unless `told` says it was posted already:
   * true once it is posted, now or before, or given up (see failedPost), and then in `told` until the
   * caller has done what follows (removed the result, saved the pull request's state), so it is never
   * posted twice. False: it is tried again next time.
   */
  private async postOnce(key: string, told: Set<string>, post: () => Promise<void>, where: string, what: string): Promise<boolean> {
    if (told.has(key)) return true;
    try {
      await post();
      this.failing.delete(key);
    } catch (e) {
      if (!this.failedPost(key, where, e, what)) return false;
    }
    told.add(key);
    return true;
  }

  /**
   * Notes that posting `key` failed: traced on its first failure (unless the same failure at the same
   * part is traced already, see traceChatError). True once it has failed for longer than the give-up
   * wait (traced then too, and forgotten), so the caller stops trying it.
   */
  private failedPost(key: string, where: string, e: unknown, what: string): boolean {
    const first = this.failing.get(key);
    if (first === undefined) {
      this.failing.set(key, Date.now());
      traceChatError(this.root, where, e);
      return false;
    }
    if (Date.now() - first < (this.opts.resultGiveUpMs ?? RESULT_GIVE_UP_MS)) return false;
    this.failing.delete(key);
    traceChatError(this.root, where, new Error(`gave up posting ${what} after an hour of tries: ${errorText(e)}`));
    return true;
  }

  /**
   * Tells each thread when a pull request it opened was merged or closed on GitHub. The notice is
   * posted first (through sendOrThrow where the transport has it), and the new state saved only once
   * it was: one that could not be posted is tried again at the next check (only open pull requests
   * are looked at), for up to RESULT_GIVE_UP_MS, as a result is. One that was posted is not posted
   * again, though its state could not be saved then.
   */
  async checkPullRequests(): Promise<void> {
    const gh = new GitHub(this.root);
    for (const thread of this.orchestrator.store.all()) {
      const t = this.transport(thread.transport);
      if (!t) continue;
      for (const h of thread.handoffs.filter((x) => x.pr?.state === "OPEN")) {
        const number = h.pr!.number;
        // By number: a branch name is free again once its pull request is merged and the branch deleted.
        const r = await gh.lookupPr(String(number));
        if (!("pr" in r) || !r.pr || r.pr.state === "OPEN") continue;
        const state = r.pr.state;
        const key = `${thread.key}#${number}`;
        const text = state === "MERGED"
          ? `The pull request for "${h.title}" was merged, so ${h.slugs.join(", ")} ${h.slugs.length > 1 ? "are" : "is"} in the queue as ${h.slugs.length > 1 ? "drafts" : "a draft"}. Ask me to start ${h.slugs.length > 1 ? "one" : "it"} when you are ready.`
          : `The pull request for "${h.title}" was closed without merging, so nothing was added.`;
        const post = () => this.orchestrator.deliver(t.name, thread.thread, text, mustSend(t, thread.thread));
        if (!(await this.postOnce(key, this.toldPrs, post, "chat-pr", `that the pull request for "${h.title}" was ${state.toLowerCase()} to ${t.via}`))) continue;
        await this.orchestrator.withThread(thread.transport, thread.thread, async (cur) => {
          const rec = cur.handoffs.find((x) => x.pr?.number === number);
          if (rec?.pr) rec.pr.state = state;
          this.orchestrator.store.save(cur);
        });
        // Saved: it is no longer open, so it is not looked at again.
        this.toldPrs.delete(key);
      }
    }
  }
}
