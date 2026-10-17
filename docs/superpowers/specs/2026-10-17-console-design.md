# The console: see every agent, help them, steer them

Date: 2026-10-17. Status: designed, not built. Replaces the dashboard page of `loopstra ui`
(`src/ui/index.html`, `/api/state`). Three parts, each with its own plan and pull request:

1. **Console**: a new UI with live streams, read-only apart from chat as it is today.
2. **Controls**: approve, send back, retry, close, priority, hold, pause, stop, from the UI and from chat.
3. **Steering**: messages into a running agent's session, and agents that ask a person a question and wait.

Choices made with the user: steering goes all the way (live messages and help requests); the UI is
Preact bundled by Bun at start-up; it listens on this machine only; writes travel as files the loop
picks up (approach "file mailbox"), not through a socket or a server inside the loop.

## Problem

The dashboard is one page that polls every two seconds and shows a table. It cannot show what an
agent is doing right now (the live session events are already in the trace and in `raw.jsonl`, but
the page hides them in a "technical event log"), it is read-only apart from chat, and when an agent
goes wrong the only way to correct it is to wait for it to block, edit `intent.md`, and let the next
session start over. Agents never ask: anything they cannot decide either becomes a guess or a block.

What we want: one place, fast and calm to look at, where a person sees every running agent and what
it is doing, has everything that needs them in one inbox, can talk to the orchestrator about any of
it, and can steer: tell a running agent something, stop it, redirect it, or answer its question.

## Principles kept

- Only the loop writes and commits in the main checkout. The UI and chat leave requests; the loop
  applies them (chat already works this way: `src/chat/requests.ts`).
- Everything a person decides is a readable file in git (`intent.md`, and the new `conversation.md`).
  Machine state stays in `.loopstra/`.
- Plain words for owners. Agent output is untrusted and always escaped.
- The UI listens on 127.0.0.1 only. Slack and Discord stay the way in from elsewhere.

---

# Part 1: Console

## Layout

**Frame**, on every screen:

- Top bar: the loop pill ("Running · 2 agents · checked 4s ago", from `LoopStatus`), Pause/Resume
  (part 2), today's spend, the command palette (Ctrl/⌘ K), and the inbox bell with its count.
- Left rail: Live, Inbox, Changes, Activity, Spend.
- Orchestrator drawer (Ctrl/⌘ J), on the right of any screen. It opens with the context of what is on
  screen: the change, the question, or the session.

```
┌───────────────────────────────────────────────────────────────┐
│ ◉ Running · 2 agents · 4s     ⏸        $3.40 today   ⌘K  🔔 3 │
├────┬──────────────────────────────────────────────────────────┤
│Live│ ┌ csv-export ──────── build · sonnet ── 6m12s · ~$0.81 ┐ │
│Inbx│ │ now: Running bun test                    ▁▃▅▂▇▃▁▅   │ │
│Chgs│ │ [Open]  [Message]  [Stop]                            │ │
│Actv│ └──────────────────────────────────────────────────────┘ │
│Spnd│ ┌ dark-mode ─── review + verify · opus ── 2m · ~$0.40 ─┐ │
│    │ │ now: Reading src/theme.ts                            │ │
│    │ └──────────────────────────────────────────────────────┘ │
│    │ Up next: auth-retry (waits for csv-export: same files)   │
└────┴──────────────────────────────────────────────────────────┘
```

## Screens and routes

