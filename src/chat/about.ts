import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "../console/files";
import { TranscriptReader } from "../console/transcript";
import type { TranscriptItem } from "../console/types";
import { readConversation } from "../conversation";
import { readIntent, SLUG } from "../intents";
import { Trace, type PhaseRow } from "../trace";

/** The change (and the session of it) the drawer was opened from, as the page sends it with the first message. */
export interface About { slug: string; seq?: number }

/** The most characters of each part. */
const PART_MAX = 4000;
/** The newest items of the session's transcript. */
const ITEMS = 50;
/** The most characters of one transcript line. */
const LINE_MAX = 300;
/** How far back from its end a transcript is read for its newest items. */
const TAIL_BYTES = 4 * 1024 * 1024;

const one = (s: string, max = LINE_MAX) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Its start, cut to PART_MAX. */
const head = (s: string) => (s.length > PART_MAX ? `${s.slice(0, PART_MAX - 2)}\n…` : s);
/** Its end, cut to PART_MAX: the newest of a record or a transcript. */
const tail = (s: string) => (s.length > PART_MAX ? `…\n${s.slice(-(PART_MAX - 2))}` : s);

/** A transcript item as one line of text for the orchestrator. */
export function itemLine(item: TranscriptItem): string {
  switch (item.kind) {
    case "text": return `text: ${one(item.text)}`;
    case "tool": return `tool ${item.tool}: ${one(item.target)}`;
    case "tool-result": return `${item.ok ? "output" : "failed"}: ${one(item.output.split("\n").find((l) => l.trim()) ?? "")}`;
    case "edit": return `edit: ${item.path}`;
    case "todos": return `todos: ${one(item.items.map((t) => `${t.text} (${t.state})`).join("; "))}`;
    case "result": return `result: ${item.ok ? "success" : "failed"}${item.summary.trim() ? ` (${one(item.summary)})` : ""}`;
    case "message": return `${item.redirect ? "redirect" : "message"}: ${one(item.text)}`;
  }
}

/** What a part says, or null when it cannot be read (each part is read on its own: one that fails leaves the rest). */
function safely<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/** The newest ITEMS items of a phase's transcript, as lines. */
function lastSteps(root: string, slug: string, phase: PhaseRow): string[] {
  const path = join(runsDir(root), slug, "phases", `${phase.seq}-${phase.name}`, "raw.jsonl");
  if (!existsSync(path)) return [];
  // From near its end: a line cut at the start is not an event, and is passed over.
  const reader = new TranscriptReader(path, Math.max(0, statSync(path).size - TAIL_BYTES));
  let items: TranscriptItem[] = [];
  for (let guard = 0; !reader.atEnd() && guard < 100; guard++) {
    const before = reader.offset;
    items = [...items, ...reader.read(undefined, { final: true }).map((r) => r.item)].slice(-ITEMS);
    if (reader.offset === before) break;
  }
  return items.map(itemLine);
}

/**
 * What the orchestrator is told about the change a person opened chat from (see IncomingMessage.about):
 * the intent, conversation.md, the note, the newest failed phase and its error, and the last steps of
 * the session (`seq`, else the newest agent session), each cut to a few thousand characters. Each part
 * is read on its own; one that cannot be read is left out. "" when there is nothing.
 */
export async function aboutContext(root: string, about: About): Promise<string> {
  if (!SLUG.test(about.slug) || !existsSync(join(root, "intent", about.slug, "intent.md"))) return "";
  const parts: string[] = [];
  const intentText = safely(() => readFileSync(join(root, "intent", about.slug, "intent.md"), "utf8"));
  if (intentText?.trim()) parts.push(`Intent:\n${head(intentText.trim())}`);
  const record = safely(() => readConversation(root, about.slug));
  parts.push(`conversation.md:\n${record?.trim() ? tail(record.trim()) : "(nothing yet)"}`);
  const note = await readIntent(root, about.slug).then((i) => i.file.frontmatter.note.trim(), () => "");
  if (note) parts.push(`Note:\n${head(note)}`);
  const rows = safely(() => {
    const trace = Trace.open(root, () => {});
    try { return trace.phases(about.slug); } finally { trace.close(); }
  }) ?? [];
  const failed = rows.findLast((p) => p.status === "fail");
  if (failed) parts.push(`Newest failure:\n${head(`${failed.name}: ${(failed.error ?? "").trim() || "no error recorded"}`)}`);
  const session = about.seq !== undefined ? rows.find((p) => p.seq === about.seq) : rows.findLast((p) => p.kind === "agent");
  if (session) {
    const steps = safely(() => lastSteps(root, about.slug, session)) ?? [];
    if (steps.length) parts.push(`The session's last steps:\n${tail(steps.join("\n"))}`);
  }
  return parts.join("\n\n");
}
