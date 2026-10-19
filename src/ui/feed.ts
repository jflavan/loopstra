import type { ActivityItem } from "../console/types";

/** Which rows the Activity screen shows: one change's (or everything's), and only rows in plain words unless `technical`. */
export interface FeedFilter { slug: string; technical: boolean }

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
