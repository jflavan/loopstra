import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { MESSAGE_LEAD, REDIRECT_LEAD, type SessionControl } from "./claude";
import { appendConversation } from "./conversation";
import type { StepContext } from "./context";
import { inboxDir, inboxFor, markDone, waitingIn, type InboxMessage } from "./inbox";
import { errorText } from "./shell";
import { stopRequested } from "./stop";

/** The work sessions a person may message or redirect; any session may be stopped (see the spec's "Which sessions"). */
export const STEERABLE: ReadonlySet<string> = new Set(["intake", "design", "plan", "build", "fix", "reconcile", "revise", "lessons"]);

/** How often the runner looks in the inbox besides when it changes (a watch may miss an event). */
const LOOK_MS = 1000;

/** A message as the session reads it. Starts with MESSAGE_LEAD, which the console's transcript looks for. */
export function messageText(m: InboxMessage): string {
  return `${MESSAGE_LEAD} ${m.by}, who is watching this work from ${m.via}: ${m.text.trim()}\n\nTake it into account and carry on. Your final answer keeps the same format.`;
}

/** A redirect as the resumed session's prompt. Starts with REDIRECT_LEAD. */
export function redirectText(m: InboxMessage): string {
  return `${REDIRECT_LEAD} ${m.by} (${m.via}): ${m.text.trim()}\n\nStop what you were doing and work this way instead. Your final answer keeps the same format.`;
}

/** Records an entry without ever failing the session: a record that cannot be written is traced. */
function record(ctx: StepContext, write: () => Promise<void>): void {
  void write().catch((e) => {
    try { ctx.trace.event(ctx.slug, "error", { where: "conversation", error: errorText(e) }); } catch { /* the trace closed meanwhile */ }
  });
}

/** A message that will not reach its session: kept in conversation.md for the next one. */
function keepForNext(ctx: StepContext, m: InboxMessage): void {
  if (!markDone(ctx.root, ctx.slug, m, "next session")) return;
  record(ctx, () => appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "later", who: m.by, via: m.via, text: m.text, at: new Date() }));
}

/**
 * Delivers what waits in the inbox for session `seq` (phase `name`) while it runs: a message is written
 * to it (a work session only; a check's is kept for the next session), a stop ends it, a redirect resumes
 * it the new way. Looks when the inbox changes and every second. Gives back what ends the watching; once
 * it ends, what is left for this session goes to the next one (stops are dropped). After a stop request
 * it is left where it is, for the next step's sweep: the loop records nothing while it stops.
 */
export function deliverInbox(ctx: StepContext, seq: number, name: string, ctl: SessionControl): () => void {
  const steerable = STEERABLE.has(name);
  const look = () => {
    for (const m of inboxFor(ctx.root, ctx.slug, seq)) {
      if (m.kind === "stop") {
        if (markDone(ctx.root, ctx.slug, m, "delivered")) {
          ctx.trace.event(ctx.slug, "steer", { kind: "stop", by: m.by, via: m.via, seq });
          ctl.stop(m.by);
        }
      } else if (!steerable) {
        keepForNext(ctx, m);
      } else if (m.kind === "message") {
        // Moved only once it is written: a loop killed in between delivers it again, at worst twice.
        if (!ctl.message(messageText(m))) continue;
        markDone(ctx.root, ctx.slug, m, "delivered");
        ctx.trace.event(ctx.slug, "steer", { kind: "message", by: m.by, via: m.via, seq, text: m.text });
        record(ctx, () => appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "message", who: m.by, via: m.via, phase: name, text: m.text, at: new Date() }));
      } else {
        if (!ctl.redirect(redirectText(m))) continue;
        markDone(ctx.root, ctx.slug, m, "delivered");
        ctx.trace.event(ctx.slug, "steer", { kind: "redirect", by: m.by, via: m.via, seq, text: m.text });
        record(ctx, () => appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "redirect", who: m.by, via: m.via, phase: name, text: m.text, at: new Date() }));
      }
    }
  };
  // Looking must never fail the session: a problem is traced, and the next look tries again.
  const safeLook = () => {
    try { look(); } catch (e) {
      try { ctx.trace.event(ctx.slug, "error", { where: "inbox", seq, error: errorText(e) }); } catch { /* the trace closed meanwhile */ }
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
  return () => {
    clearInterval(timer);
    watcher?.close();
    watcher = null;
    if (stopRequested()) return;
    for (const m of inboxFor(ctx.root, ctx.slug, seq)) {
      if (m.kind === "message" || m.kind === "redirect") keepForNext(ctx, m);
      else markDone(ctx.root, ctx.slug, m, "dropped");
    }
  };
}

/**
 * At a step's start, nothing of the change runs: what a stopped or killed loop left in its inbox goes
 * to conversation.md for the sessions to come (messages, redirects); stops are dropped. Never fails
 * the step: a problem is traced, and the next step's sweep tries again.
 */
export function sweepInbox(ctx: StepContext): void {
  try {
    for (const m of waitingIn(ctx.root, ctx.slug)) {
      if (m.kind === "stop") markDone(ctx.root, ctx.slug, m, "dropped");
      else keepForNext(ctx, m);
    }
  } catch (e) {
    ctx.trace.event(ctx.slug, "error", { where: "inbox", error: errorText(e) });
  }
}
