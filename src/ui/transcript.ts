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
  for (const it of more) {
    if (it.kind === "tool-result") results[it.id] = { ok: it.ok, output: it.output };
    else if (it.kind === "todos") todos = it.items;
    else items.push(it);
  }
  return { items, results, todos };
}
