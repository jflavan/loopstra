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
    const r = await runCommand("echo $LOOPSTRA_PHASE", t.path, { LOOPSTRA_PHASE: "fix" });
    expect(r.output.trim()).toBe("fix");
    t.cleanup();
  });

  test("lastLine returns the last non-empty line", async () => {
    const t = tempDir();
    const r = await runCommand("echo one; echo two", t.path);
    expect(r.lastLine).toBe("two");
    t.cleanup();
  });
});
