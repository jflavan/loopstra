import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamSession } from "../../src/console/session";
import type { SessionMessage, TranscriptItem } from "../../src/console/types";
import { Trace } from "../../src/trace";
import { parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

const lines = (events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const START = [
  { type: "system", subtype: "init", cwd: "/wt", model: "m" },
  { type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] } },
];
const REST = [
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 pass" }] } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, structured_output: { summary: "Done." } },
];

/** A page for one session stream. */
function page() {
  const frames: string[] = [];
  const p = { frames, closed: false, send: (f: string) => { frames.push(f); return true; }, close: () => { p.closed = true; } };
  return p;
}
const messages = (frames: string[]) => parseFrames(frames.join("")).map((f) => ({ id: f.id, msg: f.data as SessionMessage }));
const kinds = (frames: string[]) => messages(frames).flatMap((m) => (m.msg.type === "item" ? [(m.msg.item as TranscriptItem).kind] : []));

describe("a session's stream", () => {
  test("sends the transcript as it is written, says when the phase has ended, and can start from an offset", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    const stops: Array<() => void> = [];
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      const dir = join(t.path, ".loopstra", "runs", "one", "phases", `${seq}-build`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "raw.jsonl"), lines(START));
      const p = page();
      stops.push(streamSession(t.path, "one", seq, 0, p.send, p.close, 20)!);
      await until(() => kinds(p.frames).length === 2);
      expect(messages(p.frames)[0]!.msg).toMatchObject({ type: "phase", name: "build", status: "running", ended: null });

      appendFileSync(join(dir, "raw.jsonl"), lines(REST));
      trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
      await until(() => p.closed);
      expect(kinds(p.frames)).toEqual(["text", "tool", "tool-result", "result"]);
      expect(messages(p.frames).slice(-2).map((m) => m.msg)).toEqual([
        { type: "phase", name: "build", status: "success", started: expect.any(String), ended: expect.any(String) },
        { type: "end" },
      ]);
      const ids = messages(p.frames).filter((m) => m.msg.type === "item").map((m) => Number(m.id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));

      // From the offset after the tool's result: only what came after it.
      const later = page();
      stops.push(streamSession(t.path, "one", seq, ids[2]!, later.send, later.close, 20)!);
      await until(() => later.closed);
      expect(kinds(later.frames)).toEqual(["result"]);
    } finally {
      for (const stop of stops) stop();
      trace.close();
      t.cleanup();
    }
  });

  test("no stream for a phase that does not exist", () => {
    const t = tempDir();
    try {
      expect(streamSession(t.path, "one", 99, 0, () => true, () => {})).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});
