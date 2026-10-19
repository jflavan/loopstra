import type { TranscriptItem } from "../console/types";

/** What a transcript shows: its items in order, each call's result by id, and the newest todo list. */
export interface Shown {
  items: Array<Exclude<TranscriptItem, { kind: "tool-result" | "todos" }>>;
  results: Record<string, { ok: boolean; output: string }>;
  todos: Array<{ text: string; state: string }> | null;
  /**
   * The line the session stream is in the middle of (see addFrames): the offset its rows come with,
   * and the rows without an id drawn from it so far, as JSON.
   */
  line: { at: number; drawn: string[] };
}

export const EMPTY: Shown = { items: [], results: {}, todos: null, line: { at: 0, drawn: [] } };

/** `s` with `more` added; `s` itself is left as it was. */
export function addItems(s: Shown, more: TranscriptItem[]): Shown {
  const items = [...s.items];
  const results = { ...s.results };
  let todos = s.todos;
  // A stream that reconnects sends again what it sent before; a call or edit is shown once.
  const seen = new Set<string>();
  for (const it of items) if ("id" in it) seen.add(it.id);
  for (const it of more) {
    if (it.kind === "tool-result") results[it.id] = { ok: it.ok, output: it.output };
    else if (it.kind === "todos") todos = it.items;
    else if ("id" in it) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    } else items.push(it);
  }
  return { ...s, items, results, todos };
}

/** One row as a session's stream sends it, with the frame's id: the offset the stream continues from (see SessionMessage). */
export interface Frame { item: TranscriptItem; offset: number }

/**
 * `s` with the session stream's `frames` added; `s` itself is left as it was. A row without an id
 * (text, a message, the result) is drawn once per line: a stream opened again continues from the
 * start of the line it was in, so it sends that line's rows again, and the ones drawn from it
 * already are passed over. The rows of one line come with the line's start as their offset, except
 * the last, which comes with the line's end (see TranscriptReader.read): a row above the line's
 * offset ends it, and the next line starts where it ended.
 */
export function addFrames(s: Shown, frames: Frame[]): Shown {
  let { at } = s.line;
  let drawn = s.line.drawn;
  const fresh: TranscriptItem[] = [];
  for (const { item, offset } of frames) {
    if (offset > at) {
      at = offset;
      drawn = [];
    } else if (!("id" in item)) {
      // Below the line: an older line sent again, every row of which is drawn.
      if (offset < at) continue;
      const key = JSON.stringify(item);
      if (drawn.includes(key)) continue;
      drawn = [...drawn, key];
    }
    fresh.push(item);
  }
  return { ...addItems(s, fresh), line: { at, drawn } };
}

/** The cost the newest result row names, or null when there is none (a chat turn has no change page to read it from). */
export function lastCost(shown: Shown): number | null {
  for (let k = shown.items.length - 1; k >= 0; k--) {
    const it = shown.items[k]!;
    if (it.kind === "result") return it.costUsd;
  }
  return null;
}
