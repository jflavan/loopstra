# Console Part 3 (Steering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person steer running agents (send a message, redirect, or stop a session), let agents ask a person a question and wait for the answer, and keep one readable record per change of what people told its agents (`intent/<slug>/conversation.md`).

**Architecture:**
- **Live input.** Every loop agent session runs with `--input-format stream-json --replay-user-messages`, with stdin kept open. The runner watches `.loopstra/runs/<slug>/inbox/` for messages, stops and redirects addressed to the running session, and writes messages to stdin. The CLI echoes each message it takes up, so the runner knows which result answers it.
- **Questions.** An agent asks through an optional `question` in its envelope. The step ends, the change waits with `question: open` (the scheduler skips it), and the answer resumes the asking session.
- **The record.** Everything people say, and every question, goes into `conversation.md` through `commitRecord`. Every work session's prompt includes it as `{{conversation}}`.

**Tech Stack:** Bun 1.4, TypeScript, zod, the Claude Code CLI 2.1.302 (stream-json in and out), Preact (the console page), bun:test with the fake `claude` in `tests/fake-claude/claude.ts`.

**Spec:** `docs/superpowers/specs/2026-10-17-console-design.md`, "Part 3: Steering". Parts 1 and 2 are merged (PRs #32, #33).

**Worktree:** `C:\Source\Repos\loopstra-steering`, branch `feat/console-steering` from `main` (424dd86). Run everything from that folder.

**Machine notes:**
- There is no usable Python (`python3` is the Microsoft Store stub and hangs forever). Never run python; use bun.
- Tests:
  - `bun test --timeout 30000 <file>` (stage tests need the 30 s timeout);
  - `bun run test` for everything (4 shards, about 3 minutes);
  - `bun run typecheck`.
- CI runs Windows, macOS and Linux, and the Windows runner is slow: timing tests must use long fake sessions, wait for a condition rather than a fixed delay, and give heavy tests 90 s.

---

## The spike (done while planning, 2026-10-17, CLI 2.1.302, haiku, about $0.06)

The script is `C:\Users\flava\AppData\Local\Temp\claude\C--Source-Repos-loopstra\4c50ced1-cea9-4a27-955c-1c458c9a6914\scratchpad\spike\spike2.ts`.

1. **Does the session wait after its result, and exit when stdin closes?** Yes. After a result it waits for more input; closing stdin ends it (exit 0).
2. **A message written while a turn runs?** Written during a tool call, it is taken in at the next tool boundary and answered by that same turn's result (the answer changed from APPLE to BANANA). Written after the last tool call, it is not in that turn: it is queued and answered by a turn of its own after the result. It is still taken even if stdin is closed right after that result.
3. **Does `--json-schema` structured output arrive on the result of each turn?** Yes. Every result has its own `structured_output`.
4. **Do `--resume` and stream-json input work together?** Yes. The session keeps its id and remembers what came before.
5. **Is `total_cost_usd` the session's total or that turn's?** It is the process's running total: 0.0051, then 0.0057 after a second turn. A resumed session is a new process with its own total, as `runPhase` already assumes for its resends.
6. **(added) How does the runner know which result answers a message?** With `--replay-user-messages`, the CLI echoes every user message it takes up, as a `user` event with `isReplay: true`, at the moment it takes it. A mid-turn message is echoed before that turn's result; a queued one only after the result, as the start of its own turn. So the rule is:
   - Count the messages written, and the replays after the first (the first replay is the prompt itself).
   - At each result: if a message has been written but not yet echoed, keep reading; its own turn and result follow.
   - Otherwise close stdin: that result is the phase's result.

---

## Decisions made while planning (Task 19 records them in docs/decisions.md)

1. **Live input only for the loop's agent phases.** The probe and chat keep the plain `-p` input they have.
2. **A message counts as delivered once it is written to stdin.** The inbox file then moves to `inbox/delivered/` and a `steer` event is traced. The CLI's echo decides only which result is the phase's (spike 6).
3. **Which sessions can be messaged and redirected:** `intake`, `design`, `plan`, `build`, `fix`, `reconcile`, `revise`, `lessons` (STEERABLE). Any running session can be stopped. Messages wrapped by the runner start with fixed words (MESSAGE_LEAD, REDIRECT_LEAD), so the console's transcript shows those echoes as `message` items and hides the prompt's echo.
4. **Stop session** throws `SessionStopped(by)`.
   - The phase ends `interrupted` with "stopped by <name>". The step ends quietly; the change keeps its status, like a stop request.
   - The console sends the stop to the inbox and a `hold` request together, so the change does not start again.
   - `passOn` and `runStepGuarded` let it through.
5. **Redirect** kills the running process and resumes the same session with `--resume <id>`, the redirect as its prompt. It stays in the same phase row and the same `raw.jsonl`. What the killed process spent (its newest result's total, else an estimate by time) counts toward the cap, as resends do.
6. **conversation.md**
   - It is written by the loop only, through `commitRecord`, by `src/conversation.ts`. Entries record messages, redirects, questions, answers, send-back notes (part 2's applier now writes one) and messages that came too late ("for the next session").
   - Every phase's prompt gets `{{conversation}}`. When a work phase's repository prompt has no `{{conversation}}` and the record is not empty, the record is appended to the prompt, the way part 2 appends the sent-back note (the spec said such prompts would not see it; appending is kinder and costs nothing).
7. **Questions**
   - `design`, `plan`, `build`, `fix`, `reconcile` and `revise` gain an optional `question: { text, why, options? }`.
   - `intake` keeps its `question` string (non-empty asks), so its fixtures and prompt keep working; its question now asks instead of blocking.
   - A question asked by work running beside a judge (the plan written ahead) is not recorded; that result is just not used.
   - The asking session's id, the phase, the question and the step's question count live in `.loopstra/runs/<slug>/question.json`; `question: open` is in the frontmatter.
8. **Answering resumes the session.**
   - An `answer` request (console or chat) writes the answer into conversation.md and question.json, and removes `question:`.
   - On the change's next step, the first session of the phase that asked resumes the asking session with "<name> answered your question: <answer>. Carry on.". A session that cannot be resumed (`no-session`) starts fresh; conversation.md carries the question and the answer.
   - At most 3 questions per step, counted per status. With 3 asked, the prompt says no more may be asked; a 4th blocks the change.
9. **Chat.**
   - Questions are announced through the attention list (a new `question` kind), which the announcer already posts.
   - The orchestrator proposes an `answer` action; a person's reply in an announcement thread is an ordinary message, from which it can propose one.
   - The spec's "a reply in the announcement's thread from someone on acceptors" answering directly is left out: it would need thread ids per announcement on every transport.
10. **The orchestrator as the helper.** The drawer posts `about: { slug, seq? }` with the first message. The orchestrator's context then gets that change's intent, conversation.md, note, newest phase error, and the session's last 50 transcript items as text (each part cut to a few thousand characters).

## File map

| File | What it does |
|---|---|
| `tests/fake-claude/claude.ts` (modify) | reads stream-json stdin, echoes messages, runs one turn per message, a question fixture |
| `src/shell.ts` (modify) | `spawnBounded` can keep stdin open and hand out a writer |
| `src/claude.ts` (modify) | `runPhase` live mode: stream-json in, replay counting, message, stop, redirect |
| `src/stop.ts` (modify) | `SessionStopped`, `QuestionAsked`; `endsStepQuietly` |
| `src/conversation.ts` (create) | reading and appending `intent/<slug>/conversation.md` |
| `src/inbox.ts` (create) | `.loopstra/runs/<slug>/inbox/`: write, read for a seq, mark delivered, sweep leftovers |
| `src/questions.ts` (create) | `question.json`: record, answer, the answer prompt, the per-step count |
| `src/phases.ts` (modify) | live sessions for agent phases, delivery from the inbox, questions, `{{conversation}}` |
| `src/sessions.ts` (modify) | a stopped session ends `interrupted` with who stopped it |
| `src/envelopes.ts`, `src/prompts.ts`, `templates/prompts/*.md` (modify) | the `question` field, `{{conversation}}`, the asking rules |
| `src/intents.ts` (modify) | `question:` frontmatter; queue.md shows it |
| `src/scheduler.ts`, `src/context.ts` (modify) | skip a change with an open question; quiet step results; sweep the inbox at the step's start |
| `src/stages/design.ts` (modify) | intake's question asks instead of blocking |
| `src/attention.ts`, `src/trace.ts` (modify) | "Has a question"; phase status `asked`; event `steer` |
| `src/actions.ts`, `src/requests.ts`, `src/apply.ts` (modify) | the `answer` request; send back writes conversation.md |
| `src/console/*` (modify), `src/console/steer.ts` (create) | question and steerable in the model; message items in transcripts; the session message route; stop a change |
| `src/ui/*` (modify) | the session page's message box; Answer and Stop in the controls; badges |
| `src/chat/*` (modify) | the `answer` action; `about` context from the drawer |
| docs (modify) | README Steering section, intent-README, SKILL.md, decisions.md, the spec's Built note |

---
### Task 1: the fake `claude` speaks stream-json input

The fake must behave like the spike's CLI so every later test can run against it.

**Files:**
- Modify: `tests/fake-claude/claude.ts`
- Test: `tests/unit/fake-claude.test.ts`

**Behaviour to add** (only when the args include `--input-format stream-json`; without it nothing changes):
- stdin is read as lines, as they come. The first `{"type":"user",...}` line's text is the prompt: it is used for fixture selection (`FIXTURE:<name>`), `LOOPSTRA_FAKE_PROMPTS` and `LOOPSTRA_FAKE_ARGS`, exactly as the whole stdin is today.
- With `--replay-user-messages`, each user message the fake takes up is echoed on stdout when it is taken, as `{"type":"user","isReplay":true,"session_id":<id>,"message":{"role":"user","content":[{"type":"text","text":<text>}]}}`. The prompt is echoed first, as the turn starts. `<id>` is the session id of the fixture's first line that has one (or "fake-session").
- **Turns.** The first turn plays the fixture as today (delay, fake_actions, lines).
  - A user message that arrives while a turn plays (before its result line is printed) is taken mid-turn: it is echoed at once and appended to `$LOOPSTRA_FAKE_STEER_LOG` (one JSON line `{ phase, text, turn, at: "mid" }`) when that is set.
  - A message that arrives after a turn's result is queued. Once the turn has ended, each queued message is echoed and gets a turn of its own: the same fixture again, logged with `at: "queued"`.
- **The result line of a turn** is printed with:
  - `total_cost_usd` = the fixture's value × the turn number (a running total);
  - when the turn took messages, the `structured_output.summary` (if the output has one) replaced by `heard: <the messages' texts joined by " | ">`. That is how a test sees which result answered a message.
- stdin closing ends the fake once its current turn (and any turn for a message already queued) has ended, with exit code 0 (1 after an `is_error` result, as now).
- `hang.jsonl` still prints its init line and never ends. It still echoes and logs messages, so a test can deliver to a session that is waiting.
- A `fake_action` `wait_for` still holds the turn. Messages arriving meanwhile are mid-turn.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fake-claude.test.ts`. Read the file first: it has a helper that spawns the fake. Write a new helper that spawns it with `--input-format stream-json --replay-user-messages` and a pipe for stdin, reads stdout lines as they come, and lets the test write lines.

```ts
describe("stream-json input", () => {
  const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

  async function live(env: Record<string, string>, extraArgs: string[] = []) {
    const p = Bun.spawn({
      cmd: [process.execPath, FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--replay-user-messages", "--output-format", "stream-json", ...extraArgs],
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
    });
    const lines: Array<Record<string, unknown>> = [];
    const reading = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of p.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lines.push(JSON.parse(l)); }
      }
    })();
    return {
      send: (t: string) => { p.stdin.write(user(t)); p.stdin.flush(); },
      close: () => p.stdin.end(),
      lines,
      done: async () => { const code = await p.exited; await reading; return code; },
    };
  }
  const results = (ls: Array<Record<string, unknown>>) => ls.filter((l) => l.type === "result") as Array<{ total_cost_usd: number; structured_output: { summary?: string } }>;
  const replays = (ls: Array<Record<string, unknown>>) => ls.filter((l) => l.type === "user" && l.isReplay).map((l) => ((l.message as { content: Array<{ text: string }> }).content[0]!.text));

  test("the prompt is echoed, the fixture plays, and closing stdin ends it", async () => {
    const s = await live({ LOOPSTRA_PHASE: "design" });
    s.send("write the spec");
    await until(() => results(s.lines).length === 1);
    s.close();
    expect(await s.done()).toBe(0);
    expect(replays(s.lines)).toEqual(["write the spec"]);
    expect(results(s.lines)[0]!.structured_output.summary).toBe("spec written");
  });

  test("a message during a turn is answered by that turn; one after its result gets a turn of its own", async () => {
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: `${JSON.stringify({ type: "fake_action", wait_for: gate })}\n${fixture("design")}` });
    try {
      const s = await live({ LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_STEER_LOG: join(t.path, "steer.jsonl") });
      s.send("write the spec");
      await until(() => replays(s.lines).length === 1);
      s.send("cover negatives");
      await until(() => replays(s.lines).length === 2);
      writeFileSync(gate, "");
      await until(() => results(s.lines).length === 1);
      expect(results(s.lines)[0]!.structured_output.summary).toBe("heard: cover negatives");
      s.send("and zero");
      await until(() => results(s.lines).length === 2);
      s.close();
      expect(await s.done()).toBe(0);
      expect(results(s.lines)[1]!.structured_output.summary).toBe("heard: and zero");
      expect(results(s.lines).map((r) => r.total_cost_usd)).toEqual([0.05, 0.1]);
      expect(readFileSync(join(t.path, "steer.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).at)).toEqual(["mid", "queued"]);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  });

  test("hang still never ends, but echoes what it is sent", async () => {
    const s = await live({}, []);
    s.send("FIXTURE:hang");
    await until(() => s.lines.some((l) => l.type === "system"));
    s.send("hello");
    await until(() => replays(s.lines).includes("hello"));
    s.close();
    await Bun.sleep(300);
    expect(results(s.lines)).toEqual([]);
    // still running: kill it
  });
});
```

The hang test must kill the process at the end. Have `live` also return `kill: () => p.kill()`, and call it.

Imports to add: `until` from `../console-helpers`; `fixture`, `fixtureDir`, `FAKE_CLAUDE`, `tempDir` from `../helpers`; `readFileSync`, `writeFileSync` from `node:fs`; `join` from `node:path`. Check the `design.jsonl` fixture's cost (0.05) and summary ("spec written") match what the test expects.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/fake-claude.test.ts -t "stream-json input"`
Expected: FAIL. The fake reads all of stdin before it starts, so it never ends while stdin is open.

- [ ] **Step 3: Implement in `tests/fake-claude/claude.ts`**

Restructure the top: decide the input mode from `args` before reading stdin.

- Plain mode (no `--input-format stream-json`): `const prompt = await Bun.stdin.text();` as today, then the current behaviour unchanged.
- Stream mode:
  1. Start a line reader on `Bun.stdin.stream()` that pushes each parsed user message's text into a queue and resolves waiters. It records EOF.
  2. Await the first message: that is `prompt`. Then run the existing logging and fixture selection.
  3. Wrap the existing emit loop in a `playTurn(fixture, turn, heardSoFar)` function. It sets a flag `inTurn = true` while it runs. Messages that arrive while `inTurn` are echoed at once (when replay is on), logged as `mid` and added to `heard`. When it reaches a `result` line, it rewrites `total_cost_usd` and (when `heard` is not empty) `structured_output.summary` before printing.
  4. After the first turn: loop. While the queue holds messages, take one, echo it, log `queued`, and play a turn with `heard = [text]`. When the queue is empty and stdin has ended, exit (0, or 1 if a result was an error). Otherwise wait for the next message or EOF.
  5. `hang.jsonl` in stream mode: print the init line, then keep echoing and logging every message as `mid`, forever.

Keep every existing comment's meaning. Add a paragraph to the header comment that describes stream mode, `--replay-user-messages`, `$LOOPSTRA_FAKE_STEER_LOG`, the `heard:` summary and the running cost.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/fake-claude.test.ts && bun run typecheck`
Expected: PASS (the old fake-claude tests too); clean.

- [ ] **Step 5: Commit**

```bash
git add tests/fake-claude/claude.ts tests/unit/fake-claude.test.ts
git commit -m "test(fake-claude): stream-json input, echoed messages, a turn per queued message"
```

---

### Task 2: `spawnBounded` can keep stdin open

**Files:**
- Modify: `src/shell.ts`
- Test: `tests/unit/shell.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("stdin kept open: a writer goes to the caller, and what it writes reaches the process", async () => {
  let w: StdinWriter | null = null;
  const lines: string[] = [];
  const script = "for await (const c of Bun.stdin.stream()) process.stdout.write(new TextDecoder().decode(c));";
  const r = await spawnBounded({
    cmd: [process.execPath, "-e", script], timeoutMs: 10_000, onStop: "kill",
    stdin: { open: "first\n" },
    onStdin: (writer) => { w = writer; },
    onLine: (l) => { lines.push(l); if (l === "first") w!.write("second\n"); if (l === "second") { w!.end(); } return false; },
  });
  expect(r.code).toBe(0);
  expect(lines).toEqual(["first", "second"]);
});
```

Import `type StdinWriter` from `../../src/shell`.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/shell.test.ts -t "stdin kept open"`
Expected: FAIL (the type and the option do not exist).

- [ ] **Step 3: Implement**

In `src/shell.ts`:

```ts
/** What a caller writes to a process whose stdin is kept open (see SpawnOptions.stdin). */
export interface StdinWriter {
  /** Writes `text`; false when the process can no longer take it (it ended, or stdin was closed). */
  write(text: string): boolean;
  /** Closes stdin (once). */
  end(): void;
}
```

`SpawnOptions.stdin` becomes `string | { open: string }`, with this doc: "A string is written and stdin closed; `{ open }` is written and stdin left open, its writer handed to `onStdin`". Add `onStdin?: (w: StdinWriter) => void;`.

In `spawnBounded`, replace the stdin block:

```ts
  let closeStdin = () => {};
  if (o.stdin !== undefined) {
    const sink = proc.stdin as Bun.FileSink;
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      try { void Promise.resolve(sink.end()).catch(() => {}); } catch { /* exited already */ }
    };
    const write = (text: string): boolean => {
      if (!open) return false;
      try { sink.write(text); void Promise.resolve(sink.flush()).catch(() => {}); return true; } catch { open = false; return false; }
    };
    closeStdin = end;
    if (typeof o.stdin === "string") { write(o.stdin); end(); }
    else { write(o.stdin.open); o.onStdin?.({ write, end }); }
  }
```

Call `closeStdin()` once reading or the process has ended, before the grace wait (right after the `done` line). That way an open stdin never keeps a finished process waiting.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/shell.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/shell.ts tests/unit/shell.test.ts
git commit -m "feat(shell): a process's stdin can stay open, with a writer for the caller"
```

---

### Task 3: `runPhase` live mode (message, stop, redirect)

**Files:**
- Modify: `src/claude.ts`, `src/stop.ts`
- Test: `tests/unit/claude-run.test.ts`

- [ ] **Step 1: The error a stopped session throws, in `src/stop.ts`**

```ts
/**
 * A person stopped this one session (Stop in the console). Not the step's failure: the phase ends
 * interrupted with who stopped it, the change keeps its status, and the hold sent with the stop keeps
 * it from starting again. Only this step ends; the loop goes on.
 */
export class SessionStopped extends Error {
  constructor(public readonly by: string) {
    super(`stopped by ${by}`);
    this.name = "SessionStopped";
  }
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/claude-run.test.ts` (read its helpers first; it calls `runPhase` with `executable: FAKE_CLAUDE`):

```ts
describe("live sessions", () => {
  const base = (cwd: string) => ({ cwd, schema: {}, model: "haiku", permissionMode: "default" as const, allowedTools: [], timeoutMs: 60_000, executable: FAKE_CLAUDE });

  test("a message written while the turn runs is answered by its result; the session then ends", async () => {
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: `${JSON.stringify({ type: "fake_action", wait_for: gate })}\n${fixture("design")}` });
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({ ...base(t.path), prompt: "write it", env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, live: { attach: (c) => { ctl = c; return () => {}; } } });
      await until(() => ctl !== null);
      await until(() => ctl!.message("cover negatives"));
      writeFileSync(gate, "");
      const r = await run;
      expect(r.ok).toBe(true);
      expect((r.structuredOutput as { summary: string }).summary).toBe("heard: cover negatives");
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  });

  test("a message that came after the result keeps the session for the turn that answers it, and that result counts", async () => {
    const t = tempDir();
    const fixtures = fixtureDir({ design: fixture("design") });
    const log = join(t.path, "steer.jsonl");
    try {
      let ctl: SessionControl | null = null;
      let sent = false;
      // Written from the result event itself: after the turn ended, before the runner decides it is final.
      const run = runPhase({
        ...base(t.path), prompt: "write it", env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_STEER_LOG: log },
        live: { attach: (c) => { ctl = c; return () => {}; } },
        onEvent: (e) => { if (e.type === "result" && !sent) { sent = true; ctl!.message("and zero"); } },
      });
      const r = await run;
      expect(readFileSync(log, "utf8")).toContain("\"queued\"");
      expect((r.structuredOutput as { summary: string }).summary).toBe("heard: and zero");
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  });

  test("stop ends the session and throws SessionStopped", async () => {
    const t = tempDir();
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({ ...base(t.path), prompt: "FIXTURE:hang", live: { attach: (c) => { ctl = c; return () => {}; } } });
      await until(() => ctl !== null);
      ctl!.stop("John");
      await expect(run).rejects.toBeInstanceOf(SessionStopped);
    } finally {
      t.cleanup();
    }
  });

  test("redirect ends the process and resumes the same session with the new direction; the earlier cost carries over", async () => {
    const t = tempDir();
    const calls = join(t.path, "calls.jsonl");
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: `${JSON.stringify({ type: "fake_action", wait_for: gate })}\n${fixture("design")}` });
    try {
      let ctl: SessionControl | null = null;
      const run = runPhase({ ...base(t.path), prompt: "write it", maxBudgetUsd: 5, env: { LOOPSTRA_PHASE: "design", LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls }, live: { attach: (c) => { ctl = c; return () => {}; } } });
      await until(() => ctl !== null);
      await until(() => ctl!.redirect("do it the other way"));
      writeFileSync(gate, "");
      const r = await run;
      expect(r.ok).toBe(true);
      const args = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
      expect(args).toHaveLength(2);
      expect(args[1]).toContain("--resume");
      expect(args[1][args[1].indexOf("--resume") + 1]).toBe("fake-design");
      // The killed process reported no cost: it is estimated, so the total is above the last process's 0.05.
      expect(r.costUsd).toBeGreaterThan(0.05);
    } finally {
      fixtures.cleanup(); t.cleanup();
    }
  });

  test("a live session passes --input-format stream-json and --replay-user-messages", async () => {
    // Read the args through LOOPSTRA_FAKE_ARGS, as the file's other arg tests do.
  });
});
```

Complete the last test the way the file's existing args tests read `LOOPSTRA_FAKE_ARGS`. Imports: `SessionStopped` from `../../src/stop`; `type SessionControl` from `../../src/claude`; `until` from `../console-helpers`; `fixture`, `fixtureDir`, `tempDir` from `../helpers`; `readFileSync`, `writeFileSync` from `node:fs`; `join` from `node:path`.

For the redirect test, the session id must be known before `redirect` returns true: the fixture's init line has `session_id: "fake-design"`, and the fake prints it when the first turn starts. The `wait_for` line comes before it in this fixture, though, so print the init first: put the `wait_for` line after the fixture's first (init) line instead of before it, in the redirect test and wherever a test needs the id. The fake's own replay of the prompt also carries the id.

- [ ] **Step 3: Run them to see them fail**

Run: `bun test --timeout 30000 tests/unit/claude-run.test.ts -t "live sessions"`
Expected: FAIL.

- [ ] **Step 4: Implement in `src/claude.ts`**

```ts
/** What the runner of a live session may do to it while it runs (see RunPhaseInput.live). */
export interface SessionControl {
  /** Writes a message to the running session; false while no process can take one (a redirect is resuming it, or it has ended). */
  message(text: string): boolean;
  /** Ends the session now; runPhase then throws SessionStopped. */
  stop(by: string): void;
  /** Ends the running process and resumes the session at once with `text` as its prompt; false until the session has an id. */
  redirect(text: string): boolean;
}

/** A user message as one stream-json input line. */
export function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}
```

`RunPhaseInput` gains:

```ts
  /**
   * A live session: stream-json input, kept open, with every message echoed back (see the spike in
   * docs/decisions.md). `attach` gets the control once the session runs, and gives back what ends its watching.
   */
  live?: { attach: (ctl: SessionControl) => () => void };
```

In `runPhase`:
- When `input.live`, add `"--input-format", "stream-json", "--replay-user-messages"` to `args`.
- Per process (each turn of the `for` loop), keep:
  - `written` (messages written to this process);
  - `replays` (user events with `isReplay: true` seen from it);
  - `writer: StdinWriter | null`;
  - `kill = new AbortController()`.
- Pass `signal: input.signal ? AbortSignal.any([input.signal, kill.signal]) : kill.signal`, and with live: `stdin: { open: userLine(stdin) }, onStdin: (w) => { writer = w; }`. Without live: `stdin` as today.
- `onLine`:
  1. `const e = collector.push(line)`, then `onEvent` as today.
  2. If `e?.type === "user" && e.isReplay === true`, then `replays++`.
  3. At a result that is not a notification's:
     - when live and `written > replays - 1`, a message has not been taken yet: return false and keep reading;
     - otherwise `writer?.end()` and return true.
- The control. Create it once, before the loop, and call `input.live?.attach(control)`; call the returned function in a `finally` around the whole run.
  - `message(text)`: if `writer` is set and `writer.write(userLine(text))`, then `written++` and return true. Otherwise return false.
  - `stop(by)`: set `stoppedBy = by; kill.abort();`.
  - `redirect(text)`: if `collector`'s session id (or the id seen so far) is null, return false. Otherwise set `redirectTo = text; kill.abort();` and return true.
- After `spawnBounded` returns:
  1. If `stoppedBy` is set, throw `new SessionStopped(stoppedBy)` before anything else.
  2. If `r.cancelled && redirectTo !== null`:
     - add what this process cost to `earlierCostUsd`: its newest result's `total_cost_usd` when it gave one, else an estimate by time, `USD_PER_MINUTE * minutes this process ran` (import `USD_PER_MINUTE` from `./budget`);
     - set `resume` to the session id, `stdin = redirectTo`, `redirectTo = null`, and `collector = new StreamCollector()`;
     - break off if `budgetArgs(earlierCostUsd) === null`;
     - `continue` without counting a resend.
  3. Otherwise, as today.
- The existing resends (nudge, notification) keep working in live mode. Their `stdin` text is sent as the first user line of the new process.
- Expose for tests and the console: `export const MESSAGE_LEAD = "A message from"` and `export const REDIRECT_LEAD = "A change of direction from"`. They are used by Task 7.

Update the doc comment of `runPhase` with one sentence on live sessions.

- [ ] **Step 5: Run the tests**

Run: `bun test --timeout 30000 tests/unit/claude-run.test.ts && bun run typecheck`
Expected: PASS, including every existing test; clean.

- [ ] **Step 6: Commit**

```bash
git add src/claude.ts src/stop.ts tests/unit/claude-run.test.ts
git commit -m "feat(claude): live sessions take messages, a stop and a redirect while they run"
```

---

### Task 4: quiet ends of a step (a stopped session, a question asked)

**Files:**
- Modify: `src/stop.ts`, `src/git.ts` (`passOn`), `src/sessions.ts`, `src/context.ts` (`StepResult`), `src/scheduler.ts` (`runStepGuarded`, `stepText`), `src/trace.ts` (phase status `asked`, event type `steer`)
- Test: `tests/unit/sessions.test.ts`, `tests/integration/scheduler.test.ts`

- [ ] **Step 1: The question error, in `src/stop.ts`**

```ts
/**
 * An agent asked a person a question (see src/questions.ts). The question is recorded and the change
 * waits for the answer; the step ends here without blocking or advancing.
 */
export class QuestionAsked extends Error {
  constructor(public readonly phase: string, public readonly text: string) {
    super(`the ${phase} session asked: ${text}`);
    this.name = "QuestionAsked";
  }
}

/** A stopped session or a question: the step ends quietly, the change keeps its status. Passed through like a stop request. */
export function endsStepQuietly(e: unknown): e is SessionStopped | QuestionAsked {
  return e instanceof SessionStopped || e instanceof QuestionAsked;
}
```

- [ ] **Step 2: Write the failing tests**

- `tests/unit/sessions.test.ts`: a `tracedSession` whose run is stopped by `SessionStopped("John")` ends its row `interrupted` with error "stopped by John", and rethrows. Drive it with the fake's `FIXTURE:hang`, a `live` control, and `stop`. Model it on the file's existing stop-request test.
- `tests/integration/scheduler.test.ts`: `runStepGuarded` given a step that throws `SessionStopped` or `QuestionAsked` returns `{ ok: true, stoppedBy: "John" }` or `{ ok: true, asked: true }`. The change's status stays the same and nothing blocks. Do it the way the file tests `personChanged`: make a stage throw through a fixture that hangs and stop it. If that is too heavy, unit-test `runStepGuarded` with a hand-made `StepContext` whose status makes `runStep` call a stage you can make throw. Read how existing tests reach `runStepGuarded`.

- [ ] **Step 3: Implement**

- `passOn` in `src/git.ts`: `if (notTheStepsFault(e) || endsStepQuietly(e) || e instanceof GitTimeout) throw e;`. Update its doc.
- `src/sessions.ts`, the `catch` in `tracedSession`: treat `SessionStopped` like a stop request. End the row `interrupted` with `e.message` ("stopped by John"), using the spent estimate as there, and rethrow.
- `src/context.ts`: `StepResult`'s ok side gains `stoppedBy?: string; asked?: boolean`. Document each.
- `src/scheduler.ts` `runStepGuarded`, in the `catch`, before the `notTheStepsFault` check:

```ts
    if (e instanceof SessionStopped) {
      ctx.trace.event(ctx.slug, "stop", { by: e.by, note: `the session was stopped by ${e.by}; the change keeps its status` });
      return { ok: true, stoppedBy: e.by };
    }
    if (e instanceof QuestionAsked) return { ok: true, asked: true };
```

- `stepText`: `r.stoppedBy ? \`stopped by ${r.stoppedBy}\` : r.asked ? "asked a person a question" : …`.
- `src/trace.ts`:
  - `phaseEnd`'s status gains `"asked"`;
  - add `"steer"` to `EventType`;
  - add a method that marks a row asked once it has ended:

```ts
  /** Marks an ended phase as one whose session asked a person a question (see src/questions.ts). */
  phaseAsked(slug: string, seq: number, question: string): void {
    this.db.run("UPDATE phases SET status = 'asked', error = ? WHERE slug = ? AND seq = ?", [question, slug, seq]);
    this.event(slug, "phase_end", { status: "asked", question }, seq);
  }
```

- Wherever a phase status is mapped to words, add `asked`: `stepWord` in `src/ui/format.ts` ("asked a question"), `src/console/describe.ts`, and the CSS status classes if a colour is set per status (use the warn colour).

- [ ] **Step 4: Run the tests**

Run: `bun test --timeout 30000 tests/unit/sessions.test.ts tests/integration/scheduler.test.ts tests/unit/ui-logic.test.ts tests/unit/console-describe.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(loop): a stopped session or a question ends the step quietly"
```

---
### Task 5: `intent/<slug>/conversation.md` (`src/conversation.ts`)

**Files:**
- Create: `src/conversation.ts`
- Test: `tests/unit/conversation.test.ts`

The format (spec, "The record"):

```markdown
# Conversation

## 2026-10-17 14:02 · John (the dashboard) → build
Use the existing CSV parser in src/io/csv.ts; don't add a dependency.

## 2026-10-17 14:31 · build asks
Should exported rows include archived reports?
Why: the intent says "all reports" but the list screen hides archived ones.
Options: include them · leave them out

## 2026-10-17 14:40 · John (Slack) answers
Leave them out.
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appendConversation, conversationEntry, readConversation } from "../../src/conversation";
import { lastCommit } from "../helpers";
import { chatRepo, INTENT } from "../chat-helpers";

describe("conversation.md", () => {
  test("entries in the spec's format: a message, a question, an answer, a note for the next session", () => {
    const at = new Date(2026, 9, 17, 14, 2);
    expect(conversationEntry({ kind: "message", who: "John", via: "the dashboard", phase: "build", text: "Use the CSV parser.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) → build\nUse the CSV parser.\n");
    expect(conversationEntry({ kind: "question", phase: "build", text: "Archived too?", why: "The list hides them.", options: ["include them", "leave them out"], at })).toBe("## 2026-10-17 14:02 · build asks\nArchived too?\nWhy: The list hides them.\nOptions: include them · leave them out\n");
    expect(conversationEntry({ kind: "answer", who: "John", via: "Slack", text: "Leave them out.", at })).toBe("## 2026-10-17 14:02 · John (Slack) answers\nLeave them out.\n");
    expect(conversationEntry({ kind: "later", who: "John", via: "the dashboard", text: "Also zero.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) → the next session\nAlso zero.\n");
    expect(conversationEntry({ kind: "redirect", who: "John", via: "the dashboard", phase: "plan", text: "Use two steps.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) redirects plan\nUse two steps.\n");
    expect(conversationEntry({ kind: "sent-back", who: "John", via: "the dashboard", text: "Split step 3.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) sent it back\nSplit step 3.\n");
  });

  test("appending makes the file with its heading, adds after what is there, and commits it", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      expect(readConversation(r.root, "a")).toBe("");
      await appendConversation(r.root, "main", "a", { kind: "message", who: "John", via: "the dashboard", phase: "build", text: "One.", at: new Date(2026, 9, 17, 9, 0) });
      await appendConversation(r.root, "main", "a", { kind: "answer", who: "Ana", via: "Slack", text: "Two.", at: new Date(2026, 9, 17, 9, 5) });
      expect(readConversation(r.root, "a")).toBe("# Conversation\n\n## 2026-10-17 09:00 · John (the dashboard) → build\nOne.\n\n## 2026-10-17 09:05 · Ana (Slack) answers\nTwo.\n");
      expect(await lastCommit(r.root)).toContain("loopstra(a): conversation");
    } finally {
      r.cleanup();
    }
  });

  test("a person's text cannot add a heading of its own", () => {
    const at = new Date(2026, 9, 17, 9, 0);
    expect(conversationEntry({ kind: "message", who: "John", via: "the dashboard", phase: "build", text: "ok\n## 2026 · fake", at })).toBe("## 2026-10-17 09:00 · John (the dashboard) → build\nok\n\\## 2026 · fake\n");
  });
});
```

(`chatRepo` makes a repository on main; check the `main_branch` it uses.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/conversation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/conversation.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitRecord } from "./context";

/**
 * `intent/<slug>/conversation.md`: one readable record per change of what people told its agents and
 * what the agents asked. Written only by the loop, through commitRecord, one entry at a time; a person
 * may read or edit it like any record. Every work session's prompt gets it (see {{conversation}}).
 */

export type ConversationEntry =
  | { kind: "message"; who: string; via: string; phase: string; text: string; at: Date }
  | { kind: "redirect"; who: string; via: string; phase: string; text: string; at: Date }
  | { kind: "question"; phase: string; text: string; why: string; options: string[]; at: Date }
  | { kind: "answer"; who: string; via: string; text: string; at: Date }
  | { kind: "later"; who: string; via: string; text: string; at: Date }
  | { kind: "sent-back"; who: string; via: string; text: string; at: Date };

export function conversationPath(root: string, slug: string): string {
  return join(root, "intent", slug, "conversation.md");
}

/** The record's text, or "" when there is none. */
export function readConversation(root: string, slug: string): string {
  const path = conversationPath(root, slug);
  try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}

const two = (n: number) => String(n).padStart(2, "0");
/** "2026-10-17 14:02", local time. */
function when(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One line of a header: no line breaks, no `·` look-alike tricks needed beyond that. */
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** A body: trimmed, and a line that would read as a heading is escaped, so a person's text never adds an entry. */
const body = (s: string) => s.trim().split(/\r?\n/).map((l) => (/^#/.test(l) ? `\\${l}` : l)).join("\n");

/** One entry as Markdown, ending with a newline. */
export function conversationEntry(e: ConversationEntry): string {
  const at = when(e.at);
  switch (e.kind) {
    case "message": return `## ${at} · ${one(e.who)} (${one(e.via)}) → ${one(e.phase)}\n${body(e.text)}\n`;
    case "redirect": return `## ${at} · ${one(e.who)} (${one(e.via)}) redirects ${one(e.phase)}\n${body(e.text)}\n`;
    case "later": return `## ${at} · ${one(e.who)} (${one(e.via)}) → the next session\n${body(e.text)}\n`;
    case "answer": return `## ${at} · ${one(e.who)} (${one(e.via)}) answers\n${body(e.text)}\n`;
    case "sent-back": return `## ${at} · ${one(e.who)} (${one(e.via)}) sent it back\n${body(e.text)}\n`;
    case "question": {
      const lines = [`## ${at} · ${one(e.phase)} asks`, body(e.text)];
      if (e.why.trim()) lines.push(`Why: ${one(e.why)}`);
      if (e.options.length) lines.push(`Options: ${e.options.map(one).join(" · ")}`);
      return `${lines.join("\n")}\n`;
    }
  }
}

/** The record with one more entry (the heading added when the file is new). */
export function withEntry(current: string, e: ConversationEntry): string {
  const head = current.trim() ? current.replace(/\s*$/, "\n") : "# Conversation\n";
  return `${head}\n${conversationEntry(e)}`;
}

/**
 * Appends one entry and commits it ("loopstra(<slug>): conversation"). Under commitRecord's lock, so two
 * entries written at once (a message and an answer) both land.
 */
export async function appendConversation(root: string, main: string, slug: string, e: ConversationEntry): Promise<void> {
  await commitRecord(root, main, slug, "conversation", async () => {
    await Bun.write(conversationPath(root, slug), withEntry(readConversation(root, slug), e));
  });
}
```

`ARTIFACTS` in `src/intents.ts` gains `"conversation.md"`, so the console lists it as a document. The status checks (`IMPLIES`) do not need it.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/conversation.test.ts tests/unit/console-detail.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/conversation.ts src/intents.ts tests/unit/conversation.test.ts
git commit -m "feat(conversation): one readable record per change of what people told its agents"
```

---

### Task 6: the inbox (`src/inbox.ts`)

**Files:**
- Create: `src/inbox.ts`
- Test: `tests/unit/inbox.test.ts`

`.loopstra/runs/<slug>/inbox/<id>.json` holds `{ id, seq, kind: "message" | "stop" | "redirect", text, by, via, at }`. A delivered (or dropped) one moves to `inbox/delivered/<id>.json` with `delivered: <ISO>` and `how: "delivered" | "next session" | "dropped"` added.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inboxFor, markDone, sendToSession, waitingIn } from "../../src/inbox";
import { tempDir } from "../helpers";

describe("the inbox", () => {
  test("what is sent waits for its session, in order; marking it done moves it, once", () => {
    const t = tempDir();
    try {
      const a = sendToSession(t.path, "x", { seq: 3, kind: "message", text: "one", by: "John", via: "the dashboard" });
      const b = sendToSession(t.path, "x", { seq: 4, kind: "stop", text: "", by: "John", via: "the dashboard" });
      const c = sendToSession(t.path, "x", { seq: 3, kind: "redirect", text: "two", by: "John", via: "the dashboard" });
      expect(inboxFor(t.path, "x", 3).map((m) => m.id)).toEqual([a.id, c.id]);
      expect(waitingIn(t.path, "x").map((m) => m.id)).toEqual([a.id, b.id, c.id]);
      expect(markDone(t.path, "x", a, "delivered")).toBe(true);
      expect(markDone(t.path, "x", a, "delivered")).toBe(false);
      expect(inboxFor(t.path, "x", 3).map((m) => m.id)).toEqual([c.id]);
      const kept = readdirSync(join(t.path, ".loopstra", "runs", "x", "inbox", "delivered"));
      expect(kept).toEqual([`${a.id}.json`]);
    } finally {
      t.cleanup();
    }
  });

  test("a file that is not a message, or an id that is not one, is ignored", () => {
    const t = tempDir();
    try {
      sendToSession(t.path, "x", { seq: 1, kind: "message", text: "ok", by: "J", via: "v" });
      Bun.write(join(t.path, ".loopstra", "runs", "x", "inbox", "junk.json"), "{}");
      expect(inboxFor(t.path, "x", 1)).toHaveLength(1);
      expect(existsSync(join(t.path, ".loopstra", "runs", "x", "inbox"))).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/inbox.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/inbox.ts`**

```ts
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./chat/threads";

/**
 * A running session's inbox, `.loopstra/runs/<slug>/inbox/`: what people send a session while it
 * runs (a message, a stop, a redirect). The console writes; the session's runner reads and delivers
 * (see src/phases.ts). Done ones move to `delivered/`, with how they ended.
 */
export interface InboxMessage { id: string; seq: number; kind: "message" | "stop" | "redirect"; text: string; by: string; via: string; at: string }

/** How an inbox message ended: written to its session, kept in conversation.md for the next one, or dropped (a stop that came too late). */
export type Done = "delivered" | "next session" | "dropped";

const ID = /^\d{15}-\d+-\d{4,}$/;
const KINDS = new Set(["message", "stop", "redirect"]);

export function inboxDir(root: string, slug: string): string {
  return join(root, ".loopstra", "runs", slug, "inbox");
}

let counter = 0;
function newId(): string {
  return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(4, "0")}`;
}

/** Leaves a message for a session. */
export function sendToSession(root: string, slug: string, m: Omit<InboxMessage, "id" | "at">): InboxMessage {
  const full: InboxMessage = { ...m, id: newId(), at: new Date().toISOString() };
  writeJson(join(inboxDir(root, slug), `${full.id}.json`), full);
  return full;
}

/** Every message waiting in a change's inbox, oldest first. */
export function waitingIn(root: string, slug: string): InboxMessage[] {
  const dir = inboxDir(root, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
    .map((n) => [n, readJson<InboxMessage>(join(dir, n))] as const)
    .filter(([n, m]) => !!m && ID.test(m.id) && n === `${m.id}.json` && KINDS.has(m.kind) && typeof m.seq === "number" && typeof m.text === "string")
    .map(([, m]) => m!);
}

/** The messages waiting for one session (a phase's seq), oldest first. */
export function inboxFor(root: string, slug: string, seq: number): InboxMessage[] {
  return waitingIn(root, slug).filter((m) => m.seq === seq);
}

/** Moves a message to delivered/ with how it ended; false when it was gone already (done by someone else). */
export function markDone(root: string, slug: string, m: InboxMessage, how: Done): boolean {
  const from = join(inboxDir(root, slug), `${m.id}.json`);
  const to = join(inboxDir(root, slug), "delivered", `${m.id}.json`);
  mkdirSync(join(inboxDir(root, slug), "delivered"), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    return false;
  }
  writeJson(to, { ...m, how, delivered: new Date().toISOString() });
  return true;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/inbox.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/inbox.ts tests/unit/inbox.test.ts
git commit -m "feat(inbox): what people send a running session waits in its inbox"
```

---

### Task 7: the runner delivers from the inbox

**Files:**
- Create: `src/steering.ts`
- Modify: `src/phases.ts` (`attempt`), `src/scheduler.ts` (`runStepGuarded`: sweep at the step's start)
- Test: `tests/unit/steering.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/steering.test.ts`. Use `setupRepo("accepted")` from `tests/helpers.ts` (it gives `{ repo, ctx, trace }` with change `add-numbers`), and run phases through `agentPhase` with the fake.

```ts
describe("steering a running session", () => {
  test("a message reaches a running work session, is traced and recorded, and the result after it counts", async () => {
    // A design session held until the test opens the gate: wait_for after the fixture's init line.
    // 1. start agentPhase(ctx, { name: "design", … }) without awaiting;
    // 2. until a running design row exists, then sendToSession(repo.path, "add-numbers", { seq, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
    // 3. until the inbox file is in delivered/ (how: "delivered");
    // 4. open the gate; await the result.
    // Then: the result's envelope summary is "heard: …" and contains "cover negatives";
    // a "steer" event { kind: "message", by: "John", seq } is in the trace;
    // conversation.md has "## … · John (the dashboard) → design\ncover negatives".
  });

  test("a message to a check is not written to it; it is kept for the change's next session", async () => {
    // the same with name: "spec-check" (a check): the file ends in delivered/ with how "next session",
    // conversation.md has "→ the next session", and the fake's steer log is empty.
  });

  test("stop ends the session: the phase is interrupted by the person, and the step's error says so", async () => {
    // FIXTURE:hang prompt for a design phase (write loopstra/prompts/design.md as "x FIXTURE:hang");
    // send a stop once it runs; agentPhase rejects with SessionStopped("John");
    // the row ends interrupted with error "stopped by John".
  });

  test("redirect resumes the same session in the same phase; the trace and conversation.md have it", async () => {
    // gate fixture as in the first test; once running, send a redirect "do it in two steps";
    // open the gate; await: ok; the trace has one design row (not two), a steer event of kind redirect,
    // conversation.md has "redirects design".
  });

  test("a message that arrives after the session ended goes to the next session, through conversation.md", async () => {
    // Write an inbox message for a seq that is not running, then call sweepInbox(ctx):
    // the file is done with how "next session", conversation.md has "→ the next session".
  });
});
```

Write each test in full from these notes, with real calls. The pieces are `agentPhase` from `../../src/phases`, `sendToSession`/`inboxFor` from `../../src/inbox`, `readConversation` from `../../src/conversation`, `sweepInbox` from `../../src/steering`, `SessionStopped` from `../../src/stop`, `until` from `../console-helpers`, and `fixtureDir`/`fixture` from `../helpers`, with `LOOPSTRA_FAKE_FIXTURE_DIR` set through `withEnv`. Each test gets `30_000` as its timeout.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test --timeout 30000 tests/unit/steering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/steering.ts`**

```ts
import { watch, type FSWatcher } from "node:fs";
import { MESSAGE_LEAD, REDIRECT_LEAD, type SessionControl } from "./claude";
import { appendConversation } from "./conversation";
import type { StepContext } from "./context";
import { inboxDir, inboxFor, markDone, waitingIn, type InboxMessage } from "./inbox";
import { errorText } from "./shell";

/** The work sessions a person may message or redirect; any session may be stopped (see the spec's "Which sessions"). */
export const STEERABLE: ReadonlySet<string> = new Set(["intake", "design", "plan", "build", "fix", "reconcile", "revise", "lessons"]);

/** A message as the session reads it. Starts with MESSAGE_LEAD, which the console's transcript looks for. */
export function messageText(m: InboxMessage): string {
  return `${MESSAGE_LEAD} ${m.by}, who is watching this work from ${m.via}: ${m.text.trim()}\n\nTake it into account and carry on. Your final answer keeps the same format.`;
}

/** A redirect as the resumed session's prompt. Starts with REDIRECT_LEAD. */
export function redirectText(m: InboxMessage): string {
  return `${REDIRECT_LEAD} ${m.by} (${m.via}): ${m.text.trim()}\n\nStop what you were doing and work this way instead. Your final answer keeps the same format.`;
}

/** Records an entry without ever failing the session: a record that cannot be written is traced. */
function record(ctx: StepContext, write: () => Promise<void>): void {
  void write().catch((e) => ctx.trace.event(ctx.slug, "error", { where: "conversation", error: errorText(e) }));
}

/** A message that will not reach its session: kept in conversation.md for the next one. */
function keepForNext(ctx: StepContext, m: InboxMessage): void {
  if (!markDone(ctx.root, ctx.slug, m, "next session")) return;
  record(ctx, () => appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "later", who: m.by, via: m.via, text: m.text, at: new Date() }));
}

/**
 * Delivers what waits in the inbox for session `seq` (phase `name`) while it runs: a message is written
 * to it (a work session only; a check's is kept for the next session), a stop ends it, a redirect resumes
 * it the new way. Looks when the inbox changes and every second. Gives back what ends the watching; once
 * it ends, what is left for this session goes to the next one (stops and redirects are dropped).
 */
export function deliverInbox(ctx: StepContext, seq: number, name: string, ctl: SessionControl): () => void {
  const steerable = STEERABLE.has(name);
  const look = () => {
    for (const m of inboxFor(ctx.root, ctx.slug, seq)) {
      if (m.kind === "stop") {
        if (markDone(ctx.root, ctx.slug, m, "delivered")) {
          ctx.trace.event(ctx.slug, "steer", { kind: "stop", by: m.by, via: m.via, seq });
          ctl.stop(m.by);
        }
      } else if (!steerable) {
        keepForNext(ctx, m);
      } else if (m.kind === "message") {
        // Moved only once it is written: a loop killed in between delivers it again, at worst twice.
        if (!ctl.message(messageText(m))) continue;
        markDone(ctx.root, ctx.slug, m, "delivered");
        ctx.trace.event(ctx.slug, "steer", { kind: "message", by: m.by, via: m.via, seq, text: m.text });
        record(ctx, () => appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "message", who: m.by, via: m.via, phase: name, text: m.text, at: new Date() }));
      } else {
        if (!ctl.redirect(redirectText(m))) continue;
        markDone(ctx.root, ctx.slug, m, "delivered");
        ctx.trace.event(ctx.slug, "steer", { kind: "redirect", by: m.by, via: m.via, seq, text: m.text });
        record(ctx, () => appendConversation(ctx.root, ctx.cfg.main_branch, ctx.slug, { kind: "redirect", who: m.by, via: m.via, phase: name, text: m.text, at: new Date() }));
      }
    }
  };
  let watcher: FSWatcher | null = null;
  try { watcher = watch(inboxDir(ctx.root, ctx.slug), () => look()); watcher.on("error", () => { watcher?.close(); watcher = null; }); } catch { /* no inbox yet: the timer looks */ }
  const timer = setInterval(look, 1000);
  look();
  return () => {
    clearInterval(timer);
    watcher?.close();
    for (const m of inboxFor(ctx.root, ctx.slug, seq)) {
      if (m.kind === "message" || m.kind === "redirect") keepForNext(ctx, m);
      else markDone(ctx.root, ctx.slug, m, "dropped");
    }
  };
}

/**
 * At a step's start, nothing of the change runs: what a stopped or killed loop left in its inbox goes
 * to conversation.md for the sessions to come (messages, redirects); stops are dropped.
 */
export function sweepInbox(ctx: StepContext): void {
  for (const m of waitingIn(ctx.root, ctx.slug)) {
    if (m.kind === "stop") markDone(ctx.root, ctx.slug, m, "dropped");
    else keepForNext(ctx, m);
  }
}
```

(The `watch` call needs the folder to exist: make it with `mkdirSync(inboxDir(...), { recursive: true })` first.)

In `src/phases.ts` `attempt`, give the session a live control:

```ts
      live: { attach: (ctl) => deliverInbox(ctx, seq, spec.name, ctl) },
```

Put it inside `run` passed to `tracedSession` (it is part of `RunPhaseInput`, so `TracedSession.run` carries it).

In `src/scheduler.ts` `runStepGuarded`, before `return await runStep(ctx)`, call `sweepInbox(ctx);`.

The console's transcript: a replayed message must not be traced as an event every turn. `summarize` already gives a `user` event only its type, which is fine.

- [ ] **Step 4: Run the tests**

Run: `bun test --timeout 30000 tests/unit/steering.test.ts tests/unit/phases.test.ts tests/unit/stages-design.test.ts tests/unit/stages-build.test.ts && bun run typecheck`
Expected: PASS; clean. Every existing stage test now runs its sessions live through the fake's stream mode (Task 1), and must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/steering.ts src/phases.ts src/scheduler.ts tests/unit/steering.test.ts
git commit -m "feat(steering): a running session gets its messages, stops and redirects from the inbox"
```

---

### Task 8: every work session reads conversation.md

**Files:**
- Modify: `src/prompts.ts`, `src/phases.ts` (`phasePrompt`), `templates/prompts/{intake,design,plan,build,fix,reconcile,revise,lessons}.md`, `src/apply.ts` (send back writes an entry)
- Test: `tests/unit/phases.test.ts`, `tests/unit/apply.test.ts`

- [ ] **Step 1: Write the failing tests**

- In `tests/unit/phases.test.ts`, in its style:
  - With `intent/add-numbers/conversation.md` present, a design phase's prompt (`prompt.md` in its phase folder) contains the record's text under "What people told earlier sessions of this change".
  - A `spec-check` (a check) prompt does not contain it.
  - With a repository prompt `loopstra/prompts/design.md` that has no `{{conversation}}`, the record is appended at the end, under the same heading.
  - With no record, the design prompt says `(none)` there, and an old prompt gets nothing appended.
- In `tests/unit/apply.test.ts`: a send back writes a `sent-back` entry ("## … · John (the dashboard) sent it back\nSplit step 3.") into conversation.md, in the same commit as the status.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement**

- `src/prompts.ts`: add `"conversation"` to `PROMPT_VARS`.
- `src/phases.ts` `phasePrompt`: for a phase in `STEERABLE` (import from `./steering`), set `conversation: readConversation(ctx.root, ctx.slug)` in the vars (a caller's own `conversation` var wins). After rendering, when the record is not empty and the template text has no `{{conversation}}`, append:

```ts
export const CONVERSATION_HEADING = "What people told earlier sessions of this change (conversation.md); take it into account:";
```

  as `\n\n${CONVERSATION_HEADING}\n\n${record}\n`, before `withContract`.
- Each work template gets, in a sensible place (after the intent or the plan):

```
What people told earlier sessions of this change (conversation.md); take it into account:

{{conversation}}
```

- `src/apply.ts` `applyStatus`: for a send back, in the same `commitRecord` write callback (after `writeIntent`), also write the record with the entry added:

```ts
await Bun.write(conversationPath(root, req.slug), withEntry(readConversation(root, req.slug), { kind: "sent-back", who: req.byName, via: req.via, text: req.note.trim(), at: new Date() }));
```

(`commitRecord` commits all of `intent/<slug>`.) Do it only on the request's first write: the `ours` path must not add it twice.

- `tests/unit/templates.test.ts` or `templates-roundtrip.test.ts` may pin the variables each template uses; add `conversation` where they do.

- [ ] **Step 4: Run the tests**

Run: `bun test --timeout 30000 tests/unit/phases.test.ts tests/unit/apply.test.ts tests/unit/templates.test.ts tests/unit/templates-roundtrip.test.ts tests/unit/prompts.test.ts tests/unit/stages-design.test.ts tests/unit/stages-plan.test.ts && bun run typecheck`
Expected: PASS; clean.

Plan-ahead compares a stored prompt with a fresh one. With no record the prompts are as before. With a record, both are rendered from the same record unless it changed in between, in which case the plan is not taken, which is right.

- [ ] **Step 5: Commit**

```bash
git add src templates tests
git commit -m "feat(prompts): every work session reads what people told earlier sessions"
```

---

### Task 9: agents ask questions (`src/questions.ts`)

**Files:**
- Create: `src/questions.ts`
- Modify: `src/envelopes.ts`, `src/phases.ts` (`agentPhase`, `attempt` returns its seq), `src/stages/design.ts` (intake), `src/intents.ts` (the `question` frontmatter field), the templates of the askers
- Test: `tests/unit/questions.test.ts`

The askers are `intake` (its existing `question` string, non-empty), `design`, `plan`, `build`, `fix`, `reconcile` and `revise` (a new optional `question: { text, why, options? }`).

**The state** lives in `.loopstra/runs/<slug>/question.json`:

```ts
export interface Asked {
  phase: string; traceName: string; seq: number; sessionId: string | null;
  text: string; why: string; options: string[]; at: string;
  answer?: { text: string; by: string; via: string; at: string };
}
export interface QuestionState { status: Status; count: number; open: Asked | null }
```

`count` is the questions asked at `status` in this step. It starts again at 0 when the status is another.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/questions.test.ts` (setupRepo, the fake through `LOOPSTRA_FAKE_FIXTURE_DIR`). A design fixture that asks is the design fixture with the result's `structured_output` given `question: { text: "Archived too?", why: "The list hides them.", options: ["yes", "no"] }`. Build it in the test by parsing `fixture("design")` lines and editing the result line.

```ts
describe("questions", () => {
  test("a design session that asks: the phase is asked, the question is recorded, question: open is set, and the step ends quietly", async () => {
    // agentPhase(ctx, { name: "design", ... }) rejects with QuestionAsked;
    // trace row status "asked", its error the question text;
    // intent.md frontmatter question === "open", status unchanged;
    // conversation.md has "## … · design asks\nArchived too?\nWhy: The list hides them.\nOptions: yes · no";
    // readQuestion(root, slug).open matches { phase: "design", text: "Archived too?", sessionId: "fake-design" }, count 1.
  });

  test("once answered, the next design session resumes the asking session with the answer", async () => {
    // after the question: answerQuestion(root, slug, { text: "No.", by: "John", via: "the dashboard" });
    // then agentPhase design again (plain design fixture): it succeeds;
    // LOOPSTRA_FAKE_CALLS shows --resume fake-design on the last call, and its prompt (LOOPSTRA_FAKE_PROMPTS) is
    // "John answered your question: No. Carry on.";
    // readQuestion(...).open is null afterwards; count stays 1 for this status.
  });

  test("an answered question whose session is gone starts a fresh session with the normal prompt", async () => {
    // set open.sessionId to "missing-session" by hand in question.json, answer it, run design:
    // the fake answers --resume missing-session with no-session; the phase then runs fresh (no --resume) and succeeds.
  });

  test("with three asked in a step the prompt says no more; a fourth blocks", async () => {
    // write question.json { status: "designing", count: 3, open: null } by hand (ctx's status is designing);
    // a design session's prompt contains "Do not ask another question";
    // if it asks anyway: agentPhase gives { ok: false, reason: "agent-fail" } and its note contains
    // "The assistant kept asking questions on this step".
  });

  test("intake's question asks instead of blocking", async () => {
    // intake.md prompt "{{intent}} FIXTURE:intake-question" as stages-design.test.ts does;
    // runDesignStep: the change is not blocked; question: open; the trace has an asked intake row.
  });

  test("a question from work run alongside (the plan written ahead) is not recorded; that work is just not used", async () => {
    // inside alongside(ctx, main, { run: () => agentPhase(plan-that-asks) }) the extra gives null,
    // and no question.json / question: open exists.
  });
});
```

Write each in full. Imports: `QuestionAsked` from `../../src/stop`; `readQuestion`, `answerQuestion` from `../../src/questions`; `agentPhase`, `alongside` from `../../src/phases`; `readIntent` from `../../src/intents`; `readConversation` from `../../src/conversation`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement**

`src/envelopes.ts`:

```ts
/** A question for a person (only when the decision is theirs and there is no sensible default). Optional: absent means none. */
const question = z.object({ text: z.string(), why: z.string(), options: z.array(z.string()).optional() }).optional();
```

`design`, `plan`, `reconcile` and `codeChange` (build, fix, revise) gain `question`. `intake` keeps `question: z.string()`.

`src/intents.ts` `Frontmatter` gains:

```ts
  /** "open" while an agent's question waits for a person (runtime-managed; see src/questions.ts). Blank reads as absent. */
  question: blankableString,
```

and `serializeIntentFile` leaves out a blank `question`, as it does `hold`.

`src/questions.ts`:

```ts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./chat/threads";
import { commitRecord, type StepContext } from "./context";
import { conversationPath, readConversation, withEntry } from "./conversation";
import { readIntent, writeIntent, type Status } from "./intents";

/** The most questions one step may ask (spec: "A limit"). */
export const MAX_QUESTIONS = 3;
export const NO_MORE_QUESTIONS = `You have asked ${MAX_QUESTIONS} questions in this step, the most allowed. Do not ask another question: decide, and say in your summary what you decided and why.`;
export const TOO_MANY_NOTE = "The assistant kept asking questions on this step. Read conversation.md, and add what it needs to the intent.";

function statePath(root: string, slug: string): string {
  return join(root, ".loopstra", "runs", slug, "question.json");
}

export function readQuestion(root: string, slug: string): QuestionState | null {
  return readJson<QuestionState>(statePath(root, slug));
}

/** The questions asked so far at this status (0 at another). */
export function askedAt(root: string, slug: string, status: Status): number {
  const s = readQuestion(root, slug);
  return s && s.status === status ? s.count : 0;
}

/** The question in an envelope, or null: intake's string, or the others' object. */
export function questionIn(envelope: Record<string, unknown>): { text: string; why: string; options: string[] } | null {
  const q = envelope.question;
  if (typeof q === "string") return q.trim() ? { text: q.trim(), why: "", options: [] } : null;
  if (q && typeof q === "object" && typeof (q as { text?: unknown }).text === "string" && (q as { text: string }).text.trim()) {
    const o = q as { text: string; why?: string; options?: string[] };
    return { text: o.text.trim(), why: (o.why ?? "").trim(), options: (o.options ?? []).map((x) => String(x).trim()).filter(Boolean) };
  }
  return null;
}

/**
 * Records a question a session asked: question.json, `question: open` and the conversation.md entry in
 * one commit, and the phase row marked asked. The change then waits (the scheduler skips it).
 */
export async function recordQuestion(ctx: StepContext, a: Omit<Asked, "at" | "answer">): Promise<void> {
  const status = ctx.intent.file.frontmatter.status;
  const at = new Date();
  writeJson(statePath(ctx.root, ctx.slug), { status, count: askedAt(ctx.root, ctx.slug, status) + 1, open: { ...a, at: at.toISOString() } } satisfies QuestionState);
  await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, `${a.phase} asks a question`, async () => {
    const fresh = await readIntent(ctx.root, ctx.slug);
    await writeIntent(fresh, { question: "open" });
    ctx.intent.file = fresh.file;
    await Bun.write(conversationPath(ctx.root, ctx.slug), withEntry(readConversation(ctx.root, ctx.slug), { kind: "question", phase: a.phase, text: a.text, why: a.why, options: a.options, at }));
  });
  ctx.trace.phaseAsked(ctx.slug, a.seq, a.text);
}

/** Stores the answer for the session that asked (the `answer` request does this, with the record; see src/apply.ts). */
export function answerQuestion(root: string, slug: string, answer: { text: string; by: string; via: string }): boolean {
  const s = readQuestion(root, slug);
  if (!s?.open) return false;
  writeJson(statePath(root, slug), { ...s, open: { ...s.open, answer: { ...answer, at: new Date().toISOString() } } });
  return true;
}

/** The prompt that resumes the asking session with its answer. */
export function answerPrompt(a: Asked): string {
  return `${a.answer!.by} answered your question: ${a.answer!.text.trim()}\n\nCarry on.`;
}

/** The answered question is done with: the count stays for this step's limit. */
export function closeQuestion(root: string, slug: string): void {
  const s = readQuestion(root, slug);
  if (s) writeJson(statePath(root, slug), { ...s, open: null });
}
```

(Put the `Asked` and `QuestionState` interfaces above in the file and export them.)

`src/phases.ts`:
- `attempt` also returns its `seq` on success (internal; `AgentPhaseResult`'s ok side gains `seq?: number`).
- `ASKERS = new Set(["intake", "design", "plan", "build", "fix", "reconcile", "revise"])`.
- In `agentPhase`, before the first attempt, for a phase in `ASKERS` that is not work run alongside (`!cancelSignal()`):
  1. **An answered question waits for this phase:** `const q = readQuestion(...)?.open`, and `q?.answer && q.phase === spec.name`. Then:
     - run `attempt` with `{ ...spec, resume: q.sessionId ?? undefined }` and `answerPrompt(q)` as the prompt (`q.sessionId` null means run the fresh prompt instead);
     - if it fails with `no-session`, run the normal prompt fresh;
     - `closeQuestion` once either has ended (whatever it gave).
  2. **The limit:** when `askedAt(...) >= MAX_QUESTIONS`, append `\n\n${NO_MORE_QUESTIONS}\n` to the prompt.
- After a successful attempt of an asker, when `questionIn(envelope)` gives a question:
  - **inside work run alongside** (`cancelSignal()`): return `{ ok: false, reason: "agent-fail", note: "It asked a question", sessionId }`; the extra is then not used;
  - **at the limit:** return `{ ok: false, reason: "agent-fail", note: TOO_MANY_NOTE, sessionId }` (the stage blocks with it, and blockNote adds how to retry);
  - **otherwise:** `await recordQuestion(ctx, { phase: spec.name, traceName, seq, sessionId, ...q })`, then `throw new QuestionAsked(spec.name, q.text)`.
- The retry path (`-retry`) follows the same rules.

`src/stages/design.ts` `intake`: remove the block on `r.envelope.question` (agentPhase now asks). Keep the priority write.

Templates: the asker prompts (`intake.md` already asks; `design.md`, `plan.md`, `build.md`, `fix.md`, `reconcile.md`, `revise.md`) gain:

```
If a decision belongs to a person and there is no sensible default, ask: set `question` with `text`, `why`, and, when there are a few clear choices, `options`, and stop there. Otherwise decide, and say in your summary what you decided and why. Ask rarely.
```

- [ ] **Step 4: Run the tests**

Run: `bun test --timeout 30000 tests/unit/questions.test.ts tests/unit/stages-design.test.ts tests/unit/stages-plan.test.ts tests/unit/stages-build.test.ts tests/unit/envelopes.test.ts tests/unit/phases.test.ts && bun run typecheck`
Expected: PASS; clean. The stages-design test that expected intake's question to block now expects a question: update it to check `question: open` and the asked row.

- [ ] **Step 5: Commit**

```bash
git add src templates tests
git commit -m "feat(questions): an agent may ask a person, and its session resumes with the answer"
```

---

### Task 10: a change with an open question waits, and says so

**Files:**
- Modify: `src/scheduler.ts`, `src/intents.ts` (queue.md, `shownNote`), `src/attention.ts`, `src/console/types.ts`
- Test: `tests/integration/scheduler.test.ts`, `tests/unit/intents-queue.test.ts`, `tests/unit/status.test.ts`

- [ ] **Step 1: Write the failing tests**

- **Scheduler:** a change at `designing` with `question: open` gets no step from the tick, the same way the hold test does it.
- **Queue:** a change with `question: open` is under "Needs a person", and its note starts "Has a question: <text>." (the text from question.json; "Read conversation.md." when that file is missing).
- **Attention:** one item `{ kind: "question", label: "Has a question", slug, title, what: "<phase> asks: <text> Why: <why>. Options: a · b. Answer it in the console, or tell the orchestrator." }`. Leave out the parts with no value.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement**

- `src/scheduler.ts`: `held(i)` becomes `waiting(i)`, true for a hold or `question` that is not blank. Update its doc and both callers.
- `src/intents.ts`:
  - `renderQueue` counts a change with an open question as needing a person;
  - `shownNote` gets the note from a new `questionNote(intent, root?)`;
  - the queue is rendered where the root is known, so pass the text in. `renderQueue` gains an optional `questions: ReadonlyMap<string, string>` (slug → question text). The tick builds it from question.json for changes with `question: open`.
- `src/attention.ts`:
  - `AttentionItem["kind"]` gains `"question"`; `ATTENTION_LABEL` gains `question: "Has a question"`;
  - after the held items, add one item per open change with `question` set, read from `readQuestion(root, slug)?.open`;
  - the announcer posts it like any new item, so chat hears of it.
- `src/console/types.ts`: nothing yet (Task 12).

- [ ] **Step 4: Run the tests**

Run: `bun test --timeout 30000 tests/integration/scheduler.test.ts tests/unit/intents-queue.test.ts tests/unit/status.test.ts tests/unit/chat-announcer.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(questions): a change with an open question waits, and needs a person"
```

---

### Task 11: the `answer` request

**Files:**
- Modify: `src/actions.ts`, `src/requests.ts`, `src/apply.ts`, `src/console/types.ts` (`ActionKind`)
- Test: `tests/unit/apply.test.ts`, `tests/unit/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

- **actions:**
  - a change with `question: open` offers `{ kind: "answer", label: "Answer" }` first;
  - `doneWords({ kind: "answer", … })` is "question answered";
  - `askText` for answer is "Send this answer to <slug>'s waiting question?\n\n<text>";
  - `resultText` is "<slug> has its answer; the loop goes on with it.".
- **apply:** submitting `{ kind: "answer", slug: "a", text: "Leave them out." }` for a change with an open question has these effects:
  - it removes the `question:` line;
  - it adds "## … · John (the dashboard) answers\nLeave them out." to conversation.md;
  - it commits "loopstra(a): question answered by John from the dashboard";
  - `readQuestion(...).open.answer.text` is "Leave them out.";
  - on a change with no open question it answers "a has no question waiting; nothing changed." (ok: false).

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement**

- `src/actions.ts`:
  - `CHANGE_ACTIONS` gains `"answer"`;
  - `offers` puts `{ kind: "answer", label: "Answer" }` first when `fm.question.trim()`;
  - `doneWords`, `requestLabel`, `askText` (with `note` as the answer text), `resultText` cover it;
  - `RequestShape` already has `note`.
- `src/requests.ts`: `RequestBody` gains `| { kind: "answer"; slug: string; text: string }`.
- `src/console/types.ts`: `ActionKind` gains `"answer"`.
- `src/apply.ts`:
  - `badShape` checks that `text` is a non-empty string of at most 4000 characters;
  - `applyOne` routes `answer` to a new `applyAnswer`. It reads the change; refuses unless `question` is open and the change is open; then in one `commitRecord` ("question answered by <who>"):
    - writes `writeIntent(fresh, {}, { remove: ["question"] })` and the conversation.md entry (`kind: "answer"`);
    - records `written`/hash through `markWritten`, as `applyField` does;
    - calls `answerQuestion(root, slug, { text, by: byName, via })`;
  - after the commit, traces `request` applied with `what: "question answered"`, and gives `resultText`.

- [ ] **Step 4: Run the tests**

Run: `bun test --timeout 30000 tests/unit/apply.test.ts tests/unit/actions.test.ts tests/unit/requests.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(apply): an answer request answers the change's waiting question"
```

---
### Task 12: the console's model and transcripts know steering

**Files:**
- Create: `src/console/steerable.ts` (page-safe: no server imports)
- Modify: `src/console/types.ts`, `src/console/model.ts`, `src/console/detail.ts`, `src/console/transcript.ts`, `src/steering.ts` (use the shared list)
- Test: `tests/unit/console-model.test.ts`, `tests/unit/console-transcript.test.ts`

- [ ] **Step 1: The shared list**

`src/console/steerable.ts`:

```ts
/** The work sessions a person may message or redirect (any session may be stopped). Shared by the loop and the page. */
export const STEERABLE_PHASES = ["intake", "design", "plan", "build", "fix", "reconcile", "revise", "lessons"] as const;

/** A phase row's name as its kind: "fix-2" → fix, "early-lessons" → lessons, "design-retry" → design, "review-1" → review. */
export function phaseKind(name: string): string {
  return name.replace(/^early-/, "").replace(/-retry$/, "").replace(/-(\d+|after-verify)$/, "");
}

/** True when a person may message or redirect a session of this phase row. */
export function steerable(name: string): boolean {
  return (STEERABLE_PHASES as readonly string[]).includes(phaseKind(name));
}

/** The words the runner starts a message and a redirect with (see src/steering.ts); the transcript shows those echoes. */
export const MESSAGE_LEAD = "A message from";
export const REDIRECT_LEAD = "A change of direction from";
```

`src/claude.ts` re-exports `MESSAGE_LEAD`/`REDIRECT_LEAD` from here instead of defining them; `src/steering.ts` uses `steerable()` for its check.

- [ ] **Step 2: Write the failing tests**

- **console-transcript:** a `user` event with `isReplay: true` whose text starts with `MESSAGE_LEAD` gives the item `{ kind: "message", text: <the first paragraph>, redirect: false }`. One with `REDIRECT_LEAD` gives `redirect: true`. A replay of the prompt (any other text) gives no item.
- **console-model:**
  - a running design phase's card has `steerable: true`, and a running spec-check's has `false`;
  - a change with `question: open` and a question.json has `question: { text, why, options, phase }` on its summary; one without has `null`;
  - a change with an open question offers `answer` first.

- [ ] **Step 3: Implement**

- `src/console/types.ts`:
  - `TranscriptItem` gains `| { kind: "message"; text: string; redirect: boolean }`;
  - `RunningPhase` gains `steerable: boolean`;
  - `ChangeSummary` gains `question: { text: string; why: string; options: string[]; phase: string } | null`;
  - `PhaseView` statuses already carry `asked` as a string.
- `src/console/transcript.ts` `toItems`: in the `user` branch, when `e.isReplay === true`, look at the text blocks:
  - a block starting with `MESSAGE_LEAD` or `REDIRECT_LEAD` gives a `message` item, its text the block up to the first blank line;
  - any other replayed block (the prompt, the nudge, an answer) gives nothing.
- `src/console/model.ts`:
  - `runningPhases` sets `steerable: steerable(p.name)`;
  - `changeSummary` sets `question` from `readQuestion(root, slug)?.open` when `fm.question.trim()` (the root is needed: pass it in, as `detail.ts` and `buildModel` both have it).
- The UI's `Transcript` part draws a `message` item as a person's note in the transcript: a bubble with "Message" or "Redirect", and the text. Add a CSS class `msg` using the accent tokens.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/console-model.test.ts tests/unit/console-transcript.test.ts tests/unit/console-detail.test.ts tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts && bun run typecheck`
Expected: PASS; clean. Fix the hand-made summaries in tests (`question: null`, `steerable: false`).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(console): questions, steerable sessions and people's messages in the model and transcripts"
```

---

### Task 13: the console's steering routes

**Files:**
- Create: `src/console/steer.ts`
- Modify: `src/console/server.ts`, `src/console/writes.ts` (the `answer` request's shape)
- Test: `tests/unit/console-server.test.ts`

The routes need the same safety as the part 2 writes (local host, the page's own Origin, JSON by MIME essence):

| Route | Does |
|---|---|
| `POST /api/sessions/<slug>/<seq>/message` | body `{ kind: "message" \| "redirect" \| "stop", text }`. Checks that the phase row is running and the loop is working on the change (`runningRows`). For message and redirect: the phase must be steerable (409 "Checks cannot be messaged. Approve or send back instead.") and the text 1-4000 characters. Writes the inbox file (`by` = the machine's user, `via` "the dashboard"). For stop: also submits a `hold` request ("Stopped from the dashboard"). 202 `{ id }`. |
| `POST /api/changes/<slug>/stop` | Stops every running session of the change (one stop per running seq) and submits one hold request; 202 `{ stopped: <n> }`; 409 when nothing runs. |
| `POST /api/requests` | now also takes `{ kind: "answer", slug, text }` (text 1-4000), offered only while the change's question is open. |

- [ ] **Step 1: Write the failing tests**

In `tests/unit/console-server.test.ts`, alongside the part 2 write tests. Make a "running" phase the way the console tests make one: a phase row started with `trace.phaseStart`, and a heartbeat that says the loop works on the change (see `tests/console-helpers.ts` and how `console-model.test.ts` makes a running row).

- a message to a running design session lands in the inbox (`inboxFor(root, slug, seq)` has it, by the machine's user, via "the dashboard");
- a message to a running spec-check gets 409 with the checks text;
- a message to a phase that is not running gets 409 "That session is not running.";
- stop on a running session writes a stop and leaves a hold request;
- `/api/changes/<slug>/stop` stops both running sessions of a change and leaves one hold;
- an answer request is taken while `question: open` and refused (409) without it;
- every one of them refuses another Origin (403) and non-JSON (415).

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement `src/console/steer.ts`**

Write `steerRoutes(root, hub, req, url): Promise<Response | null>`, which handles the two paths above (null otherwise).
- It uses the same Origin and JSON checks as `writes.ts`: export `isJson` from there and a small `fromPage(req, url)` helper, and use them in both.
- `running(root, slug)` builds the running rows with `loopNow` + `runningRows` from `./model`, using a `Trace` it opens and closes.
- The hold goes through `submitRequest` with `kind: "hold"` and `expect`: the change's status now.
- `hub.poke()` after each write.

In `server.ts`, call it right after `writes(...)`. In `writes.ts`, `parse` takes `answer`. The offers check covers it, since `offers` offers answer only while a question is open.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/console-server.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/console tests/unit/console-server.test.ts
git commit -m "feat(console): routes to message, redirect or stop a running session, and to answer a question"
```

---

### Task 14: the session page steers

**Files:**
- Create: `src/ui/parts/Steer.tsx`
- Modify: `src/ui/views/Session.tsx`, `src/ui/requests.ts` (a `steer` call), `src/ui/theme.css`
- Test: `tests/unit/ui-logic.test.ts`, `tests/unit/console-page.test.ts`

- [ ] **Step 1: Write the failing test**

A pure helper in `src/ui/requests.ts`, `steerOffer(phaseName, status, ended)`:
- `{ message: true, stop: true }` for a running steerable phase;
- `{ message: false, stop: true, note: "Checks cannot be messaged. Approve or send back instead." }` for a running check;
- `null` once it has ended or is not running.

Test it in `ui-logic.test.ts`.

- [ ] **Step 2: Implement**

`src/ui/requests.ts`:

```ts
/** Sends a message, a redirect or a stop to a running session; says what happened in a toast. */
export async function steer(slug: string, seq: number, kind: "message" | "redirect" | "stop", text = ""): Promise<boolean> {
  const r = await post(`/api/sessions/${encodeURIComponent(slug)}/${seq}/message`, { kind, text });
  if (!r.ok) { toast(r.error, "bad"); return false; }
  toast(kind === "stop" ? "Stopping the session. The change is held, so it does not start again." : kind === "redirect" ? "Sent: the session starts again your way." : "Sent: the session reads it at its next step.");
  return true;
}
```

`src/ui/parts/Steer.tsx`, a box under the session's header while the session runs:
- A textarea ("Tell the agent something. It reads it at its next step, and it is kept in conversation.md.").
- **Send message** (primary) and **Redirect** (the text replaces what the session was doing).
- **Stop session**, with an inline confirm: "Stop this session? The change is held until someone releases it."
- For a check: only **Stop session** and the note.
- The text stays after a failed send, and clears after a sent one.
- Focus behaves like `Actions.tsx` (a confirm focuses its button; closing returns focus).
- Ctrl/Cmd+Enter sends the message.

`Session.tsx` renders `<Steer slug seq name={phase.name} />` while `phase.status === "running"` and the stream has not ended. Keep the layout working at 375 px.

- [ ] **Step 3: Run the tests**

Run: `bun test tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts && bun run typecheck`
Expected: PASS (the bundle stays under 80 KB gzipped); clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui tests/unit/ui-logic.test.ts
git commit -m "feat(ui): message, redirect or stop a running session from its page"
```

---

### Task 15: answering and stopping from the controls; badges

**Files:**
- Modify: `src/ui/parts/Actions.tsx`, `src/ui/requests.ts` (`bodyFor` for answer; `stopChange`), `src/ui/views/Change.tsx`, `src/ui/views/Changes.tsx`, `src/ui/views/Inbox.tsx`, `src/ui/views/Live.tsx`, `src/ui/theme.css`
- Test: `tests/unit/ui-logic.test.ts`

- [ ] **Step 1: Write the failing tests**

- `bodyFor(change, { kind: "answer", label: "Answer" }, { note: "No." })` gives `{ kind: "answer", slug, text: "No." }` (no `expect`).
- `UNDOABLE` does not have answer.

- [ ] **Step 2: Implement**

- **`Actions.tsx`:** `answer` opens a form (it is in `FORMS`).
  - The form shows the question (its text, why, and options) above a textarea, "Your answer. The agent carries on with it.".
  - Each option is a button that fills the textarea.
  - **Send answer** is primary.
  - `answer` is in `COMPACT` (the inbox shows it).
  - A change that is `running` gets a **Stop** button, in the compact set too, with an inline confirm: "Stop <slug>'s running session? The change is held until someone releases it.". It calls `stopChange(slug)`, which POSTs `/api/changes/<slug>/stop` and toasts.
- **Badges:** "Has a question" (warn) on the board card, in the list, in the change header and on Live's card for the change.
- **Inbox:** a `question` item shows the compact Actions, so Answer is right there.
- **Live:** each running card links to its session; add a small "Message" link to the session page for steerable cards.

- [ ] **Step 3: Run the tests**

Run: `bun test tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui tests/unit/ui-logic.test.ts
git commit -m "feat(ui): answer a question and stop a running change from the controls"
```

---

### Task 16: chat answers questions

**Files:**
- Modify: `src/chat/schemas.ts` (`ACTION_KINDS` follows `CHANGE_ACTIONS`, so `answer` comes with it), `src/chat/orchestrator.ts`, `templates/prompts/orchestrator.md`, `src/chat/agents.ts` (the appended section for old prompts)
- Test: `tests/unit/chat-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

- With `csv-export` at `designing` with `question: open` (and a question.json), a turn `{ action: { kind: "answer", slug: "csv-export", note: "Leave them out.", priority: null } }` gets the question "Send this answer to csv-export's waiting question?\n\nLeave them out.\n\nReply yes to go ahead.". A yes then submits `{ kind: "answer", slug: "csv-export", text: "Leave them out." }` with the person's name and where they are.
- An answer with an empty note gets "Tell me the answer, and I will pass it on.".
- An answer to a change with no open question gets the "not something I can do" text.

- [ ] **Step 2: Implement**

- `proposeAction`: the `answer` case needs a note and builds `{ kind: "answer", slug, text: note }`.
- The prompt's "## Acting on a change" section gains a sentence: when a change has a question waiting, the person can answer it through you: set `action` to `answer` with the answer in `note`.
- The message context's "Announced by Loopstra" already brings questions in, through the attention announcements.
- Old prompts get the section through `chatTemplate` as in part 2, so its text must be the updated one.

- [ ] **Step 3: Run the tests**

Run: `bun test --timeout 30000 tests/unit/chat-orchestrator.test.ts tests/unit/chat-config.test.ts tests/integration/chat.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 4: Commit**

```bash
git add src/chat templates/prompts/orchestrator.md tests
git commit -m "feat(chat): the orchestrator passes on an answer to a waiting question"
```

---

### Task 17: the orchestrator gets the change's context

**Files:**
- Create: `src/chat/about.ts`
- Modify: `src/chat/orchestrator.ts` (`IncomingMessage.about`, `messageBlock`), `src/chat/transports/dashboard.ts` (the POST takes `about`), `src/ui/parts/Drawer.tsx`, `src/ui/chat.ts` (`About` gains `seq`), `src/ui/views/Session.tsx` and `src/ui/views/Change.tsx` (open the drawer with `seq` from a session)
- Test: `tests/unit/chat-orchestrator.test.ts`, `tests/unit/chat-transports.test.ts`

- [ ] **Step 1: Write the failing tests**

- **`aboutContext(root, { slug: "a", seq: 2 })`** in a repo whose change `a` has an intent, a conversation.md, a note, a failed phase with an error, and a `raw.jsonl` for phase 2. It gives text with:
  - "Intent:" and the intent;
  - "conversation.md:" and the record;
  - "Note:" and the note;
  - "Newest failure:" and the error;
  - "The session's last steps:" and lines of the transcript ("text: …", "tool Bash: bun test", "result: success").
  - Each part is cut to at most 4000 characters; the transcript is the last 50 items.
- **The orchestrator:** a message with `about: { slug: "a" }` puts that context inside `<context>`, never inside `<message>`.
- **The dashboard transport:** a POST with `about` passes it on; a bad `about` (a slug that is not a slug, a seq that is not a number) is dropped, not refused.

- [ ] **Step 2: Implement**

- **`src/chat/about.ts`:** `aboutContext(root, about)` reads, each safely:
  - the intent;
  - the record (`readConversation`);
  - the note;
  - the newest phase row whose status is `fail`, and its `error`;
  - the transcript of `about.seq`, or else the newest agent phase. It uses `TranscriptReader` from `src/console/transcript.ts` and turns items into one-line texts.
- **`IncomingMessage`:** gains `about?: { slug: string; seq?: number }`.
- **`messageBlock`:** adds `About this change (from where the person opened chat):\n<context>` to the context lines.
- **The dashboard transport:** reads `body.about` (validated: slug `SLUG`, seq a positive integer) and passes it.
- **The drawer:**
  - it sends `about: { slug, seq }` with the first message after it was opened from somewhere (where it sends the prefix today);
  - the visible prefix stays as it is.
- **The session page's "Ask the orchestrator":** passes the session's `seq`.

- [ ] **Step 3: Run the tests**

Run: `bun test --timeout 30000 tests/unit/chat-orchestrator.test.ts tests/unit/chat-transports.test.ts tests/unit/ui-logic.test.ts tests/unit/console-page.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 4: Commit**

```bash
git add src tests
git commit -m "feat(chat): the orchestrator opened from a change or a session hears its context"
```

---

### Task 18: documentation

**Files:**
- Modify: `README.md`, `templates/intent-README.md`, `templates/skill/SKILL.md`, `docs/decisions.md`, `docs/superpowers/specs/2026-10-17-console-design.md`

- [ ] **Step 1: Write it**

- **`README.md`:** a new **Steering** section, after the console's paragraphs. In plain short sentences:
  - message, redirect or stop a running session from its page;
  - which sessions can be messaged;
  - questions agents ask, the "Has a question" inbox item, and answering in the console or in chat;
  - `conversation.md`;
  - the 3-question limit.

  Where statuses and frontmatter are explained, add `question:`.
- **`templates/intent-README.md`:**
  - the `question:` line: "Set by the loop while an agent's question waits. To answer by hand, write your answer under the question in conversation.md and remove this line.";
  - conversation.md as one of the change's files.
- **`templates/skill/SKILL.md`:** the same additions, where it lists the files and the frontmatter.
- **`docs/decisions.md`:** a section "## The console, part 3: steering (2026-10-17)" with:
  - the spike's six answers, as a short table or list;
  - the ten decisions at the top of this plan;
  - what the reviews change (added by the controller later, if any).
- **The spec, under "# Part 3: Steering":** a "Built" note pointing at this plan, with the differences:
  - old prompts get conversation.md appended;
  - intake keeps its string question;
  - chat answers through the orchestrator's `answer` action rather than a direct thread reply;
  - redirects stay in one phase row.

- [ ] **Step 2: Check the docs tests**

Run: `bun test tests/unit/templates.test.ts tests/unit/templates-roundtrip.test.ts tests/unit/init.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md templates docs
git commit -m "docs: steering, questions and conversation.md"
```

---

### Task 19: verify everything

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run test` → every test passes.
  - The lanes flake: if it fails, run the file alone.
  - Also run the suite in WSL (`~/lc`, Linux), as part 2's CI fixes did: `git pull` the branch there, then `bun run test`.
- [ ] **Step 3: In the browser.** The controller does this with a demo repository, a real loop and the fake claude, with long fake sessions (`LOOPSTRA_FAKE_DELAY_MS=40000`, plus a `wait_for` gate where needed):
  - on a running design session's page, send a message: it shows in the transcript as a message, Activity says it was sent, and conversation.md has it;
  - redirect it, then stop another session: the phase ends interrupted "stopped by <you>", the change is held, and the Live card goes;
  - a check's page shows only Stop, with the checks note;
  - a change whose design asks a question (a fixture that asks): the inbox has "Has a question"; answer it inline. On the next step the session resumes (the trace shows `--resume` through `LOOPSTRA_FAKE_CALLS`) and the change goes on;
  - "Ask the orchestrator" from a session: the first message carries the context (check the thread file's message text, or a trace of the turn);
  - 375 px, light and dark; no console errors.
- [ ] **Step 4:** Make one real-CLI check that a live session still ends cleanly. Run a single design-like `runPhase` with `live` against the real `claude`, model haiku and a $0.10 cap, the way the spike did: it must succeed and exit. Record it in decisions.md.
