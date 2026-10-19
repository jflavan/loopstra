import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { relativePath, toolTarget } from "../tools";
import { MEANWHILE_HEADING, MESSAGE_LEAD, MESSAGE_TAIL, REDIRECT_LEAD, REDIRECT_TAIL } from "./steerable";
import type { TranscriptItem } from "./types";

/** The longest tool output one item carries. */
export const OUTPUT_MAX = 256 * 1024;
/** The most lines of a written file shown as an edit. */
const WRITE_LINES = 400;
/** The most of a raw file one read takes. */
const READ_MAX = 4 * 1024 * 1024;
/** How far into a raw file the session's init event is looked for; its line lists every tool, so it can be long. */
const INIT_MAX = 16 * 1024 * 1024;

type Raw = Record<string, unknown>;
/** A content block as the CLI writes it; the fields are checked before use, since a line may hold anything. */
type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
/** A tool input's field as text: only a string is shown (a field may hold anything, as a line may). */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** One line of a raw file as an event, or null when it is not one (a cut-off line, a bare value). */
function rawEvent(line: string): Raw | null {
  try {
    const v = JSON.parse(line) as unknown;
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function cut(text: string): string {
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n… (cut)` : text;
}

/** A tool result's content as text: a string, or the text parts of a list. */
function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as unknown[]).filter(isObject).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : c.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

const signed = (text: string, sign: "+" | "-"): string[] => text.split(/\r?\n/).map((l) => `${sign}${l}`);

/** An edit as unified-diff text: a file header, then one hunk per change. */
function editDiff(tool: string, path: string, input: Raw): string {
  const head = [`--- ${path}`, `+++ ${path}`];
  if (tool === "Write") {
    const all = text(input.content).split(/\r?\n/);
    const more = all.length > WRITE_LINES ? [`\\ ${all.length - WRITE_LINES} more lines`] : [];
    return [...head, "@@ new file @@", ...all.slice(0, WRITE_LINES).map((l) => `+${l}`), ...more].join("\n");
  }
  const edits = tool === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as unknown[]).filter(isObject) : [input];
  return [...head, ...edits.flatMap((e) => ["@@ edit @@", ...signed(text(e.old_string), "-"), ...signed(text(e.new_string), "+")])].join("\n");
}

const EDITS = new Set(["Edit", "MultiEdit", "Write"]);
/** Tools whose calls are not shown: the session's answer shows as its result instead. */
const HIDDEN = new Set(["StructuredOutput"]);

/**
 * A user message the session echoed as it took it up (see the live sessions in src/claude.ts): a
 * person's message or redirect, which the runner starts with MESSAGE_LEAD or REDIRECT_LEAD, is an item
 * with the person's words (the runner's lead and closing words left out, else the first paragraph). Any other
 * echo (the prompt, a nudge, an answer to a question) shows nothing.
 */
function replayed(content: unknown): TranscriptItem[] {
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? (content as unknown[]).filter(isObject).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string) : [];
  const out: TranscriptItem[] = [];
  for (const raw of texts) {
    const text = raw.replace(/\r\n/g, "\n").trim();
    const redirect = text.startsWith(REDIRECT_LEAD);
    if (!redirect && !text.startsWith(MESSAGE_LEAD)) continue;
    const tail = text.indexOf(`\n\n${redirect ? REDIRECT_TAIL : MESSAGE_TAIL}`);
    const words = tail >= 0 ? text.slice(0, tail) : text.split(/\n\s*\n/)[0]!;
    out.push({ kind: "message", text: cut(ownWords(words.trim())), redirect });
    if (redirect) out.push(...carried(text));
  }
  return out;
}

/**
 * The messages a redirect carries (sent to the killed process, not taken up yet: see src/claude.ts),
 * one item each, the runner's closing words left out.
 */
function carried(redirect: string): TranscriptItem[] {
  const at = redirect.indexOf(`\n\n${MEANWHILE_HEADING}\n\n`);
  if (at < 0) return [];
  return redirect.slice(at + MEANWHILE_HEADING.length + 4).split(`\n\n${MESSAGE_TAIL}`)
    .map((m) => m.trim())
    .filter((m) => m.startsWith(MESSAGE_LEAD))
    .map((m) => ({ kind: "message" as const, text: cut(ownWords(m)), redirect: false }));
}

/**
 * A message or redirect without the runner's lead ("A message from John, who is watching this work from
 * the dashboard: "): up to and including the first ": " of its first line. The bubble's label says which it is.
 */
function ownWords(text: string): string {
  const firstLine = text.split("\n", 1)[0]!;
  const at = firstLine.indexOf(": ");
  return at < 0 ? text : text.slice(at + 2);
}

/**
 * One raw `stream-json` event as transcript items. `cwd`, the session's folder from its init event,
 * shortens paths. Events the console does not show (thinking, hooks, rate limits, progress) give none.
 */
export function toItems(e: Raw, cwd?: string): TranscriptItem[] {
  if (e.type === "user" && e.isReplay === true) return replayed((e.message as { content?: unknown } | undefined)?.content);
  if (e.type === "assistant" || e.type === "user") {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const out: TranscriptItem[] = [];
    for (const b of (content as unknown[]).filter(isObject) as Block[]) {
      if (e.type === "assistant" && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ kind: "text", text: b.text });
      } else if (e.type === "assistant" && b.type === "tool_use" && typeof b.name === "string" && b.name && typeof b.id === "string" && b.id && !HIDDEN.has(b.name)) {
        const input = isObject(b.input) ? b.input : {};
        if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
          out.push({ kind: "todos", items: (input.todos as unknown[]).filter(isObject).map((t) => ({ text: text(t.content), state: text(t.status) })) });
        } else if (EDITS.has(b.name)) {
          const path = relativePath(text(input.file_path), cwd);
          out.push({ kind: "edit", id: b.id, tool: b.name, path, diff: editDiff(b.name, path, input) });
        } else {
          out.push({ kind: "tool", id: b.id, tool: b.name, target: toolTarget(b.name, input, cwd), input });
        }
      } else if (e.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string" && b.tool_use_id) {
        out.push({ kind: "tool-result", id: b.tool_use_id, ok: b.is_error !== true, output: cut(outputText(b.content)) });
      }
    }
    return out;
  }
  if (e.type === "system" && e.subtype === "permission_denied" && typeof e.tool_use_id === "string") {
    return [{ kind: "tool-result", id: e.tool_use_id, ok: false, output: `Not allowed: ${text(e.message) || text(e.decision_reason)}` }];
  }
  if (e.type === "result") {
    const answer = isObject(e.structured_output) ? e.structured_output : undefined;
    const summary = typeof answer?.summary === "string" ? answer.summary : typeof e.result === "string" ? e.result : "";
    return [{ kind: "result", ok: e.subtype === "success" && e.is_error !== true, summary, costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null }];
  }
  return [];
}

/**
 * The folder a session's init event names, read from the start of its raw file line by line up to
 * that event (hook events may come before it), so a long init line is still read whole.
 */
function initCwd(fd: number): string | undefined {
  let buf = Buffer.alloc(64 * 1024);
  let filled = 0;
  let start = 0;
  for (;;) {
    if (filled === buf.length) {
      if (buf.length >= INIT_MAX) return undefined;
      const bigger = Buffer.alloc(Math.min(buf.length * 2, INIT_MAX));
      buf.copy(bigger, 0, 0, filled);
      buf = bigger;
    }
    const n = readSync(fd, buf, filled, buf.length - filled, filled);
    if (n === 0) return undefined;
    const got = buf.subarray(0, filled + n);
    for (let nl = got.indexOf(10, filled); nl >= 0; nl = got.indexOf(10, nl + 1)) {
      const e = rawEvent(got.subarray(start, nl).toString("utf8"));
      start = nl + 1;
      if (e?.type === "system" && e.subtype === "init") return typeof e.cwd === "string" ? e.cwd : undefined;
    }
    filled += n;
  }
}

/** One transcript item with its frame id (see TranscriptReader.read). */
interface ReadItem { item: TranscriptItem; id: string }

/**
 * The byte offset a session stream resumes from, given the frame id a page names (Last-Event-ID or
 * `from`): the number before the dot, so "123.4" (a row inside the line that starts at 123) resumes
 * at 123 and the line is sent again. Anything that is not such an id, or not above 0, is 0, the start.
 */
export function resumePoint(id: string | null | undefined): number {
  const m = /^(\d+)(?:\.\d+)?$/.exec(id ?? "");
  const at = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(at) && at > 0 ? at : 0;
}

/** Reads a phase's raw.jsonl as transcript items from a byte offset, one finished line at a time. */
export class TranscriptReader {
  private cwd: string | undefined;
  private cwdRead = false;

  constructor(private readonly path: string, public offset = 0) {}

  /** Whether everything written so far has been read. */
  atEnd(): boolean {
    return !existsSync(this.path) || statSync(this.path).size <= this.offset;
  }

  /**
   * The items of the finished lines after the offset, each with a frame id of its own: the line's
   * last item has the line's end ("200"), any other the line's start and its index in the line
   * ("100.1"). A page that reconnects after an earlier item resumes at the line's start (see
   * resumePoint), so it gets that line again rather than losing the items after it, and passes over
   * the rows it has drawn by their ids. With `final` the file is known to be complete, so its
   * end also ends a last line written without a newline.
   */
  read(maxBytes = READ_MAX, opts: { final?: boolean } = {}): ReadItem[] {
    // One open file for the size and every read, so they all see the same file.
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch (e) { if ((e as { code?: string })?.code === "ENOENT") return []; throw e; }
    let buf: Buffer;
    let size: number;
    try {
      size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      if (!this.cwdRead) {
        this.cwd = initCwd(fd);
        this.cwdRead = true;
      }
      const want = Buffer.alloc(Math.min(size - this.offset, maxBytes));
      buf = want.subarray(0, readSync(fd, want, 0, want.length, this.offset));
    } finally {
      closeSync(fd);
    }
    const out: ReadItem[] = [];
    let start = 0;
    /** Takes the line from `start` to `end`; the next one begins at `next`. */
    const line = (end: number, next: number) => {
      const e = rawEvent(buf.subarray(start, end).toString("utf8"));
      const lineStart = this.offset + start;
      start = next;
      if (!e) return;
      if (e.type === "system" && e.subtype === "init" && typeof e.cwd === "string") this.cwd = e.cwd;
      // An event in a shape nothing here expected is passed over, so the lines after it still come.
      let items: TranscriptItem[];
      try { items = toItems(e, this.cwd); } catch { return; }
      items.forEach((item, k) => out.push({ item, id: k === items.length - 1 ? String(this.offset + next) : `${lineStart}.${k}` }));
    };
    for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) line(nl, nl + 1);
    if (opts.final && start < buf.length && this.offset + buf.length >= size) line(buf.length, buf.length);
    // A line longer than one whole read is skipped, so one huge event cannot stall the stream.
    if (start === 0 && buf.length === maxBytes) start = buf.length;
    this.offset += start;
    return out;
  }
}
