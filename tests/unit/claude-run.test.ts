import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENT_PATTERNS, FAKE_CLAUDE_ENV, runPhase, unavailable, type SessionControl } from "../../src/claude";
import { MEANWHILE_HEADING } from "../../src/console/steerable";
import { MIN_SESSION_USD, USD_PER_MINUTE } from "../../src/budget";
import { SessionStopped } from "../../src/stop";
import { until } from "../console-helpers";
import { FAKE_CLAUDE as FAKE, fixture, fixtureDir, tempDir } from "../helpers";


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

  test("passes no --max-budget-usd when there is no cap", async () => {
    const t = tempDir();
    try {
      for (const maxBudgetUsd of [undefined, Infinity]) {
        const argsFile = join(t.path, `args-${String(maxBudgetUsd)}.json`);
        await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "default",
          allowedTools: [], timeoutMs: 10_000, maxBudgetUsd, env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
        expect((await Bun.file(argsFile).json()).args).not.toContain("--max-budget-usd");
      }
    } finally { t.cleanup(); }
  });

  test("kills a hung process at the timeout and reports failure", async () => {
    const t = tempDir();
    const started = Date.now();
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:hang", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 800, maxBudgetUsd: 1, executable: FAKE });
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
      allowedTools: [], timeoutMs: 60_000, maxBudgetUsd: 1, executable: FAKE, exitGraceMs: 200 });
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

  test("an outage is an environment failure, not the agent's: signed out, usage limit", async () => {
    const t = tempDir();
    const base = { cwd: t.path, schema: {}, model: "haiku", permissionMode: "default" as const, allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, executable: FAKE };
    // No result at all, a sign-in problem on stderr, exit 1.
    const signedOut = await runPhase({ ...base, prompt: "FIXTURE:outage" });
    expect(signedOut.reason).toBe("environment");
    expect(signedOut.detail).toContain("Please run /login");
    // A result event with is_error and a usage-limit text.
    const limited = await runPhase({ ...base, prompt: "FIXTURE:usage-limit" });
    expect(limited.reason).toBe("environment");
    expect(limited.detail).toContain("session limit");
    // An ordinary crash stays the agent's. A missing executable is the environment's too.
    expect((await runPhase({ ...base, prompt: "FIXTURE:crash" })).reason).toBe("crash");
    expect(unavailable("environment") && unavailable("not-started")).toBe(true);
    expect(unavailable("crash") || unavailable("budget") || unavailable("agent-fail") || unavailable("timeout")).toBe(false);
    t.cleanup();
  });

  test("stderr is matched only when the session never answered; the error result's text always is", async () => {
    const t = tempDir();
    const base = { cwd: t.path, schema: {}, model: "haiku", permissionMode: "default" as const, allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, executable: FAKE };
    // The session worked (an assistant event) and then died with a network word on stderr: that is
    // the session's own failure (for example a command it ran), not an outage.
    const worked = await runPhase({ ...base, prompt: "FIXTURE:worked-then-died" });
    expect(worked.reason).toBe("crash");
    expect(worked.matched).toBeNull();
    // No assistant event: stderr counts, and the matched line is kept.
    const out = await runPhase({ ...base, prompt: "FIXTURE:outage" });
    expect(out.reason).toBe("environment");
    expect(out.matched).toBe("Invalid API key · Please run /login");
    // An assistant event, but the error result itself says usage limit: the CLI 2.x wording, and the older one.
    const limited = await runPhase({ ...base, prompt: "FIXTURE:usage-limit" });
    expect(limited.reason).toBe("environment");
    expect(limited.matched).toBe("You've hit your session limit · resets 8:10pm (America/Chicago)");
    const limitedOld = await runPhase({ ...base, prompt: "FIXTURE:usage-limit-old" });
    expect(limitedOld.reason).toBe("environment");
    expect(limitedOld.matched).toBe("Claude AI usage limit reached|1790000000");
    // A limit on one model, with no API status: the words decide.
    const modelLimit = await runPhase({ ...base, prompt: "FIXTURE:model-limit" });
    expect(modelLimit.reason).toBe("environment");
    expect(modelLimit.matched).toBe("You've reached your Fable limit. Switch to another model to continue.");
    // Text that matches nothing, but the result says the API call failed with 529: the status decides.
    const apiError = await runPhase({ ...base, prompt: "FIXTURE:api-error" });
    expect(apiError.reason).toBe("environment");
    expect(apiError.matched).toBe("API error 529");
    t.cleanup();
  });

  test("the environment patterns each say what they catch", () => {
    expect(ENVIRONMENT_PATTERNS.length).toBeGreaterThan(0);
    for (const p of ENVIRONMENT_PATTERNS) expect(p.catches.length).toBeGreaterThan(0);
    const hit = (s: string) => ENVIRONMENT_PATTERNS.some((p) => p.pattern.test(s));
    for (const s of ["Invalid API key · Please run /login", "OAuth token has expired", "Claude AI usage limit reached|1790000000",
      "API Error: 429 rate_limit_error", "API Error: 529 Overloaded", "API Error: 503 Service Unavailable", "getaddrinfo ENOTFOUND api.anthropic.com",
      "Unable to connect to API (ECONNREFUSED)", "You've hit your session limit · resets 8:10pm (America/Chicago)", "You've hit your weekly limit",
      "You've hit your monthly spend limit", "You're out of usage credits", "Credit balance is too low", "OAuth token refresh failed",
      "OAuth token revoked · Please run /login", "You've reached your Fable limit. Switch to another model to continue.",
      "claude-opus-5-5 requires usage credits. Switch to another model to continue.", "You've hit your team's shared budget. /model to switch models."]) expect(hit(s)).toBe(true);
    for (const s of ["TypeError: x is undefined", "claude ended with error_during_execution", "tests failed"]) expect(hit(s)).toBe(false);
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

  test("passes settings to claude as --settings", async () => {
    const t = tempDir();
    try {
      const argsFile = join(t.path, "args.json");
      const settings = '{"hooks":{"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"bun \\"C:/a b/hook.ts\\""}]}]}}';
      await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "default",
        allowedTools: [], settings, timeoutMs: 10_000, maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
      const { args } = (await Bun.file(argsFile).json()) as { args: string[] };
      expect(args[args.indexOf("--settings") + 1]).toBe(settings);
    } finally { t.cleanup(); }
  });

  test("sessions run with background tasks turned off", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    await runPhase({ cwd: t.path, prompt: "FIXTURE:simple-success", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_ARGS: argsFile }, executable: FAKE });
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    t.cleanup();
  });

  test("a turn that answers a background task's notification is not the prompt's result: reading goes on", async () => {
    const t = tempDir();
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:notification-then-result", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, resume: "fake-notified", executable: FAKE });
    expect(r.ok).toBe(true);
    expect(r.structuredOutput).toMatchObject({ status: "success", summary: "answered the prompt" });
    t.cleanup();
  });

  test("a resumed session that only answers a pending notification gets the prompt again on the same session", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    const callsFile = join(t.path, "calls.jsonl");
    const r = await runPhase({ cwd: t.path, prompt: "Reconcile. FIXTURE:notification-only", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, resume: "build-session", env: { LOOPSTRA_FAKE_ARGS: argsFile, LOOPSTRA_FAKE_CALLS: callsFile }, executable: FAKE });
    expect(r.ok).toBe(true);
    expect(r.structuredOutput).toMatchObject({ status: "success" });
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["--resume", "build-session"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["--resume", "notified-session"]));
    expect((await Bun.file(argsFile).json()).prompt).toContain("Reconcile.");
    t.cleanup();
  });

  test("a session that never gets past notifications is resent a bounded number of times, then fails", async () => {
    const t = tempDir();
    const callsFile = join(t.path, "calls.jsonl");
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:notification-forever", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_CALLS: callsFile }, executable: FAKE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("crash");
    expect(r.detail).toMatch(/notification/);
    expect((await Bun.file(callsFile).text()).trim().split("\n").length).toBe(3);
    t.cleanup();
  });

  test("a session that finishes without structured output is asked once, on the same session, to return it", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    const callsFile = join(t.path, "calls.jsonl");
    const r = await runPhase({ cwd: t.path, prompt: "Verify. FIXTURE:no-envelope", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_ARGS: argsFile, LOOPSTRA_FAKE_CALLS: callsFile }, executable: FAKE });
    expect(r.ok).toBe(true);
    expect(r.structuredOutput).toMatchObject({ status: "success" });
    // Both sends are paid for.
    expect(r.costUsd).toBeCloseTo(0.03);
    // What the working session was refused is kept, so the trace can name the allow rule to add.
    expect(r.denied).toEqual(["Bash(dotnet ef database update)"]);
    const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.length).toBe(2);
    expect(calls[0]).not.toContain("--resume");
    expect(calls[1]).toEqual(expect.arrayContaining(["--resume", "no-envelope-session"]));
    const nudge = (await Bun.file(argsFile).json()).prompt as string;
    expect(nudge).toMatch(/StructuredOutput tool/);
    expect(nudge).not.toContain("Verify.");
    t.cleanup();
  });

  test("the nudge may spend only what the first send left of the cap", async () => {
    const t = tempDir();
    try {
      const callsFile = join(t.path, "calls.jsonl");
      await runPhase({ cwd: t.path, prompt: "FIXTURE:no-envelope", schema: {}, model: "haiku", permissionMode: "default",
        allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_CALLS: callsFile }, executable: FAKE });
      const calls = (await Bun.file(callsFile).text()).trim().split("\n").map((l) => JSON.parse(l) as string[]);
      expect(calls[0]).toEqual(expect.arrayContaining(["--max-budget-usd", "1"]));
      // The first send cost $0.02.
      expect(calls[1]).toEqual(expect.arrayContaining(["--max-budget-usd", "0.98"]));
    } finally { t.cleanup(); }
  });

  test("a session that used up its cap is not nudged: its report is unreadable", async () => {
    const t = tempDir();
    try {
      const callsFile = join(t.path, "calls.jsonl");
      const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:no-envelope", schema: {}, model: "haiku", permissionMode: "default",
        allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 0.025, env: { LOOPSTRA_FAKE_CALLS: callsFile }, executable: FAKE });
      expect(r.reason).toBe("invalid-envelope");
      expect(r.costUsd).toBeCloseTo(0.02);
      expect((await Bun.file(callsFile).text()).trim().split("\n").length).toBe(1);
    } finally { t.cleanup(); }
  });

  test("says whether the session reported its cost", async () => {
    const t = tempDir();
    try {
      const base = { cwd: t.path, schema: {}, model: "haiku", permissionMode: "default" as const, allowedTools: [], maxBudgetUsd: 1, executable: FAKE };
      expect((await runPhase({ ...base, prompt: "FIXTURE:simple-success", timeoutMs: 10_000 })).costReported).toBe(true);
      const hung = await runPhase({ ...base, prompt: "FIXTURE:hang", timeoutMs: 800 });
      expect(hung.reason).toBe("timeout");
      expect(hung.costReported).toBe(false);
    } finally { t.cleanup(); }
  });

  test("a session that still returns no structured output after the nudge fails as an unreadable report", async () => {
    const t = tempDir();
    const callsFile = join(t.path, "calls.jsonl");
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:no-envelope-forever", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 10_000, maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_CALLS: callsFile }, executable: FAKE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-envelope");
    expect(r.detail).toMatch(/without structured output/);
    expect((await Bun.file(callsFile).text()).trim().split("\n").length).toBe(2);
    t.cleanup();
  });

  test("a nudge that times out is still an unreadable report, not a timeout to rerun", async () => {
    const t = tempDir();
    const r = await runPhase({ cwd: t.path, prompt: "FIXTURE:no-envelope-stuck", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 2_000, maxBudgetUsd: 1, executable: FAKE, exitGraceMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-envelope");
    expect(r.detail).toMatch(/without structured output, and asking again failed: .*timed out/);
    t.cleanup();
  });

  test("FAKE_CLAUDE_ENV names the override variable", () => {
    expect(FAKE_CLAUDE_ENV).toBe("LOOPSTRA_CLAUDE_EXECUTABLE");
  });
});

