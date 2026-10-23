#!/usr/bin/env bun
// Fake `claude` executable: replays a stream-json fixture. Never calls the network.
// Fixture selection, in order: $LOOPSTRA_FAKE_FIXTURE, "FIXTURE:<name>" in the prompt,
// $LOOPSTRA_FAKE_FIXTURE_DIR/<$LOOPSTRA_PHASE>.jsonl, fixtures/<$LOOPSTRA_PHASE>.jsonl, fixtures/simple-success.jsonl.
// A fixture line {"type":"fake_action","write":{"path":"...","content":"..."}} writes a file
// under the current directory before the remaining lines are emitted, so a fake "build" can change code.
// An absolute path is written as it is (a person changing loopstra/config.yaml while a session runs, say).
// A fixture line {"type":"fake_action","wait_for":"<absolute path>"} holds the session until that file exists,
// so a test decides when it ends (judging what happens meanwhile by order, not by time).
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
// each prompt as one JSON line ({phase, args, prompt, cwd}).
// One model (the --model argument): before everything above, $LOOPSTRA_FAKE_FIXTURE_DIR/<phase>@<model>-<n>.jsonl
// (counted per model in <dir>/.count-<phase>@<model>), then <phase>@<model>.jsonl. Two sessions of one phase
// that start together race on the plain sequence's counter, so a test that runs both judges uses these.
// One change: when $LOOPSTRA_FAKE_FIXTURE_DIR/<$LOOPSTRA_SLUG>/ exists, every sequence and <phase>.jsonl above is
// looked up (and counted) in that folder instead, with the shared <phase>.jsonl as a fallback, so sessions of
// one phase in two changes that run at the same time each get their own fixtures.
// Like the real CLI, the process exits 1 after a result event with is_error.
// $LOOPSTRA_FAKE_DELAY_MS, when set, makes every session take at least that long (to see sessions overlap);
// as "<phase>=<ms>,..." only those phases' sessions, and as "<phase>@<model>=<ms>" only that phase on that model.
// Stream mode (--input-format stream-json), like the real CLI: stdin is read as lines while the session runs,
// and its first user message is the prompt (used for everything the whole stdin is used for above). With
// --replay-user-messages every user message taken is echoed ({"type":"user","isReplay":true,...}, with the
// fixture's first session id); the prompt first, as its turn starts. The first turn plays the fixture. A message
// that arrives while a turn plays (before its result is printed) is taken by that turn; one that arrives after
// is queued, and once the turn has ended it gets a turn of its own (the same fixture again, without the delay).
// $LOOPSTRA_FAKE_STEER_LOG, when set, gets one line per message taken ({phase, text, turn, at: "mid" | "queued"}).
// A turn that took messages says so in its result's summary ("heard: <texts joined by ' | '>"), and each
// result's total_cost_usd is the fixture's times the turn number (a running total, as the CLI reports). Once
// stdin closes the fake ends, after its turn and one for each message already queued. "hang" never ends, but
// still echoes and logs what it is sent; a session that answers only notifications ends after its turn.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const args = Bun.argv.slice(2);
const phase = process.env.LOOPSTRA_PHASE ?? "";
const inputAt = args.indexOf("--input-format");
const streaming = inputAt >= 0 && args[inputAt + 1] === "stream-json";
const replay = args.includes("--replay-user-messages");

// Stream mode's input: the messages not yet taken, whether stdin has ended, and the wait for either.
const queue: string[] = [];
let ended = false;
let wake: () => void = () => {};
/** Set while a turn plays: a message that arrives then is taken by that turn. */
let takeMidTurn: ((text: string) => void) | null = null;

/** A user message's text: its content is a string, or parts of which the text ones count. */
function userText(e: { message?: { content?: unknown } }): string {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: unknown }) => (typeof p.text === "string" ? p.text : "")).join("");
}

