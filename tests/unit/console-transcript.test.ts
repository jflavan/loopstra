import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_MAX, toItems, TranscriptReader } from "../../src/console/transcript";
import type { TranscriptItem } from "../../src/console/types";
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

describe("session transcripts", () => {
  test("raw events become items; thinking, hooks, limits and the answer tool are left out", () => {
    expect(RAW.flatMap((e) => toItems(e, CWD))).toEqual(EXPECTED);
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
      expect(first[0]!.offset).toBe(first[1]!.offset); // two items from one line share its end
      expect(first[2]!.offset).toBeGreaterThan(first[1]!.offset);
      expect(reader.atEnd()).toBe(true);

      const line = JSON.stringify(RAW[4]);
      appendFileSync(path, line.slice(0, 20));
      expect(reader.read()).toEqual([]);
      expect(reader.atEnd()).toBe(false);
      appendFileSync(path, `${line.slice(20)}\n`);
      expect(reader.read().map((r) => r.item)).toEqual([EXPECTED[3]!]);

      // A reader started part way still shortens paths: it reads the init line first.
      const later = new TranscriptReader(path, first[2]!.offset);
      expect(later.read().map((r) => r.item)).toEqual([EXPECTED[3]!]);
    } finally {
      t.cleanup();
    }
  });
});
