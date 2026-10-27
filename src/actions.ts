import type { ActionKind, Offer } from "./console/types";
import { isHeld, plainStatus, REVIEW_GATE, STATUSES, type Frontmatter, type HumanGates, type Priority, type Status } from "./intents";
import type { Trace } from "./trace";

/*
 * What a person can do to a change, and where each action takes it. Pure rules: the console's
 * server offers them, the loop checks them again when it applies a request, and chat proposes them.
 */

/** The actions on a change chat may propose (start is its own, `accept`). */
export const CHANGE_ACTIONS = ["approve", "send-back", "retry", "close", "priority", "hold", "release", "answer"] as const;

/** Every kind of request the loop applies: start, chat's written intents (`new`), the actions on a change, undo, and a change of a setting. */
export const REQUEST_KINDS = ["accept", "new", ...CHANGE_ACTIONS, "undo", "settings"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** True when a value read from a request is a status. */
export function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

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
  // An agent's question waits for a person: answering it is what the change needs first.
  if (isOpen(s) && fm.question.trim()) out.push({ kind: "answer", label: "Answer" });
  if (personReviews(s, human) && APPROVE_TO[s]) {
    out.push({ kind: "approve", label: APPROVE_LABEL[s]!, to: APPROVE_TO[s] });
    if (SEND_BACK_TO[s]) out.push({ kind: "send-back", label: "Send back", to: SEND_BACK_TO[s] });
  }
  if (s === "blocked") for (const to of retry) out.push({ kind: "retry", label: `Retry from ${to}`, to });
  if (s === "draft") out.push({ kind: "accept", label: "Start", to: "accepted" });
  if (!isOpen(s)) return out;
  if (isHeld(fm)) out.push({ kind: "release", label: "Release" });
  else if (s !== "draft" && s !== "blocked") out.push({ kind: "hold", label: "Hold" });
  out.push({ kind: "priority", label: "Priority" });
  out.push({ kind: "close", label: "Close", to: "closed", confirm: true });
  return out;
}

/** The parts of a request these rules read. An answer's text is its `note`, and `asked` the question it answers. */
export interface RequestShape { kind: ActionKind | "undo"; expect: Status; to?: Status; priority?: Priority | null; note?: string; reason?: string; asked?: string }

/**
 * True when an answer naming the question asked at `named` (undefined: an older request, naming none)
 * may go to the question open now, asked at `open` (undefined: none open).
 */
export function sameQuestion(named: string | undefined, open: string | undefined): boolean {
  return named === undefined || named === open;
}

/** Why an answer to a question that is no longer the one waiting is refused. */
export function questionChangedText(slug: string): string {
  return `${slug}'s question changed since; nothing changed. Read the new one.`;
}

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

/** Where a retry or an undo goes: its `to`, which a retry and an undo always name (the shape leaves it optional for the others). */
const toStatus = (r: RequestShape): string => r.to ?? "an earlier status";

/** What a request did, for the commit subject and the trace: "plan approved", "build sent back". */
export function doneWords(r: RequestShape): string {
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? "confirmed done" : `${REVIEWED[r.expect] ?? "work"} approved`;
    case "send-back": return `${REVIEWED[r.expect] ?? "work"} sent back`;
    case "retry": return `retried from ${toStatus(r)}`;
    case "accept": return "accepted";
    case "close": return "closed";
    case "priority": return `priority set to ${r.priority ?? "normal"}`;
    case "hold": return "held";
    case "release": return "released";
    case "answer": return "question answered";
    case "undo": return `undone, back to ${toStatus(r)}`;
  }
}

/** A request as a short label, for the page's pending list and its toasts: "Approve the plan". */
export function requestLabel(r: RequestShape): string {
  switch (r.kind) {
    case "approve": return APPROVE_LABEL[r.expect] ?? "Approve";
    case "send-back": return "Send back";
    case "retry": return `Retry from ${toStatus(r)}`;
    case "accept": return "Start";
    case "close": return "Close";
    case "priority": return `Set priority to ${r.priority ?? "normal"}`;
    case "hold": return "Hold";
    case "release": return "Release";
    case "answer": return "Answer";
    case "undo": return `Undo, back to ${toStatus(r)}`;
  }
}

/**
 * The question chat asks before it submits a request. A send back's note and a hold's reason are
 * the model's words and go on with the request, so the question quotes them on their own lines:
 * the person says yes to exactly what will be sent.
 */
export function askText(r: RequestShape, slug: string): string {
  const note = (r.note ?? "").trim();
  const reason = (r.reason ?? "").trim();
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? `Confirm ${slug} is done?` : r.expect === "merge-review" ? `Approve merging ${slug}?` : `Approve the ${REVIEWED[r.expect] ?? "work"} of ${slug}?`;
    case "send-back": return `Send ${slug} back, so its ${REVIEWED[r.expect] ?? "work"} is done again, with this note?\n\n${note}`;
    case "retry": return `Retry ${slug} from ${toStatus(r)}?`;
    case "accept": return `Start work on ${slug} now?`;
    case "close": return `Close ${slug}? It stops for good.`;
    case "priority": return `Set ${slug}'s priority to ${r.priority ?? "normal"}?`;
    case "hold": return reason ? `Hold ${slug}, so the loop starts no step for it, with this reason?\n\n${reason}` : `Hold ${slug}, so the loop starts no step for it?`;
    case "release": return `Release ${slug}, so the loop goes on with it?`;
    case "answer": {
      const asked = (r.asked ?? "").replace(/\s+/g, " ").trim();
      return asked ? `Send this answer to ${slug}'s question "${asked}"?\n\n${note}` : `Send this answer to ${slug}'s waiting question?\n\n${note}`;
    }
    case "undo": return `Take ${slug} back to ${toStatus(r)}?`;
  }
}

/** What a request asks the loop to do, after "asked the loop to": "approve the plan of csv-export". */
export function askedWords(r: RequestShape, slug: string): string {
  switch (r.kind) {
    case "approve": return r.expect === "verifying" ? `confirm ${slug} is done` : r.expect === "merge-review" ? `approve merging ${slug}` : `approve the ${REVIEWED[r.expect] ?? "work"} of ${slug}`;
    case "send-back": return `send ${slug} back, so its ${REVIEWED[r.expect] ?? "work"} is done again`;
    case "retry": return `retry ${slug} from ${toStatus(r)}`;
    case "accept": return `start ${slug}`;
    case "close": return `close ${slug}`;
    case "priority": return `set ${slug}'s priority to ${r.priority ?? "normal"}`;
    case "hold": return `hold ${slug}`;
    case "release": return `release ${slug}`;
    case "answer": return `answer ${slug}'s question`;
    case "undo": return `take ${slug} back to ${toStatus(r)}`;
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The plain result of a request that was applied; `now` is the change's status after it. */
export function resultText(r: RequestShape, slug: string, now: Status): string {
  switch (r.kind) {
    case "priority": return `${slug} now has priority ${r.priority ?? "normal"}.`;
    case "hold": return `${slug} is held: the loop starts no step for it until it is released.`;
    case "release": return `${slug} is released: the loop goes on with it.`;
    case "answer": return `${slug} has its answer; the loop goes on with it.`;
    default: return `${capital(doneWords(r))}: ${slug} is now ${plainStatus(now)}.`;
  }
}
