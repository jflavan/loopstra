import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPhase } from "../../src/claude";
import { GitHub } from "../../src/github";
import { agentPhase } from "../../src/phases";
import { runCommand } from "../../src/shell";
import { GitTimeout, passOn } from "../../src/git";
import { AssistantUnavailable, LoopBudgetReached, notTheStepsFault, onStopSignal, requestStop, resetStop, stopPromise, stopRequested, StopRequested } from "../../src/stop";
import { FAKE_CLAUDE as FAKE, setupRepo, tempDir } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

afterEach(() => resetStop());

/** Asks for a stop after `ms`, the way a first Ctrl-C would. */
function stopAfter(ms: number): void {
  setTimeout(() => requestStop(), ms);
}

describe("stop", () => {
  test("a request sets the flag and resolves the stop promise; reset clears it", async () => {
    expect(stopRequested()).toBe(false);
    const p = stopPromise();
    requestStop();
    expect(stopRequested()).toBe(true);
    await p;
    resetStop();
    expect(stopRequested()).toBe(false);
  });

  test("the first signal asks for a stop; a second exits with 130", () => {
    const exits: number[] = [];
    const quiet = () => {};
    onStopSignal((c) => exits.push(c), quiet);
    expect(stopRequested()).toBe(true);
    expect(exits).toEqual([]);
    onStopSignal((c) => exits.push(c), quiet);
    expect(exits).toEqual([130]);
  });

  test("no command starts after a stop", async () => {
    const t = tempDir();
    requestStop();
    await expect(runCommand("echo hi", t.path)).rejects.toBeInstanceOf(StopRequested);
    t.cleanup();
  });

  test("a running command is killed when a stop is requested", async () => {
    const t = tempDir();
    const started = Date.now();
    stopAfter(300);
    await expect(runCommand('bun -e "await Bun.sleep(60000)"', t.path, { timeoutMs: 60_000 })).rejects.toBeInstanceOf(StopRequested);
    expect(Date.now() - started).toBeLessThan(15_000);
    t.cleanup();
  }, 30_000);

  test("no gh call starts after a stop, and a running one is killed", async () => {
    const t = tempDir();
    const gh = new GitHub(t.path, { executable: FAKE_GH, env: { LOOPSTRA_FAKE_GH_STATE: join(t.path, "gh.json"), LOOPSTRA_FAKE_GH_HANG: "1" } });
    const started = Date.now();
    stopAfter(300);
    await expect(gh.lookupPr("intent/x")).rejects.toBeInstanceOf(StopRequested);
    expect(Date.now() - started).toBeLessThan(15_000);
    await expect(gh.available()).rejects.toBeInstanceOf(StopRequested);
    t.cleanup();
  }, 30_000);

  test("a running claude session is killed when a stop is requested", async () => {
    const t = tempDir();
    const started = Date.now();
    stopAfter(500);
    await expect(runPhase({
      cwd: t.path, prompt: "FIXTURE:hang", schema: {}, model: "haiku", permissionMode: "default",
      allowedTools: [], timeoutMs: 60_000, maxBudgetUsd: 1, executable: FAKE,
    })).rejects.toBeInstanceOf(StopRequested);
    expect(Date.now() - started).toBeLessThan(15_000);
    t.cleanup();
  }, 30_000);

  test("an agent phase stopped mid-run is marked interrupted, not failed, and is not retried", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:hang");
    stopAfter(500);
    await expect(agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} })).rejects.toBeInstanceOf(StopRequested);
    expect(trace.phases("add-numbers").map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);
    // After the stop nothing new starts.
    await expect(agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} })).rejects.toBeInstanceOf(StopRequested);
    expect(trace.phases("add-numbers")).toHaveLength(1);
    trace.close(); repo.cleanup();
  }, 30_000);
});

describe("not the step's fault", () => {
  test("a stop, an unavailable assistant, and the loop's used-up day; nothing else", () => {
    for (const e of [new StopRequested(), new AssistantUnavailable("down"), new LoopBudgetReached()]) expect(notTheStepsFault(e)).toBe(true);
    for (const e of [new Error("x"), new GitTimeout(["status"], 1000), "text", null]) expect(notTheStepsFault(e)).toBe(false);
  });

  test("passOn rethrows those and a git timeout, and lets anything else be handled", () => {
    for (const e of [new StopRequested(), new AssistantUnavailable("down"), new LoopBudgetReached(), new GitTimeout(["status"], 1000)]) expect(() => passOn(e)).toThrow(e);
    expect(() => passOn(new Error("x"))).not.toThrow();
  });
});
