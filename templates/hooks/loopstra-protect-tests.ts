#!/usr/bin/env bun
// Claude Code PreToolUse hook. During a Loopstra fix phase, block edits to test files.
// Input: JSON on stdin with tool_name and tool_input. Exit 2 blocks the action and sends stderr to Claude.
import { appendFileSync } from "node:fs";
const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { file_path?: string; path?: string } };
if (process.env.LOOPSTRA_PHASE !== "fix") process.exit(0);
const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
// The path is judged inside the project, so a project that itself sits under a tests/ folder is not all tests.
// Claude Code sets CLAUDE_PROJECT_DIR; without it the hook runs in the project, so the working folder stands in.
const root = slashes(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const caseless = process.platform === "win32" || process.platform === "darwin";
const same = (a: string) => (caseless ? a.toLowerCase() : a);
let path = slashes(input.tool_input?.file_path ?? input.tool_input?.path ?? "");
if (root && same(path).startsWith(`${same(root)}/`)) path = path.slice(root.length + 1);
// A test folder (tests/, Tests/, __tests__/, spec/, a .NET App.Tests/, App.Tests.Unit/ or App.UnitTests/), a test file name
// (a.test.ts, a.spec.ts; _test and _spec only for the runners that use them: add_test.go, calc_test.py, calc_spec.rb;
// test_calc.py), or a .NET/JVM class name (CalcTests.cs, CalcTest.java) or XCTest's CalcTests.swift. Class names are
// case-sensitive and need a small letter or digit before Test, so Latest.java and ABTest.java are not tests.
const isTest = /(^|\/)(tests?|__tests__|spec|[^/]+\.tests?(\.\w+)?)\//i.test(path)
  || /(^|\/)[^/]+\.\w*Tests?(\.\w+)?\//.test(path)
  || /\.(test|spec)s?\.[a-z0-9]+$|_test\.(go|py|rb|exs|cc|cpp|c|rs)$|_spec\.rb$|(^|\/)test_[^/]+\.py$/i.test(path)
  || /(^|\/)[A-Za-z0-9_]*[a-z0-9](Tests?\.(cs|fs|vb|java|kt|scala)|Tests\.swift)$/.test(path);
if (isTest && !changedOnBranch().some((f) => same(f) === same(path))) {
  // The runtime names the file in the block note, so a person can make the edit instead of rebuilding.
  if (process.env.LOOPSTRA_PROTECTED_LOG) {
    try { appendFileSync(process.env.LOOPSTRA_PROTECTED_LOG, `${path}\n`); } catch { /* the refusal still stands */ }
  }
  console.error(`Loopstra: test files are protected during a fix phase. Fix the code, not the test (${path}).`);
  process.exit(2);
}
process.exit(0);

/**
 * Files this change added or changed on its branch since it left main ($LOOPSTRA_BASE), relative to the project.
 * Its own new tests are part of the change, not the line it must hold. Empty when git cannot say.
 */
function changedOnBranch(): string[] {
  const base = process.env.LOOPSTRA_BASE;
  if (!base) return [];
  try {
    const r = Bun.spawnSync({ cmd: ["git", "diff", "--name-only", "--relative", "-z", `${base}...HEAD`, "--"], cwd: root || undefined, stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean) : [];
  } catch {
    return [];
  }
}
