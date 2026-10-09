import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, tempDir, tempGitRepo } from "../helpers";

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

  test("during fix, allows tests the change added or changed on its branch, and refuses tests unchanged on main", async () => {
    const repo = await tempGitRepo();
    try {
      const root = realpathSync.native(repo.path);
      mkdirSync(join(root, "tests"), { recursive: true });
      await Bun.write(join(root, "tests", "old.test.ts"), "old\n");
      await Bun.write(join(root, "tests", "kept.test.ts"), "kept\n");
      await run(["git", "add", "-A"], root);
      await run(["git", "commit", "-q", "-m", "tests on main"], root);
      await run(["git", "checkout", "-q", "-b", "intent/x"], root);
      await Bun.write(join(root, "tests", "new.test.ts"), "new\n");
      await Bun.write(join(root, "tests", "kept.test.ts"), "kept, changed\n");
      await run(["git", "add", "-A"], root);
      await run(["git", "commit", "-q", "-m", "build"], root);
      // main moves on after the branch left it: its own changes are not the branch's.
      await run(["git", "checkout", "-q", "main"], root);
      await Bun.write(join(root, "tests", "old.test.ts"), "old, changed on main\n");
      await run(["git", "commit", "-q", "-am", "main moves"], root);
      await run(["git", "checkout", "-q", "intent/x"], root);

      const log = join(root, ".git", "protected-tests.txt");
      const env = { LOOPSTRA_PHASE: "fix", LOOPSTRA_BASE: "main", LOOPSTRA_PROTECTED_LOG: log, CLAUDE_PROJECT_DIR: root };
      const edit = (rel: string, e: Record<string, string> = env) => runHook({ tool_name: "Edit", tool_input: { file_path: join(root, rel) } }, e);
      expect((await edit("tests/new.test.ts")).code).toBe(0);
      expect((await edit("tests/kept.test.ts")).code).toBe(0);
      expect(existsSync(log)).toBe(false);
      const refused = await edit("tests/old.test.ts");
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("protected");
      expect(readFileSync(log, "utf8")).toBe("tests/old.test.ts\n");
      // Without a base (an older runtime) or with one git does not know, every test stays protected.
      const { LOOPSTRA_BASE: _, ...noBase } = env;
      expect((await edit("tests/new.test.ts", noBase)).code).toBe(2);
      expect((await edit("tests/new.test.ts", { ...env, LOOPSTRA_BASE: "no-such-branch" })).code).toBe(2);
    } finally { repo.cleanup(); }
  });
});
