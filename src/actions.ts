import type { ActionKind, Offer } from "./console/types";
import { plainStatus, REVIEW_GATE, STATUSES, type Frontmatter, type HumanGates, type Priority, type Status } from "./intents";
import type { Trace } from "./trace";

/*
 * What a person can do to a change, and where each action takes it. Pure rules: the console's
 * server offers them, the loop checks them again when it applies a request, and chat proposes them.
 */

/** Where Approve takes a change waiting at each review status. */
export const APPROVE_TO: Readonly<Partial<Record<Status, Status>>> = { "spec-review": "spec-approved", "plan-review": "plan-approved", "merge-review": "merge-approved", verifying: "done" };

/** Where Send back takes it: the approved status before the work under review, so that work is done again. */
export const SEND_BACK_TO: Readonly<Partial<Record<Status, Status>>> = { "spec-review": "accepted", "plan-review": "spec-approved", "merge-review": "plan-approved" };

/** The work each review status shows a person. */
const REVIEWED: Readonly<Partial<Record<Status, string>>> = { "spec-review": "spec", "plan-review": "plan", "merge-review": "build", verifying: "result" };

const APPROVE_LABEL: Readonly<Partial<Record<Status, string>>> = { "spec-review": "Approve the spec", "plan-review": "Approve the plan", "merge-review": "Approve the merge", verifying: "Confirm it is done" };

/** Statuses a retry never sets: they are not somewhere work goes on from. */
const NOT_RETRY: ReadonlySet<string> = new Set(["draft", "blocked", "done", "closed"]);

/** Not finished: done and closed changes offer nothing. */
export function isOpen(s: Status): boolean {
  return s !== "done" && s !== "closed";
}

/** True when a person sits on the gate of this review status (so Approve and Send back are theirs to give). */
export function personReviews(s: Status, human: HumanGates): boolean {
  const gate = REVIEW_GATE[s];
  return !!gate && human[gate] !== "none";
}

/**
 * Where a blocked change can be retried from: `fromBlock` (the status the block itself recorded,
 * see retryTarget in context.ts) first, then every status named as "to <status>" in a sentence of
 * the note that is about the status. Never draft, blocked, done or closed (Close is its own action).
 */
export function retryTargets(note: string, fromBlock: Status | null): Status[] {
  const out: Status[] = [];
  const add = (s: string) => {
    if ((STATUSES as readonly string[]).includes(s) && !NOT_RETRY.has(s) && !out.includes(s as Status)) out.push(s as Status);
  };
  if (fromBlock) add(fromBlock);
  for (const sentence of note.split(/(?<=[.!?])\s+/)) {
    if (!/\bstatus\b/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/\bto ([a-z]+(?:-[a-z]+)*)\b/g)) add(m[1]!);
  }
  return out;
}

/** retryTargets for a change as the trace has it: the newest block's recorded retry, and the note on the change now. */
export function retryOptions(trace: Trace, slug: string, note: string): Status[] {
  const e = trace.lastEvent(slug, "status_change", '"to":"blocked"');
  let fromBlock: Status | null = null;
  if (e) {
    try {
      const r = (JSON.parse(e.payload) as { retry?: unknown }).retry;
      if (typeof r === "string" && (STATUSES as readonly string[]).includes(r)) fromBlock = r as Status;
    } catch { /* an unreadable payload: the note alone */ }
  }
  return retryTargets(note, fromBlock);
}

/** What a change offers a person now. `retry`: its retry targets (see retryOptions); only a blocked change uses them. */
export function offers(fm: Frontmatter, human: HumanGates, retry: Status[]): Offer[] {
  const s = fm.status;
  const out: Offer[] = [];
  if (personReviews(s, human) && APPROVE_TO[s]) {
    out.push({ kind: "approve", label: APPROVE_LABEL[s]!, to: APPROVE_TO[s] });
    if (SEND_BACK_TO[s]) out.push({ kind: "send-back", label: "Send back", to: SEND_BACK_TO[s] });
  }
  if (s === "blocked") for (const to of retry) out.push({ kind: "retry", label: `Retry from ${to}`, to });
  if (s === "draft") out.push({ kind: "accept", label: "Start", to: "accepted" });
  if (!isOpen(s)) return out;
  if (fm.hold.trim()) out.push({ kind: "release", label: "Release" });
  else if (s !== "draft" && s !== "blocked") out.push({ kind: "hold", label: "Hold" });
  out.push({ kind: "priority", label: "Priority" });
  out.push({ kind: "close", label: "Close", to: "closed", confirm: true });
  return out;
}