describe("live sessions", () => {
  const base = (cwd: string) => ({ cwd, schema: {}, model: "haiku", permissionMode: "default" as const, allowedTools: [], timeoutMs: 60_000, executable: FAKE });
  /** The design fixture, held at `gate` after its init line (so the session id is known while it waits). */
  const heldDesign = (gate: string) => {
    const [init, ...rest] = fixture("design").split("\n");
    return [init, JSON.stringify({ type: "fake_action", wait_for: gate }), ...rest].join("\n");
  };

  test("a message written while the turn runs is answered by its result; the session then ends", async () => {
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: `${JSON.stringify({ type: "fake_action", wait_for: gate })}\n${fixture("design")}` });
    try {
      let ctl: SessionControl | null = null;
      let detached = false;
      const run = runPhase({ ...base(t.path), prompt: "write it", env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, live: { attach: (c) => { ctl = c; return () => { detached = true; }; } } });
      await until(() => ctl !== null);
      await until(() => ctl!.message("cover negatives"));
      writeFileSync(gate, "");
      const r = await run;
      expect(r.ok).toBe(true);
      expect((r.structuredOutput as { summary: string }).summary).toBe("heard: cover negatives");
      // Ended: nothing more can be sent, and the watching is over.
      expect(ctl!.message("too late")).toBe(false);
      expect(detached).toBe(true);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("a message that came after the result keeps the session for the turn that answers it, and that result counts", async () => {
    const t = tempDir();
    const fixtures = fixtureDir({ design: fixture("design") });
    const log = join(t.path, "steer.jsonl");
    try {
      let ctl: SessionControl | null = null;
      let sent = false;
      // Written from the result event itself: after the turn ended, before the runner decides it is final.
      const run = runPhase({
        ...base(t.path), prompt: "write it", env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_STEER_LOG: log },
        live: { attach: (c) => { ctl = c; return () => {}; } },
        onEvent: (e) => { if (e.type === "result" && !sent) { sent = ctl!.message("and zero"); } },
      });
      const r = await run;
      expect(sent).toBe(true);
      expect(readFileSync(log, "utf8")).toContain("\"queued\"");
      expect((r.structuredOutput as { summary: string }).summary).toBe("heard: and zero");
      // The second turn's result carries the process's running total.
      expect(r.costUsd).toBeCloseTo(0.1);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("stop ends the session and throws SessionStopped", async () => {
    const t = tempDir();
    try {
      let ctl: SessionControl | null = null;
      let detached = false;
      const run = runPhase({ ...base(t.path), prompt: "FIXTURE:hang", live: { attach: (c) => { ctl = c; return () => { detached = true; }; } } });
      await until(() => ctl !== null);
      ctl!.stop("John");
      const e = await run.then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(SessionStopped);
      expect((e as SessionStopped).by).toBe("John");
      expect((e as Error).message).toBe("stopped by John");
      expect(detached).toBe(true);
    } finally {
      t.cleanup();
    }
  }, 90_000);

  test("redirect ends the process and resumes the same session with the new direction; the earlier cost carries over", async () => {
    const t = tempDir();
    const calls = join(t.path, "calls.jsonl");
    const prompts = join(t.path, "prompts.jsonl");
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: heldDesign(gate) });
    const lines = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({
        ...base(t.path), prompt: "write it", maxBudgetUsd: 5,
        env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts },
        live: { attach: (c) => { ctl = c; return () => {}; } },
      });
      await until(() => ctl !== null);
      await until(() => ctl!.redirect("do it the other way"));
      // A second redirect waits until the first has been taken up.
      expect(ctl!.redirect("and another")).toBe(false);
      await until(() => lines().length === 2);
      writeFileSync(gate, "");
      const r = await run;
      expect(r.ok).toBe(true);
      const args = lines().map((l) => JSON.parse(l) as string[]);
      expect(args).toHaveLength(2);
      expect(args[1]).toContain("--resume");
      expect(args[1]![args[1]!.indexOf("--resume") + 1]).toBe("fake-design");
      expect(args[1]).toContain("--input-format");
      const sent = readFileSync(prompts, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { prompt: string }).prompt);
      expect(sent).toEqual(["write it", "do it the other way"]);
      // The killed process reported no cost: it is estimated, so the total is above the last process's 0.05.
      expect(r.costUsd).toBeGreaterThan(0.05);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("redirect waits for the session's id: false before the session's first event, true once it has one", async () => {
    const t = tempDir();
    const before = join(t.path, "before");
    const after = join(t.path, "after");
    const argsFile = join(t.path, "args.json");
    const calls = join(t.path, "calls.jsonl");
    const [init, ...rest] = fixture("design").split("\n");
    // Without echoes the fake prints nothing until `before` exists; then its init line names the session, and it waits at `after`.
    const fixtures = fixtureDir({ design: [JSON.stringify({ type: "fake_action", wait_for: before }), init, JSON.stringify({ type: "fake_action", wait_for: after }), ...rest].join("\n") });
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({
        ...base(t.path), prompt: "write it",
        env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_ARGS: argsFile, LOOPSTRA_FAKE_CALLS: calls },
        live: { attach: (c) => { ctl = c; return () => {}; }, replay: false },
      });
      // The fake has read its prompt, so its stdin is open: only the missing id refuses the redirect.
      await until(() => existsSync(argsFile));
      expect(ctl!.redirect("too soon")).toBe(false);
      writeFileSync(before, "");
      await until(() => ctl!.redirect("now"));
      writeFileSync(after, "");
      const r = await run;
      expect(r.ok).toBe(true);
      const args = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
      expect(args).toHaveLength(2);
      expect(args[1]![args[1]!.indexOf("--resume") + 1]).toBe("fake-design");
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("a CLI that never echoes: a session nobody messaged ends at its result", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    try {
      const r = await runPhase({ ...base(t.path), prompt: "FIXTURE:simple-success", env: { LOOPSTRA_FAKE_ARGS: argsFile }, live: { attach: () => () => {}, replay: false } });
      expect(r.ok).toBe(true);
      // Not its whole timeout (60 s) waiting for an echo.
      expect(r.durationMs).toBeLessThan(30_000);
      const recorded = await Bun.file(argsFile).json();
      expect(recorded.args).toContain("--input-format");
      expect(recorded.args).not.toContain("--replay-user-messages");
    } finally { t.cleanup(); }
  }, 90_000);

  test("a message whose echo never comes: the wait for it runs out, stdin closes, and the newest result counts", async () => {
    const t = tempDir();
    const fixtures = fixtureDir({ design: fixture("design") });
    const log = join(t.path, "steer.jsonl");
    try {
      let ctl: SessionControl | null = null;
      let sent = false;
      const r = await runPhase({
        ...base(t.path), prompt: "write it", env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_STEER_LOG: log },
        live: { attach: (c) => { ctl = c; return () => {}; }, replay: false, echoWaitMs: 500 },
        onEvent: (e) => { if (e.type === "result" && !sent) { sent = ctl!.message("and zero"); } },
      });
      expect(sent).toBe(true);
      expect(readFileSync(log, "utf8")).toContain("\"queued\"");
      expect(r.ok).toBe(true);
      // The queued turn ran, unechoed, and its result is the phase's.
      expect((r.structuredOutput as { summary: string }).summary).toBe("heard: and zero");
      expect(r.costUsd).toBeCloseTo(0.1);
      expect(r.durationMs).toBeLessThan(30_000);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("once the echo came, the wait for it is over: a long quiet stretch in the queued turn never closes stdin", async () => {
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: heldDesign(gate) });
    try {
      writeFileSync(gate, ""); // the first turn goes straight through
      let ctl: SessionControl | null = null;
      let sent = false;
      let echoed = false;
      let echoedMore = false;
      const run = runPhase({
        ...base(t.path), prompt: "write it", env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path },
        live: { attach: (c) => { ctl = c; return () => {}; }, echoWaitMs: 200 },
        onEvent: (e) => {
          // After the first result: the queued turn holds at the gate, quiet, once it has echoed the message.
          if (e.type === "result" && !sent) { rmSync(gate); sent = ctl!.message("and zero"); }
          if (e.type === "user" && e.isReplay === true && JSON.stringify(e).includes("and zero")) echoed = true;
          if (e.type === "user" && e.isReplay === true && JSON.stringify(e).includes("one more")) echoedMore = true;
        },
      });
      await until(() => echoed);
      // Well past the echo wait, with nothing from the session meanwhile.
      await Bun.sleep(1_500);
      expect(ctl!.message("one more")).toBe(true);
      // The gate opens once the held turn has taken the message: opened sooner, the turn could end before
      // the fake reads it from stdin, and the message would get a turn of its own.
      await until(() => echoedMore);
      writeFileSync(gate, "");
      const r = await run;
      expect(r.ok).toBe(true);
      expect((r.structuredOutput as { summary: string }).summary).toBe("heard: and zero | one more");
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("an error result never waits for an echo", async () => {
    const t = tempDir();
    try {
      let ctl: SessionControl | null = null;
      let sent = false;
      const r = await runPhase({
        ...base(t.path), prompt: "FIXTURE:budget",
        live: { attach: (c) => { ctl = c; return () => {}; }, replay: false },
        onEvent: (e) => { if (e.type === "result" && !sent) { sent = ctl!.message("one more thing"); } },
      });
      expect(sent).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("budget");
      expect(r.durationMs).toBeLessThan(30_000);
    } finally { t.cleanup(); }
  }, 90_000);

  test("a stop that comes after the final result is too late: it does nothing, and the result stands", async () => {
    const t = tempDir();
    try {
      let ctl: SessionControl | null = null;
      let stopped = null as boolean | null;
      // Linger keeps running after its result, so the stop lands while the process gets its grace to exit.
      const r = await runPhase({
        ...base(t.path), prompt: "FIXTURE:linger",
        live: { attach: (c) => { ctl = c; return () => {}; } },
        onEvent: (e) => { if (e.type === "result") setTimeout(() => { stopped = ctl!.stop("John"); }, 0); },
      });
      expect(stopped).toBe(false);
      expect(r.ok).toBe(true);
    } finally { t.cleanup(); }
  }, 90_000);

  test("once a stop is pending, a message is refused", async () => {
    const t = tempDir();
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({ ...base(t.path), prompt: "FIXTURE:hang", live: { attach: (c) => { ctl = c; return () => {}; } } });
      await until(() => ctl !== null && ctl.message("first"));
      expect(ctl!.stop("John")).toBe(true);
      expect(ctl!.message("after the stop")).toBe(false);
      expect(await run.then(() => null, (err: unknown) => err)).toBeInstanceOf(SessionStopped);
    } finally { t.cleanup(); }
  }, 90_000);

  test("a redirect takes the messages the killed process had not taken up yet to the resumed one, after the new direction", async () => {
    const t = tempDir();
    const calls = join(t.path, "calls.jsonl");
    const prompts = join(t.path, "prompts.jsonl");
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: heldDesign(gate) });
    const lines = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({
        ...base(t.path), prompt: "write it",
        env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts },
        // Never echoed, so the message is still not taken up when the redirect comes.
        live: { attach: (c) => { ctl = c; return () => {}; }, replay: false },
      });
      await until(() => ctl !== null && ctl.message("cover negatives"));
      await until(() => ctl!.redirect("do it the other way", "John"));
      await until(() => lines().length === 2);
      writeFileSync(gate, "");
      const r = await run;
      expect(r.ok).toBe(true);
      const sent = readFileSync(prompts, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { prompt: string }).prompt);
      expect(sent).toEqual(["write it", `do it the other way\n\n${MEANWHILE_HEADING}\n\ncover negatives`]);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("a redirect with too little left of the cap to resume ends the session quietly, as stopped by whoever sent it", async () => {
    const t = tempDir();
    const calls = join(t.path, "calls.jsonl");
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: heldDesign(gate) });
    try {
      let ctl: SessionControl | null = null;
      const started = Date.now();
      const run = runPhase({
        ...base(t.path), prompt: "write it", maxBudgetUsd: MIN_SESSION_USD + 0.002,
        env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls },
        live: { attach: (c) => { ctl = c; return () => {}; } },
      });
      // Past this long, the killed process is estimated (at USD_PER_MINUTE) to have spent more than the cap leaves above MIN_SESSION_USD.
      const enough = (0.002 / USD_PER_MINUTE) * 60_000 + 500;
      await until(() => Date.now() - started > enough);
      await until(() => ctl!.redirect("do it the other way", "John"));
      const e = await run.then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(SessionStopped);
      expect((e as SessionStopped).by).toBe("John");
      // Not resumed.
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      writeFileSync(gate, "");
      fixtures.cleanup(); t.cleanup();
    }
  }, 90_000);

  test("a live session passes --input-format stream-json and --replay-user-messages", async () => {
    const t = tempDir();
    const argsFile = join(t.path, "args.json");
    try {
      const r = await runPhase({ ...base(t.path), prompt: "FIXTURE:simple-success", env: { LOOPSTRA_FAKE_ARGS: argsFile }, live: { attach: () => () => {} } });
      expect(r.ok).toBe(true);
      const recorded = await Bun.file(argsFile).json();
      expect(recorded.args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--replay-user-messages"]));
      expect(recorded.args[recorded.args.indexOf("--input-format") + 1]).toBe("stream-json");
      expect(recorded.prompt).toBe("FIXTURE:simple-success");
    } finally { t.cleanup(); }
  });

  test("the resends work live too: a missing envelope is asked for, a notification gets the prompt again", async () => {
    const t = tempDir();
    const calls = join(t.path, "calls.jsonl");
    try {
      const nudged = await runPhase({ ...base(t.path), prompt: "FIXTURE:no-envelope", maxBudgetUsd: 1, env: { LOOPSTRA_FAKE_CALLS: calls }, live: { attach: () => () => {} } });
      expect(nudged.ok).toBe(true);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
      const notified = await runPhase({ ...base(t.path), prompt: "FIXTURE:notification-only", maxBudgetUsd: 1, resume: "build-session", live: { attach: () => () => {} } });
      expect(notified.ok).toBe(true);
    } finally { t.cleanup(); }
  }, 90_000);
});
