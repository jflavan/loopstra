import type { ChangeSummary } from "../console/types";

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
