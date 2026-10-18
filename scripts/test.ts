#!/usr/bin/env bun
// Runs the test files in parallel: a queue of files, heaviest first, drained by N workers, each file
// its own `bun test` process. So no shard waits on a badly balanced bucket, every file's time is
// reported, and tests that touch process.env or the stop state stay isolated.
// Usage: bun run test [--workers N] [--part i/n] [extra bun test args]
//   --workers N   processes at once (default 4; --shards N is the old spelling)
//   --part i/n    only the i-th of n slices of the files (1-based), for splitting across CI jobs
// Serial run: bun run test:serial.
import { Glob } from "bun";

// Rough seconds per file from a serial run; unknown files count as 2. Only the order matters: the
// heaviest files start first so the end of the run is not one long file alone.
const WEIGHTS: Record<string, number> = {
  "tests/integration/remote.test.ts": 34,
  "tests/unit/stages-review-merge.test.ts": 29,
  "tests/integration/lanes.test.ts": 36,
  "tests/integration/scheduler.test.ts": 17,
  "tests/integration/upgrade-e2e.test.ts": 15,
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
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}
const workers = Math.max(1, Number(option("--workers") ?? option("--shards")) || 4);
const [part, parts] = (option("--part") ?? "1/1").split("/").map(Number) as [number, number];
if (!(part >= 1 && parts >= 1 && part <= parts)) {
  console.error("--part wants i/n with 1 <= i <= n");
  process.exit(2);
}

// Many tests build real git repositories and spawn processes: well under a second each on Linux and
// macOS, but several seconds on a busy Windows CI runner. Bun's 5s default is too tight there, and a
// timed-out test keeps running and disturbs the next one. (Bun ignores a timeout in bunfig.toml.)
if (!args.some((a) => a.startsWith("--timeout"))) args.push("--timeout", "30000");

const all = [...new Glob("tests/**/*.test.ts").scanSync(".")].map((f) => f.replaceAll("\\", "/")).sort();
const byWeight = [...all].sort((a, b) => (WEIGHTS[b] ?? 2) - (WEIGHTS[a] ?? 2));
// A slice takes every n-th file of the weight-sorted list, so each slice gets its share of heavy ones.
const queue = byWeight.filter((_, i) => i % parts === part - 1);

interface Result { file: string; code: number; seconds: number; text: string }
const results: Result[] = [];
const started = Date.now();

async function runFile(file: string): Promise<Result> {
  const t0 = Date.now();
  const proc = Bun.spawn({ cmd: [process.execPath, "test", ...args, `./${file}`], stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { file, code, seconds: (Date.now() - t0) / 1000, text: out + err };
}

await Promise.all(
  Array.from({ length: Math.min(workers, queue.length) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const r = await runFile(file);
      results.push(r);
      // bun test reports to stderr; a failing file is shown in full, a passing one as one line.
      console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${r.seconds.toFixed(1).padStart(6)}s  ${r.file}`);
      if (r.code !== 0) console.log(r.text);
    }
  }),
);

const count = (re: RegExp) => results.reduce((n, r) => n + Number(r.text.match(re)?.[1] ?? 0), 0);
const failed = results.filter((r) => r.code !== 0);
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5).map((r) => `${r.seconds.toFixed(1)}s ${r.file}`);
console.log(`\nslowest: ${slowest.join(", ")}`);
if (failed.length) console.log(`failed: ${failed.map((r) => r.file).join(", ")}`);
const slice = parts > 1 ? ` (part ${part}/${parts})` : "";
console.log(`${count(/^\s*(\d+) pass$/m)} pass, ${count(/^\s*(\d+) fail$/m)} fail across ${results.length} files${slice}, ${workers} workers, ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed.length ? 1 : 0);
