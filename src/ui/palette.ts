export interface Command { id: string; title: string; hint?: string; run: () => void }

/**
 * How well `query` matches `text`: null when its letters are not all there in order; otherwise
 * higher for letters that follow each other and for letters that start a word.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || /[\s\-_/]/.test(t[i - 1]!)) score += 2;
    prev = i;
    from = i + 1;
  }
  return score;
}

/** The items whose title matches, best first (ties keep their order), at most `limit`. */
export function filterCommands<T extends { title: string }>(items: T[], query: string, limit = 12): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item.title) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

/** The highlighted row, kept inside a list of `length` rows (0 when there are none). */
export function clampAt(at: number, length: number): number {
  return Math.max(0, Math.min(at, length - 1));
}

/**
 * The highlighted row after a step down (`by` 1) or up (-1) through a list of `length` rows: the
 * ends stop it, and a row left beyond the list (it shrank) is brought back in first, so a step up
 * from there lands on the row before the last and not somewhere past it.
 */
export function stepAt(at: number, by: 1 | -1, length: number): number {
  return clampAt(clampAt(at, length) + by, length);
}
