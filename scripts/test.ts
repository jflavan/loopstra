#!/usr/bin/env bun
// Runs the test files in parallel shards, one `bun test` process each, so the suite takes about a
// third of the serial time. Each shard is its own process, so tests that touch process.env or the
// stop state stay isolated. Usage: bun run test [--shards N] [extra bun test args]
// Serial run: bun run test:serial.
import { Glob } from "bun";

// Rough seconds per file from a serial run; unknown files count as 2. Only balance matters.
const WEIGHTS: Record<string, number> = {
  "tests/integration/remote.test.ts": 34,
  "tests/unit/stages-review-merge.test.ts": 29,
  "tests/integration/scheduler.test.ts": 17,
  "tests/unit/remote.test.ts": 13,
  "tests/unit/stages-build.test.ts": 12,
  "tests/integration/loop.test.ts": 10,
  "tests/unit/stages-design.test.ts": 8,
  "tests/unit/stages-verify.test.ts": 7,
  "tests/unit/stages-plan.test.ts": 7,
  "tests/unit/git.test.ts": 6,
  "tests/unit/phases.test.ts": 5,
  "tests/unit/context.test.ts": 5,
  "tests/unit/signals.test.ts": 3,
};

const args = process.argv.slice(2);
const i = args.indexOf("--shards");
const shards = i >= 0 ? Math.max(1, Number(args.splice(i, 2)[1]) || 4) : 4;

// Many tests build real git repositories and spawn processes: well under a second each on Linux and
// macOS, but several seconds on a busy Windows CI runner. Bun's 5s default is too tight there, and a
// timed-out test keeps running and disturbs the next one. (Bun ignores a timeout in bunfig.toml.)
if (!args.some((a) => a.startsWith("--timeout"))) args.push("--timeout", "30000");

const files = [...new Glob("tests/**/*.test.ts").scanSync(".")].map((f) => f.replaceAll("\\", "/")).sort();
const buckets = Array.from({ length: shards }, () => ({ files: [] as string[], weight: 0 }));
for (const f of [...files].sort((a, b) => (WEIGHTS[b] ?? 2) - (WEIGHTS[a] ?? 2))) {
  const lightest = buckets.reduce((m, b) => (b.weight < m.weight ? b : m));
  lightest.files.push(f);
  lightest.weight += WEIGHTS[f] ?? 2;
}

const started = Date.now();
const results = await Promise.all(
  buckets.filter((b) => b.files.length).map(async (b, n) => {
    const proc = Bun.spawn({ cmd: [process.execPath, "test", ...args, ...b.files.map((f) => `./${f}`)], stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { n: n + 1, code, text: out + err };
  }),
);

let failed = false;
for (const r of results) {
  if (r.code !== 0) failed = true;
  // bun test reports to stderr; show a failing shard in full, a passing one by its summary only.
  const summary = r.text.split("\n").filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l)).join("\n");
  console.log(`--- shard ${r.n} ${r.code === 0 ? "passed" : "FAILED"}`);
  console.log(r.code === 0 ? summary : r.text);
}
const count = (re: RegExp) => results.reduce((n, r) => n + Number(r.text.match(re)?.[1] ?? 0), 0);
console.log(`\n${count(/^\s*(\d+) pass$/m)} pass, ${count(/^\s*(\d+) fail$/m)} fail across ${files.length} files in ${shards} shards, ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
