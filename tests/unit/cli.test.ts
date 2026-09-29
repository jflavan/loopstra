import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "../../src/scheduler";
import { FAKE_CLAUDE, run, tempDir, tempGitRepo } from "../helpers";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const NOT_SET_UP = "This folder is not set up for Loopstra. Run loopstra init first.";

describe("the command line outside a set-up repo", () => {
  test("status, tail, and ui say the folder is not set up, and create nothing", async () => {
    const t = tempDir();
    try {
      for (const cmd of ["status", "tail", "ui"]) {
        const r = await run([process.execPath, CLI, cmd], t.path);
        expect({ cmd, code: r.code, said: (r.out + r.err).trim() }).toEqual({ cmd, code: 1, said: NOT_SET_UP });
      }
      expect(readdirSync(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("start refuses the same way, in its preflight", async () => {
    const repo = await tempGitRepo();
    try {
      const env = { ...process.env, LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE };
      expect(await preflight(repo.path, env)).toBe(NOT_SET_UP);
      expect(existsSync(join(repo.path, ".loopstra"))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("init in a folder that is not a git repository warns and stops", async () => {
    const t = tempDir();
    try {
      const r = await run([process.execPath, CLI, "init"], t.path);
      expect(r.code).toBe(1);
      expect((r.out + r.err).trim()).toBe("warning: This folder is not a git repository; run git init first.");
      expect(readdirSync(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
