import type { ActivityItem } from "../console/types";

/** Which rows the Activity screen shows: one change's (or everything's), and only rows in plain words unless `technical`. */
interface FeedFilter { slug: string; technical: boolean }

/** Whether a row fits the filter: the live stream's rows and a page read again both go in by this rule. */
export const fitsFeed = (a: ActivityItem, f: FeedFilter): boolean => (!f.slug || a.slug === f.slug) && (f.technical || a.text !== null);

/**
 * What the Activity screen shows after it read the newest page again (the live stream said it
 * missed events): the page merged into `older` by id, newest first, so what was shown is kept and
 * the holes are filled. When the page does not reach what was shown (more was missed than one page
 * holds) it is shown on its own, since what lies between could not be read; `joined` says which, so
 * the screen knows whether its Older cursor still holds.
 */
export function mergeFeed(older: ActivityItem[], fresh: ActivityItem[], filter: FeedFilter): { items: ActivityItem[]; joined: boolean } {
  const page = fresh.filter((a) => fitsFeed(a, filter));
  const ids = new Set(page.map((a) => a.id));
  const joined = older.length > 0 && older.some((a) => ids.has(a.id));
  if (!joined) return { items: page, joined: false };
  const items = [...page, ...older.filter((a) => !ids.has(a.id))].sort((a, b) => b.id - a.id);
  return { items, joined: true };
}

/** A read of the Activity screen's history: its cursor (0 for the newest page), and what is done with the page (see feedAfter). */
export interface FeedRead { before: number; how: "reset" | "more" | "merge" }

/**
 * What the Activity screen holds of its history: the rows read, the Older cursor (null when there is
 * nothing older), and the read that failed (null when none did), which Try again repeats. While a read
 * has failed the screen offers Try again in place of Older.
 */
export interface FeedState { items: ActivityItem[]; next: number | null; failed: FeedRead | null }

/**
 * The screen's history after `read` came back with `page`, or failed (`page` null). "reset" shows
 * the page alone (a new filter, Refresh), "more" adds it below (Older), "merge" merges the newest page
 * into what is shown (the stream said the screen missed events). A failed read leaves what is shown
 * and its cursor as they were.
 */
export function feedAfter(s: FeedState, read: FeedRead, page: { items: ActivityItem[]; next: number | null } | null, filter: FeedFilter): FeedState {
  if (!page) return { ...s, failed: read };
  if (read.how === "merge") {
    const merged = mergeFeed(s.items, page.items, filter);
    // Not joined, the page stands alone with its own cursor. Joined, the Older cursor still points
    // below what is shown, and an Older read that failed has still not been done, so it is still offered.
    if (!merged.joined) return { items: merged.items, next: page.next, failed: null };
    return { items: merged.items, next: s.next, failed: s.failed?.how === "more" ? s.failed : null };
  }
  return { items: read.how === "reset" ? page.items : [...s.items, ...page.items], next: page.next, failed: null };
}
