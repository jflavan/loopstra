import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { relativePath, toolTarget } from "../tools";
import type { TranscriptItem } from "./types";

/** The longest tool output one item carries. */
export const OUTPUT_MAX = 256 * 1024;
/** The most lines of a written file shown as an edit. */
const WRITE_LINES = 400;
/** The most of a raw file one read takes. */
const READ_MAX = 4 * 1024 * 1024;

type Raw = Record<string, unknown>;
type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function cut(text: string): string {
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n… (cut)` : text;
}

/** A tool result's content as text: a string, or the text parts of a list. */
function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Block[]).map((c) => (c?.type === "text" ? c.text ?? "" : c?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

const signed = (text: string, sign: "+" | "-"): string[] => text.split(/\r?\n/).map((l) => `${sign}${l}`);

/** An edit as unified-diff text: a file header, then one hunk per change. */
function editDiff(tool: string, path: string, input: Raw): string {
  const head = [`--- ${path}`, `+++ ${path}`];
  if (tool === "Write") {
    const all = String(input.content ?? "").split(/\r?\n/);
    const more = all.length > WRITE_LINES ? [`\\ ${all.length - WRITE_LINES} more lines`] : [];
    return [...head, "@@ new file @@", ...all.slice(0, WRITE_LINES).map((l) => `+${l}`), ...more].join("\n");
  }
  const edits = tool === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Raw[]) : [input];
  return [...head, ...edits.flatMap((e) => ["@@ edit @@", ...signed(String(e.old_string ?? ""), "-"), ...signed(String(e.new_string ?? ""), "+")])].join("\n");
}

const EDITS = new Set(["Edit", "MultiEdit", "Write"]);
/** Tools whose calls are not shown: the session's answer shows as its result instead. */
const HIDDEN = new Set(["StructuredOutput"]);

/**
 * One raw `stream-json` event as transcript items. `cwd`, the session's folder from its init event,
 * shortens paths. Events the console does not show (thinking, hooks, rate limits, progress) give none.
 */
export function toItems(e: Raw, cwd?: string): TranscriptItem[] {
  if (e.type === "assistant" || e.type === "user") {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const out: TranscriptItem[] = [];
    for (const b of content as Block[]) {
      if (e.type === "assistant" && b.type === "text" && b.text?.trim()) {
        out.push({ kind: "text", text: b.text });
      } else if (e.type === "assistant" && b.type === "tool_use" && b.name && b.id && !HIDDEN.has(b.name)) {
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Raw;
        if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
          out.push({ kind: "todos", items: (input.todos as Raw[]).map((t) => ({ text: String(t.content ?? ""), state: String(t.status ?? "") })) });
        } else if (EDITS.has(b.name)) {
          const path = relativePath(String(input.file_path ?? ""), cwd);
          out.push({ kind: "edit", id: b.id, tool: b.name, path, diff: editDiff(b.name, path, input) });
        } else {
          out.push({ kind: "tool", id: b.id, tool: b.name, target: toolTarget(b.name, input, cwd), input });
        }
      } else if (e.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        out.push({ kind: "tool-result", id: b.tool_use_id, ok: b.is_error !== true, output: cut(outputText(b.content)) });
      }
    }
    return out;
  }
  if (e.type === "system" && e.subtype === "permission_denied" && typeof e.tool_use_id === "string") {
    return [{ kind: "tool-result", id: e.tool_use_id, ok: false, output: `Not allowed: ${String(e.message ?? e.decision_reason ?? "")}` }];
  }
  if (e.type === "result") {
    const answer = e.structured_output as { summary?: unknown } | undefined;
    const summary = typeof answer?.summary === "string" ? answer.summary : typeof e.result === "string" ? e.result : "";
    return [{ kind: "result", ok: e.subtype === "success" && e.is_error !== true, summary, costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null }];
  }
  return [];
}

/** The folder a session's init event names, read from the start of its raw file. */
function initCwd(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      try {
        const e = JSON.parse(line) as Raw;
        if (e.type === "system" && e.subtype === "init") return typeof e.cwd === "string" ? e.cwd : undefined;
      } catch { /* a cut-off line */ }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
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

  /** The items of the finished lines after the offset, each with the offset just after its line. */
  read(maxBytes = READ_MAX): Array<{ item: TranscriptItem; offset: number }> {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size <= this.offset) return [];
    if (!this.cwdRead) {
      this.cwd = initCwd(this.path);
      this.cwdRead = true;
    }
    const fd = openSync(this.path, "r");
    let buf: Buffer;
    try {
      const want = Buffer.alloc(Math.min(size - this.offset, maxBytes));
      buf = want.subarray(0, readSync(fd, want, 0, want.length, this.offset));
    } finally {
      closeSync(fd);
    }
    const out: Array<{ item: TranscriptItem; offset: number }> = [];
    let start = 0;
    for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
      const line = buf.subarray(start, nl).toString("utf8");
      start = nl + 1;
      let e: Raw;
      try { e = JSON.parse(line) as Raw; } catch { continue; }
      if (e.type === "system" && e.subtype === "init" && typeof e.cwd === "string") this.cwd = e.cwd;
      for (const item of toItems(e, this.cwd)) out.push({ item, offset: this.offset + nl + 1 });
    }
    // A line longer than one whole read is skipped, so one huge event cannot stall the stream.
    if (start === 0 && buf.length === maxBytes) start = buf.length;
    this.offset += start;
    return out;
  }
}
