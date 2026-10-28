#!/usr/bin/env bun
// Claude Code PreToolUse hook that keeps Loopstra's sessions off the tests they must not change:
// - the acceptance step writes only tests and test fixtures;
// - build, fix, reconcile and revise may not edit the acceptance tests ($LOOPSTRA_ACCEPTANCE, a JSON list);
// - fix may not edit test files, except tests the change added or changed on its branch;
// - no session may edit loopstra/standards/, which only a person changes on main (resolve gets that rule alone).
// Input: JSON on stdin with tool_name and tool_input. Exit 2 blocks the action and sends stderr to Claude.
import { appendFileSync } from "node:fs";
import { posix } from "node:path";
// The test rules, from the installed package beside this hook.
import { isAcceptancePath, isTestPath } from "../../src/test-paths";
const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { file_path?: string; path?: string } };
const phase = process.env.LOOPSTRA_PHASE ?? "";
// The phases the hook guards: the writing phases, and resolve (which takes the standards rule only).
const GUARDED = new Set(["acceptance", "build", "fix", "reconcile", "revise", "resolve"]);
// The phases that change the code, and so may not change the tests written from Done when.
const EDITS_CODE = new Set(["build", "fix", "reconcile", "revise"]);
if (!GUARDED.has(phase)) process.exit(0);
// Forward slashes, and `.` and `..` segments resolved, so `src/../loopstra/standards/x.md` is the file it names.
const slashes = (p: string) => {
  const forward = p.replace(/\\/g, "/");
  return (forward ? posix.normalize(forward) : forward).replace(/\/+$/, "");
};
// The path is judged inside the project, so a project that itself sits under a tests/ folder is not all tests.
// Claude Code sets CLAUDE_PROJECT_DIR; without it the hook runs in the project, so the working folder stands in.
const root = slashes(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const caseless = process.platform === "win32" || process.platform === "darwin";
const same = (a: string) => (caseless ? a.toLowerCase() : a);
let path = slashes(input.tool_input?.file_path ?? input.tool_input?.path ?? "");
if (root && same(path).startsWith(`${same(root)}/`)) path = path.slice(root.length + 1);
// The standards rule comes first. Its refusal is not logged: a standard is never a protected test.
const STANDARDS = same("loopstra/standards");
if (same(path) === STANDARDS || same(path).startsWith(`${STANDARDS}/`)) {
  console.error(`Loopstra: the repository's standards (loopstra/standards/) are changed by a person on main, never by the loop's sessions (${path}).`);
  process.exit(2);
}
if (phase === "resolve") process.exit(0);
const isTest = isTestPath(path);
if (phase === "acceptance") {
  if (isAcceptancePath(path)) process.exit(0);
  console.error(`Loopstra: the acceptance step writes only tests and test fixtures (${path}).`);
  process.exit(2);
}
if (acceptanceTests().some((f) => same(f) === same(path))) refuse(`Loopstra: this is an acceptance test written from Done when; fix the code, not the test (${path}).`);
if (phase === "fix" && isTest && !changedOnBranch().some((f) => same(f) === same(path))) {
  refuse(`Loopstra: test files are protected during a fix phase. Fix the code, not the test (${path}).`);
}
process.exit(0);

/** Refuses the edit with `message`, and records the file, so the runtime names it in the block note and a person can make the edit instead of rebuilding. */
function refuse(message: string): never {
  if (process.env.LOOPSTRA_PROTECTED_LOG) {
    try { appendFileSync(process.env.LOOPSTRA_PROTECTED_LOG, `${path}\n`); } catch { /* the refusal still stands */ }
  }
  console.error(message);
  process.exit(2);
}

/** The acceptance test files ($LOOPSTRA_ACCEPTANCE), relative to the project with forward slashes. A list that cannot be read holds none. */
function acceptanceTests(): string[] {
  let list: unknown;
  try { list = JSON.parse(process.env.LOOPSTRA_ACCEPTANCE ?? "[]"); } catch { return []; }
  return Array.isArray(list) && list.every((f) => typeof f === "string") ? list.map((f: string) => slashes(f)) : [];
}

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
