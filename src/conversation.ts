import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitRecord } from "./context";

/**
 * `intent/<slug>/conversation.md`: one readable record per change of what people told its agents and
 * what the agents asked. Written only by the loop, through commitRecord, one entry at a time; a person
 * may read or edit it like any record. Every work session's prompt gets it (see {{conversation}}).
 */

export type ConversationEntry =
  | { kind: "message"; who: string; via: string; phase: string; text: string; at: Date }
  | { kind: "redirect"; who: string; via: string; phase: string; text: string; at: Date }
  | { kind: "question"; phase: string; text: string; why: string; options: string[]; at: Date }
  | { kind: "answer"; who: string; via: string; text: string; at: Date }
  | { kind: "later"; who: string; via: string; text: string; at: Date }
  | { kind: "sent-back"; who: string; via: string; text: string; at: Date }
  /** An undo of a send back: the note it was sent back with no longer steers anything. */
  | { kind: "took-back"; who: string; via: string; at: Date };

export function conversationPath(root: string, slug: string): string {
  return join(root, "intent", slug, "conversation.md");
}

/** The record's text, or "" when there is none. */
export function readConversation(root: string, slug: string): string {
  const path = conversationPath(root, slug);
  try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}

const two = (n: number) => String(n).padStart(2, "0");
/** "2026-10-17 14:02", local time. */
function when(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One line of a header: no line breaks. */
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** A line Markdown could read as a heading: an ATX one (up to 3 spaces, then #), or a setext underline. */
const HEADING = /^\s{0,3}#|^\s{0,3}(=+|-+)\s*$/;

/**
 * A body: line breaks as \n (a lone \r ends a line too), trimmed, and a line that would read as a
 * heading is escaped with a backslash at its start, so a person's text never adds an entry.
 */
const body = (s: string) => s.replace(/\r\n?/g, "\n").trim().split("\n").map((l) => (HEADING.test(l) ? `\\${l}` : l)).join("\n");

/** One entry as Markdown, ending with a newline. */
export function conversationEntry(e: ConversationEntry): string {
  const at = when(e.at);
  switch (e.kind) {
    case "message": return `## ${at} · ${one(e.who)} (${one(e.via)}) → ${one(e.phase)}\n${body(e.text)}\n`;
    case "redirect": return `## ${at} · ${one(e.who)} (${one(e.via)}) redirects ${one(e.phase)}\n${body(e.text)}\n`;
    case "later": return `## ${at} · ${one(e.who)} (${one(e.via)}) → the next session\n${body(e.text)}\n`;
    case "answer": return `## ${at} · ${one(e.who)} (${one(e.via)}) answers\n${body(e.text)}\n`;
    case "sent-back": return `## ${at} · ${one(e.who)} (${one(e.via)}) sent it back\n${body(e.text)}\n`;
    case "took-back": return `## ${at} · ${one(e.who)} (${one(e.via)}) took back the send back\nThe note above no longer stands.\n`;
    case "question": {
      const lines = [`## ${at} · ${one(e.phase)} asks`, body(e.text)];
      if (e.why.trim()) lines.push(`Why: ${one(e.why)}`);
      if (e.options.length) lines.push(`Options: ${e.options.map(one).join(" · ")}`);
      return `${lines.join("\n")}\n`;
    }
  }
}

/** The record with one more entry (the heading added when the file is new). */
export function withEntry(current: string, e: ConversationEntry): string {
  const head = current.trim() ? current.replace(/\s*$/, "\n") : "# Conversation\n";
  return `${head}\n${conversationEntry(e)}`;
}

/** An entry's text without its time (the header's "YYYY-MM-DD HH:MM · "). */
const timeless = (entry: string) => entry.trim().replace(/^## \S+ \S+ · /, "## ");

/**
 * The record with one more entry, unless it already ends with that same entry (whatever its time): an
 * earlier try whose commit failed left it on disk.
 */
export function withEntryOnce(current: string, e: ConversationEntry): string {
  const last = current.trim().split(/\n(?=## )/).at(-1) ?? "";
  return timeless(last) === timeless(conversationEntry(e)) ? current : withEntry(current, e);
}

/**
 * Appends one entry and commits it ("loopstra(<slug>): conversation"). Under commitRecord's lock, so two
 * entries written at once (a message and an answer) both land. `once`: not added when the record already
 * ends with it (an earlier try whose commit failed after writing it; see withEntryOnce).
 */
export async function appendConversation(root: string, main: string, slug: string, e: ConversationEntry, opts: { once?: boolean } = {}): Promise<void> {
  await commitRecord(root, main, slug, "conversation", async () => {
    const current = readConversation(root, slug);
    await Bun.write(conversationPath(root, slug), opts.once ? withEntryOnce(current, e) : withEntry(current, e));
  });
}