/** Reads stdin line by line as it comes; each user message is taken by the running turn, or queued. */
async function readInput(): Promise<void> {
  const dec = new TextDecoder();
  let buffer = "";
  const take = (line: string) => {
    if (!line.trim()) return;
    let e: { type?: string; message?: { content?: unknown } };
    try { e = JSON.parse(line); } catch { return; }
    if (e.type !== "user") return;
    const text = userText(e);
    if (takeMidTurn) takeMidTurn(text);
    else { queue.push(text); wake(); }
  };
  try {
    for await (const chunk of Bun.stdin.stream()) {
      buffer += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) { take(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
    }
    take(buffer);
  } catch { /* stdin broke: as good as closed */ }
  ended = true;
  wake();
}

/** Waits until a message is queued or stdin has ended. */
async function nextInput(): Promise<void> {
  while (!queue.length && !ended) await new Promise<void>((resolve) => { wake = resolve; });
}

let prompt: string;
if (streaming) {
  void readInput();
  await nextInput();
  prompt = queue.shift() ?? "";
} else {
  prompt = await Bun.stdin.text();
}

if (process.env.LOOPSTRA_FAKE_ARGS) {
  await Bun.write(process.env.LOOPSTRA_FAKE_ARGS, JSON.stringify({ args, prompt, cwd: process.cwd(), env: {
    LOOPSTRA_PHASE: phase || null,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null,
    LOOPSTRA_BASE: process.env.LOOPSTRA_BASE ?? null,
    LOOPSTRA_SLOT: process.env.LOOPSTRA_SLOT ?? null,
    LOOPSTRA_PROTECTED_LOG: process.env.LOOPSTRA_PROTECTED_LOG ?? null,
    GIT_OPTIONAL_LOCKS: process.env.GIT_OPTIONAL_LOCKS ?? null,
  } }));
}
if (process.env.LOOPSTRA_FAKE_CALLS) appendFileSync(process.env.LOOPSTRA_FAKE_CALLS, JSON.stringify(args) + "\n");

if (process.env.LOOPSTRA_FAKE_PROMPTS) appendFileSync(process.env.LOOPSTRA_FAKE_PROMPTS, JSON.stringify({ phase, args, prompt, cwd: process.cwd() }) + "\n");

/** Counts one more call of `name` in <dir>/.count-<name> and gives the count. */
async function nextCall(dir: string, name: string): Promise<number> {
  const countPath = join(dir, `.count-${name}`);
  const n = (existsSync(countPath) ? Number(await Bun.file(countPath).text()) : 0) + 1;
  await Bun.write(countPath, String(n));
  return n;
}

const modelAt = args.indexOf("--model");
const model = modelAt >= 0 ? args[modelAt + 1] : undefined;
let sequenced: string | undefined;
let modelSequenced: string | undefined;
let modelFixture: string | undefined;
const sharedDir = process.env.LOOPSTRA_FAKE_FIXTURE_DIR;
const slug = process.env.LOOPSTRA_SLUG;
// One change's own folder, when there is one, takes the shared folder's place for the sequences.
const slugDir = sharedDir && slug ? join(sharedDir, slug) : undefined;
const fixtureDir = slugDir && existsSync(slugDir) ? slugDir : sharedDir;
if (fixtureDir && phase) {
  sequenced = join(fixtureDir, `${phase}-${await nextCall(fixtureDir, phase)}.jsonl`);
  if (model) {
    modelSequenced = join(fixtureDir, `${phase}@${model}-${await nextCall(fixtureDir, `${phase}@${model}`)}.jsonl`);
    modelFixture = join(fixtureDir, `${phase}@${model}.jsonl`);
  }
}

const here = join(dirname(Bun.main), "fixtures");
const named = /FIXTURE:([a-z0-9-]+)/.exec(prompt)?.[1];
const candidates = [
  modelSequenced,
  modelFixture,
  process.env.LOOPSTRA_FAKE_FIXTURE,
  sequenced,
  named ? join(here, `${named}.jsonl`) : undefined,
  fixtureDir && phase ? join(fixtureDir, `${phase}.jsonl`) : undefined,
  sharedDir && phase ? join(sharedDir, `${phase}.jsonl`) : undefined,
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

const fixtureText = await Bun.file(fixture).text();
// The session id stream mode's echoes carry: the fixture's first.
const sessionId = fixtureText.split("\n").map((l) => /"session_id":"([^"]*)"/.exec(l)?.[1]).find(Boolean) ?? "fake-session";

/** Echoes a user message the session takes (stream mode, with --replay-user-messages). */
function echo(text: string): void {
  if (streaming && replay) console.log(JSON.stringify({ type: "user", isReplay: true, session_id: sessionId, message: { role: "user", content: [{ type: "text", text }] } }));
}

/** Records a message the session took in $LOOPSTRA_FAKE_STEER_LOG. */
function logSteer(text: string, turn: number, at: "mid" | "queued"): void {
  if (process.env.LOOPSTRA_FAKE_STEER_LOG) appendFileSync(process.env.LOOPSTRA_FAKE_STEER_LOG, JSON.stringify({ phase, text, turn, at }) + "\n");
}

/** From now until the turn's result, a message that arrives is taken by turn `turn` and added to `heard`. */
function takeDuring(turn: number, heard: string[]): void {
  if (streaming) takeMidTurn = (text) => { echo(text); logSteer(text, turn, "mid"); heard.push(text); };
}

if (fixture.endsWith("hang.jsonl")) {
  echo(prompt);
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "hang-session" }));
  // In stream mode it still takes what it is sent, so a test can deliver to a session that is waiting.
  takeDuring(1, []);
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

