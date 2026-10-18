import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionControl } from "./claude";
import { MESSAGE_LEAD, MESSAGE_TAIL, REDIRECT_LEAD, REDIRECT_TAIL, steerable as isSteerable } from "./console/steerable";
import { appendConversation, type ConversationEntry } from "./conversation";
import type { StepContext } from "./context";
import { inboxDir, inboxFor, markDone, waitingIn, type Done, type InboxMessage } from "./inbox";
import { errorText } from "./shell";
import { StopRequested, stopRequested } from "./stop";

/** How often the runner looks in the inbox besides when it changes (a watch may miss an event). */
const LOOK_MS = 1000;

/** A message as the session reads it. Starts with MESSAGE_LEAD, which the console's transcript looks for. */
export function messageText(m: InboxMessage): string {
  return `${MESSAGE_LEAD} ${m.by}, who is watching this work from ${m.via}: ${m.text.trim()}\n\n${MESSAGE_TAIL}`;
}

/** A redirect as the resumed session's prompt. Starts with REDIRECT_LEAD. */
export function redirectText(m: InboxMessage): string {
  return `${REDIRECT_LEAD} ${m.by} (${m.via}): ${m.text.trim()}\n\n${REDIRECT_TAIL}`;
}

/** Traces a problem without ever failing: the trace may have closed meanwhile. */
function traceError(ctx: StepContext, more: Record<string, unknown>): void {
  try { ctx.trace.event(ctx.slug, "error", more); } catch { /* the trace closed meanwhile */ }
}

/** Records an entry without ever failing the session: a record that cannot be written is traced. Gives back its write. */
function record(ctx: StepContext, e: ConversationEntry): Promise<void> {
  return appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, e).catch((err: unknown) => {
    traceError(ctx, { where: "conversation", error: errorText(err) });
  });
}

/** A message's key across this process's changes and repositories. */
const keyOf = (ctx: StepContext, m: InboxMessage) => `${resolve(ctx.root)}|${ctx.slug}|${m.id}`;

/** The messages kept for the next session whose record is being written now (see keepForNext). */
const recording = new Set<string>();
/** The messages kept for the next session whose record landed, but whose move to delivered/ failed. */
const recorded = new Set<string>();

/**
 * A message that will not reach its session: kept in conversation.md for the next one. It is marked
 * done only once its entry is committed: one whose record fails (the loop started stopping, and
 * commitRecord refuses) stays in the inbox, for the next sweep. While its record is in flight, a second
 * look leaves it alone; once it landed, a later look only moves it. Never throws: a problem is traced.
 */
async function keepForNext(ctx: StepContext, m: InboxMessage): Promise<void> {
  const key = keyOf(ctx, m);
  if (recording.has(key)) return;
  recording.add(key);
  try {
    if (!recorded.has(key)) {
      await appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "later", who: m.by, via: m.via, text: m.text, at: new Date() });
      recorded.add(key);
    }
    if (markDone(ctx.root, ctx.slug, m, "next session") || !waiting(ctx, m)) recorded.delete(key);
  } catch (e) {
    // A stopping loop records nothing: the message waits for the next step's sweep.
    if (!(e instanceof StopRequested)) traceError(ctx, { where: "conversation", error: errorText(e) });
  } finally {
    recording.delete(key);
  }
}

/** True while the message's file is still in the inbox (its move to delivered/ failed, or nobody moved it). */
function waiting(ctx: StepContext, m: InboxMessage): boolean {
  return existsSync(join(inboxDir(ctx.root, ctx.slug), `${m.id}.json`));
}

/**
 * Delivers what waits in the inbox for session `seq` (phase `name`) while it runs: a message is written
 * to it (a work session only; a check's is kept for the next session), a stop ends it, a redirect resumes
 * it the new way. Looks when the inbox changes and every second. Gives back what ends the watching; once
 * it ends, what is left for this session goes to the next one (stops are dropped), and it resolves once
 * every record it started has landed (or failed, traced), so the next session's prompt has them. After a
 * stop request what is left stays where it is, for the next step's sweep: the loop records nothing while it stops.
 *
 * A message is written to the session once only: when its move to delivered/ fails (a file held open on
 * Windows), the error is traced once and the next look tries the move again. It is traced and recorded
 * once moved.
 */
