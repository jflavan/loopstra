import { existsSync } from "node:fs";
import { join } from "node:path";
import { askedWords, askText, offers, retryOptions, type RequestShape } from "../actions";
import { limitOf } from "../budget";
import { unavailable } from "../claude";
import { loadConfig, type Config } from "../config";
import { Git } from "../git";
import { heartbeatState, readHeartbeat, readLoopHold, readPause } from "../heartbeat";
import { humanGates, parseIntentFile, plainStatus, readIntent, SLUG, type Frontmatter, type Status } from "../intents";
import { localDate } from "../signals";
import { errorText } from "../shell";
import { StopRequested } from "../stop";
import { Trace } from "../trace";
import { aboutContext, type About } from "./about";
import { AnnouncementLog } from "./announcer";
import { CHAT_SLUG, chatSpentToday, chatTemplate, MIN_SESSION_USD, renderChatPrompt, runChatAgent } from "./agents";
import { handOff, type HandoffOutcome } from "./publish";
import { submitRequest, type RequestBody } from "../requests";
import { readQuestion } from "../questions";
import { OrchestratorTurn, type Handoff, type ProposedAction } from "./schemas";
import { oneLine, ThreadStore, threadKey, type ThreadState } from "./threads";

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
  /** The change (and session) the person opened chat from, sent with the first message from there (the dashboard's drawer). */
  about?: About;
}

/** Sends one message back into the thread. */
export type Send = (text: string) => Promise<void>;

/** A plain yes, and nothing else: anything more goes back into the conversation. */
const YES = /^\s*(y|yes|yep|yeah|yup|sure|ok|okay|go|go ahead|do it|please do|yes please|confirm(ed)?|start it)\s*[.!]*\s*$/i;
export function isYes(text: string): boolean {
  return YES.test(text);
}

/** At most this many announcements go into one message's context. */
const ANNOUNCEMENTS_IN_CONTEXT = 10;
/** How many of the main branch's newest commits go into each message's context. */
const HISTORY_IN_CONTEXT = 30;
/** How long a proposal waits for its yes. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;

/**
 * A display name is the person's own choice: kept to one line with no tags, wherever it goes, so it
 * cannot end the context block or open another.
 */
