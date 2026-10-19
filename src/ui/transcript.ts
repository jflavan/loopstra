import type { TranscriptItem } from "../console/types";

/** What a transcript shows: its items in order, each call's result by id, and the newest todo list. */
export interface Shown {
  items: Array<Exclude<TranscriptItem, { kind: "tool-result" | "todos" }>>;
  results: Record<string, { ok: boolean; output: string }>;
  todos: Array<{ text: string; state: string }> | null;
  /**
   * Where the session stream is (see addFrames): the end of the last line drawn whole, and the frame
   * ids of the rows drawn since, from the line it is in the middle of.
   */
  line: { end: number; drawn: string[] };
}

export const EMPTY: Shown = { items: [], results: {}, todos: null, line: { end: 0, drawn: [] } };

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

/** One row as a session's stream sends it, with its frame's id (see SessionMessage). */
export interface Frame { item: TranscriptItem; id: string }

/**
 * `s` with the session stream's `frames` added; `s` itself is left as it was. Every row's frame id
 * is its own: a line's last row has the line's end ("200"), any other the line's start and its index
 * in the line ("100.1"), see TranscriptReader.read. A stream opened again continues from the start of
 * the line it was in, so it sends that line's rows again; the ones drawn already are known by their
 * ids and passed over. A last row completes its line, and the ids drawn before it are let go. A row
 * of a line drawn whole (an older line sent again) is passed over too.
 */
export function addFrames(s: Shown, frames: Frame[]): Shown {
  let { end, drawn } = s.line;
  const fresh: TranscriptItem[] = [];
  for (const { item, id } of frames) {
    const at = Number.parseInt(id, 10);
    const last = !id.includes(".");
    // A row without a usable id cannot be placed, so it is drawn as it comes.
    if (Number.isFinite(at)) {
      if (last ? at <= end : at < end) continue;
      if (drawn.includes(id)) continue;
      if (last) {
        end = at;
        drawn = [];
      } else drawn = [...drawn, id];
    }
    fresh.push(item);
  }
  return { ...addItems(s, fresh), line: { end, drawn } };
}

/** The cost the newest result row names, or null when there is none (a chat turn has no change page to read it from). */
export function lastCost(shown: Shown): number | null {
  for (let k = shown.items.length - 1; k >= 0; k--) {
    const it = shown.items[k]!;
    if (it.kind === "result") return it.costUsd;
  }
  return null;
}
