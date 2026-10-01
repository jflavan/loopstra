import { existsSync } from "node:fs";
import { join } from "node:path";
import { unavailable } from "../claude";
import { loadConfig, type Config } from "../config";
import { Git } from "../git";
import { heartbeatState, readHeartbeat, readPause } from "../heartbeat";
import { parseIntentFile } from "../intents";
import { localDate } from "../signals";
import { errorText } from "../shell";
import { StopRequested } from "../stop";
import { Trace } from "../trace";
import { AnnouncementLog } from "./announcer";
import { CHAT_SLUG, chatSpentToday, chatTemplate, renderChatPrompt, runChatAgent } from "./agents";
import { handOff, type HandoffOutcome } from "./publish";
import { submitRequest } from "./requests";
import { OrchestratorTurn, type Handoff } from "./schemas";
import { ThreadStore, threadKey, type ThreadState } from "./threads";

/** A message from a person, as a transport delivers it. */
export interface IncomingMessage {
  transport: string;
  /** Where the transport is, in words for the prompt and the intents ("Slack", "the dashboard"). */
  via: string;
  thread: string;
  authorId: string;
  authorName: string;
  text: string;
  /** Whether this person may start drafts (on the transport's acceptors list, or local). */
  canAccept: boolean;
  /** Who may, in words, for telling someone who may not. */
  acceptors: string;
}

/** Sends one message back into the thread. */
export type Send = (text: string) => Promise<void>;

/** A plain yes, and nothing else: anything more goes back into the conversation. */
const YES = /^\s*(y|yes|yep|yeah|yup|sure|ok|okay|go|go ahead|do it|please do|yes please|confirm(ed)?|start it)\s*[.!]*\s*$/i;
export function isYes(text: string): boolean {
  return YES.test(text);
}

/** The words that go first on a fresh session; a resumed one already has them. */
const ANNOUNCEMENTS_IN_CONTEXT = 10;

export class Orchestrator {
  readonly store: ThreadStore;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {
    this.store = new ThreadStore(root);
  }

