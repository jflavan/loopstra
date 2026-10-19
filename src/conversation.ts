import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runDir } from "./paths";
import { readJsonAs, writeJson } from "./fsutil";
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

/** The record's entries (the heading first), each without its time. */
const entriesOf = (current: string) => current.trim().split(/\n(?=## )/).map(timeless);

/**
 * The record with one more entry, unless it already ends with that same entry (whatever its time): an
 * earlier try whose commit failed left it on disk.
 */
export function withEntryOnce(current: string, e: ConversationEntry): string {
  const last = entriesOf(current).at(-1) ?? "";
  return last === timeless(conversationEntry(e)) ? current : withEntry(current, e);
}

/**
 * `.loopstra/runs/<slug>/recorded.json`: the inbox messages whose entries were written to conversation.md,
 * by message id, with the kind of entry each got. Not in the record itself: an id there would show in
 * the record people read and every prompt quotes.
 */
function recordedPath(root: string, slug: string): string {
  return join(runDir(root, slug), "recorded.json");
}

type EntryKind = ConversationEntry["kind"];

const ENTRY_KINDS = ["message", "redirect", "question", "answer", "later", "sent-back", "took-back"] as const satisfies readonly EntryKind[];

/** recorded.json's shape: message id to the kind of entry it got. */
const RecordedSchema = z.record(z.string(), z.enum(ENTRY_KINDS));

/** An inbox message as its record is looked for: who sent it, from where, and its words. */
interface Recorded { who: string; via: string; text: string }

/**
 * True when the record holds the inbox message's entry: one by the same person from the same place
 * (its header), addressed to a phase or to the next session (which of them is not known to every
 * caller), whose body is exactly the message's text. The whole entry, never the words alone: "ok" is
 * in many a record, and a message whose first commit failed must still be written.
 */
function holdsEntry(current: string, m: Recorded): boolean {
  const head = `## ${one(m.who)} (${one(m.via)}) `;
  const text = body(m.text);
  return entriesOf(current).some((entry) => {
    if (!entry.startsWith(head)) return false;
    const nl = entry.indexOf("\n");
    const address = nl < 0 ? entry.slice(head.length) : entry.slice(head.length, nl);
    return /^(→|redirects) \S/.test(address) && (nl < 0 ? "" : entry.slice(nl + 1)) === text;
  });
}

/**
 * The kind of entry an inbox message got in conversation.md ("message", "redirect", "later"), or null
 * when it has none: never written, or its entry is no longer in the record (a failed write put back;
 * see holdsEntry).
 */
export function recordedAs(root: string, slug: string, id: string, m: Recorded, current = readConversation(root, slug)): EntryKind | null {
  const kind = readJsonAs(recordedPath(root, slug), RecordedSchema)?.[id];
  return kind && holdsEntry(current, m) ? kind : null;
}

/** Notes that an inbox message's entry is written. A failure is left: at worst a later try writes the entry again. */
function noteRecorded(root: string, slug: string, id: string, kind: EntryKind): void {
  try {
    writeJson(recordedPath(root, slug), { ...readJsonAs(recordedPath(root, slug), RecordedSchema), [id]: kind });
  } catch { /* see above */ }
}

/**
 * Appends one entry and commits it ("loopstra(<slug>): conversation"). Under commitRecord's lock, so two
 * entries written at once (a message and an answer) both land. `id`: the inbox
 * message the entry is for, whose entry is written once only, wherever it is in the record (see
 * recordedAs): an earlier try whose commit failed wrote it, and a later entry's commit may have taken it
 * along. What is on disk is committed either way.
 */
export async function appendConversation(root: string, main: string, slug: string, e: ConversationEntry, opts: { id?: string } = {}): Promise<void> {
  await commitRecord(root, main, slug, "conversation", async () => {
    const current = readConversation(root, slug);
    if (opts.id && "who" in e && "text" in e && recordedAs(root, slug, opts.id, e, current)) return;
    await Bun.write(conversationPath(root, slug), withEntry(current, e));
    if (opts.id) noteRecorded(root, slug, opts.id, e.kind);
  });
}
