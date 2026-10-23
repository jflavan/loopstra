import { describe, expect, test } from "bun:test";
import { classify, StreamCollector, unavailable } from "../../src/claude";
import { Cancelled, StopRequested } from "../../src/stop";

/** What a session printed, collected as runPhase collects it. */
function collected(...events: object[]) {
  const c = new StreamCollector();
  for (const e of events) c.push(JSON.stringify(e));
  return c.finish();
}

/** A process that started and exited on its own, unless told otherwise. */
function spawned(over: Partial<{ code: number | null; err: string; started: boolean; timedOut: boolean; stopped: boolean; cancelled: boolean }> = {}) {
  return { code: 0, out: "", err: "", started: true, timedOut: false, stopped: false, cancelled: false, ...over };
}

const ctx = { started: Date.now(), timeoutMs: 60_000, resume: undefined, nudged: false };
const init = { type: "system", subtype: "init", session_id: "s1" };
const assistant = { type: "assistant", session_id: "s1", message: { content: [] } };
const success = (more: object = {}) => ({ type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0.2, structured_output: { status: "success" }, ...more });

describe("classify: the end of a session as a phase result, without a process", () => {
  test("success: the structured output, the session and its cost", () => {
    const r = classify(collected(init, assistant, success()), spawned(), ctx);
    expect(r).toMatchObject({ ok: true, reason: null, detail: "", sessionId: "s1", costUsd: 0.2, structuredOutput: { status: "success" }, exitCode: 0, matched: null });
  });

  test("timeout: past the deadline, whatever was collected", () => {
    const r = classify(collected(init), spawned({ code: null, timedOut: true }), { ...ctx, timeoutMs: 90_000 });
    expect(r).toMatchObject({ ok: false, reason: "timeout", detail: "claude timed out after 90s", sessionId: "s1" });
  });

  test("a nudge that timed out is an unreadable report, not a timeout to rerun", () => {
    const r = classify(collected(init), spawned({ code: null, timedOut: true }), { ...ctx, nudged: true });
    expect(r).toMatchObject({ ok: false, reason: "invalid-envelope", detail: "claude finished without structured output, and asking again failed: claude timed out after 60s" });
  });

  test("no-session: a resumed session the CLI could not find, though it also sent an error result", () => {
    const stderr = "Error: No conversation found with session ID: gone";
    const r = classify(collected({ type: "result", subtype: "error_during_execution", is_error: true }), spawned({ code: 1, err: stderr }), { ...ctx, resume: "gone" });
    expect(r).toMatchObject({ ok: false, reason: "no-session", detail: stderr, stderr });
    // Without --resume, the same text is not a missing session.
    expect(classify(collected({ type: "result", subtype: "error_during_execution", is_error: true }), spawned({ code: 1, err: stderr }), ctx).reason).toBe("crash");
  });

  test("budget: the session hit --max-budget-usd", () => {
    const r = classify(collected(init, { type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "s1", total_cost_usd: 5.01 }), spawned({ code: 1 }), ctx);
    expect(r).toMatchObject({ ok: false, reason: "budget", detail: "claude ended with error_max_budget_usd", costUsd: 5.01 });
  });

  test("environment: an outage in the error result, or in stderr when the session never answered", () => {
    const limit = classify(collected(init, assistant, { type: "result", subtype: "success", is_error: true, session_id: "s1", result: "You've hit your usage limit" }), spawned({ code: 1 }), ctx);
    expect(limit).toMatchObject({ ok: false, reason: "environment", detail: "the assistant is unavailable: You've hit your usage limit", matched: "You've hit your usage limit" });
    const signedOut = classify(collected(init), spawned({ code: 1, err: "Invalid API key · Please run /login" }), ctx);
    expect(signedOut).toMatchObject({ reason: "environment", matched: "Invalid API key · Please run /login" });
    // A session that answered may print such words itself: its stderr is not read.
    expect(classify(collected(init, assistant), spawned({ code: 1, err: "fetch failed" }), ctx).reason).toBe("crash");
    const status = classify(collected(init, { type: "result", subtype: "success", is_error: true, session_id: "s1", api_error_status: 529, result: "something new" }), spawned({ code: 1 }), ctx);
    expect(status).toMatchObject({ reason: "environment", matched: "API error 529" });
  });

  test("a bad model name is reason model", () => {
    const text = "There's an issue with the selected model (opuss). It may not exist or you may not have access to it.";
    const r = classify(collected(init, { type: "result", subtype: "success", is_error: true, session_id: "s1", api_error_status: 404, result: text }), spawned({ code: 1 }), ctx);
    expect(r).toMatchObject({ ok: false, reason: "model" });
    expect(unavailable("model")).toBe(false);
    // A session that never answered says it on stderr.
    expect(classify(collected(init), spawned({ code: 1, err: text }), ctx).reason).toBe("model");
  });

  test("notification-only: the session answered background notifications and never the prompt", () => {
    const notified = { type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0, origin: { kind: "task-notification" } };
    const r = classify(collected(init, notified), spawned({ err: "bye" }), ctx);
    expect(r).toMatchObject({ ok: false, reason: "crash", detail: "claude answered only background task notifications and never the prompt: bye" });
  });

  test("missing result: the process ended without one", () => {
    expect(classify(collected(init), spawned({ code: 3, err: "segfault\n" }), ctx)).toMatchObject({ ok: false, reason: "crash", detail: "claude exited 3 without a result: segfault" });
    expect(classify(collected(init), spawned({ code: null }), ctx).detail).toBe("claude exited without an exit code without a result");
  });

  test("invalid envelope: a structured-output error, or a success with no structured output", () => {
    const retries = classify(collected(init, { type: "result", subtype: "error_max_structured_output_retries", is_error: true, session_id: "s1" }), spawned({ code: 1 }), ctx);
    expect(retries).toMatchObject({ ok: false, reason: "invalid-envelope", detail: "claude ended with error_max_structured_output_retries" });
    const none = classify(collected(init, assistant, success({ structured_output: undefined })), spawned(), ctx);
    expect(none).toMatchObject({ ok: false, reason: "invalid-envelope", detail: "claude finished without structured output" });
  });

  test("not started, stopped and cancelled: the process never ran, or was killed from outside", () => {
    expect(classify(collected(), spawned({ code: 127, started: false, err: "ENOENT" }), ctx)).toMatchObject({ ok: false, reason: "not-started", detail: "could not start claude: ENOENT", exitCode: null, stderr: "" });
    // What is thrown names the session, else the one it resumed, so its row can name the transcript.
    const thrown = (f: () => unknown): unknown => { try { f(); return null; } catch (e) { return e; } };
    const stopped = thrown(() => classify(collected(init), spawned({ stopped: true }), ctx));
    expect(stopped).toBeInstanceOf(StopRequested);
    expect((stopped as StopRequested).sessionId).toBe("s1");
    const cancelled = thrown(() => classify(collected(), spawned({ cancelled: true }), { ...ctx, resume: "old" }));
    expect(cancelled).toBeInstanceOf(Cancelled);
    expect((cancelled as Cancelled).sessionId).toBe("old");
  });
});