  /**
   * Runs `fn` with the thread's state, after anything already running on that thread: one thing at
   * a time per thread, so a turn and a background update never write over each other.
   */
  withThread<T>(transport: string, thread: string, fn: (t: ThreadState) => Promise<T>): Promise<T> {
    const key = threadKey(transport, thread);
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn(this.store.get(transport, thread)));
    const tail = next.catch(() => {});
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return next;
  }

  /** Puts a message from Loopstra into a thread's log (not through the agent) and sends it. */
  async deliver(transport: string, thread: string, text: string, send: Send): Promise<void> {
    await this.withThread(transport, thread, async (t) => {
      this.store.addMessage(t, { from: "loopstra", text });
      this.store.save(t);
    });
    await send(text);
  }

  /** Handles one message: a yes to a waiting proposal, or a turn of the conversation. */
  handle(m: IncomingMessage, send: Send): Promise<void> {
    return this.withThread(m.transport, m.thread, async (t) => {
      this.store.addMessage(t, { from: "person", author: m.authorName, text: m.text });
      this.store.save(t);
      const say: Send = async (text) => {
        this.store.addMessage(t, { from: "loopstra", text });
        this.store.save(t);
        try { await send(text); } catch { /* the transport says why itself; the log has the message */ }
      };
      let cfg: Config;
      try { cfg = await loadConfig(this.root); } catch (e) {
        await say(`Loopstra's settings have a problem, so I cannot answer until an engineer fixes them: ${errorText(e)}`);
        return;
      }
      const trace = Trace.open(this.root, () => {});
      try {
        trace.event(CHAT_SLUG, "chat-message", { transport: m.transport, thread: m.thread, from: m.authorName, chars: m.text.length });
        let declined: string | null = null;
        if (t.pending) {
          const pending = t.pending;
          t.pending = null;
          this.store.save(t);
          if (isYes(m.text)) {
            if (pending.kind === "handoff") await this.doHandoff(cfg, trace, t, m, pending.handoff, say);
            else await this.doAccept(cfg, m, pending.slug, say);
            return;
          }
          declined = pending.kind === "handoff" ? `You proposed handing off "${pending.handoff.title}"; the person did not say yes, so nothing was written.` : `You proposed starting ${pending.slug}; the person did not say yes, so it was not started.`;
        }
        await this.turn(cfg, trace, t, m, say, declined);
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        trace.event(CHAT_SLUG, "error", { where: "chat", error: errorText(e) });
        await say("Something went wrong on my side answering that. Please try again; an engineer can find the details in the trace.");
      } finally {
        this.store.save(t);
        trace.close();
      }
    });
  }

  private budgetLeft(cfg: Config, trace: Trace): number {
    return cfg.chat.max_budget_usd_per_day - chatSpentToday(trace);
  }

  private async turn(cfg: Config, trace: Trace, t: ThreadState, m: IncomingMessage, say: Send, declined: string | null): Promise<void> {
    const left = this.budgetLeft(cfg, trace);
    if (left <= 0) {
      await say(`I have used today's chat budget ($${cfg.chat.max_budget_usd_per_day.toFixed(2)}), so I cannot answer until tomorrow. An engineer can raise chat.max_budget_usd_per_day in loopstra/config.yaml.`);
      return;
    }
    const message = await this.messageBlock(cfg, t, m, declined);
    const maxBudgetUsd = Math.max(0.01, Math.min(cfg.claude.max_budget_usd, left));
    const fresh = async () => `${renderChatPrompt(await chatTemplate(this.root, "orchestrator"), { main_branch: cfg.main_branch })}\n\n${message}`;
    let r = await runChatAgent({
      root: this.root, cfg, trace, name: "orchestrator", schema: OrchestratorTurn, model: cfg.chat.model, maxBudgetUsd,
      prompt: t.sessionId ? message : await fresh(), resume: t.sessionId,
    });
    // The session is gone (cleared, or another machine): start a new one; this thread's record of its hand-offs carries over.
    if (!r.ok && r.reason === "no-session") {
      t.sessionId = null;
      r = await runChatAgent({ root: this.root, cfg, trace, name: "orchestrator", schema: OrchestratorTurn, model: cfg.chat.model, maxBudgetUsd, prompt: await fresh() });
    }
    if (r.sessionId) t.sessionId = r.sessionId;
    t.lastAnnouncementSeen = new AnnouncementLog(this.root).lastId();
    if (!r.ok) {
      await say(unavailable(r.reason)
        ? `I cannot reach the assistant right now (${r.detail.replace(/^the assistant is unavailable: /, "")}). Please try again in a few minutes.`
        : r.reason === "budget" ? "That answer hit its spending limit before it finished. Try asking something narrower."
        : r.reason === "timeout" ? "That took too long to answer. Please try again, or ask something narrower."
        : "Something went wrong answering that. Please try again; an engineer can find the details in the trace.");
      return;
    }
    const turn = r.value;
    if (turn.reply.trim()) await say(turn.reply.trim());
    if (turn.handoff) await this.proposeHandoff(t, m, turn.handoff, say);
    else if (turn.accept) await this.proposeAccept(t, m, turn.accept.slug.trim(), say);
  }

  /** The context Loopstra vouches for, then the person's own words, delimited. */
  private async messageBlock(cfg: Config, t: ThreadState, m: IncomingMessage, declined: string | null): Promise<string> {
    const remote = await new Git(this.root).remoteName().catch(() => null);
    const log = new AnnouncementLog(this.root);
    const since = t.sessionId ? log.since(t.lastAnnouncementSeen) : log.since(0);
    const announced = since.slice(-ANNOUNCEMENTS_IN_CONTEXT);
    const handoffs = t.handoffs.map((h) => `- "${h.title}" (${h.slugs.join(", ")}): ${h.pr ? `pull request ${h.pr.url}, ${h.pr.state.toLowerCase()}` : "added to the queue without a pull request"}`);
    const lines = [
      `From: ${m.authorName}, ${m.canAccept ? "who may ask you to start drafts" : `who may not start drafts (${m.acceptors} may)`}`,
      `Where: ${m.via}`,
      `Today: ${localDate()}`,
      `Main branch: ${cfg.main_branch}; ${remote ? "intents are added through a pull request" : "no GitHub remote, so intents are added to the queue directly"}`,
      `Handed off from this conversation so far:${handoffs.length ? `\n${handoffs.join("\n")}` : " nothing yet"}`,
      `Announced by Loopstra since the last message:${announced.length ? `\n${announced.map((a) => `- ${a.text}`).join("\n")}` : " nothing"}`,
    ];
    if (declined) lines.push(declined);
    const text = m.text.replace(/<\/?(message|context)\b/gi, (s) => s.replace("<", "&lt;"));
    return `<context>\n${lines.join("\n")}\n</context>\n<message from=${JSON.stringify(m.authorName)}>\n${text}\n</message>`;
  }

  /** Drafts on the main checkout, by slug; the status of anything else. */
  private async statusOf(slug: string): Promise<string | null> {
    const path = join(this.root, "intent", slug, "intent.md");
    if (!existsSync(path)) return null;
    try { return parseIntentFile(await Bun.file(path).text()).frontmatter.status; } catch { return "unreadable"; }
  }

  private async proposeHandoff(t: ThreadState, m: IncomingMessage, h: Handoff, say: Send): Promise<void> {
    const updates = [...new Set(h.updates.map((s) => s.trim()).filter(Boolean))];
    const bad: string[] = [];
    for (const s of updates) {
      const st = await this.statusOf(s);
      if (st !== "draft") bad.push(st === null ? `${s} does not exist` : `${s} is ${st}`);
    }
    if (bad.length) {
      await say(`I cannot hand that off as it is: only drafts can be changed that way, and ${bad.join(", ")}. A change that has started has to be closed and a new one written, or edited by a person in its intent.md.`);
      return;
    }
    t.pending = { kind: "handoff", handoff: { ...h, updates }, by: m.authorId, at: new Date().toISOString() };
    const remote = await new Git(this.root).remoteName().catch(() => null);
    const ask = remote ? "Shall I write this up as a pull request?" : "Shall I write this up and add it to the queue as drafts?";
    await say(`Here is what I would hand to the writer:\n\n${h.title.trim()}\n\n${h.brief.trim()}${updates.length ? `\n\nIt changes these drafts: ${updates.join(", ")}.` : ""}\n\n${ask} Reply yes to go ahead; anything else and we keep talking.`);
  }

  private async proposeAccept(t: ThreadState, m: IncomingMessage, slug: string, say: Send): Promise<void> {
    if (!m.canAccept) {
      await say(`You cannot start work from here; ${m.acceptors} can. They can ask me, or set the status line in intent/${slug}/intent.md to accepted.`);
      return;
    }
    const st = await this.statusOf(slug);
    if (st === null) { await say(`There is no change called ${slug} in the main code yet. If it is in a pull request, that needs to be merged first.`); return; }
    if (st !== "draft") { await say(`${slug} is ${st}, not a draft, so there is nothing to start.`); return; }
    t.pending = { kind: "accept", slug, by: m.authorId, at: new Date().toISOString() };
    await say(`Start work on ${slug} now? Reply yes to go ahead.`);
  }

  private async doHandoff(cfg: Config, trace: Trace, t: ThreadState, m: IncomingMessage, h: Handoff, say: Send): Promise<void> {
    const left = this.budgetLeft(cfg, trace);
    if (left <= 0) {
      await say(`I have used today's chat budget, so I cannot write this up until tomorrow. Say yes again then, or an engineer can raise chat.max_budget_usd_per_day.`);
      t.pending = { kind: "handoff", handoff: h, by: m.authorId, at: new Date().toISOString() };
      return;
    }
    await say("Writing it up now. This can take a few minutes.");
    const out: HandoffOutcome = await handOff({
      root: this.root, cfg, trace, handoff: h, author: m.authorName, authorId: m.authorId, transport: m.transport, thread: m.thread, via: m.via,
      maxBudgetUsd: Math.min(cfg.claude.max_budget_usd, left),
    });
    if (out.kind === "failed") { await say(`I could not write that up: ${out.problem} Nothing was opened.`); return; }
    const slugs = out.intents.map((i) => i.slug);
    t.handoffs.push({ title: h.title.trim(), slugs, at: new Date().toISOString(), by: m.authorName, pr: out.kind === "pr" ? { number: out.number, url: out.url, branch: out.branch, state: "OPEN" } : null, local: out.kind === "local" });
    const list = out.intents.map((i) => `${i.slug}${i.update ? " (updated)" : ""}`).join(", ");
    if (out.kind === "pr") await say(`Opened a pull request with ${list}: ${out.url}\nOnce it is merged they are drafts in the queue; ask me to start one when you are ready.`);
    else await say(`Wrote ${list}. ${this.loopWhen(cfg, "adds them to the queue as drafts")}`);
  }

  private async doAccept(cfg: Config, m: IncomingMessage, slug: string, say: Send): Promise<void> {
    if (!m.canAccept) { await say(`Only ${m.acceptors} can start work, so I have not started ${slug}.`); return; }
    const st = await this.statusOf(slug);
    if (st !== "draft") { await say(`${slug} is ${st ?? "not in the main code"} now, not a draft, so I have not started it.`); return; }
    submitRequest(this.root, { kind: "accept", slug, by: m.authorId, byName: m.authorName, transport: m.transport, thread: m.thread });
    await say(`Asked the loop to start ${slug}. ${this.loopWhen(cfg, "starts it")}`);
  }

  /** When the loop will act on a request, in words: on its next check, or when it is started. */
  private loopWhen(cfg: Config, what: string): string {
    const loop = heartbeatState(readHeartbeat(this.root), cfg.poll_seconds, new Date(), { pause: readPause(this.root) });
    if (loop.state === "stopped") return `The loop is not running right now, so it ${what} once someone runs loopstra start. I will say here when it has.`;
    if (loop.state === "not-responding") return `The loop is not responding right now; it ${what} once it is running again. I will say here when it has.`;
    return `It ${what} on its next check, within about ${cfg.poll_seconds} seconds, and I will say here when it has.`;
  }
}
