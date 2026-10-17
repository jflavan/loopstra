import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamSession } from "../../src/console/session";
import { TranscriptReader } from "../../src/console/transcript";
import type { SessionMessage, TranscriptItem } from "../../src/console/types";
import { Trace } from "../../src/trace";
import { parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

const lines = (events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

/** A phase's raw.jsonl path, with its folder made. */
function raw(root: string, slug: string, seq: number, name: string): string {
  const dir = join(root, ".loopstra", "runs", slug, "phases", `${seq}-${name}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "raw.jsonl");
}
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

  test("a last line written without a newline still comes before the end; a cut-off one is passed over", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    const stops: Array<() => void> = [];
    try {
      const whole = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", whole, "build"), `${lines([...START, REST[0]])}${JSON.stringify(REST[1])}`);
      trace.phaseEnd("one", whole, { status: "success", costUsd: 0.1 });
      const p = page();
      stops.push(streamSession(t.path, "one", whole, 0, p.send, p.close, 20)!);
      await until(() => p.closed, 3_000);
      expect(kinds(p.frames)).toEqual(["text", "tool", "tool-result", "result"]);
      expect(messages(p.frames).at(-1)!.msg).toEqual({ type: "end" });

      const cut = trace.phaseStart("one", "fix-1", "agent");
      writeFileSync(raw(t.path, "one", cut, "fix-1"), `${lines(START)}{"type":"assist`);
      trace.phaseEnd("one", cut, { status: "fail" });
      const q = page();
      stops.push(streamSession(t.path, "one", cut, 0, q.send, q.close, 20)!);
      await until(() => q.closed, 3_000);
      expect(kinds(q.frames)).toEqual(["text", "tool"]);
      expect(messages(q.frames).at(-1)!.msg).toEqual({ type: "end" });
    } finally {
      for (const stop of stops) stop();
      trace.close();
      t.cleanup();
    }
  });

  test("a transcript that cannot be read, or a page that cannot be written to, ends the stream without throwing", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    const read = TranscriptReader.prototype.read;
    const stops: Array<() => void> = [];
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", seq, "build"), lines(START));

      TranscriptReader.prototype.read = () => { throw new Error("unreadable"); };
      const first = page();
      stops.push(streamSession(t.path, "one", seq, 0, first.send, first.close, 20)!);
      expect(first.closed).toBe(true);

      let reads = 0;
      TranscriptReader.prototype.read = function (this: TranscriptReader, ...args: Parameters<TranscriptReader["read"]>) {
        if (++reads > 2) throw new Error("unreadable");
        return read.apply(this, args);
      };
      const later = page();
      stops.push(streamSession(t.path, "one", seq, 0, later.send, later.close, 20)!);
      await until(() => later.closed, 3_000);
      TranscriptReader.prototype.read = read;
      const sent = later.frames.length;
      await Bun.sleep(100);
      expect(later.frames).toHaveLength(sent);

      const gone = page();
      stops.push(streamSession(t.path, "one", seq, 0, (f) => { if (f.includes('"item"')) throw new Error("the page is gone"); return gone.send(f); }, gone.close, 20)!);
      expect(gone.closed).toBe(true);
    } finally {
      TranscriptReader.prototype.read = read;
      for (const stop of stops) stop();
      trace.close();
      t.cleanup();
    }
  });

  test("a phase with no folder yet sends nothing but itself, and still ends", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    const stops: Array<() => void> = [];
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      const p = page();
      stops.push(streamSession(t.path, "one", seq, 0, p.send, p.close, 20)!);
      await Bun.sleep(100);
      expect(messages(p.frames).map((m) => m.msg.type)).toEqual(["phase"]);
      trace.phaseEnd("one", seq, { status: "fail" });
      await until(() => p.closed, 3_000);
      expect(messages(p.frames).map((m) => m.msg.type)).toEqual(["phase", "phase", "end"]);
    } finally {
      for (const stop of stops) stop();
      trace.close();
      t.cleanup();
    }
  });

  test("a chat turn streams like any phase", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    const stops: Array<() => void> = [];
    try {
      const seq = trace.phaseStart("_chat", "orchestrator", "agent");
      writeFileSync(raw(t.path, "_chat", seq, "orchestrator"), lines([...START, ...REST]));
      trace.phaseEnd("_chat", seq, { status: "success", costUsd: 0.1 });
      const p = page();
      stops.push(streamSession(t.path, "_chat", seq, 0, p.send, p.close, 20)!);
      await until(() => p.closed, 3_000);
      expect(messages(p.frames)[0]!.msg).toMatchObject({ type: "phase", name: "orchestrator" });
      expect(kinds(p.frames)).toEqual(["text", "tool", "tool-result", "result"]);
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
