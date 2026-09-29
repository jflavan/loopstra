import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../templates/hooks/loopstra-protect-tests.ts", import.meta.url));

async function runHook(input: object, env: Record<string, string>): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn({ cmd: [process.execPath, HOOK], stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
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
});
