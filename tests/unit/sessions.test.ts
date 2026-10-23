import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { runChatAgent } from "../../src/chat/agents";
import type { SessionControl } from "../../src/claude";
import { configPath, loadConfig } from "../../src/config";
import { tracedSession } from "../../src/sessions";
import { Cancelled, requestStop, resetStop, SessionStopped, StopRequested } from "../../src/stop";
import { andList } from "../../src/text";
import { Trace } from "../../src/trace";
import { until } from "../console-helpers";
import { FAKE_CLAUDE, tempDir, tempGitRepo, withEnv } from "../helpers";

const FIXTURES = join(import.meta.dir, "..", "fake-claude", "fixtures");

describe("one session runner for the loop and chat", () => {
  test("chat's sessions record the commands they were refused, even when their report cannot be read", async () => {
    const repo = await tempGitRepo();
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
    const cfg = await loadConfig(repo.path);
    const trace = Trace.open(repo.path);
    try {
      await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, LOOPSTRA_FAKE_FIXTURE: join(FIXTURES, "denied.jsonl") }, async () => {
        const r = await runChatAgent({ root: repo.path, cfg, trace, name: "orchestrator", prompt: "hello", schema: z.object({ reply: z.string() }), capUsd: 1 });
        expect(r).toMatchObject({ ok: false, reason: "invalid-envelope" });
        const row = trace.phases("_chat")[0]!;
        expect(row.status).toBe("fail");
        expect(row.error).toContain("not allowed: Bash(git tag v1)");
        expect(trace.deniedCommands("_chat").get(row.seq)).toEqual(["Bash(git tag v1)", "Write(/repo/notes.txt)"]);
      });
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("a traced session with a ref", () => {
  const session = (trace: Trace, dir: string, prompt: string) => {
    const seq = trace.phaseStart("add-numbers", "design", "agent");
    return tracedSession({
      trace, slug: "add-numbers", seq, dir: join(dir, "phase"), capUsd: 1, ref: "default",
      read: (output) => ({ ok: true, value: output }),
      run: { cwd: dir, prompt, schema: {}, model: "sonnet", permissionMode: "default", allowedTools: [], timeoutMs: 60_000, maxBudgetUsd: 1, executable: FAKE_CLAUDE },
    });
  };

  test("records its run", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE: join(FIXTURES, "design.jsonl") }, () => session(trace, t.path, "hello"));
      expect(trace.lastModelRuns().default).toMatchObject({ ref: "default", asked: "sonnet", ran: "fake", result: "ok" });
    } finally { trace.close(); t.cleanup(); }
  });

  test("a crash writes none", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const out = await withEnv({ LOOPSTRA_FAKE_FIXTURE: join(FIXTURES, "crash.jsonl") }, () => session(trace, t.path, "hello"));
      expect(out.ok).toBe(false);
      expect(trace.lastModelRuns()).toEqual({});
    } finally { trace.close(); t.cleanup(); }
  });
});

