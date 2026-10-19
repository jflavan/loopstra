import type { ChangeSummary } from "../console/types";
import type { Status } from "../intents";

/** Changes waiting their turn: in progress, or approved and ready for their next step. */
const WAITING: ReadonlySet<Status> = new Set<Status>(["accepted", "designing", "spec-approved", "planning", "plan-approved", "building", "reviewing", "merge-approved", "merged", "verifying"]);

/** The most the Live screen lists as up next. */
export const UP_NEXT = 6;

/** The changes next in line, in the list's order: waiting their turn and not being worked on (`busy`: the slugs with a running session), at most `limit`. */
export function upNext(changes: ChangeSummary[], busy: Iterable<string>, limit = UP_NEXT): ChangeSummary[] {
  const working = new Set(busy);
  return changes.filter((c) => !working.has(c.slug) && WAITING.has(c.status as Status)).slice(0, limit);
}

/** How long a done change stays on the board before it folds away with the closed ones. */
export const RECENT_DONE_MS = 7 * 24 * 3_600_000;

/**
 * The changes the board and list show (`open`), and the ones folded below them: done before the last
 * week (`earlier`) and closed. A done change with no readable finish time stays out where it can be seen.
 */
export function splitFinished(items: ChangeSummary[], now: number): { open: ChangeSummary[]; earlier: ChangeSummary[]; closed: ChangeSummary[] } {
  const isEarlier = (c: ChangeSummary) => c.stage === "done" && c.since !== null && now - Date.parse(c.since) > RECENT_DONE_MS;
  const open: ChangeSummary[] = [], earlier: ChangeSummary[] = [], closed: ChangeSummary[] = [];
  for (const c of items) (c.stage === "closed" ? closed : isEarlier(c) ? earlier : open).push(c);
  return { open, earlier, closed };
}
