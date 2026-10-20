import { existsSync, mkdirSync, readdirSync, rmSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readJsonAs, writeJson } from "./fsutil";
import type { SessionControl } from "./claude";
import { MESSAGE_LEAD, MESSAGE_TAIL, REDIRECT_LEAD, REDIRECT_TAIL, steerable as isSteerable } from "./console/steerable";
import { appendConversation, recordedAs, type ConversationEntry } from "./conversation";
import type { StepContext } from "./context";
import { inboxDir, InboxMessageSchema, leaveDelivered, markDone, waitingIn, type Done, type InboxMessage } from "./inbox";
import { errorText } from "./shell";
import { StopRequested, stopRequested } from "./stop";

/** How often the runner looks in the inbox besides when it changes (a watch may miss an event). */
const LOOK_MS = 1000;
/** How many times the end of deliverInbox looks for messages written while its records landed. */
const END_LOOKS = 5;
/** How long a look waits before trying an ended session's message again after its record failed; doubled after each failure. */
const PICK_UP_WAIT_MS = 60_000;
/** How many times the looks try an ended session's message before leaving it for the next step's sweep. */
const PICK_UP_TRIES = 4;

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

/**
 * `inbox/unrecorded/<id>.json`: a message delivered to its session whose record failed (the loop started
 * stopping, the main checkout moved, git failed), with the phase it went to and when. The next step's
 * sweep records it (see sweepInbox).
 */
const UnrecordedSchema = z.object({ message: InboxMessageSchema, phase: z.string(), at: z.string() });
type Unrecorded = z.infer<typeof UnrecordedSchema>;

function unrecordedDir(root: string, slug: string): string {
  return join(inboxDir(root, slug), "unrecorded");
}

/**
 * Records a delivered message (or redirect) without ever failing the session. A record that fails
 * leaves a marker for the next step's sweep, so conversation.md never loses what a session was told.
 * Gives back its write.
 */
function recordDelivered(ctx: StepContext, m: InboxMessage, phase: string): Promise<void> {
  const at = new Date();
  return appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, deliveredEntry(m, phase, at), { id: m.id, since: m.at, trace: ctx.trace }).catch((err: unknown) => {
    if (!(err instanceof StopRequested)) traceError(ctx, { where: "conversation", error: errorText(err) });
    try {
      const marker: Unrecorded = { message: m, phase, at: at.toISOString() };
      writeJson(join(unrecordedDir(ctx.root, ctx.slug), `${m.id}.json`), marker);
    } catch (e) {
      traceError(ctx, { where: "conversation", id: m.id, error: `a delivered message could not be kept for its record: ${errorText(e)}` });
    }
  });
}

/** A delivered message's entry: addressed to the phase whose session it went to. */
function deliveredEntry(m: InboxMessage, phase: string, at: Date): ConversationEntry {
  return { kind: m.kind === "redirect" ? "redirect" : "message", who: m.by, via: m.via, phase, text: m.text, at };
}

/**
 * Records the delivered messages whose record failed (see recordDelivered); each marker goes once its
 * record landed. An entry the record already holds (its record landed, but the marker did not go) is
 * not written twice (see recordedAs). Never throws.
 */
async function recordUnrecorded(ctx: StepContext): Promise<void> {
  const dir = unrecordedDir(ctx.root, ctx.slug);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, name);
    const u = readJsonAs(path, UnrecordedSchema);
    if (!u) continue;
    try {
      const at = new Date(u.at);
      await appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, deliveredEntry(u.message, u.phase, Number.isNaN(at.getTime()) ? new Date() : at), { id: u.message.id, since: u.message.at, trace: ctx.trace });
      rmSync(path, { force: true });
    } catch (e) {
      // A stopping loop records nothing: the marker waits for the next step's sweep.
      if (e instanceof StopRequested) return;
      traceError(ctx, { where: "conversation", id: u.message.id, error: errorText(e) });
    }
  }
}

/** A message's key across this process's changes and repositories. */
const keyOf = (ctx: StepContext, m: InboxMessage) => `${resolve(ctx.root)}|${ctx.slug}|${m.id}`;

/** The messages kept for the next session whose record is being written now (see keepForNext). */
const recording = new Set<string>();

/**
 * A message that will not reach its session: kept in conversation.md for the next one. It is marked
 * done only once its entry is committed: one whose record fails (the loop started stopping, and
 * commitRecord refuses) stays in the inbox, for the next sweep. While its record is in flight, a second
 * look leaves it alone. One with an entry already (its move to delivered/ failed after its record, in
 * this process or before a restart; see recordedAs) is only moved, as what its entry says: delivered
 * to its session, or kept for the next one. Never throws: a problem is given to `failed`, which traces it.
 */
