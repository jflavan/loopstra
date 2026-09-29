import { describe, expect, test } from "bun:test";
import { tailLines, type TailCursor } from "../../src/commands/tail";
import { writeHeartbeat } from "../../src/heartbeat";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("tail", () => {
  test("prints new events once, filters by change, and prints heartbeat changes only", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      trace.statusChange("one", "accepted", "designing");
      trace.event("two", "error", { where: "step", error: "boom", stack: "at x\nat y" });
      const all: TailCursor = { lastId: 0, loopKey: null };
      const first = tailLines(t.path, trace, all, { pollSeconds: 60 });
      expect(first[0]).toContain("Stopped");
      expect(first.slice(1).map((l) => l.split(/\s+/).slice(1, 3).join(" "))).toEqual(["one status_change", "two error"]);
      expect(first[2]).toContain("error=boom");
      expect(first[2]).not.toContain("stack");
      expect(tailLines(t.path, trace, all, { pollSeconds: 60 })).toEqual([]);

      const now = new Date();
      writeHeartbeat(t.path, { pid: 1, startedAt: now.toISOString(), lastTickAt: now.toISOString(), lastBeatAt: now.toISOString(), current: { slug: "one", phase: null }, stopping: false, stopped: false });
      trace.event("one", "tick", {});
      const next = tailLines(t.path, trace, all, { pollSeconds: 60, now });
      expect(next).toHaveLength(2);
      expect(next[0]).toContain("Running — working on one");
      // The "last check" time changes every second; that alone is not a change.
      expect(tailLines(t.path, trace, all, { pollSeconds: 60, now: new Date(now.getTime() + 5000) })).toEqual([]);

      const only: TailCursor = { lastId: 0, loopKey: null };
      const lines = tailLines(t.path, trace, only, { slug: "two", pollSeconds: 60, now });
      expect(lines.slice(1).every((l) => l.includes(" two "))).toBe(true);
      expect(lines).toHaveLength(2);
    } finally {
      trace.close();
      t.cleanup();
    }
  });
});
