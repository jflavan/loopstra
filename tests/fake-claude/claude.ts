#!/usr/bin/env bun
// Fake `claude` executable: replays a stream-json fixture. Never calls the network.
import { join, dirname } from "node:path";

const args = Bun.argv.slice(2);
const prompt = await Bun.stdin.text();

if (process.env.LOOPSTRA_FAKE_ARGS) {
  await Bun.write(process.env.LOOPSTRA_FAKE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { LOOPSTRA_PHASE: process.env.LOOPSTRA_PHASE ?? null } }));
}

const named = /FIXTURE:([a-z0-9-]+)/.exec(prompt)?.[1];
const fixture = process.env.LOOPSTRA_FAKE_FIXTURE ?? join(dirname(Bun.main), "fixtures", `${named ?? "simple-success"}.jsonl`);

if (fixture.endsWith("hang.jsonl")) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "hang-session" }));
  await new Promise(() => {});
}

const text = await Bun.file(fixture).text();
for (const line of text.split("\n")) {
  if (line.trim()) console.log(line);
}
process.exit(0);