async function keepForNext(ctx: StepContext, m: InboxMessage, failed: (error: string) => void = (error) => traceError(ctx, { where: "conversation", error })): Promise<void> {
  const key = keyOf(ctx, m);
  if (recording.has(key)) return;
  recording.add(key);
  try {
    const was = recordedAs(ctx.root, ctx.slug, m.id, { who: m.by, via: m.via, text: m.text });
    if (!was) await appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "later", who: m.by, via: m.via, text: m.text, at: new Date() }, { id: m.id, since: m.at, trace: ctx.trace });
    markDone(ctx.root, ctx.slug, m, was && was !== "later" ? "delivered" : "next session");
  } catch (e) {
    // A stopping loop records nothing: the message waits for the next step's sweep.
    if (!(e instanceof StopRequested)) failed(errorText(e));
  } finally {
    recording.delete(key);
  }
}

/**
 * Ended sessions' messages whose record failed (see pickUp), by keyOf: the failed tries, when the
 * next may start (ms), and the error last traced (see sameError).
 */
const pickUpFailed = new Map<string, { tries: number; next: number; traced: string }>();

/** An error's words without the commit ids in them, which differ on every try of the same failure. */
const sameError = (error: string) => error.replace(/\b[0-9a-f]{7,64}\b/g, "<commit>");

/**
 * Keeps an ended session's message for the next session (see keepForNext), from a session's look.
 * A record that keeps failing (the checkout off main, a held lock, git failing) is not tried on every
 * look: after a failure the looks wait PICK_UP_WAIT_MS from when that try began, twice as long after each one, and after
 * PICK_UP_TRIES failures they leave the message for the next step's sweep. The error is traced once
 * while it stays the same for the message (commit ids aside). Null when it is not tried now.
 */
function pickUp(ctx: StepContext, m: InboxMessage): Promise<void> | null {
  const key = keyOf(ctx, m);
  const was = pickUpFailed.get(key);
  if (was && (was.tries >= PICK_UP_TRIES || Date.now() < was.next)) return null;
  let failed = false;
  // The wait counts from the try's start, so a slow failure (git on a busy machine) does not push the next try back.
  const began = Date.now();
  return keepForNext(ctx, m, (error) => {
    failed = true;
    const tries = (was?.tries ?? 0) + 1;
    const traced = sameError(error);
    pickUpFailed.set(key, { tries, next: began + PICK_UP_WAIT_MS * 2 ** (tries - 1), traced });
    if (traced === was?.traced) return;
    try {
      ctx.trace.event(ctx.slug, "error", { where: "conversation", id: m.id, error, note: `a message for a session that ended could not be kept for the next one; tried again less often, and after ${PICK_UP_TRIES} tries left for the next step` });
    } catch { /* the trace closed meanwhile */ }
  }).then(() => { if (!failed) pickUpFailed.delete(key); });
}

/** True while the message's file is still in the inbox (its move to delivered/ failed, or nobody moved it). */
function waiting(ctx: StepContext, m: InboxMessage): boolean {
  return existsSync(join(inboxDir(ctx.root, ctx.slug), `${m.id}.json`));
}

/**
 * A message given to its session whose move to delivered/ still fails as the watching ends: its
 * delivered copy is left in delivered/ anyway (see leaveDelivered), so no look, sweep or restart takes
 * it for one still waiting. A copy that cannot be written is traced; the next sweep then finds its
 * entry (see keepForNext).
 */
function keepDelivered(ctx: StepContext, seq: number, m: InboxMessage): void {
  try {
    leaveDelivered(ctx.root, ctx.slug, m, "delivered");
  } catch (e) {
    traceError(ctx, { where: "inbox", seq, id: m.id, error: `a delivered message's copy could not be left in delivered/: ${errorText(e)}` });
  }
}

/** The sessions being watched (see deliverInbox), as root|slug|seq: a message for one of them is that watcher's. */
const watched = new Set<string>();

const watchKey = (ctx: StepContext, seq: number) => `${resolve(ctx.root)}|${ctx.slug}|${seq}`;

/**
 * True when the message is for another session of this change that ended (nothing watches it any
 * more): a person sent it to the session they saw running, just as it ended. That session ran before
 * the one at `seq`, or alongside it (the trace's row for it has ended). One whose row still says
 * running is not (a session alongside, about to be watched), and neither is a later one with no row
 * yet (a session to come).
 */
function forEndedSession(ctx: StepContext, m: InboxMessage, seq: number): boolean {
  if (m.seq === seq || watched.has(watchKey(ctx, m.seq))) return false;
  const row = ctx.trace.phase(ctx.slug, m.seq);
  return row ? row.status !== "running" : m.seq < seq;
}

