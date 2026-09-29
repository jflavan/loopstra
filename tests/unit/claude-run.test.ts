import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runPhase, FAKE_CLAUDE_ENV } from "../../src/claude";
import { FAKE_CLAUDE as FAKE, tempDir } from "../helpers";


describe("runPhase", () => {
  test("spawns claude with the expected flags, pipes the prompt, and returns structured output", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    const r = await runPhase({
      cwd: t.path,
      prompt: "Do the thing. FIXTURE:simple-success",
      schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      model: "haiku",
      permissionMode: "default",
      allowedTools: ["Read", "Grep"],
      timeoutMs: 10_000,
      maxBudgetUsd: 1,
      env: { LOOPSTRA_FAKE_ARGS: argsFile, LOOPSTRA_PHASE: "fix" },
      executable: FAKE,
    });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("fake-session-1");
    expect(r.structuredOutput).toMatchObject({ status: "success", priority: "normal" });
    expect(r.costUsd).toBeCloseTo(0.01);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.prompt).toContain("Do the thing.");
    expect(recorded.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--json-schema", "--model", "haiku", "--permission-mode", "default", "--allowedTools", "Read,Grep", "--max-budget-usd", "1"]));
    expect(recorded.args).not.toContain("--resume");
    expect(recorded.env.LOOPSTRA_PHASE).toBe("fix");
    t.cleanup();
  });

  test("passes --resume when a session id is given", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "acceptEdits",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, resume: "old-session", env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.args).toEqual(expect.arrayContaining(["--resume", "old-session"]));
    t.cleanup();
  });

  test("kills a hung process at the timeout and reports failure", async () => {
    const t = tempDir();
    const started = Date.now();
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:hang", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 1_500, maxBudgetUsd: 1, executable: FAKE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
    expect(r.detail).toMatch(/timed out/);
    expect(r.sessionId).toBe("hang-session");
    expect(Date.now() - started).toBeLessThan(10_000);
    t.cleanup();
  });

  test("reports a missing executable plainly", async () => {
    const t = tempDir();
    const r = await runPhase({ cwd: t.path, prompt: "x", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 1_000, maxBudgetUsd: 1, executable: join(t.path, "nope.exe") });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-started");
    expect(r.detail).toMatch(/could not start/i);
    t.cleanup();
  });

  test("returns promptly after the result even if the process and a grandchild keep running", async () => {
    const t = tempDir();
    const started = Date.now();
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:linger", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 60_000, maxBudgetUsd: 1, executable: FAKE });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe("fake-linger");
    expect(r.structuredOutput).toMatchObject({ status: "success" });
    expect(Date.now() - started).toBeLessThan(15_000);
    t.cleanup();
  }, 30_000);

  test("classifies budget, crash, and missing-session failures", async () => {
    const t = tempDir();
    const base = { cwd: t.path, schema: {}, model: "haiku", permissionMode: "default" as const, allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, executable: FAKE };
    const budget = await runPhase({ ...base, prompt: "FIXTURE:budget" });
    expect(budget.ok).toBe(false);
    expect(budget.reason).toBe("budget");
    const crash = await runPhase({ ...base, prompt: "FIXTURE:crash" });
    expect(crash.reason).toBe("crash");
    const gone = await runPhase({ ...base, prompt: "FIXTURE:simple-success", resume: "missing-session" });
    expect(gone.reason).toBe("no-session");
    expect(gone.detail).toMatch(/No conversation found/);
    t.cleanup();
  });

  test("a missing session is no-session even though the CLI also sends an error result", async () => {
    const t = tempDir();
    const gone = await runPhase({ cwd: t.path, schema: {}, model: "haiku", permissionMode: "default", allowedTools: [], timeoutMs: 10_000,
      maxBudgetUsd: 1, executable: FAKE, prompt: "FIXTURE:simple-success", resume: "missing-session" });
    // The real shape (Claude Code 2.1.x): a result event error_during_execution, the reason on stderr, exit 1.
    expect(gone.subtype).toBe("error_during_execution");
    expect(gone.exitCode).toBe(1);
    expect(gone.ok).toBe(false);
    expect(gone.reason).toBe("no-session");
    t.cleanup();
  });

  test("collects the commands the session was not allowed to run", async () => {
    const t = tempDir();
    const r = await runPhase({ cwd: t.path, schema: {}, model: "haiku", permissionMode: "default", allowedTools: [], timeoutMs: 10_000,
      maxBudgetUsd: 1, executable: FAKE, prompt: "FIXTURE:denied" });
    expect(r.ok).toBe(true);
    expect(r.denied).toEqual(["Bash(git tag v1)", "Write(/repo/notes.txt)"]);
    const plain = await runPhase({ cwd: t.path, schema: {}, model: "haiku", permissionMode: "default", allowedTools: [], timeoutMs: 10_000,
      maxBudgetUsd: 1, executable: FAKE, prompt: "FIXTURE:simple-success" });
    expect(plain.denied).toEqual([]);
    t.cleanup();
  });

  test("passes --disallowedTools when given", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: ["Read"], disallowedTools: ["Edit", "Write", "NotebookEdit"], timeoutMs: 10_000, maxBudgetUsd: 1,
      env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.args).toEqual(expect.arrayContaining(["--disallowedTools", "Edit,Write,NotebookEdit"]));
    t.cleanup();
  });

  test("FAKE_CLAUDE_ENV names the override variable", () => {
    expect(FAKE_CLAUDE_ENV).toBe("LOOPSTRA_CLAUDE_EXECUTABLE");
  });
});