| Route | Screen | What it shows |
|---|---|---|
| `/` | Live | A card per running session: change, phase and model, a running clock, cost so far (`~`), a "now:" line from the newest tool call ("Editing src/parser.ts +12 −3", "Running bun test"), an activity strip of the last 30 events. Buttons: Open, Message, Stop (Message and Stop from parts 3 and 2). Under the cards: up next, each with why it waits; then the last five finished steps. Empty: "Nothing running. Next check in 12s." |
| `/s/<slug>/<seq>` | Session | The transcript, live while the phase runs: the agent's text; tool calls as one-line rows (tool, target, time, result) that expand to input and output; file edits as inline diffs; the agent's todo list pinned at the side; messages a person sent. Follows the live end until the person scrolls up, then shows "Jump to live". Side panel: model, started, cost, the session's limits, refused commands, `prompt.md` and `envelope.json`. Bottom: the message box, Stop, and Stop & redirect (part 3). |
| `/inbox` | Inbox | Everything that needs a person, most pressing first: agent questions (answer inline), reviews (the document inline; Approve, Send back with a note), blocked changes (the note; Retry, Close), held changes (Release), drafts (Accept, Close), then the loop and repository items (paused, main red, sync, settings). Keys: `j`/`k` move, `a` approve or accept, `r` reply, `o` open, `?` help. |
| `/changes` | Changes | A board with one column per stage: Draft, Design, Plan, Build, Review, Merge, Verify, Done; Blocked and Closed folded at the end. Cards: title, priority, time in status, cost, badges (waiting for a dependency, same files, held, has a question). Search, filter by status and priority, and a list view. |
| `/c/<slug>` (`/c/<slug>/<tab>`) | Change | Header: title, status, priority, the actions that apply. A stage stepper. Tabs: **Overview** (note, the intent, `conversation.md`), **Documents** (spec, plan, review, outcome, lessons, rendered), **Timeline** (phases as bars on a time axis, so phases that ran at once show side by side; each opens its session), **Code** (the branch's diff against main), **Gates** (each check, its result and evidence). |
| `/activity` | Activity | A feed in plain words across all changes and chat; filters by change and kind; a "technical" switch shows raw events. Pages back with `?before=<event id>`. |
| `/spend` | Spend | Today, this week, all time; per change; per phase name; by hour for the last two days; the cheaper judges' record (what `loopstra judges` shows). |

**Throughout.** The theme follows the system, with a toggle; dark is designed first. System fonts for
text, `ui-monospace` for code; no web fonts to fetch. A soft pulse marks anything live. Opt-in browser
notifications for a new question, a new block, and a review waiting. The tab title carries the inbox
count ("(3) Loopstra") and the favicon gets a dot. Keys: `g l`, `g i`, `g c`, `g a`, `g s` go to the
screens; Ctrl/⌘ K the palette (jump to a change or session, run any action the current screen
offers); Ctrl/⌘ J the orchestrator. Theme, notifications and the rail's state are kept in
`localStorage`, read in `try`, so a private window still works.

## Server

`loopstra ui` keeps its flags (`--port`, `--no-chat`) and its address (127.0.0.1). `src/commands/ui.ts`
becomes a thin router; the parts move to `src/console/`:

```
src/console/
  server.ts       routes, Host and Origin checks, static page
  model.ts        builds the five sections (from today's buildState, split up)
  hub.ts          the watcher and the SSE clients
  transcript.ts   raw stream-json events -> transcript items
  describe.ts     trace events -> plain sentences (shared with `loopstra tail`)
  diff.ts         a change's diff against main, capped
src/ui/
  index.html      Bun HTML import: the page and its bundle
  app.tsx, store.ts, router.ts, keys.ts, palette.ts
  views/  Live.tsx  Session.tsx  Inbox.tsx  Changes.tsx  Change.tsx  Activity.tsx  Spend.tsx
  parts/  Orchestrator.tsx  Markdown.tsx  Diff.tsx  Transcript.tsx  ...
  theme.css
```

`Bun.serve` with `routes` serves `index.html` as an HTML import with `development: false`: Bun
bundles and minifies the TSX once at start-up and caches it. No build step, nothing generated is
committed. The app routes (`/`, `/inbox`, `/changes`, `/c/*`, `/s/*`, `/activity`, `/spend`) all
serve the page, so links and the back button work.

**Every data route** must name a local host (`127.0.0.1`, `localhost`, or `[::1]` with the port);
anything else gets 403. This closes the review finding that only `/api/chat` checked it. The page
and its bundled chunks are static, the same for everyone, and Bun serves them from `routes` before
the router runs, so they carry no Host check and nothing private. Writes
(parts 2 and 3, and chat) also need POST, `content-type: application/json`, and an `Origin` equal to
the page's own.

### Reads

| Endpoint | Returns |
|---|---|
| `GET /api/stream` | SSE: the model's sections and new trace events (below) |
| `GET /api/changes/<slug>` | phases (with files and refused commands), gates, documents, `conversation.md`, retry status |
| `GET /api/changes/<slug>/diff` | `git diff <main>...intent/<slug>`: a stat and the patch, cut at 1 MB or 5,000 lines with a note |
| `GET /api/sessions/<slug>/<seq>/stream?from=<byte>` | SSE: the phase's transcript items (below) |
| `GET /api/events?before=<id>&slug=&kind=` | a page of 200 plain-words events for Activity |
| `GET /api/spend` | the Spend screen's figures |
| `GET /docs/<slug>/<name>`, `GET /files/...` | as today (`resolveDocument`, `resolveRunFile`) |

### The live stream

On connect the client gets one `snapshot` message with five sections:

- `loop`: `LoopStatus`, the pause or hold, the next check time.
- `inbox`: the attention items (`attention()`), plus questions and held changes (parts 2 and 3), each
  with the actions it offers.
- `changes`: one summary per change (slug, title, status, plain status, priority, since, cost,
  badges, why it waits).
- `running`: one entry per running phase: slug, seq, name, model, started, cost so far, the "now:"
  line, the last 30 event kinds for the strip.
- `totals`: today, this week, all time.

**One watcher** per server, shared by all tabs. Every 500 ms, and on `fs.watch` of `intent/` and
`.loopstra/`, it checks the heartbeat's mtime, the trace's newest event id and phase change, and the
intent files' mtimes. When any changed it rebuilds the model (at most four times a second), compares
each section with the last one sent (by a hash of its JSON), and sends a `section` message for each
that changed, replacing it whole. New trace events go out as `event` messages, each with its id as the
SSE id; a reconnect sends `Last-Event-ID` and gets the events after it, then a fresh snapshot. A
comment line every 15 s keeps the connection alive. A client that cannot be written to is dropped.

The **"now:" line** is the newest `claude_event` of the running phase, read as: the tool and its target
(file path, command, pattern), or "Thinking" when the newest is text. **Cost so far** is shown with
`~`: the CLI reports cost only at a session's end, so it is the minutes so far times the per-minute
rate Loopstra already uses for sessions killed before they report (`budget.ts`), never more than the
session's cap. **Why it waits** comes from the same code that writes `queue.md` (dependencies, the
same files, the day's budget, held, a question).

### Session transcripts

`/api/sessions/<slug>/<seq>/stream` reads `.loopstra/runs/<slug>/phases/<seq>-<name>/raw.jsonl` from
the byte offset `from` (0 at first; the SSE id of each message is the offset after it, so a reconnect
continues where it was). While the phase runs it checks the file every 250 ms (fs.watch on a growing
file is unreliable on Windows); when the phase row has ended and the file is read to its end, it sends
`end` and closes. A chat session (`_chat`) streams the same way.

`transcript.ts` turns raw events into items, so the browser never parses Claude's format:

```ts
type TranscriptItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; tool: string; target: string; input: unknown }
  | { kind: "tool-result"; id: string; ok: boolean; output: string }   // output cut at 256 KB
  | { kind: "edit"; id: string; path: string; diff: string }           // Edit, Write, MultiEdit
  | { kind: "todos"; items: Array<{ text: string; state: string }> }
  | { kind: "message"; by: string; text: string }                      // a person's message (part 3)
  | { kind: "result"; ok: boolean; summary: string; costUsd: number | null };
```

Unknown event types are skipped, never shown raw.

## Browser

- **State.** `store.ts` holds one Preact signal per section, plus the open change and session. The
  SSE client reconnects with backoff (1, 2, 4, then 8 s). Twenty seconds without a message shows a
  "Reconnecting…" bar and marks live parts stale, so old data never passes as live. Actions are
  disabled while disconnected.
- **Long transcripts.** A windowed list renders only what is on screen, so a session of 5,000 items
  scrolls smoothly. Tool output is folded by default and cut at 200 lines with "Show all".
- **Markdown** (documents, notes, the orchestrator's replies) goes through `marked` with raw HTML
  escaped, never rendered, and links only when they are `http(s)` or relative; they open in a new tab
  with `rel="noopener noreferrer"`. No `innerHTML` of anything else.
- **Diffs** are drawn by a small renderer of our own from unified diff text.
- **Chat.** The drawer uses the existing dashboard transport (`/api/chat`), with one thread per tab as
  today. Opening it from a change, a question or a session starts the first message with
  "About csv-export: "; part 3 replaces that with fuller context the person does not have to see.

New dependencies: `preact`, `@preact/signals`, `marked`.

## Speed budgets

- The bundled JS is under 80 KB gzipped.
- First useful paint under 300 ms on this machine.
- A model rebuild under 50 ms with 200 changes (helped by simpler-core's trace indexes).
- A session of 5,000 items scrolls without dropped frames.

## What goes

`src/ui/index.html` (the old page), `/api/state` and `buildState`'s single-shot shape. Their tests
are replaced by the tests below. The README's Watch section is rewritten.

---

# Part 2: Controls

> **Built** (2026-10-17), from `docs/superpowers/plans/2026-10-17-console-part-2.md`; `docs/decisions.md`
> ("The console, part 2") records the decisions. Four places differ from the text below: priority, hold
> and release apply whatever the change's status is now (any open change), not only when it is still
> the status the person saw; Hold is not offered on a draft or a blocked change (neither runs, so
> there is nothing to hold); the step after an approval starts on the next tick (the request lands
> within seconds; with the loop sleeping, the wake starts a tick at once; while lanes run, it waits
> for them); and Stop session waits for part 3.

Builds on simpler-core (`commitRecord`, the records lock, the watcher). It starts once
`feat/simpler-core` is merged.

## One way in: requests

`src/chat/requests.ts` becomes `src/requests.ts`, used by the UI server and by chat. A request is a
JSON file in `.loopstra/requests/`; the loop applies it and leaves a plain-words result in
`.loopstra/requests/results/` for whoever asked (the dashboard turns it into a toast; chat posts it
in the thread). After an upgrade, the applier also drains the old `.loopstra/chat/requests/` once.

```ts
interface RequestBase {
  id: string; by: string; byName: string; via: string;   // "the dashboard", "Slack", ...
  transport: string; thread: string; at: string;
  written?: string[];                                    // as today
}
type Request = RequestBase & (
  | { kind: "accept"; slug: string }                     // as today
  | { kind: "new"; title: string; intents: Array<{ slug: string; text: string; update: boolean }> }  // as today
  | { kind: "approve"; slug: string; expect: Status }
  | { kind: "send-back"; slug: string; expect: Status; note: string }
  | { kind: "retry"; slug: string; expect: "blocked"; to: Status }
  | { kind: "close"; slug: string; expect: Status }
  | { kind: "priority"; slug: string; expect: Status; priority: Priority }
  | { kind: "hold"; slug: string; expect: Status; reason: string }
  | { kind: "release"; slug: string; expect: Status }
  | { kind: "answer"; slug: string; question: string; text: string }   // part 3
);
```

**Applying fast.** A small applier runs in the loop process beside the tick, from start to stop. It
wakes on `fs.watch` of `.loopstra/requests/` and every 2 s, and applies each pending request, oldest
first, through `commitRecord`. The tick start still applies what is left, as today. The UI also
touches `.loopstra/wake`; the loop's sleep between ticks watches that file (and checks it each
second) and starts the next tick at once. So with the loop running, an approval lands and its next
step starts within a couple of seconds. With the loop stopped, the request waits and the UI says
"Applies when the loop starts."

**Compare and swap.** Each request names the status the person saw (`expect`). The loop applies it
only if the status is still that; otherwise it does nothing and answers, for example, "csv-export
moved on to building; nothing changed."

**Attribution.** The commit reads `loopstra(<slug>): plan approved by John from the dashboard` (or
"from Slack"). Each applied request is traced as a `request` event, which Activity shows.

**Safety of writes.** Protection against the page being framed by another site (`frame-ancestors`,
or `X-Frame-Options`) needs a response header, and the static page route Bun serves cannot set one
(a `<meta>` policy ignores `frame-ancestors`). So clicks cannot be kept from a framed page by the
page itself: every write must keep requiring POST with `content-type: application/json` and an
`Origin` equal to the page's own, which a framing site's requests cannot send.

## The actions

| Action | Offered at | The loop sets |
|---|---|---|
| Approve | `spec-review`, `plan-review`, `merge-review`, `verifying` | `spec-approved`, `plan-approved`, `merge-approved`, `done` |
| Send back, with a note | `spec-review`, `plan-review`, `merge-review` | `accepted`, `spec-approved`, `plan-approved`; the note goes into `note:` and, from part 3 on, into `conversation.md` |
| Retry | `blocked` | the retry status (below) |
| Accept | `draft` | `accepted` (as chat does today) |
| Close | any status but `done`, `closed` | `closed` |
| Priority | any open status | `priority:` |
| Hold / Release | any open status | adds or removes `hold: <reason>` |
| Pause / Resume the loop | always | not a request: the UI writes or removes `.loopstra/hold.json` (`{ by, at }`) |
| Stop session | any running phase, checks included | part 3's `stop` message, plus a `hold` request ("Stopped by John from the dashboard") |

**Retry status.** `blockNote` already works out the status the note tells a person to set. It will
also put it in the block's `status_change` event payload (`retry`). The server offers Retry with the
newest block event's `retry`; for a block from before this change, the status named in the note
("set status to X", when X is a valid status); otherwise no Retry button, only the note.

**Held changes.** `hold` is a new optional frontmatter field (plain text, written by the runtime or a
person; blank reads as absent). The scheduler skips a held change. It shows in "Needs attention" as
"Held" with the reason, in `status`, `queue.md` and the console. A person can also add or remove the
line by hand.

**Pausing the loop.** While `.loopstra/hold.json` exists, the tick starts no new step; running steps
and the merge watcher finish what they are doing. The loop line reads "Paused by John: running steps
finish, nothing new starts." It is not the outage pause (`paused.json`) and never clears by itself.

**Undo.** After an action, a toast offers Undo for 10 s. Undo sends the reverse request (approve and
send-back go back to the review status; hold and release swap; priority goes back), with `expect`
set to the status the first request led to, so it does nothing if the loop has moved on.

**Confirmation** only for Close and Stop.

## Chat gets the same actions

The orchestrator's turn schema gains an `action` (one request it proposes, in the shape above). Like
the hand-off, the runtime asks "Approve the plan for csv-export?" and only a plain yes from the person
it asked submits it, within a day. On Slack and Discord only people on that bot's `acceptors` may;
at the terminal and the dashboard anyone may. The prompt (`orchestrator.md`) says which actions exist
and that it must never claim one happened before the result comes back.

---

# Part 3: Steering

## Sessions keep stdin open

Every agent session starts with `--input-format stream-json` beside `--output-format stream-json`.
The prompt is sent as the first message:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```

and stdin stays open until the session is finished (below). Chat sessions are unchanged.

**The spike comes first.** Before anything else in part 3, a short spike with the real CLI
(2.1.302 here) answers, and records in `docs/decisions.md`:

1. Does the session wait for more input after its result, and exit when stdin closes?
2. A message written while a turn runs: is it read at the next tool boundary, or queued as a new turn
   after the result?
3. Does `--json-schema` structured output still arrive on the result of each turn?
4. Do `--resume` and `stream-json` input work together?
5. Is `total_cost_usd` on a later result the session's total, or that turn's?

If the answers rule live input out, part 3 still ships everything else: messages then go to the
change's next session through `conversation.md` (below), and Stop & redirect still works.

## Messages to a running agent

**Which sessions.** Any running session can be stopped. Only work sessions can be messaged or
redirected: `intake`, `design`, `plan`, `build`, `fix`, `reconcile`, `revise`, `lessons`. Not the checks: `review`, `verify`, the spec check, the plan challenge, the done-check and
the cheaper judges. A message to a judge would quietly change a gate, so the UI says "Checks cannot
be messaged. Approve or send back instead."

**Delivery.** The UI posts `/api/sessions/<slug>/<seq>/message` (`{ kind, text }`), and the server
writes `.loopstra/runs/<slug>/inbox/<id>.json` (`{ id, seq, kind: "message" | "stop" | "redirect",
text, by, at }`). While its session runs, the phase runner (simpler-core's `src/sessions.ts`)
watches that folder (`fs.watch`, and every second) and, for each file addressed to its `seq`:

- `message`: writes it to stdin as a user message, "A message from John, who is watching this work
  from the Loopstra dashboard: <text>. Take it into account and carry on. Your final answer keeps the
  same format.", moves the file to `inbox/delivered/` with the time, traces a `steer` event, and
  adds an entry to `conversation.md`. The transcript shows it as a `message` item.
- `stop`: ends the session the way a stop request ends it today; the phase ends `interrupted` with
  "stopped by <name>". The `hold` request that came with it keeps the change from starting again.
- `redirect`: ends the session, then resumes it at once with `--resume <session id>` and the text as
  the prompt, in the same phase. What the session already cost counts toward its cap, as re-sends do
  today. The redirect is traced and added to `conversation.md`.

**Which result counts.** The phase's result is the newest result the session gives once every
message delivered to it has been answered: after each result, if a message was delivered after that
turn began, the runner keeps stdin open for the turn that answers it; otherwise it closes stdin and
the session ends. This holds whether the CLI reads a message mid-turn or queues it.

**Nothing is lost.** A message not delivered by the time its session ends (it came too late, or the
loop was stopped) is added to `conversation.md` as "for the next session". Inbox files a killed loop
left behind are delivered the same way at the change's next step.

## The record: `intent/<slug>/conversation.md`

One readable file per change, in git, written only by the loop through `commitRecord`:

```markdown
# Conversation

## 2026-10-17 14:02 · John (dashboard) → build
Use the existing CSV parser in src/io/csv.ts; don't add a dependency.

## 2026-10-17 14:31 · build asks
Should exported rows include archived reports?
Why: the intent says "all reports" but the list screen hides archived ones.
Options: include them · leave them out

## 2026-10-17 14:40 · John (Slack) answers
Leave them out.
```

Every work session's prompt gets the file's text through a new `{{conversation}}` placeholder (empty
when there is none), under "What people told earlier sessions of this change". The shipped prompts
gain it; a repository's own prompts without it simply do not see it. Send-back notes (part 2) are
added here too.

## Agents asking for help

**The field.** The envelopes of `intake`, `design`, `plan`, `build`, `fix`, `reconcile` and `revise`
gain an optional `question: { text: string; why: string; options?: string[] }`. Their prompts say:
ask only when the decision belongs to a person and there is no sensible default; otherwise decide,
and say what was decided and why in the summary. A code session that asks keeps its work: its
worktree is saved as it is today before the step ends.

**When an agent asks**, the session has ended cleanly. The runtime:

1. traces the phase as `asked` (a new phase status) with the question;
2. adds the question to `conversation.md`;
3. sets `question: open` in the frontmatter (new optional field, runtime-managed), leaving `status`
   as it was;
4. announces it to chat: "csv-export's build agent asks: Should exported rows include archived
   reports? Reply in this thread to answer."

The scheduler skips a change with an open question, so it holds no lane and costs nothing while it
waits. It shows in "Needs attention" as "Has a question" (a new attention kind, `question`), in
`status`, `queue.md`, the console's inbox and badges.

**Answering.** In the console (inline in the inbox, or on the change), in chat (the orchestrator
proposes an `answer` action, or a reply in the announcement's thread from someone on `acceptors`),
or by hand: write the answer under the question in `conversation.md` and remove `question: open`.
The `answer` request adds the answer to `conversation.md` and clears `question`. On the change's next
step the runner resumes the asking session with `--resume <session id>` and the prompt "John
answered your question: <answer>. Carry on." If that session cannot be resumed (`no-session`), it
starts a fresh one, which gets the question and the answer through `{{conversation}}`.

**A limit.** At most 3 questions in one step. With 3 asked, the prompt says no more questions may be
asked; a 4th blocks the change with "The assistant kept asking questions on this step. Read
conversation.md, add what it needs to the intent, then set status to <retry>."

## The orchestrator as the helper

"Ask the orchestrator" on a question, a blocked change, a held change or a session opens the drawer
with that context in the first message's context (not the visible text): the intent,
`conversation.md`, the note, the newest phase's error, and the session's last 50 transcript items as
plain text. The orchestrator explains what happened and suggests an answer, a retry or a message,
which it can propose as an `action`. Its read-only limits stay as they are.

---

# Failure handling

- **The server never dies on a bad file.** A section that fails to build becomes a problem item; the
  other sections still go out. A watcher error is traced once, not every 500 ms.
- **A request the loop refuses** (status moved on, change held or closed, a session already ended)
  answers in plain words, shown as a toast or posted in chat.
- **A loop that is not running.** The console still shows everything; requests and answers wait in
  their files; Pause/Resume still works (the next start reads `hold.json`).
- **A killed loop mid-delivery.** A message is moved to `delivered/` only after its stdin write, so
  at worst it is delivered twice, and the second copy says it may repeat an earlier message.
- **A malformed `question`** is an invalid envelope, as any other.
- **fs.watch missing or quiet** (network drives, some Linux setups): every watcher also polls.

# Tests

**Console**

- The model: each section from fixtures; a section's hash changes only when its content does.
- The stream: a snapshot on connect, only changed sections after, events with ids, resume with
  `Last-Event-ID`, a keep-alive, a dropped client removed.
- Transcripts: `raw.jsonl` fixtures taken from real sessions turn into the right items; unknown
  events are skipped; `from` resumes mid-file; `end` after the phase ends.
- Every data route refuses a non-local Host; writes refuse a foreign Origin and non-JSON.
- The diff is cut at its limits with a note; documents and run files resolve as today.
- The bundle builds, the page serves on every app route, and the JS is under 80 KB gzipped.
- The store, router, keys and palette as pure functions.

**Controls**

- Each action applies with the right status, note and attribution, and refuses when `expect` does
  not match.
- Undo restores, and does nothing once the loop has moved on.
- The applier picks up a request through `fs.watch` and, with watching turned off, through its poll.
- A held change is skipped and listed under "Needs attention"; release resumes it.
- `hold.json` starts no new step and lets running ones finish; `wake` cuts the sleep short.
- A block records `retry`; Retry uses it, falls back to the note, and is not offered otherwise.
- Chat: an `action` needs a plain yes from the person asked, and an acceptor on Slack and Discord.

**Steering** (the fake `claude` behind `LOOPSTRA_CLAUDE_EXECUTABLE` learns to read stream-json
stdin, echo a message into its next turn, and answer with a question)

- A message is delivered mid-session, recorded in `conversation.md` and the trace, and the result
  after it counts.
- Stop ends the phase `interrupted` and holds the change.
- Redirect resumes the same session id in the same phase, and the cost carries over.
- A message that arrives after the session ended reaches the next session through `conversation.md`.
- A check session refuses messages.
- A question: the phase ends `asked`, `question: open` is set, the change is skipped, it is
  announced; an answer clears it and resumes the session; a lost session starts fresh with the
  conversation; a 4th question blocks.

Before each part is called done it is checked by hand in Chrome against a live loop. CI runs on
Windows, macOS and Linux as now.

# Build order

1. **Console**, branch `feat/console` from `main`. Independent of simpler-core.
2. **Controls**, after `feat/simpler-core` is merged.
3. **Steering**: the spike, then messages, then questions, then the orchestrator's actions.

# Docs

- README: Watch rewritten for the console; Chat gains actions; a new Steering section; `hold:`,
  `question:` and `conversation.md` where statuses are explained.
- `intent/README.md` (the owners' table): `hold`, `question`, `conversation.md`, answering by hand.
- `docs/decisions.md`: the choices above, and the spike's answers.

# Out of scope

- Access from other machines (the console stays on 127.0.0.1; chat covers elsewhere).
- Editing documents in the console. People still edit the files; the console reads them.
- Changing a gate's settings or the config from the console (`loopstra setup` does that).
- Messaging check sessions.
- Several people with separate identities: the console acts as the machine's user.
