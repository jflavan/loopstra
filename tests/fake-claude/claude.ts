#!/usr/bin/env bun
// Fake `claude` executable: replays a stream-json fixture. Never calls the network.
// Fixture selection, in order: $LOOPSTRA_FAKE_FIXTURE, "FIXTURE:<name>" in the prompt,
// $LOOPSTRA_FAKE_FIXTURE_DIR/<$LOOPSTRA_PHASE>.jsonl, fixtures/<$LOOPSTRA_PHASE>.jsonl, fixtures/simple-success.jsonl.
// A fixture line {"type":"fake_action","write":{"path":"...","content":"..."}} writes a file
// under the current directory before the remaining lines are emitted, so a fake "build" can change code.
// A fixture line {"type":"fake_action","refuse":"<path>"} records <path> in $LOOPSTRA_PROTECTED_LOG, as the
// protect-tests hook does when it refuses an edit.
// A fixture line {"type":"fake_exit","code":1,"stderr":"..."} writes that line to stderr and exits
// with that code at once (an outage: the CLI gives up without a result).
// "notification-only" answers a background task's notification and exits without reading the prompt,
// the way a resumed session with a pending notification does; resumed as "notified-session" it has
// nothing pending and answers the prompt. "notification-forever" never gets past the notification.
// "no-envelope" finishes with its report as text and no structured output; resumed, it returns one.
// "no-envelope-forever" never does; "no-envelope-stuck" hangs when resumed.
// $LOOPSTRA_FAKE_CALLS, when set, gets one line of args per call.
// A sequence: $LOOPSTRA_FAKE_FIXTURE_DIR/<phase>-<n>.jsonl is used for the n-th call of that phase
// (counted in <dir>/.count-<phase>), before <phase>.jsonl. $LOOPSTRA_FAKE_PROMPTS, when set, gets
// each prompt as one JSON line ({phase, args, prompt}).
// Like the real CLI, the process exits 1 after a result event with is_error.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Bun.argv.slice(2);
const prompt = await Bun.stdin.text();
const phase = process.env.LOOPSTRA_PHASE ?? "";

if (process.env.LOOPSTRA_FAKE_ARGS) {
  await Bun.write(process.env.LOOPSTRA_FAKE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), env: {
    LOOPSTRA_PHASE: phase || null,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null,
  } }));
}
if (process.env.LOOPSTRA_FAKE_CALLS) appendFileSync(process.env.LOOPSTRA_FAKE_CALLS, JSON.stringify(args) + "\n");

if (process.env.LOOPSTRA_FAKE_PROMPTS) appendFileSync(process.env.LOOPSTRA_FAKE_PROMPTS, JSON.stringify({ phase, args, prompt }) + "\n");

let sequenced: string | undefined;
const fixtureDir = process.env.LOOPSTRA_FAKE_FIXTURE_DIR;
if (fixtureDir && phase) {
  const countPath = join(fixtureDir, `.count-${phase}`);
  const n = (existsSync(countPath) ? Number(await Bun.file(countPath).text()) : 0) + 1;
  await Bun.write(countPath, String(n));
  sequenced = join(fixtureDir, `${phase}-${n}.jsonl`);
}

const here = join(dirname(Bun.main), "fixtures");
const named = /FIXTURE:([a-z0-9-]+)/.exec(prompt)?.[1];
const candidates = [
  process.env.LOOPSTRA_FAKE_FIXTURE,
  sequenced,
  named ? join(here, `${named}.jsonl`) : undefined,
  process.env.LOOPSTRA_FAKE_FIXTURE_DIR && phase ? join(process.env.LOOPSTRA_FAKE_FIXTURE_DIR, `${phase}.jsonl`) : undefined,
  phase ? join(here, `${phase}.jsonl`) : undefined,
  join(here, "simple-success.jsonl"),
].filter((p): p is string => !!p && existsSync(p));
let fixture = candidates[0]!;
const resumeAt = args.indexOf("--resume");
if (fixture.endsWith("notification-only.jsonl") && args[resumeAt + 1] === "notified-session") fixture = join(here, "simple-success.jsonl");
// Asked again on the same session (no fixture name in the nudge), "no-envelope" returns its structured output.
if (resumeAt >= 0 && args[resumeAt + 1] === "no-envelope-session") fixture = join(here, "simple-success.jsonl");
if (resumeAt >= 0 && args[resumeAt + 1] === "no-envelope-forever") fixture = join(here, "no-envelope-forever.jsonl");
if (resumeAt >= 0 && args[resumeAt + 1] === "no-envelope-stuck") fixture = join(here, "hang.jsonl");

if (fixture.endsWith("hang.jsonl")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "hang-session" }));
  await new Promise(() => {});
}

// Like the real CLI (2.1.x) when a resumed session no longer exists: an error result on stdout,
// the reason on stderr, exit 1.
if (resumeAt >= 0 && args[resumeAt + 1] === "missing-session") {
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "fresh-after-missing", total_cost_usd: 0, usage: {} }));
  console.error("No conversation found with session ID: missing-session");
  process.exit(1);
}

// "linger": emit the result, then keep running with a grandchild that holds stdout open,
// the way a real session can leave a background process behind.
const linger = fixture.endsWith("linger.jsonl");

let failed = false;
for (const line of (await Bun.file(fixture).text()).split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as { type: string; is_error?: boolean; write?: { path: string; content: string }; refuse?: string; code?: number; stderr?: string };
  if (e.type === "fake_action" && e.refuse) {
    if (process.env.LOOPSTRA_PROTECTED_LOG) appendFileSync(process.env.LOOPSTRA_PROTECTED_LOG, `${e.refuse}\n`);
    continue;
  }
  if (e.type === "fake_action" && e.write) {
    const target = join(process.cwd(), e.write.path);
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, e.write.content);
    continue;
  }
  if (e.type === "fake_exit") {
    if (e.stderr) console.error(e.stderr);
    process.exit(e.code ?? 1);
  }
  if (e.type === "result" && e.is_error) failed = true;
  console.log(line);
}
if (linger) {
  Bun.spawn({ cmd: [process.execPath, "-e", "await Bun.sleep(600000)"], stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  await new Promise(() => {});
}
process.exit(failed ? 1 : 0);