describe("andList", () => {
  test("joins items as a plain list", () => {
    expect(andList([])).toBe("");
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("a session a person stopped", () => {
  test("ends its row interrupted, saying who stopped it, with what it must have spent, and is thrown on", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const seq = trace.phaseStart("add-numbers", "design", "agent");
      let ctl: SessionControl | null = null;
      let running = false;
      const run = tracedSession({
        trace, slug: "add-numbers", seq, dir: join(t.path, "phase"), capUsd: 1, stoppedNote: "stopped by request",
        read: (output) => ({ ok: true, value: output }),
        onEvent: (e) => { if (e.type === "system") running = true; },
        run: {
          cwd: t.path, prompt: "FIXTURE:hang", schema: {}, model: "haiku", permissionMode: "default", allowedTools: [], timeoutMs: 60_000,
          maxBudgetUsd: 1, executable: FAKE_CLAUDE, live: { attach: (c) => { ctl = c; return () => {}; } },
        },
      });
      await until(() => running);
      ctl!.stop("John");
      const e = await run.then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(SessionStopped);
      const row = trace.phases("add-numbers")[0]!;
      expect(row.status).toBe("interrupted");
      expect(row.error).toBe("stopped by John");
      expect(row.ended).not.toBeNull();
      // Killed, it never said what it spent: it counts at about its minutes.
      expect(row.cost_usd).toBeGreaterThan(0);
    } finally { trace.close(); t.cleanup(); }
  }, 90_000);
});

describe("a session ended mid-way", () => {
  // Each way a running session is ended from outside: a person's Stop, the loop's stop request, and
  // a cancel of work no longer wanted. The fake printed its first events, with its session id, first.
  const endings: Array<{ name: string; end: (ctl: SessionControl, abort: AbortController) => void; thrown: new (...a: never[]) => Error }> = [
    { name: "a person's stop", end: (ctl) => { ctl.stop("John"); }, thrown: SessionStopped },
    { name: "a stop request", end: () => { requestStop(); }, thrown: StopRequested },
    { name: "a cancel", end: (_ctl, abort) => { abort.abort(); }, thrown: Cancelled },
  ];
  for (const ending of endings) {
    test(`${ending.name} keeps the session's id on its interrupted row, so its transcript can be found`, async () => {
      const t = tempDir();
      const trace = Trace.open(t.path);
      try {
        const seq = trace.phaseStart("add-numbers", "build", "agent");
        let ctl: SessionControl | null = null;
        let running = false;
        let sessionId: string | undefined;
        const abort = new AbortController();
        const run = tracedSession({
          trace, slug: "add-numbers", seq, dir: join(t.path, "phase"), capUsd: 1,
          read: (output) => ({ ok: true, value: output }),
          onEvent: (e) => { sessionId ??= e.session_id; if (e.type === "system") running = true; },
          run: {
            cwd: t.path, prompt: "FIXTURE:hang", schema: {}, model: "haiku", permissionMode: "default", allowedTools: [], timeoutMs: 60_000,
            maxBudgetUsd: 1, executable: FAKE_CLAUDE, signal: abort.signal, live: { attach: (c) => { ctl = c; return () => {}; } },
          },
        });
        await until(() => running);
        ending.end(ctl!, abort);
        const e = await run.then(() => null, (err: unknown) => err);
        expect(e).toBeInstanceOf(ending.thrown);
        expect(sessionId).toBeString();
        expect((e as { sessionId?: unknown }).sessionId).toBe(sessionId!);
        expect(trace.phases("add-numbers")[0]).toMatchObject({ status: "interrupted", session_id: sessionId! });
      } finally { resetStop(); trace.close(); t.cleanup(); }
    }, 90_000);
  }
});

describe("a session that asked a question", () => {
  test("ends its row asked once, with no error, and the question is an event of its own under that phase", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const seq = trace.phaseStart("add-numbers", "design", "agent");
      const out = await tracedSession({
        trace, slug: "add-numbers", seq, dir: join(t.path, "phase"), capUsd: 1,
        read: (output) => ({ ok: true, value: output, endAs: "asked", note: "Round half up or to even?" }),
        run: { cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "default", allowedTools: [], timeoutMs: 60_000, maxBudgetUsd: 1, executable: FAKE_CLAUDE },
      });
      expect(out.ok).toBe(true);
      const row = trace.phases("add-numbers")[0]!;
      expect(row).toMatchObject({ status: "asked", error: null, session_id: "fake-session-1" });
      expect(row.cost_usd).toBeCloseTo(0.01);
      const events = trace.events("add-numbers");
      expect(events.filter((e) => e.type === "phase_end")).toHaveLength(1);
      expect(JSON.parse(events.find((e) => e.type === "phase_end")!.payload)).toMatchObject({ status: "asked", error: null });
      const question = events.find((e) => e.type === "question")!;
      expect(question.phase_seq).toBe(seq);
      expect(JSON.parse(question.payload)).toEqual({ question: "Round half up or to even?" });
    } finally { trace.close(); t.cleanup(); }
  }, 90_000);
});