const delay = process.env.LOOPSTRA_FAKE_DELAY_MS ?? "";
const delays = delay.split(",").map((d) => d.split("="));
const delayMs = delay.includes("=") ? (delays.find(([p]) => p === `${phase}@${model}`) ?? delays.find(([p]) => p === phase))?.[1] : delay;

let failed = false;

/**
 * Plays the fixture's lines once, as turn `turn` (from 1) that has taken `heard`. In stream mode the turn takes
 * messages until its result is printed, and that result is rewritten (see the header).
 */
async function playTurn(turn: number, heard: string[]): Promise<void> {
  takeDuring(turn, heard);
  for (const line of fixtureText.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as {
      type: string; is_error?: boolean; write?: { path: string; content: string }; refuse?: string; wait_for?: string; code?: number; stderr?: string;
      total_cost_usd?: number; structured_output?: { summary?: unknown }; origin?: { kind?: unknown };
    };
    if (e.type === "fake_action" && e.wait_for) {
      while (!existsSync(e.wait_for)) await Bun.sleep(50);
      continue;
    }
    if (e.type === "fake_action" && e.refuse) {
      if (process.env.LOOPSTRA_PROTECTED_LOG) appendFileSync(process.env.LOOPSTRA_PROTECTED_LOG, `${e.refuse}\n`);
      continue;
    }
    if (e.type === "fake_action" && e.write) {
      const target = isAbsolute(e.write.path) ? e.write.path : join(process.cwd(), e.write.path);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, e.write.content);
      continue;
    }
    if (e.type === "fake_exit") {
      if (e.stderr) console.error(e.stderr);
      process.exit(e.code ?? 1);
    }
    if (e.type === "result" && e.is_error) failed = true;
    if (streaming && e.type === "result" && e.origin?.kind !== "task-notification") {
      // The turn ends with its result: a message that comes later waits for a turn of its own.
      takeMidTurn = null;
      if (typeof e.total_cost_usd === "number") e.total_cost_usd = Math.round(e.total_cost_usd * turn * 1e6) / 1e6;
      if (heard.length && e.structured_output && "summary" in e.structured_output) e.structured_output.summary = `heard: ${heard.join(" | ")}`;
      console.log(JSON.stringify(e));
      continue;
    }
    console.log(line);
  }
  takeMidTurn = null;
}

// The first turn: the prompt is taken as it starts, so a message during the delay is taken by it too.
const firstHeard: string[] = [];
echo(prompt);
takeDuring(1, firstHeard);
if (delayMs) await Bun.sleep(Number(delayMs));
await playTurn(1, firstHeard);

// A session that answered only notifications ends without reading the prompt, in stream mode too.
const answersPrompt = fixtureText.split("\n").some((l) => l.includes('"type":"result"') && !l.includes('"task-notification"'));
if (streaming && answersPrompt && !linger) {
  for (let turn = 2; ; turn++) {
    await nextInput();
    const text = queue.shift();
    if (text === undefined) break; // stdin has ended, and nothing is left to take
    echo(text);
    logSteer(text, turn, "queued");
    await playTurn(turn, [text]);
  }
}
if (linger) {
  Bun.spawn({ cmd: [process.execPath, "-e", "await Bun.sleep(600000)"], stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  await new Promise(() => {});
}
process.exit(failed ? 1 : 0);
