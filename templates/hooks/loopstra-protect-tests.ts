#!/usr/bin/env bun
// Claude Code PreToolUse hook. During a Loopstra fix phase, block edits to test files.
// Input: JSON on stdin with tool_name and tool_input. Exit 2 blocks the action and sends stderr to Claude.
const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { file_path?: string; path?: string } };
if (process.env.LOOPSTRA_PHASE !== "fix") process.exit(0);
const path = (input.tool_input?.file_path ?? input.tool_input?.path ?? "").replace(/\\/g, "/");
const isTest = /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
if (isTest) {
  console.error(`Loopstra: test files are protected during a fix phase. Fix the code, not the test (${path}).`);
  process.exit(2);
}
process.exit(0);
