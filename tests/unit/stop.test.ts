import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runPhase } from "../../src/claude";
import { agentPhase } from "../../src/phases";
import { runCommand } from "../../src/shell";
import { onStopSignal, requestStop, resetStop, stopPromise, stopRequested, StopRequested } from "../../src/stop";
import { FAKE_CLAUDE as FAKE, setupRepo, tempDir } from "../helpers";

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
