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
const isTest = /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
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
