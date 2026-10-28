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
  void proc.stdin.write(JSON.stringify(input)); void proc.stdin.end();
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

  test("the acceptance step may write only tests and test fixtures", async () => {
    const acceptance = { LOOPSTRA_PHASE: "acceptance" };
    for (const p of ["/repo/tests/count.test.ts", "/repo/tests/fixtures/words.txt", "/repo/src/__tests__/count.ts", "C:\\repo\\tests\\count.test.ts"]) {
      expect({ p, code: (await runHook({ tool_name: "Write", tool_input: { file_path: p } }, acceptance)).code }).toEqual({ p, code: 0 });
    }
    for (const p of ["/repo/src/count.ts", "/repo/package.json", "/repo/docs/testing.md"]) {
      expect({ p, code: (await runHook({ tool_name: "Edit", tool_input: { file_path: p } }, acceptance)).code }).toEqual({ p, code: 2 });
    }
    const refused = await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/src/count.ts" } }, { ...acceptance, CLAUDE_PROJECT_DIR: "/repo" });
    expect(refused.err).toBe("Loopstra: the acceptance step writes only tests and test fixtures (src/count.ts).\n");
  });

  test("build, fix, reconcile and revise may not edit an acceptance test; other phases and other files are left alone", async () => {
    const t = tempDir();
    try {
      const log = join(t.path, "protected-tests.txt");
      const accepted = JSON.stringify(["tests/count.test.ts", "tests/fixtures/words.txt"]);
      const env = (phase: string) => ({ LOOPSTRA_PHASE: phase, LOOPSTRA_ACCEPTANCE: accepted, LOOPSTRA_PROTECTED_LOG: log, CLAUDE_PROJECT_DIR: "/repo" });
      for (const phase of ["build", "fix", "reconcile", "revise"]) {
        const r = await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/count.test.ts" } }, env(phase));
        expect({ phase, code: r.code }).toEqual({ phase, code: 2 });
        expect(r.err).toBe("Loopstra: this is an acceptance test written from Done when; fix the code, not the test (tests/count.test.ts).\n");
      }
      expect(readFileSync(log, "utf8")).toBe("tests/count.test.ts\n".repeat(4));
      // A fixture the acceptance step wrote is held the same way.
      expect((await runHook({ tool_name: "Write", tool_input: { file_path: "/repo/tests/fixtures/words.txt" } }, env("build"))).code).toBe(2);
      // The build writes its own tests and code freely.
      expect((await runHook({ tool_name: "Write", tool_input: { file_path: "/repo/tests/other.test.ts" } }, env("build"))).code).toBe(0);
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/src/count.ts" } }, env("revise"))).code).toBe(0);
      // Phases that do not write code, and the acceptance step itself, are not held by the list.
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/count.test.ts" } }, env("acceptance"))).code).toBe(0);
      expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/count.test.ts" } }, env("review"))).code).toBe(0);
    } finally { t.cleanup(); }
  });

  test("an acceptance test is matched through Windows backslashes, and its case only where the file system ignores case", async () => {
    const accepted = { LOOPSTRA_PHASE: "build", LOOPSTRA_ACCEPTANCE: JSON.stringify(["tests/count.test.ts"]) };
    const backslashed = await runHook({ tool_name: "Edit", tool_input: { file_path: "C:\\repo\\tests\\count.test.ts" } }, { ...accepted, CLAUDE_PROJECT_DIR: "C:\\repo" });
    expect(backslashed.code).toBe(2);
    expect(backslashed.err).toContain("(tests/count.test.ts)");
    // The list may be written with backslashes too.
    const listed = { LOOPSTRA_PHASE: "fix", LOOPSTRA_ACCEPTANCE: JSON.stringify(["tests\\count.test.ts"]), CLAUDE_PROJECT_DIR: "/repo" };
    expect((await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/count.test.ts" } }, listed)).code).toBe(2);
    const caseless = process.platform === "win32" || process.platform === "darwin";
    const upper = await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/Tests/Count.test.ts" } }, { ...accepted, CLAUDE_PROJECT_DIR: "/repo" });
    expect(upper.code).toBe(caseless ? 2 : 0);
  });

  test("an unreadable acceptance list holds nothing back", async () => {
    for (const list of ["not json", "{\"a\": 1}", "[1, 2]", ""]) {
      const r = await runHook({ tool_name: "Edit", tool_input: { file_path: "/repo/tests/count.test.ts" } }, { LOOPSTRA_PHASE: "build", LOOPSTRA_ACCEPTANCE: list, CLAUDE_PROJECT_DIR: "/repo" });
      expect({ list, code: r.code }).toEqual({ list, code: 0 });
    }
  });

  test("knows the test names of other languages: Go, pytest, .NET, Java", async () => {
    const fix = { LOOPSTRA_PHASE: "fix" };
    for (const p of ["/repo/pkg/add_test.go", "/repo/app/calc_test.py", "/repo/src/App.Tests/CalcTests.cs", "/repo/Tests/X.cs",
      "/repo/src/main/java/CalcTest.java", "/repo/test/calc.spec.js"]) {
      expect({ p, code: (await runHook({ tool_name: "Edit", tool_input: { file_path: p } }, fix)).code }).toEqual({ p, code: 2 });
    }
    for (const p of ["/repo/src/latest.ts", "/repo/src/Latest.java", "/repo/src/contest.py", "/repo/src/attestation.ts",
      "/repo/docs/testing.md", "/repo/src/protest-utils.ts"]) {
      expect({ p, code: (await runHook({ tool_name: "Edit", tool_input: { file_path: p } }, fix)).code }).toEqual({ p, code: 0 });
    }
  });

  test("knows .NET test projects, and leaves source files whose names only mention a test alone", async () => {
    const fix = { LOOPSTRA_PHASE: "fix" };
    for (const p of ["/repo/MyApp.UnitTests/Calc.cs", "/repo/MyApp.IntegrationTests/Api.cs", "/repo/MyApp.Tests.Unit/Calc.cs",
      "/repo/lib/calc_test.rb", "/repo/spec/calc_spec.rb", "/repo/lib/calc_spec.rb", "/repo/test/calc_test.exs", "/repo/src/calc_test.cc",
      "/repo/Tests/AppTests.swift", "/repo/src/AppTests.swift", "/repo/src/calc.spec.ts"]) {
      expect({ p, code: (await runHook({ tool_name: "Edit", tool_input: { file_path: p } }, fix)).code }).toEqual({ p, code: 2 });
    }
    // ABTest.java is not JUnit's CalcTest.java: the class name before Test must end in a small letter or a digit.
    for (const p of ["/repo/src/features/ab-test.ts", "/repo/src/cli/self-test.ts", "/repo/api/openapi-spec.yaml",
      "/repo/src/utils/load-test.ts", "/repo/src/smoke-test.ts", "/repo/src/api_spec.json", "/repo/docs/design-spec.md",
      "/repo/specs/openapi.yaml", "/repo/scripts/run-tests.sh", "/repo/.github/workflows/unit-tests.yml", "/repo/src/ABTest.java",
      "/repo/src/SpeedTest.swift", "/repo/src/v1.latest/a.ts"]) {
      expect({ p, code: (await runHook({ tool_name: "Edit", tool_input: { file_path: p } }, fix)).code }).toEqual({ p, code: 0 });
    }
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