/**
 * Delivers what waits in the inbox for session `seq` (phase `name`) while it runs: a message is written
 * to it (a work session only; a check's is kept for the next session), a stop ends it, a redirect resumes
 * it the new way. Looks when the inbox changes and every second. Gives back what ends the watching; once
 * it ends, what is left for this session goes to the next one (stops are dropped), and it resolves once
 * every record it started has landed (or failed, traced), so the next session's prompt has them; what
 * was written meanwhile is looked for again, until a look finds nothing new (at most END_LOOKS). After a
 * stop request what is left stays where it is, for the next step's sweep: the loop records nothing while it stops.
 *
 * A message for a session of the change that ended (see forEndedSession) is kept for the next session
 * by whichever look finds it, and a stop for one is dropped: held until the next step's sweep, it would
 * wait hours at a human gate. A record of it that fails is tried again less and less often (see
 * pickUp). One for a session yet to come waits for it.
 *
 * A message is written to the session once only: when its move to delivered/ fails (a file held open on
 * Windows), the error is traced once and the next look tries the move again. It is traced and recorded
 * once moved.
 */
export function deliverInbox(ctx: StepContext, seq: number, name: string, ctl: SessionControl): () => Promise<void> {
  const steerable = isSteerable(name);
  watched.add(watchKey(ctx, seq));
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
    pending.push(recordDelivered(ctx, m, name));
  };
  /**
   * A message for a session that ended: kept for the next session, as the sweep would, unless its
   * record failed lately (see pickUp); a stop for it came too late.
   */
  const forNext = (m: InboxMessage) => {
    if (m.kind === "stop") { markDone(ctx.root, ctx.slug, m, "dropped"); return; }
    const record = pickUp(ctx, m);
    if (record) pending.push(record);
  };
  const look = () => {
    for (const m of waitingIn(ctx.root, ctx.slug)) {
      if (m.seq !== seq) {
        // A stopping loop records nothing: what is left waits for the next step's sweep.
        if (!stopRequested() && forEndedSession(ctx, m, seq)) forNext(m);
        continue;
      }
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
  /** The messages the end has dealt with: a later look passes over them. */
  const ended = new Set<string>();
  /** One look as the watching ends; true when it found a message it had not dealt with. */
  const lastLook = (): boolean => {
    if (stopRequested()) return false;
    let found = false;
    try {
      for (const m of waitingIn(ctx.root, ctx.slug)) {
        if (m.seq !== seq && !forEndedSession(ctx, m, seq)) continue;
        if (ended.has(m.id)) continue;
        ended.add(m.id);
        found = true;
        if (m.seq !== seq) forNext(m);
        // Given to the session already, but not moved: one more try, else its delivered copy is left. The
        // session got it either way, so it is traced and recorded as delivered (stops are not recorded).
        else if (sent.has(m.id)) {
          if (!settle(m, "delivered")) keepDelivered(ctx, seq, m);
          delivered(m);
        }
        else if (m.kind === "message" || m.kind === "redirect") pending.push(keepForNext(ctx, m));
        else markDone(ctx.root, ctx.slug, m, "dropped");
      }
    } catch (e) {
      traceError(ctx, { where: "inbox", seq, error: errorText(e) });
    }
    return found;
  };
  return async () => {
    clearInterval(timer);
    watcher?.close();
    watcher = null;
    // A message written while the records land (the session's last moments) is looked for again, so it
    // reaches the step's next session too: until a look finds nothing new, at most END_LOOKS times.
    for (let i = 0; i < END_LOOKS; i++) {
      const found = lastLook();
      await Promise.all(pending.splice(0));
      if (!found) break;
    }
    // Only now, once its own messages are dealt with: a session watched alongside takes the ones from here on.
    watched.delete(watchKey(ctx, seq));
  };
}

/**
 * At a step's start, nothing of the change runs: a delivered message whose record failed is recorded
 * (see recordDelivered), and what a stopped or killed loop left in its inbox goes to conversation.md for
 * the sessions to come (messages, redirects); stops are dropped. Resolves once
 * those records landed, so the step's first session reads them. Never fails the step: a problem is
 * traced, and what was not recorded stays for the next step's sweep.
 */
export async function sweepInbox(ctx: StepContext): Promise<void> {
  await recordUnrecorded(ctx);
  try {
    for (const m of waitingIn(ctx.root, ctx.slug)) {
      if (m.kind === "stop") markDone(ctx.root, ctx.slug, m, "dropped");
      else {
        await keepForNext(ctx, m);
        // A new step: the sessions' looks may try again what the earlier ones gave up on.
        pickUpFailed.delete(keyOf(ctx, m));
      }
    }
  } catch (e) {
    traceError(ctx, { where: "inbox", error: errorText(e) });
  }
}