/** The parts of a request these rules read. */
export interface RequestShape { kind: ActionKind | "undo"; expect: Status; to?: Status; priority?: Priority | null }

/** The status a status-changing request leads to, from the request alone; null for one that sets no status, or that is not allowed from `expect`. */
export function targetOf(r: RequestShape): Status | null {
  switch (r.kind) {
    case "approve": return APPROVE_TO[r.expect] ?? null;
    case "send-back": return SEND_BACK_TO[r.expect] ?? null;
    case "retry": case "undo": return r.to ?? null;
    case "close": return "closed";
    case "accept": return "accepted";
    default: return null;
  }
}

/** True when going from `from` back to `to` undoes an approve or a send back (`to` is the review it came from). */
export function undoAllowed(from: Status, to: Status): boolean {
  return APPROVE_TO[to] === from || SEND_BACK_TO[to] === from;
}

/**
 * True when an undo from `expect` back to `to` takes back the step that really happened last: the
 * pair is one undoAllowed accepts, and the newest status change the trace has for the change went
 * from `to` to `expect`. A pair alone could jump a change forward (plan-approved to merge-review).
 */
export function undoMatches(trace: Trace, slug: string, expect: Status, to: Status): boolean {
  if (!undoAllowed(expect, to)) return false;
  const e = trace.lastEvent(slug, "status_change");
  if (!e) return false;
  try {
    const p = JSON.parse(e.payload) as { from?: unknown; to?: unknown };
    return p.from === to && p.to === expect;
  } catch {
    return false;
  }
}

/** What a request did, for the commit subject and the trace: "plan approved", "build sent back". */
export function doneWords(r: RequestShape): string {
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? "confirmed done" : `${REVIEWED[r.expect] ?? "work"} approved`;
    case "send-back": return `${REVIEWED[r.expect] ?? "work"} sent back`;
    case "retry": return `retried from ${r.to}`;
    case "accept": return "accepted";
    case "close": return "closed";
    case "priority": return `priority set to ${r.priority ?? "normal"}`;
    case "hold": return "held";
    case "release": return "released";
    case "undo": return `undone, back to ${r.to}`;
  }
}

/** A request as a short label, for the page's pending list and its toasts: "Approve the plan". */
export function requestLabel(r: RequestShape): string {
  switch (r.kind) {
    case "approve": return APPROVE_LABEL[r.expect] ?? "Approve";
    case "send-back": return "Send back";
    case "retry": return `Retry from ${r.to}`;
    case "accept": return "Start";
    case "close": return "Close";
    case "priority": return `Set priority to ${r.priority ?? "normal"}`;
    case "hold": return "Hold";
    case "release": return "Release";
    case "undo": return `Undo, back to ${r.to}`;
  }
}

/** The question chat asks before it submits a request. */
export function askText(r: RequestShape, slug: string): string {
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? `Confirm ${slug} is done?` : r.expect === "merge-review" ? `Approve merging ${slug}?` : `Approve the ${REVIEWED[r.expect] ?? "work"} of ${slug}?`;
    case "send-back": return `Send ${slug} back with your note, so its ${REVIEWED[r.expect] ?? "work"} is done again?`;
    case "retry": return `Retry ${slug} from ${r.to}?`;
    case "accept": return `Start work on ${slug} now?`;
    case "close": return `Close ${slug}? It stops for good.`;
    case "priority": return `Set ${slug}'s priority to ${r.priority ?? "normal"}?`;
    case "hold": return `Hold ${slug}, so the loop starts no step for it?`;
    case "release": return `Release ${slug}, so the loop goes on with it?`;
    case "undo": return `Take ${slug} back to ${r.to}?`;
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The plain result of a request that was applied; `now` is the change's status after it. */
export function resultText(r: RequestShape, slug: string, now: Status): string {
  switch (r.kind) {
    case "priority": return `${slug} now has priority ${r.priority ?? "normal"}.`;
    case "hold": return `${slug} is held: the loop starts no step for it until it is released.`;
    case "release": return `${slug} is released: the loop goes on with it.`;
    default: return `${capital(doneWords(r))}: ${slug} is now ${plainStatus(now)}.`;
  }
}
