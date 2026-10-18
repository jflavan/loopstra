#!/usr/bin/env bun
// Runs the test files in parallel: a queue of files, heaviest first, drained by N workers, each file
// its own `bun test` process. So no shard waits on a badly balanced bucket, every file's time is
// reported, and tests that touch process.env or the stop state stay isolated.
// Usage: bun run test [--workers N] [--part i/n] [extra bun test args]
//   --workers N   processes at once (default 4; --shards N is the old spelling)
//   --part i/n    only the i-th of n parts of the files (1-based), for splitting across CI jobs
//   --list        print the files this run would take, with their weights, and stop
// Serial run: bun run test:serial.
import { Glob } from "bun";

// Rough seconds per file on a GitHub Windows runner (the slowest platform); unknown files count as
// 5. Only the order and the split across parts depend on them: the heaviest files start first, so
// the end of the run is not one long file alone.
const WEIGHTS: Record<string, number> = {
  "tests/integration/remote.test.ts": 180,
  "tests/integration/remote-checks.test.ts": 180,
  "tests/integration/lanes.test.ts": 170,
  "tests/integration/lanes-remote.test.ts": 140,
  "tests/unit/stages-build.test.ts": 140,
  "tests/unit/stages-design.test.ts": 115,
  "tests/unit/stages-review-merge.test.ts": 100,
  "tests/unit/stages-plan.test.ts": 95,
  "tests/integration/scheduler.test.ts": 80,
  "tests/unit/main-lock.test.ts": 60,
  "tests/unit/stages-verify.test.ts": 60,
  "tests/unit/remote.test.ts": 57,
  "tests/unit/apply.test.ts": 57,
  "tests/unit/git.test.ts": 40,
  "tests/unit/questions.test.ts": 27,
  "tests/integration/loop.test.ts": 26,
  "tests/integration/chat.test.ts": 25,
  "tests/unit/upgrade-repo.test.ts": 25,
  "tests/unit/loop-budget.test.ts": 25,
  "tests/unit/phases.test.ts": 24,
  "tests/unit/judges-run.test.ts": 23,
  "tests/unit/steering.test.ts": 22,
  "tests/unit/chat-transports.test.ts": 14,
  "tests/unit/signals.test.ts": 12,
};

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}
const list = args.includes("--list") && args.splice(args.indexOf("--list"), 1).length > 0;
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

const weight = (f: string) => WEIGHTS[f] ?? 5;
const all = [...new Glob("tests/**/*.test.ts").scanSync(".")].map((f) => f.replaceAll("\\", "/")).sort();
const byWeight = [...all].sort((a, b) => weight(b) - weight(a));
// Each file goes to the lightest part so far (heaviest first), so the parts take about the same time.
const partWeights = Array.from({ length: parts }, () => 0);
const queue = byWeight.filter((f) => {
  const lightest = partWeights.indexOf(Math.min(...partWeights));
  partWeights[lightest]! += weight(f);
  return lightest === part - 1;
});
if (list) {
  for (const f of queue) console.log(`${String(weight(f)).padStart(4)}  ${f}`);
  console.log(`${queue.length} files, weight ${queue.reduce((n, f) => n + weight(f), 0)} of ${all.reduce((n, f) => n + weight(f), 0)}`);
  process.exit(0);
}

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
