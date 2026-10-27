import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEANWHILE_HEADING } from "../../src/console/steerable";
import { OUTPUT_MAX, resumePoint, toItems, TranscriptReader } from "../../src/console/transcript";
import { frameId, parseFrameId, type TranscriptItem } from "../../src/console/types";
import { messageText, redirectText } from "../../src/steering";
import { tempDir } from "../helpers";

const CWD = "C:\\repo\\.loopstra\\worktrees\\csv";
const RAW: Array<Record<string, unknown>> = [
  { type: "system", subtype: "init", cwd: CWD, session_id: "s", model: "claude-sonnet-5-5" },
  { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Reading the parser first." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: `${CWD}\\src\\csv.ts` } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export function parse() {}" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${CWD}\\src\\csv.ts`, old_string: "a\nb", new_string: "a\nc" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok" }] }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [{ content: "Write tests", status: "completed", activeForm: "x" }, { content: "Ship", status: "in_progress" }] } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "bun test" } }] } },
  { type: "system", subtype: "permission_denied", tool_use_id: "t4", message: "Contains simple_expansion" },
  { type: "rate_limit_event", rate_limit_info: {} },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t5", name: "StructuredOutput", input: { status: "success" } }] } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, structured_output: { status: "success", summary: "Added the export." } },
];

const EXPECTED: TranscriptItem[] = [
  { kind: "text", text: "Reading the parser first." },
  { kind: "tool", id: "t1", tool: "Read", target: "src/csv.ts", input: { file_path: `${CWD}\\src\\csv.ts` } },
  { kind: "tool-result", id: "t1", ok: true, output: "export function parse() {}" },
  { kind: "edit", id: "t2", tool: "Edit", path: "src/csv.ts", diff: "--- src/csv.ts\n+++ src/csv.ts\n@@ edit @@\n-a\n-b\n+a\n+c" },
  { kind: "tool-result", id: "t2", ok: true, output: "ok" },
  { kind: "todos", items: [{ text: "Write tests", state: "completed" }, { text: "Ship", state: "in_progress" }] },
  { kind: "tool", id: "t4", tool: "Bash", target: "bun test", input: { command: "bun test" } },
  { kind: "tool-result", id: "t4", ok: false, output: "Not allowed: Contains simple_expansion" },
  { kind: "result", ok: true, summary: "Added the export.", costUsd: 0.42 },
];

const jsonl = (events: Array<Record<string, unknown>>) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

/** A session that hands work to one subagent, from a real stream (Claude Code 2.1.311, --forward-subagent-text), paths shortened. */
const SUBAGENT_FILE = readFileSync(new URL("../fixtures/subagent.jsonl", import.meta.url), "utf8");
const SUBAGENT = SUBAGENT_FILE.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
const SUBAGENT_CALL = { subagent_type: "sec", description: "Security review of a.txt", prompt: "Review the file a.txt in /wt for security problems. Report your verdict on one line.", run_in_background: false };

describe("session transcripts", () => {
  test("raw events become items; thinking, hooks, limits and the answer tool are left out", () => {
    // Strictly equal: a session without subagents gives the items it always gave, with no parent field.
    expect(RAW.flatMap((e) => toItems(e, CWD))).toStrictEqual(EXPECTED);
  });

  test("a person's message and redirect echoed by the session are items; the prompt's echo is not", () => {
    const replay = (text: string) => ({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text }] } });
    const m = { id: "1", seq: 3, kind: "message" as const, text: "Cover negatives.\n\nAnd zero.", by: "John", via: "the dashboard", at: "" };
    // The person's own words: the runner's lead (up to the first ": ") and closing words are left out.
    expect(toItems(replay(messageText(m)))).toEqual([{ kind: "message", text: "Cover negatives.\n\nAnd zero.", redirect: false }]);
    expect(toItems(replay(redirectText({ ...m, kind: "redirect", text: "Use two steps." })))).toEqual([{ kind: "message", text: "Use two steps.", redirect: true }]);
    // Only the first ": " of the first line ends the lead.
    expect(toItems(replay(messageText({ ...m, text: "Note: keep it small.\n\nWhy: speed." })))).toEqual([{ kind: "message", text: "Note: keep it small.\n\nWhy: speed.", redirect: false }]);
    // A redirect with what was sent meanwhile: the person's words only.
    expect(toItems(replay(`${redirectText({ ...m, kind: "redirect", text: "Use two steps." })}\n\nMessages sent meanwhile:\n\nx`))).toEqual([{ kind: "message", text: "Use two steps.", redirect: true }]);
    // The messages it carries (sent to the killed process, not taken up yet) show too, each after the redirect.
    const carried = `${redirectText({ ...m, kind: "redirect", text: "Use two steps." })}\n\n${MEANWHILE_HEADING}\n\n${messageText(m)}\n\n${messageText({ ...m, by: "Ana", text: "Keep it small." })}`;
    expect(toItems(replay(carried))).toEqual([
      { kind: "message", text: "Use two steps.", redirect: true },
      { kind: "message", text: "Cover negatives.\n\nAnd zero.", redirect: false },
      { kind: "message", text: "Keep it small.", redirect: false },
    ]);
    // Without the runner's closing words (an older runner), the first paragraph.
    expect(toItems(replay("A message from Ana: keep it small\n\nmore"))).toEqual([{ kind: "message", text: "keep it small", redirect: false }]);
    expect(toItems({ type: "user", isReplay: true, message: { role: "user", content: "A message from Ana: as a string" } })).toEqual([{ kind: "message", text: "as a string", redirect: false }]);
    // The prompt, the nudge, an answer: replayed, but nothing to show.
    expect(toItems(replay("You are the design phase. FIXTURE:design"))).toEqual([]);
    // Not a replay: a user's text block is not shown.
    expect(toItems({ type: "user", message: { content: [{ type: "text", text: "A message from John: hi" }] } })).toEqual([]);
  });

  test("a written file shows its first 400 lines; a long output is cut; a failed session's result says so", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const [write] = toItems({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/wt/a.txt", content } }] } }, "/wt");
    expect(write).toMatchObject({ kind: "edit", path: "a.txt" });
    const diff = (write as Extract<TranscriptItem, { kind: "edit" }>).diff.split("\n");
    expect(diff.slice(0, 3)).toEqual(["--- a.txt", "+++ a.txt", "@@ new file @@"]);
    expect(diff.filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toHaveLength(400);
    expect(diff.at(-1)).toBe("\\ 100 more lines");
    const [big] = toItems({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "x".repeat(OUTPUT_MAX + 10), is_error: true }] } });
    expect(big).toMatchObject({ kind: "tool-result", ok: false });
    expect((big as { output: string }).output.endsWith("… (cut)")).toBe(true);
    expect(toItems({ type: "result", subtype: "error_max_turns", is_error: true, result: "Too many turns" }))
      .toEqual([{ kind: "result", ok: false, summary: "Too many turns", costUsd: null }]);
  });

  test("the reader goes line by line from an offset, waits for a line to be finished, and knows the session's folder", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      const reader = new TranscriptReader(path);
      expect(reader.read()).toEqual([]);
      expect(reader.atEnd()).toBe(true);
      writeFileSync(path, jsonl(RAW.slice(0, 4)));
      const first = reader.read();
      expect(first.map((r) => r.item)).toEqual(EXPECTED.slice(0, 3));
      // Every item has an id of its own. Of two items from one line, the first has the line's start
      // and its index in the line, the last the line's end: a page that reconnects after the first
      // resumes at the line's start and gets the line again, rather than losing the second.
      const [start, end] = [Buffer.byteLength(jsonl(RAW.slice(0, 2))), Buffer.byteLength(jsonl(RAW.slice(0, 3)))];
      expect(first.map((r) => r.id)).toEqual([`${start}.0`, String(end), String(Buffer.byteLength(jsonl(RAW.slice(0, 4))))]);
      expect(resumePoint(first[0]!.id)).toBe(start);
      expect(new TranscriptReader(path, resumePoint(first[0]!.id)).read().map((r) => r.item)).toEqual(EXPECTED.slice(0, 3));
      expect(new TranscriptReader(path, resumePoint(first[1]!.id)).read().map((r) => r.item)).toEqual(EXPECTED.slice(2, 3));
      expect(reader.atEnd()).toBe(true);

      const line = JSON.stringify(RAW[4]);
      appendFileSync(path, line.slice(0, 20));
      expect(reader.read()).toEqual([]);
      expect(reader.atEnd()).toBe(false);
      appendFileSync(path, `${line.slice(20)}\n`);
      expect(reader.read().map((r) => r.item)).toEqual([EXPECTED[3]!]);

      // A reader started part way still shortens paths: it reads the init line first.
      const later = new TranscriptReader(path, resumePoint(first[2]!.id));
      expect(later.read().map((r) => r.item)).toEqual([EXPECTED[3]!]);
    } finally {
      t.cleanup();
    }
  });

  test("a frame id's resume point is its line's start for a row inside a line, and its number otherwise", () => {
    expect(resumePoint("123.4")).toBe(123);
    expect(resumePoint("123.0")).toBe(123);
    expect(resumePoint("456")).toBe(456);
    for (const bad of [null, undefined, "", "0", "-5", "abc", "12.x", "12x", "1e3", " 7"]) expect({ bad, at: resumePoint(bad) }).toEqual({ bad, at: 0 });
  });

  test("a frame id is built and read in one place: a line's end alone, or its start and the row's index", () => {
    expect(frameId(200)).toBe("200");
    expect(frameId(100, 1)).toBe("100.1");
    expect(parseFrameId("200")).toEqual({ at: 200, last: true });
    expect(parseFrameId("100.1")).toEqual({ at: 100, last: false });
    expect(parseFrameId("0.0")).toEqual({ at: 0, last: false });
    for (const bad of ["", "12x", "12.x", "12.", ".1", "-5", "1e3", " 7", "1.2.3", "99999999999999999999"]) expect({ bad, parsed: parseFrameId(bad) }).toEqual({ bad, parsed: null });
  });

  test("a line that is not an event, or has odd fields, is skipped and the lines after it still come", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      const odd = [
        "null", "42", "[1,2]", '"text"',
        JSON.stringify({ type: "assistant", message: { content: [null, { type: "text", text: 5 }, { type: "tool_use", id: 7, name: "Bash", input: {} }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "m", name: "MultiEdit", input: { file_path: `${CWD}\\a.ts`, edits: [null, { old_string: "x", new_string: "y" }] } }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "td", name: "TodoWrite", input: { todos: [null, { content: "Ship", status: "pending" }] } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r", content: [null, { type: "text", text: 3 }, { type: "text", text: "ok" }] }] } }),
        JSON.stringify({ type: "user", message: null }),
        JSON.stringify({ type: "result", subtype: "success", structured_output: null, result: "Done." }),
      ];
      writeFileSync(path, `${JSON.stringify(RAW[0])}\n${odd.join("\n")}\n${jsonl(RAW.slice(2, 4))}`);
      const reader = new TranscriptReader(path);
      expect(reader.read().map((r) => r.item)).toEqual([
        { kind: "edit", id: "m", tool: "MultiEdit", path: "a.ts", diff: "--- a.ts\n+++ a.ts\n@@ edit @@\n-x\n+y" },
        { kind: "todos", items: [{ text: "Ship", state: "pending" }] },
        { kind: "tool-result", id: "r", ok: true, output: "ok" },
        { kind: "result", ok: true, summary: "Done.", costUsd: null },
        ...EXPECTED.slice(0, 3),
      ]);
      expect(reader.atEnd()).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("Windows line endings, a character split across two reads, and a line longer than one read", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      writeFileSync(path, RAW.slice(0, 4).map((e) => `${JSON.stringify(e)}\r\n`).join(""));
      expect(new TranscriptReader(path).read().map((r) => r.item)).toEqual(EXPECTED.slice(0, 3));

      // "é" is two bytes. The first read ends between them; the line is read whole by the next one.
      const said = { type: "assistant", message: { content: [{ type: "text", text: "Café, résumé, naïve." }] } };
      const line = JSON.stringify(said);
      const max = Buffer.byteLength(line) + 1;
      const filler = "x".repeat(max - 2 - Buffer.from(line).indexOf(Buffer.from("é")));
      writeFileSync(path, `${filler}\n${line}\n`);
      expect(Buffer.from(`${filler}\n${line}`).subarray(max - 1, max + 1).toString()).toBe("é");
      const small = new TranscriptReader(path);
      const items: TranscriptItem[] = [];
      for (let k = 0; k < 10 && !small.atEnd(); k++) items.push(...small.read(max).map((r) => r.item));
      expect(items).toEqual([{ kind: "text", text: "Café, résumé, naïve." }]);
      expect(small.offset).toBe(Buffer.byteLength(`${filler}\n${line}\n`));

      // A line longer than a whole read is passed over, so the stream goes on after it.
      writeFileSync(path, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "y".repeat(500) }] } })}\n${line}\n`);
      const long = new TranscriptReader(path);
      const after: TranscriptItem[] = [];
      for (let k = 0; k < 20 && !long.atEnd(); k++) after.push(...long.read(200).map((r) => r.item));
      expect(after).toEqual([{ kind: "text", text: "Café, résumé, naïve." }]);
    } finally {
      t.cleanup();
    }
  });

  test("a last read takes a line the file ends without a newline; an unreadable one is passed over", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      writeFileSync(path, `${jsonl(RAW.slice(0, 2))}${JSON.stringify(RAW[11])}`);
      const reader = new TranscriptReader(path);
      expect(reader.read()).toEqual([]);
      expect(reader.atEnd()).toBe(false);
      expect(reader.read(undefined, { final: true })).toEqual([{ item: EXPECTED[8]!, id: String(Bun.file(path).size) }]);
      expect(reader.atEnd()).toBe(true);

      writeFileSync(path, `${jsonl(RAW.slice(0, 4))}{"type":"assist`);
      const cut = new TranscriptReader(path);
      expect(cut.read(undefined, { final: true }).map((r) => r.item)).toEqual(EXPECTED.slice(0, 3));
      expect(cut.atEnd()).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("a subagent's work carries the id of the call that started it, and its prompt is never a person's message", () => {
    // Strictly equal: the main session's own rows have no parent at all, as before.
    expect(SUBAGENT.flatMap((e) => toItems(e, "/wt"))).toStrictEqual([
      { kind: "tool", id: "toolu_agent", tool: "Agent", target: "sec: Security review of a.txt", input: SUBAGENT_CALL },
      { kind: "delegated", parent: "toolu_agent", text: "Review the file a.txt in /wt for security problems. Report your verdict on one line." },
      { kind: "text", text: "Reading the file first.", parent: "toolu_agent" },
      { kind: "tool", id: "toolu_read", tool: "Read", target: "a.txt", input: { file_path: "/wt/a.txt" }, parent: "toolu_agent" },
      { kind: "tool-result", id: "toolu_read", ok: true, output: "1\thi\n2\t", parent: "toolu_agent" },
      { kind: "text", text: "SECURITY-OK: a.txt holds only the text \"hi\".", parent: "toolu_agent" },
      { kind: "tool-result", id: "toolu_agent", ok: true, output: "SECURITY-OK: a.txt holds only the text \"hi\".\nagentId: a1\n<usage>subagent_tokens: 5264\ntool_uses: 1\nduration_ms: 4102</usage>" },
      { kind: "text", text: "**Verdict: SECURITY-OK.** The reviewer found no security problems in `a.txt`." },
      { kind: "result", ok: true, summary: "Verdict: SECURITY-OK.", costUsd: 0.0067 },
    ]);
    // A prompt given as a string is the subagent's prompt too; an empty one shows nothing.
    expect(toItems({ type: "user", message: { content: "Look at b.txt" }, parent_tool_use_id: "p" })).toEqual([{ kind: "delegated", parent: "p", text: "Look at b.txt" }]);
    expect(toItems({ type: "user", message: { content: [{ type: "text", text: "  " }] }, parent_tool_use_id: "p" })).toEqual([]);
    // A subagent's todo list is a row in its block; the session's own is its list.
    const todo = { type: "tool_use", id: "tw", name: "TodoWrite", input: { todos: [{ content: "check a.txt", status: "pending" }] } };
    expect(toItems({ type: "assistant", message: { content: [todo] }, parent_tool_use_id: "p" }))
      .toEqual([expect.objectContaining({ kind: "tool", id: "tw", tool: "TodoWrite", parent: "p" })]);
    expect(toItems({ type: "assistant", message: { content: [todo] } })).toEqual([{ kind: "todos", items: [{ text: "check a.txt", state: "pending" }] }]);
    // An Agent call with no subagent type (and an older CLI's Task) names what it hands off.
    expect(toItems({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Task", input: { description: "Find the parser" } }] } }))
      .toEqual([{ kind: "tool", id: "t", tool: "Task", target: "Find the parser", input: { description: "Find the parser" } }]);
  });

  test("a reader resumed in the middle of a subagent's work still knows which call each row belongs to", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      writeFileSync(path, SUBAGENT_FILE);
      const read = SUBAGENT_FILE.split("\n").findIndex((l) => l.includes('"toolu_read","name"'));
      const from = Buffer.byteLength(SUBAGENT_FILE.split("\n").slice(0, read).join("\n")) + 1;
      expect(new TranscriptReader(path, from).read().map((r) => r.item).slice(0, 3)).toEqual([
        { kind: "tool", id: "toolu_read", tool: "Read", target: "a.txt", input: { file_path: "/wt/a.txt" }, parent: "toolu_agent" },
        { kind: "tool-result", id: "toolu_read", ok: true, output: "1\thi\n2\t", parent: "toolu_agent" },
        { kind: "text", text: "SECURITY-OK: a.txt holds only the text \"hi\".", parent: "toolu_agent" },
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("a reader started part way finds the session's folder past a long first line", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "raw.jsonl");
      const init = { ...RAW[0], tools: "t".repeat(200 * 1024) };
      writeFileSync(path, `${JSON.stringify({ type: "system", subtype: "hook_started" })}\n${JSON.stringify(init)}\n`);
      const offset = Bun.file(path).size;
      appendFileSync(path, jsonl(RAW.slice(2, 3)));
      expect(new TranscriptReader(path, offset).read().map((r) => r.item)).toEqual(EXPECTED.slice(0, 2));
    } finally {
      t.cleanup();
    }
  });
});
