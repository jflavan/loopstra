import { describe, expect, test } from "bun:test";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("trace queries for the console", () => {
  test("the newest event id, pages of older events, events after an id, and one phase's events", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      expect(trace.lastEventId()).toBe(0);
      const a = trace.phaseStart("one", "build", "agent"); // event 1
      trace.event("one", "claude_event", { type: "system", subtype: "init", model: "m" }, a); // 2
      trace.event("one", "claude_event", { type: "assistant", items: ["tool:Bash"] }, a); // 3
      trace.event("two", "tick", {}); // 4
      trace.phaseEnd("one", a, { status: "success", costUsd: 0.5 }); // 5
      expect(trace.lastEventId()).toBe(5);
      expect(trace.eventsBefore(0, 2).map((e) => e.id)).toEqual([5, 4]);
      expect(trace.eventsBefore(4, 10).map((e) => e.id)).toEqual([3, 2, 1]);
      expect(trace.eventsBefore(0, 10, "two").map((e) => e.id)).toEqual([4]);
      expect(trace.eventsAfter(2, 2).map((e) => e.id)).toEqual([3, 4]);
      expect(trace.phaseEvents("one", a, 2).map((e) => e.id)).toEqual([3, 5]);
      expect(trace.firstEvent("one", a, "claude_event")?.id).toBe(2);
      expect(trace.phase("one", a)).toMatchObject({ name: "build", status: "success", cost_usd: 0.5 });
      expect(trace.phase("one", 99)).toBeNull();
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("every phase in the order they started, and the newest ended ones first", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const a = trace.phaseStart("one", "build", "agent");
      trace.phaseEnd("one", a, { status: "success" });
      trace.phaseStart("two", "design", "agent");
      const c = trace.phaseStart("_chat", "orchestrator", "agent");
      trace.phaseEnd("_chat", c, { status: "success" });
      expect(trace.allPhases().map((p) => p.slug)).toEqual(["one", "two", "_chat"]);
      expect(trace.recentPhases(5).map((p) => p.slug)).toEqual(["_chat", "one"]);
      expect(trace.recentPhases(1).map((p) => p.slug)).toEqual(["_chat"]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
