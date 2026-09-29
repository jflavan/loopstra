import { describe, expect, test } from "bun:test";
import { runCommand } from "../../src/shell";
import { tempDir } from "../helpers";

describe("runCommand", () => {
  test("captures exit code and combined output", async () => {
    const t = tempDir();
    const r = await runCommand("echo hello", t.path);
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe("hello");
    t.cleanup();
  });

  test("non-zero exit is reported, not thrown", async () => {
    const t = tempDir();
    const r = await runCommand("exit 3", t.path);
    expect(r.code).toBe(3);
    t.cleanup();
  });

  test("passes environment variables", async () => {
    const t = tempDir();
    const r = await runCommand("echo $LOOPSTRA_PHASE", t.path, { env: { LOOPSTRA_PHASE: "fix" } });
    expect(r.output.trim()).toBe("fix");
    t.cleanup();
  });

  test("a command that outlives its timeout is killed and reported plainly", async () => {
    const t = tempDir();
    const started = Date.now();
    const r = await runCommand(`bun -e "await Bun.sleep(5000)"`, t.path, { timeoutMs: 500 });
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.lastLine).toBe("A project command did not finish in time.");
    const ok = await runCommand("echo fine", t.path, { timeoutMs: 10_000 });
    expect(ok.timedOut).toBe(false);
    t.cleanup();
  });

  test("lastLine returns the last non-empty line", async () => {
    const t = tempDir();
    const r = await runCommand("echo one; echo two", t.path);
    expect(r.lastLine).toBe("two");
    t.cleanup();
  });
});
