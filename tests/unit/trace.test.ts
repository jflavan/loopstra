import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

describe("Trace", () => {
  test("writes events to jsonl and sqlite, and reports intent summaries", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    trace.upsertIntent("a-b", "building", "high");
    const seq = trace.phaseStart("a-b", "build", "agent");
    trace.event("a-b", "claude_event", { type: "assistant" }, seq);
    trace.phaseEnd("a-b", seq, { status: "success", costUsd: 0.12, sessionId: "sid-1" });
    trace.gate("a-b", "merge", "tests", "pass", "exit 0");
    trace.signal("main_health", "pass", "all green");

    const rows = trace.events("a-b");
    expect(rows.map((r) => r.type)).toEqual(["phase_start", "claude_event", "phase_end", "gate_check"]);
    const jsonl = readFileSync(join(t.path, ".loopstra", "runs", "a-b", "events.jsonl"), "utf8").trim().split("\n");
    expect(jsonl.length).toBe(4);
    expect(JSON.parse(jsonl[0]!).type).toBe("phase_start");

    const summary = trace.intentSummary("a-b");
    expect(summary?.status).toBe("building");
    expect(summary?.costUsd).toBeCloseTo(0.12);
    expect(summary?.lastPhase).toBe("build");
    expect(summary?.lastPhaseStatus).toBe("success");
    expect(existsSync(join(t.path, ".loopstra", "trace.db"))).toBe(true);
    trace.close();
    t.cleanup();
  });

  test("lastGate returns the newest row for one gate check only", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    expect(trace.lastGate("x", "review", "findings")).toBeNull();
    trace.gate("x", "review", "findings", "fail", "round 1");
    trace.gate("x", "review", "findings", "pass", "round 2");
    trace.gate("x", "merge", "findings", "fail", "other gate");
    trace.gate("y", "review", "findings", "fail", "other intent");
    expect(trace.lastGate("x", "review", "findings")).toMatchObject({ result: "pass", evidence: "round 2" });
    trace.close();
    t.cleanup();
  });

  test("phase sequence increments per intent and survives reopen", () => {
    const t = tempDir();
    let trace = Trace.open(t.path);
    expect(trace.phaseStart("x", "design", "agent")).toBe(1);
    expect(trace.phaseStart("x", "spec-check", "agent")).toBe(2);
    trace.close();
    trace = Trace.open(t.path);
    expect(trace.phaseStart("x", "plan", "agent")).toBe(3);
    trace.close();
    t.cleanup();
  });

  test("a damaged trace.db is moved aside and a fresh one started, with a plain line and a recorded event", () => {
    const t = tempDir();
    mkdirSync(join(t.path, ".loopstra"), { recursive: true });
    writeFileSync(join(t.path, ".loopstra", "trace.db"), "this is not a database, just some bytes that got written here by mistake".repeat(20));
    const said: string[] = [];
    const trace = Trace.open(t.path, (l) => said.push(l));
    trace.event("x", "tick", {});
    expect(trace.events("x")).toHaveLength(1);
    const moved = readdirSync(join(t.path, ".loopstra")).filter((f) => f.startsWith("trace.db.corrupt-"));
    expect(moved).toHaveLength(1);
    expect(said).toEqual([`The trace database could not be read, so it was moved to .loopstra/${moved[0]} and a new one was started.`]);
    expect(trace.events("_loop").some((e) => e.type === "error" && e.payload.includes("moved aside"))).toBe(true);
    trace.close();
    // The fresh database opens normally next time.
    const again = Trace.open(t.path, (l) => said.push(l));
    again.close();
    expect(said).toHaveLength(1);
    t.cleanup();
  });
});
