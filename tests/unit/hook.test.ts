import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers";

const HOOK = fileURLToPath(new URL("../../templates/hooks/loopstra-protect-tests.ts", import.meta.url));

async function runHook(input: object, env: Record<string, string>, cwd?: string): Promise<{ code: number; err: string }> {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.CLAUDE_PROJECT_DIR;
  const proc = Bun.spawn({ cmd: [process.execPath, HOOK], cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...base, ...env } });
  proc.stdin.write(JSON.stringify(input)); proc.stdin.end();
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err };
}

describe("protect-tests hook", () => {
  test("blocks test file edits during fix, allows otherwise", async () => {
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "C:\\repo\\tests\\a.test.ts" } }, { LOOPSTRA_PHASE: "fix" })).code).toBe(2);
    expect((await runHook({ tool_name: "Write", tool_input: { file_path: "/repo/src/__tests__/a.ts" } }, { LOOPSTRA_PHASE: "fix" })).code).toBe(2);
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } }, { LOOPSTRA_PHASE: "fix" })).code).toBe(0);
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/a.test.ts" } }, { LOOPSTRA_PHASE: "build" })).code).toBe(0);
    const blocked = await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/a.test.ts" } }, { LOOPSTRA_PHASE: "fix" });
    expect(blocked.err).toContain("protected");
  });

  test("judges the path inside the project: CLAUDE_PROJECT_DIR, or the working folder without it", async () => {
    const t = tempDir();
    try {
      // A project that itself sits under a folder called tests.
      const project = join(t.path, "tests", "proj");
      mkdirSync(project, { recursive: true });
      const real = realpathSync.native(project);
      const code = join(real, "src", "a.ts");
      const test_ = join(real, "tests", "a.test.ts");
      const fix = { LOOPSTRA_PHASE: "fix" };
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: code } }, { ...fix, CLAUDE_PROJECT_DIR: real })).code).toBe(0);
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: test_ } }, { ...fix, CLAUDE_PROJECT_DIR: real })).code).toBe(2);
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: code } }, fix, real)).code).toBe(0);
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: test_ } }, fix, real)).code).toBe(2);
    } finally { t.cleanup(); }
  });
});
