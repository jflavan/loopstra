#!/usr/bin/env bun
// Coverage gate: runs the suite with coverage and fails when the project-wide line or function
// coverage is under MIN_PERCENT. (bun's own coverageThreshold applies per file, which is stricter
// than the goal, so the total is computed here from the lcov report.)
// Usage: bun run coverage [--min N]
import { readFileSync } from "node:fs";

const minArg = process.argv.indexOf("--min");
const MIN_PERCENT = minArg >= 0 ? Number(process.argv[minArg + 1]) : 80;

const proc = Bun.spawn({
  cmd: [process.execPath, "test", "--timeout", "30000", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"],
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) process.exit(code);

const total = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
for (const line of readFileSync("coverage/lcov.info", "utf8").split("\n")) {
  const [key, value] = line.split(":");
  if (key && key in total) total[key as keyof typeof total] += Number(value);
}
const lines = (total.LH / total.LF) * 100;
const functions = (total.FNH / total.FNF) * 100;
console.log(`\ncoverage: ${lines.toFixed(2)}% lines, ${functions.toFixed(2)}% functions (minimum ${MIN_PERCENT}%)`);
process.exit(lines >= MIN_PERCENT && functions >= MIN_PERCENT ? 0 : 1);