export function deliverInbox(ctx: StepContext, seq: number, name: string, ctl: SessionControl): () => Promise<void> {
  const steerable = isSteerable(name);
  /** The records started while watching. */
  const pending: Promise<void>[] = [];
  /** The messages already written to the session (or the stops already given to it), by id. */
  const sent = new Set<string>();
  /** The messages whose failed move is traced already. */
  const moveFailed = new Set<string>();
  /** Moves a message sent to the session to delivered/; true once it is moved (by this look, never twice). */
  const settle = (m: InboxMessage, how: Done): boolean => {
    if (markDone(ctx.root, ctx.slug, m, how)) {
      moveFailed.delete(m.id);
      return true;
    }
    if (waiting(ctx, m) && !moveFailed.has(m.id)) {
      moveFailed.add(m.id);
      traceError(ctx, { where: "inbox", seq, id: m.id, error: "a message given to the session could not be moved to delivered/; the next look tries again" });
    }
    return false;
  };
  /** A message moved to delivered/: traced, and (but a stop) recorded. */
  const delivered = (m: InboxMessage) => {
    if (m.kind === "stop") return ctx.trace.event(ctx.slug, "steer", { kind: "stop", by: m.by, via: m.via, seq });
    ctx.trace.event(ctx.slug, "steer", { kind: m.kind, by: m.by, via: m.via, seq, text: m.text });
    pending.push(record(ctx, { kind: m.kind, who: m.by, via: m.via, phase: name, text: m.text, at: new Date() }));
  };
  const look = () => {
    for (const m of inboxFor(ctx.root, ctx.slug, seq)) {
      // Given to the session once only: a loop killed before the move delivers it again, at worst twice.
      if (!sent.has(m.id)) {
        if (m.kind === "stop") {
          // A stop that comes once the session has finished is too late, and is dropped.
          if (!ctl.stop(m.by)) { markDone(ctx.root, ctx.slug, m, "dropped"); continue; }
        } else if (!steerable) {
          pending.push(keepForNext(ctx, m));
          continue;
        } else if (!(m.kind === "message" ? ctl.message(messageText(m)) : ctl.redirect(redirectText(m), m.by))) {
          continue;
        }
        sent.add(m.id);
      }
      if (settle(m, "delivered")) delivered(m);
    }
  };
  // Looking must never fail the session: a problem is traced, and the next look tries again.
  const safeLook = () => {
    try { look(); } catch (e) {
      traceError(ctx, { where: "inbox", seq, error: errorText(e) });
    }
  };
  let watcher: FSWatcher | null = null;
  try {
    mkdirSync(inboxDir(ctx.root, ctx.slug), { recursive: true });
    watcher = watch(inboxDir(ctx.root, ctx.slug), () => safeLook());
    watcher.on("error", () => { watcher?.close(); watcher = null; });
  } catch { /* no watching: the timer looks */ }
  const timer = setInterval(safeLook, LOOK_MS);
  safeLook();
  return async () => {
    clearInterval(timer);
    watcher?.close();
    watcher = null;
    if (!stopRequested()) {
      try {
        for (const m of inboxFor(ctx.root, ctx.slug, seq)) {
          // Given to the session already, but not moved: one more try (else the next sweep keeps it for the next session).
          if (sent.has(m.id)) { if (settle(m, "delivered")) delivered(m); }
          else if (m.kind === "message" || m.kind === "redirect") pending.push(keepForNext(ctx, m));
          else markDone(ctx.root, ctx.slug, m, "dropped");
        }
      } catch (e) {
        traceError(ctx, { where: "inbox", seq, error: errorText(e) });
      }
    }
    await Promise.all(pending);
  };
}

/**
 * At a step's start, nothing of the change runs: what a stopped or killed loop left in its inbox goes
 * to conversation.md for the sessions to come (messages, redirects); stops are dropped. Resolves once
 * those records landed, so the step's first session reads them. Never fails the step: a problem is
 * traced, and what was not recorded stays for the next step's sweep.
 */
export async function sweepInbox(ctx: StepContext): Promise<void> {
  try {
    for (const m of waitingIn(ctx.root, ctx.slug)) {
      if (m.kind === "stop") markDone(ctx.root, ctx.slug, m, "dropped");
      else await keepForNext(ctx, m);
    }
  } catch (e) {
    traceError(ctx, { where: "inbox", error: errorText(e) });
  }
}
