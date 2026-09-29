#!/usr/bin/env bun
// Fake `claude` executable: replays a stream-json fixture. Never calls the network.
// Fixture selection, in order: $LOOPSTRA_FAKE_FIXTURE, "FIXTURE:<name>" in the prompt,
// $LOOPSTRA_FAKE_FIXTURE_DIR/<$LOOPSTRA_PHASE>.jsonl, fixtures/<$LOOPSTRA_PHASE>.jsonl, fixtures/simple-success.jsonl.
// A fixture line {"type":"fake_action","write":{"path":"...","content":"..."}} writes a file
// under the current directory before the remaining lines are emitted, so a fake "build" can change code.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Bun.argv.slice(2);
const prompt = await Bun.stdin.text();
const phase = process.env.LOOPSTRA_PHASE ?? "";

if (process.env.LOOPSTRA_FAKE_ARGS) {
  await Bun.write(process.env.LOOPSTRA_FAKE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { LOOPSTRA_PHASE: phase || null } }));
}

const here = join(dirname(Bun.main), "fixtures");
const named = /FIXTURE:([a-z0-9-]+)/.exec(prompt)?.[1];
const candidates = [
  process.env.LOOPSTRA_FAKE_FIXTURE,
  named ? join(here, `${named}.jsonl`) : undefined,
  process.env.LOOPSTRA_FAKE_FIXTURE_DIR && phase ? join(process.env.LOOPSTRA_FAKE_FIXTURE_DIR, `${phase}.jsonl`) : undefined,
  phase ? join(here, `${phase}.jsonl`) : undefined,
  join(here, "simple-success.jsonl"),
].filter((p): p is string => !!p && existsSync(p));
const fixture = candidates[0]!;

if (fixture.endsWith("hang.jsonl")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "hang-session" }));
  await new Promise(() => {});
}

// Like the real CLI when a resumed session no longer exists: an error on stderr, no result.
const resumeAt = args.indexOf("--resume");
if (resumeAt >= 0 && args[resumeAt + 1] === "missing-session") {
  console.error("No conversation found with session ID: missing-session");
  process.exit(1);
}

// "linger": emit the result, then keep running with a grandchild that holds stdout open,
// the way a real session can leave a background process behind.
const linger = fixture.endsWith("linger.jsonl");

for (const line of (await Bun.file(fixture).text()).split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as { type: string; write?: { path: string; content: string } };
  if (e.type === "fake_action" && e.write) {
    const target = join(process.cwd(), e.write.path);
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, e.write.content);
    continue;
  }
  console.log(line);
}
if (linger) {
  Bun.spawn({ cmd: [process.execPath, "-e", "await Bun.sleep(600000)"], stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  await new Promise(() => {});
}
process.exit(0);