function plainName(s: string): string {
  return s.replace(/[\s<>"]+/g, " ").trim() || "someone";
}

/** Characters that show as nothing (U+200B-U+200D, U+2060, U+FEFF): one inside a tag would hide it from a plain match. */
const INVISIBLE = /[​-‍⁠﻿]/g;

/**
 * Text with any tag that could end the context or message block, or open another, made harmless, and
 * its look-alikes too: "< /context", "</ context>", in any case, with invisible characters inside (they go).
 */
export function untagged(s: string): string {
  return s.replace(INVISIBLE, "").replace(/<\s*\/?\s*(message|context)\b/gi, (x) => `&lt;${x.slice(1)}`);
}

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

  /**
   * Puts a message from Loopstra into a thread's log (not through the agent) and sends it. `since`:
   * a line for the agent's next turn about it (see ThreadState.since), as for a request's result.
   */
  async deliver(transport: string, thread: string, text: string, send: Send, since?: string): Promise<void> {
    await this.withThread(transport, thread, async (t) => {
      this.store.addMessage(t, { from: "loopstra", text });
      if (since) this.store.noteSince(t, since);
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
        // Only the person a proposal was made to can confirm it; anyone else's message is a turn.
        if (t.pending && t.pending.by === m.authorId) {
          const pending = t.pending;
          t.pending = null;
          this.store.save(t);
          // A yes long after the question is not an answer to it: things may have moved on.
          const expired = Date.now() - Date.parse(pending.at) > PENDING_TTL_MS;
          if (isYes(m.text) && !expired) {
            if (pending.kind === "handoff") await this.doHandoff(cfg, trace, t, m, pending.handoff, say);
            else if (pending.kind === "action") await this.doAction(cfg, t, m, pending.request, say);
            else await this.doAccept(cfg, t, m, pending.slug, say);
            return;
          }
          const why = expired ? "the person's answer came over a day later, so it was not acted on" : "the person did not say yes";
          declined = pending.kind === "handoff" ? `You proposed handing off "${pending.handoff.title}"; ${why}, so nothing was written. Propose it again if it still stands.`
            : pending.kind === "action" ? `You proposed: "${pending.ask}"; ${why}, so nothing was done. Propose it again if it still stands.`
            : `You proposed starting ${pending.slug}; ${why}, so it was not started. Propose it again if it still stands.`;
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
    return limitOf(cfg.chat.max_budget_usd_per_day) - chatSpentToday(trace);
  }

  private budgetUsedUp(cfg: Config, why: "today" | "held" = "today"): string {
    if (why === "held") return "Other conversations are using what is left of today's chat budget right now. Please try again in a few minutes.";
    const d = cfg.chat.max_budget_usd_per_day;
    return `I have used today's chat budget${d === undefined ? "" : ` ($${d.toFixed(2)})`}, so I cannot answer until tomorrow. An engineer can raise or remove the limit with \`loopstra setup budgets\`.`;
  }

  private async turn(cfg: Config, trace: Trace, t: ThreadState, m: IncomingMessage, say: Send, declined: string | null): Promise<void> {
    // A quick answer without building the message; the session itself holds its share of what is left (runChatAgent).
    if (this.budgetLeft(cfg, trace) < MIN_SESSION_USD) {
      await say(this.budgetUsedUp(cfg));
      return;
    }
    const seenUpTo = new AnnouncementLog(this.root).lastId();
    const told = t.since.length;
    const message = await this.messageBlock(cfg, t, m, declined, seenUpTo);
    const capUsd = limitOf(cfg.claude.max_budget_usd);
    const fresh = async () => `${renderChatPrompt(await chatTemplate(this.root, "orchestrator"), { main_branch: cfg.main_branch })}\n\n${message}`;
    let r = await runChatAgent({
      root: this.root, cfg, trace, name: "orchestrator", schema: OrchestratorTurn, model: cfg.chat.model, capUsd,
      prompt: t.sessionId ? message : await fresh(), resume: t.sessionId,
    });
    // The session is gone (cleared, or another machine): start a new one; this thread's record of its hand-offs carries over.
    if (!r.ok && r.reason === "no-session") {
      t.sessionId = null;
      r = await runChatAgent({ root: this.root, cfg, trace, name: "orchestrator", schema: OrchestratorTurn, model: cfg.chat.model, capUsd, prompt: await fresh() });
    }
    if (r.sessionId) t.sessionId = r.sessionId;
    // Only what was in the message block counts as seen, and only once the agent has had it: a failed
    // turn shows them again next time. Announcements made during the turn come next time.
    // The same for the lines of what happened since its last turn.
    if (r.ok) {
      t.lastAnnouncementSeen = seenUpTo;
      t.since = t.since.slice(told);
    }
    if (!r.ok && r.budgetUsedUp) {
      await say(this.budgetUsedUp(cfg, r.budgetUsedUp));
      return;
    }
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
    else if (turn.accept) {
      // The prompt says never both; when it happens anyway, the start goes ahead and the trace says what was dropped.
      if (turn.action) trace.event(CHAT_SLUG, "error", { where: "chat", error: `the turn set both accept and action, so its ${turn.action.kind} of ${turn.action.slug} was dropped` });
      await this.proposeAccept(t, m, turn.accept.slug.trim(), say);
    }
    else if (turn.action) await this.proposeAction(cfg, trace, t, m, turn.action, say);
  }

  /** The context Loopstra vouches for, then the person's own words, delimited. */
  private async messageBlock(cfg: Config, t: ThreadState, m: IncomingMessage, declined: string | null, upTo: number): Promise<string> {
    const remote = await new Git(this.root).remoteName().catch(() => null);
    const log = new AnnouncementLog(this.root);
    const since = (t.sessionId ? log.since(t.lastAnnouncementSeen) : log.since(0)).filter((a) => a.id <= upTo);
    const announced = since.slice(-ANNOUNCEMENTS_IN_CONTEXT);
    const handoffs = t.handoffs.map((h) => `- "${h.title}" (${h.slugs.join(", ")}): ${h.pr ? `pull request ${h.pr.url}, ${h.pr.state.toLowerCase()}` : "added to the queue without a pull request"}`);
    const name = plainName(m.authorName);
    const history = await this.recentHistory(cfg);
    const lines = [
      `From: ${name}, ${m.canAccept ? "who may ask you to start drafts and to act on changes" : `who may not start drafts or act on changes (${m.acceptors} may)`}`,
      `Where: ${m.via}`,
      `Today: ${localDate()}`,
      `Main branch: ${cfg.main_branch}; ${remote ? "intents are added through a pull request" : "no GitHub remote, so intents are added to the queue directly"}`,
      `Handed off from this conversation so far:${handoffs.length ? `\n${handoffs.join("\n")}` : " nothing yet"}`,
      `Recent changes on ${cfg.main_branch} (newest first):${history.length ? `\n${history.join("\n")}` : " none found"}`,
      `Announced by Loopstra since the last message:${announced.length ? `\n${announced.map((a) => `- ${a.text}`).join("\n")}` : " nothing"}`,
    ];
    if (m.about) {
      // Read from the change's own files, which hold people's words: never able to end the context block.
      const about = await aboutContext(this.root, m.about).catch(() => "");
      if (about) lines.push(`About this change (from where the person opened chat):\n${untagged(about)}`);
    }
    if (t.since.length) lines.push(`Since your last turn:\n${t.since.map((l) => `- ${untagged(oneLine(l, 1000))}`).join("\n")}`);
    if (declined) lines.push(declined);
    const text = untagged(m.text);
    return `<context>\n${lines.join("\n")}\n</context>\n<message from=${JSON.stringify(name)}>\n${text}\n</message>`;
  }

  /**
   * The newest commits on the main branch, one line each (date and subject), read by the runtime.
   * The agents have no git of their own: `git show` and `git log -p` could read any file's content.
   */
  private async recentHistory(cfg: Config): Promise<string[]> {
    const r = await new Git(this.root).run(["log", `-${HISTORY_IN_CONTEXT}`, "--format=- %ad %s", "--date=short", cfg.main_branch, "--"], true).catch(() => null);
    return r && r.code === 0 ? r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  }

  /** Drafts on the main checkout, by slug; the status of anything else. */
  private async statusOf(slug: string): Promise<string | null> {
    if (!SLUG.test(slug)) return null;
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
    if (this.budgetLeft(cfg, trace) < MIN_SESSION_USD) {
      await say(`I have used today's chat budget, so I cannot write this up until tomorrow. Say yes again then, or an engineer can raise or remove the limit with \`loopstra setup budgets\`.`);
      t.pending = { kind: "handoff", handoff: h, by: m.authorId, at: new Date().toISOString() };
      return;
    }
    await say("Writing it up now. This can take a few minutes.");
    const out: HandoffOutcome = await handOff({
      root: this.root, cfg, trace, handoff: h, author: m.authorName, authorId: m.authorId, transport: m.transport, thread: m.thread, via: m.via,
      maxBudgetUsd: limitOf(cfg.claude.max_budget_usd),
    });
    if (out.kind === "failed") {
      // Stopped by the budget: the proposal still stands, so a later yes writes it up.
      if (out.budget) t.pending = { kind: "handoff", handoff: h, by: m.authorId, at: new Date().toISOString() };
      this.store.noteSince(t, `${plainName(m.authorName)} said yes to handing off "${h.title.trim()}", but it could not be written up: ${out.problem}`);
      await say(`I could not write that up: ${out.problem}${out.pushed ? "" : " Nothing was opened."}`);
      return;
    }
    const slugs = out.intents.map((i) => i.slug);
    this.store.noteSince(t, `${plainName(m.authorName)} said yes: "${h.title.trim()}" was written up as ${slugs.join(", ")}${out.kind === "pr" ? `, in pull request ${out.url}` : ", and the loop was asked to add it to the queue"}.`);
    t.handoffs.push({ title: h.title.trim(), slugs, at: new Date().toISOString(), by: m.authorName, pr: out.kind === "pr" ? { number: out.number, url: out.url, branch: out.branch, state: "OPEN" } : null, local: out.kind === "local" });
    const list = out.intents.map((i) => `${i.slug}${i.update ? " (updated)" : ""}`).join(", ");
    if (out.kind === "pr") await say(`Opened a pull request with ${list}: ${out.url}\nOnce it is merged they are drafts in the queue; ask me to start one when you are ready.`);
    else await say(`Wrote ${list}. ${this.loopWhen(cfg, "adds them to the queue as drafts")}`);
  }

  private async doAccept(cfg: Config, t: ThreadState, m: IncomingMessage, slug: string, say: Send): Promise<void> {
    if (!m.canAccept) { await say(`Only ${m.acceptors} can start work, so I have not started ${slug}.`); return; }
    const st = await this.statusOf(slug);
    if (st !== "draft") { await say(`${slug} is ${st ?? "not in the main code"} now, not a draft, so I have not started it.`); return; }
    submitRequest(this.root, { kind: "accept", slug, by: m.authorId, byName: m.authorName, via: m.via, transport: m.transport, thread: m.thread });
    this.store.noteSince(t, `${plainName(m.authorName)} said yes: asked the loop to start ${slug}.`);
    await say(`Asked the loop to start ${slug}. ${this.loopWhen(cfg, "starts it")}`);
  }

  /**
   * Checks an action against the change as it is now (what it offers a person; see offers), words
   * the question, and waits for the person's yes. The request names the status the change has now,
   * so the loop refuses it if the change moves on before the yes.
   */
  private async proposeAction(cfg: Config, trace: Trace, t: ThreadState, m: IncomingMessage, a: ProposedAction, say: Send): Promise<void> {
    const slug = a.slug.trim();
    if (!m.canAccept) {
      await say(`You cannot change work from here; ${m.acceptors} can. They can ask me, or edit intent/${slug}/intent.md.`);
      return;
    }
    if (!SLUG.test(slug) || !existsSync(join(this.root, "intent", slug, "intent.md"))) { await say(`There is no change called ${slug} in the main code.`); return; }
    let fm: Frontmatter;
    try { fm = (await readIntent(this.root, slug)).file.frontmatter; } catch { await say(`${slug}'s intent.md cannot be read, so I cannot do that.`); return; }
    const offered = offers(fm, humanGates(cfg), fm.status === "blocked" ? retryOptions(trace, slug, fm.note) : []).filter((o) => o.kind === a.kind);
    if (!offered.length) {
      const held = !!fm.hold.trim();
      // A hold on a held change, or a release of one not held: its status is not the reason.
      if (a.kind === "hold" && held) await say(`${slug} is held already.`);
      else if (a.kind === "release" && !held) await say(`${slug} is not held.`);
      else await say(`${slug} is ${plainStatus(fm.status)} now, so that is not something I can do to it.`);
      return;
    }
    const note = a.note.trim();
    const expect = fm.status;
    let request: RequestBody & RequestShape;
    switch (a.kind) {
      case "send-back":
        if (!note) { await say("Tell me what should change, and I will send it back with that note."); return; }
        request = { kind: "send-back", slug, expect, note };
        break;
      // The status named in the note when the block offers it, else the first the block names (see retryOptions).
      case "retry": request = { kind: "retry", slug, expect: "blocked", to: (offered.find((o) => o.to === note) ?? offered[0]!).to as Status }; break;
      case "priority":
        if (!a.priority) { await say("Which priority: urgent, high, normal or low?"); return; }
        request = { kind: "priority", slug, expect, priority: a.priority };
        break;
      case "hold": request = { kind: "hold", slug, expect, reason: note }; break;
      case "approve": request = { kind: "approve", slug, expect }; break;
      case "close": request = { kind: "close", slug, expect }; break;
      case "release": request = { kind: "release", slug, expect }; break;
      case "answer": {
        if (!note) { await say("Tell me the answer, and I will pass it on."); return; }
        // The question waiting now: the yes is to answering that one, so the request names it (the loop refuses it once another waits).
        const open = readQuestion(this.root, slug)?.open;
        const asked = open && !open.answer && typeof open.at === "string" ? open : null;
        // `expect`, `note` and `asked` word the question (see askText); the request itself is the answer and the question's time (see doAction).
        request = { kind: "answer", slug, text: note, expect, note, ...(asked ? { question: asked.at, asked: String(asked.text ?? "") } : {}) };
        break;
      }
    }
    const ask = askText(request, slug);
    t.pending = { kind: "action", request, ask, by: m.authorId, at: new Date().toISOString() };
    // A quoted note or reason stands on its own lines (see askText); the go-ahead comes after it.
    await say(`${ask}${ask.includes("\n") ? "\n\n" : " "}Reply yes to go ahead.`);
  }

  private async doAction(cfg: Config, t: ThreadState, m: IncomingMessage, request: RequestBody & RequestShape, say: Send): Promise<void> {
    if (!m.canAccept) { await say(`Only ${m.acceptors} can do that, so I have not.`); return; }
    // An answer is its text and the question it answers (none from a proposal made before questions were named: then whichever waits).
    const body: RequestBody = request.kind === "answer"
      ? { kind: "answer", slug: request.slug, text: request.text, ...(request.question === undefined ? {} : { question: request.question }) }
      : request;
    submitRequest(this.root, { ...body, by: m.authorId, byName: m.authorName, via: m.via, transport: m.transport, thread: m.thread });
    this.store.noteSince(t, `${plainName(m.authorName)} said yes: asked the loop to ${askedWords(request, request.slug)}.`);
    await say(`Asked the loop to do it. ${this.loopWhen(cfg, "does it")}`);
  }

  /**
   * When the loop will act on a request, in words. `what` is what it does ("starts it"). A running
   * loop applies requests within a few seconds, paused or not; a person's pause only keeps new steps
   * waiting. A stopped loop applies them once it is started.
   */
  private loopWhen(cfg: Config, what: string): string {
    const hold = readLoopHold(this.root);
    const loop = heartbeatState(readHeartbeat(this.root), cfg.poll_seconds, new Date(), { pause: readPause(this.root), hold });
    const held = hold ? ` The loop is paused by ${hold.by}, so new steps then wait until someone resumes it.` : "";
    if (loop.state === "stopped") return `The loop is not running right now, so it ${what} once someone runs loopstra start.${held} I will say here when it has.`;
    if (loop.state === "not-responding") return `The loop is not responding right now; it ${what} once it is running again. I will say here when it has.`;
    if (hold) return `It ${what} within a few seconds. The loop is paused by ${hold.by}, so new steps wait until someone resumes it. I will say here when it has.`;
    return `It ${what} within a few seconds, and I will say here when it has.`;
  }
}
