import type { TranscriptItem } from "../console/types";

/** What a transcript shows: its items in order, each call's result by id, and the newest todo list. */
export interface Shown {
  items: Array<Exclude<TranscriptItem, { kind: "tool-result" | "todos" }>>;
  results: Record<string, { ok: boolean; output: string }>;
  todos: Array<{ text: string; state: string }> | null;
}

export const EMPTY: Shown = { items: [], results: {}, todos: null };

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
  return { items, results, todos };
}
