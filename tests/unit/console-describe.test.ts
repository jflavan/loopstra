import { describe, expect, test } from "bun:test";
import { activityItem, describeEvent, eventsPage, phaseNamer, technicalText } from "../../src/console/describe";
import { Trace, type EventRow } from "../../src/trace";
import { tempDir } from "../helpers";

const row = (type: string, payload: unknown, over: Partial<EventRow> = {}): EventRow => ({
  id: 1, slug: "csv-export", phase_seq: null, type: type as EventRow["type"], ts: "2026-10-17T12:00:00.000Z", payload: JSON.stringify(payload), ...over,
});

describe("events in plain words", () => {
  test("each kind an owner cares about reads as a sentence; ticks and raw session events do not", () => {
    expect(describeEvent(row("status_change", { from: "plan-approved", to: "building", note: "" }))).toBe("Building and testing.");
    expect(describeEvent(row("phase_start", { name: "build", kind: "agent" }))).toBe("Started build.");
    expect(describeEvent(row("phase_end", { status: "success", cost_usd: 0.42, error: null }, { phase_seq: 3 }), () => "build")).toBe("Build passed ($0.42).");
    expect(describeEvent(row("phase_end", { status: "fail", cost_usd: 0, error: "agent-fail: tests failed\nmore" }, { phase_seq: 3 }), () => "fix-1"))
      .toBe("Fix-1 failed: agent-fail: tests failed.");
    expect(describeEvent(row("phase_end", { status: "interrupted", cost_usd: 0 }))).toBe("A step was interrupted.");
    expect(describeEvent(row("gate_check", { gate: "spec", check: "headings", result: "pass", evidence: "" }))).toBe("Spec gate, headings: passed.");
    expect(describeEvent(row("command", { command: "bun test", code: 0 }))).toBe("Ran bun test.");
    expect(describeEvent(row("command", { command: "bun test", code: 1, lastLine: "x" }))).toBe("Ran bun test: exit code 1.");
    expect(describeEvent(row("command", { command: "bun test", note: "stopped" }))).toBe("Stopped bun test.");
    expect(describeEvent(row("signal", { name: "main_health", result: "fail", output: "" }, { slug: "_signals" }))).toBe("The tests on main fail.");
    expect(describeEvent(row("error", { where: "scan", problem: "The status line is wrong" }))).toBe("Problem (scan): The status line is wrong");
    expect(describeEvent(row("pause", { reason: "The assistant is unavailable." }))).toBe("Paused: The assistant is unavailable.");
    expect(describeEvent(row("chat-request", { kind: "accept", by: "ana", result: "accepted" }))).toBe("ana accepted it from chat.");
    expect(describeEvent(row("tick", {}))).toBeNull();
    expect(describeEvent(row("claude_event", { type: "assistant" }))).toBeNull();
  });

  test("the technical line is the type and the payload's fields on one line", () => {
    expect(technicalText(row("command", { command: "bun test\n--bail", code: 0 }))).toBe("command command=bun test --bail code=0");
    expect(technicalText(row("tick", {}))).toBe("tick");
    expect(activityItem(row("tick", {}))).toEqual({ id: 1, slug: "csv-export", seq: null, ts: "2026-10-17T12:00:00.000Z", type: "tick", text: null, technical: "tick" });
  });

  test("phases are named from the trace, and pages of activity go back in time", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const seq = trace.phaseStart("one", "build", "agent");
      trace.event("_loop", "tick", {});
      trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
      const name = phaseNamer(trace);
      expect(name("one", seq)).toBe("build");
      expect(name("one", 99)).toBeUndefined();

      const plain = eventsPage(trace, 0, undefined, false);
      expect(plain.items.map((a) => a.text)).toEqual(["Build passed ($0.10).", "Started build."]);
      expect(plain.next).toBeNull();
      expect(eventsPage(trace, 0, undefined, true).items.map((a) => a.type)).toEqual(["phase_end", "tick", "phase_start"]);
      expect(eventsPage(trace, 0, "_loop", true).items.map((a) => a.type)).toEqual(["tick"]);
      const newest = eventsPage(trace, 0, undefined, true).items[0]!.id;
      expect(eventsPage(trace, newest, undefined, true).items.map((a) => a.type)).toEqual(["tick", "phase_start"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
