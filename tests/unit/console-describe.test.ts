import { describe, expect, test } from "bun:test";
import { activityItem, describeEvent, eventsPage, phaseNamer, technicalText } from "../../src/console/describe";
import { Cancelled } from "../../src/stop";
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
    expect(describeEvent(row("command", { command: "bun test", note: new Cancelled().message }))).toBe("Stopped bun test.");
    expect(describeEvent(row("signal", { name: "main_health", result: "fail", output: "" }, { slug: "_signals" }))).toBe("The tests on main fail.");
    expect(describeEvent(row("error", { where: "scan", problem: "The status line is wrong" }))).toBe("Problem (scan): The status line is wrong.");
    expect(describeEvent(row("pause", { reason: "The assistant is unavailable." }))).toBe("Paused: The assistant is unavailable.");
    expect(describeEvent(row("chat-request", { kind: "accept", by: "ana", result: "accepted" }))).toBe("ana accepted it from chat.");
    expect(describeEvent(row("tick", {}))).toBeNull();
    expect(describeEvent(row("claude_event", { type: "assistant" }))).toBeNull();
  });

  test("every shape of command, error and pause the loop traces reads as a sentence", () => {
    const cancelled = new Cancelled().message;
    // A project command that ran, and one cancelled because its result was no longer needed.
    expect(describeEvent(row("command", { command: "bun test", code: 0, lastLine: "ok", durationMs: 900, where: "verify" }))).toBe("Ran bun test.");
    expect(describeEvent(row("command", { command: "bun test", note: cancelled }))).toBe("Stopped bun test.");
    expect(describeEvent(row("command", { command: "bun test", note: cancelled, where: "verify" }))).toBe("Stopped bun test.");
    // Informational ones: a note says what happened; a waiting one says it waits; others are named.
    expect(describeEvent(row("command", { command: "plan ahead", note: "kept for the plan step" }))).toBe("Plan ahead: kept for the plan step.");
    expect(describeEvent(row("command", { command: "early review", note: `not used: ${cancelled}`, extra: 1 }))).toBe(`Early review: not used: ${cancelled}.`);
    expect(describeEvent(row("command", { command: "share main", pushed: 0, note: "the remote has newer commits; the next sync brings them in first", error: "x" })))
      .toBe("Share main: the remote has newer commits; the next sync brings them in first.");
    expect(describeEvent(row("command", { command: "drift", changed: ["a"], note: "first\nsecond" }))).toBe("Drift: first.");
    expect(describeEvent(row("command", { command: "merge lock", waiting: "waits for two to finish merging first" }))).toBe("Merge lock: waits for two to finish merging first.");
    expect(describeEvent(row("command", { command: "up to date", waiting: "main on GitHub has changes\nthat main here could not take yet" }))).toBe("Up to date: main on GitHub has changes.");
    expect(describeEvent(row("command", { command: "clean up closed change", kept: "/wt", reason: "the worktree has uncommitted work" }))).toBe("Clean up closed change: the worktree has uncommitted work.");
    // A note comes first; a command with nothing to say about it is only named; with no command at all it is a command.
    expect(describeEvent(row("command", { command: "drift", note: "the plan has no Files section", reason: "r", waiting: "w" }))).toBe("Drift: the plan has no Files section.");
    expect(describeEvent(row("command", { note: "kept for later" }))).toBe("Kept for later.");
    expect(describeEvent(row("command", {}))).toBe("Ran a command.");
    expect(describeEvent(row("command", { code: 2 }))).toBe("Ran a command: exit code 2.");
    expect(describeEvent(row("command", { command: "sync main", pulled: 2 }))).toBe("Sync main.");
    expect(describeEvent(row("command", { command: "clean up closed change", removed: "/wt", branchKept: "b" }))).toBe("Clean up closed change.");
    // Errors name what went wrong, from whichever field the call site used.
    expect(describeEvent(row("error", { where: "block", note: "The tests failed.", detail: "x" }))).toBe("Problem (block): The tests failed.");
    expect(describeEvent(row("error", { where: "probe", phase: "build", detail: "the build phase failed 3 times" }))).toBe("Problem (probe): the build phase failed 3 times.");
    expect(describeEvent(row("error", { where: "tick", expected: "main", actual: "feature" }))).toBe("Problem (tick): expected main, found feature.");
    expect(describeEvent(row("error", { where: "tick", error: "boom\n  at x", stack: "..." }))).toBe("Problem (tick): boom.");
    expect(describeEvent(row("error", { where: "sync", result: "fail" }))).toBe("Problem (sync).");
    expect(describeEvent(row("error", {}))).toBe("Problem.");
    // A problem with both what failed and why says both: the first line of the error after what failed.
    expect(describeEvent(row("error", { where: "cleanup", what: "worktree", error: "fatal: 'wt' is locked\nuse 'git worktree unlock'" })))
      .toBe("Problem (cleanup): worktree: fatal: 'wt' is locked.");
    expect(describeEvent(row("error", { where: "cleanup", what: "branch", error: "" }))).toBe("Problem (cleanup): branch.");
    // Likewise when the call site called it a problem or a note.
    expect(describeEvent(row("error", { where: "lane", problem: "the change could not be read", error: "ENOENT: no such file\n  at x" })))
      .toBe("Problem (lane): the change could not be read: ENOENT: no such file.");
    expect(describeEvent(row("error", { where: "move main", note: "putting back a move of main failed; it is tried again on the next tick", error: "fatal: locked" })))
      .toBe("Problem (move main): putting back a move of main failed; it is tried again on the next tick: fatal: locked.");
    expect(describeEvent(row("error", { where: "lane", problem: "", error: "boom" }))).toBe("Problem (lane): boom.");
    expect(describeEvent(row("error", { where: "cleanup", what: "worktree", error: "a".repeat(200) }))).toBe(`Problem (cleanup): worktree: ${"a".repeat(149)}…`);
    // Pauses: a reason, or a note when the loop is still backing off.
    expect(describeEvent(row("pause", { note: "the probe could not reach the assistant either; still backing off" })))
      .toBe("Paused: the probe could not reach the assistant either; still backing off.");
    expect(describeEvent(row("pause", { reason: "Waiting for midnight" }))).toBe("Paused: Waiting for midnight.");
    expect(describeEvent(row("pause", {}))).toBe("Paused.");
    // A line cut short ends with its ellipsis, not a full stop after it; padding is trimmed.
    expect(describeEvent(row("error", { where: "x", error: `  ${"a".repeat(200)}` }))).toBe(`Problem (x): ${"a".repeat(159)}…`);
    expect(describeEvent(row("status_change", { from: "draft" }))).toBeNull();
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
