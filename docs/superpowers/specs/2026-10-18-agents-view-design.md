# Agents: every active agent on one screen, each one steerable

Date: 2026-10-18. Status: built (plan: `docs/superpowers/plans/2026-10-18-agents-view.md`). Builds on the console
(`2026-10-17-console-design.md`, parts 1-3, merged as #32, #33, #34). One plan, one pull request.

Choices made with the user: a new rail item under Activity; a grid of mini consoles, not a list
with one open agent; tiles for running sessions, agents waiting on a question, the orchestrator,
and sessions that just finished; every steering control on the tile; a scrollable live tail per
tile; Live stays the overview; "ask the orchestrator" from a tile goes to the orchestrator tile;
one multiplexed stream for the whole grid.

## Problem

Steering works, but one session at a time: Live shows a card per running session, and Watch or
Message opens that session's page, where the transcript and the steering box are. With two or more
agents running (`speed.max_parallel_changes` up to 4, plus concurrent phases), a person watching
them all hops between pages, and the orchestrator sits in a drawer on top of whichever page is open.

What we want: one screen where every active agent is visible at once, live, and each can be
messaged, redirected, stopped, answered or asked about without leaving it.

## Screen

**Rail.** A new item, **Agents**, at `/agents`, between Activity and Spend, with its own icon. Its
badge counts running sessions plus open questions. Shortcut `g w` ("who is working"; `g a` is
Activity's), listed in the help overlay and the command palette.

**Grid.** Tiles fill the width, about 420px at the least each (`grid-template-columns:
repeat(auto-fill, minmax(420px, 1fr))`): one column on a phone, two or three on a desktop. A tile:

- **Header**: change title › phase name · short model, a running clock, the estimated cost so far
  (`~$0.20`, the same `costSoFar` as Live). The title links to the change; an ⤢ icon opens the
  session's page (`/s/<slug>/<seq>`).
- **Body**: the session's whole transcript in a pane of fixed height (about 12 rows) that follows
  the live end. Scrolling up stops following and shows a "↓ live" pill that jumps back. Rows are
  compact: the agent's text, one-line tool rows (tool, target, time, result), edits as `+12 −3`
  without the diff, and messages a person sent as bubbles. No todo list and no
  side panel: the session's page keeps those.
- **Footer**: a one-line message box, **Send**, **Redirect**, **Stop** (with the inline confirm
  the session page has), and 💬 (ask the orchestrator about this agent). A check phase offers only
  Stop, with the note it has today (`steerOffer`).

**Tile kinds.**

| Kind | Comes from | Body | Footer |
|---|---|---|---|
| Running session | the agents stream (`open`) | live transcript | message, redirect, stop, 💬 |
| Waiting on a question | `changes.value[].question` | the question and why it asks; the change's title links to its page (the summary does not name the asking session) | the Inbox's answer form: the same `answer` request, resuming the agent |
| Orchestrator | always shown (unless chat is off) | the chat conversation, the drawer's lines | a message box; an "about csv-export › build" tag when a 💬 set one, with × to clear it |
| Just finished | the agents stream (`end`) | the transcript, greyed | "Finished · $0.61", "Stopped" or "Failed"; only ⤢ stays enabled |

A finished tile stays 60 seconds, so it does not vanish while someone is typing to it, then
leaves. A change whose agent asked a question has no running session, so it has one tile, the
question's; once answered, the resumed session arrives as a running tile.

**Order.** Question tiles first, then running tiles in the order they started, then the
orchestrator. Positions never move under the person: a new tile is added at its group's end, and a
finished tile fades where it is.

**Empty.** "No agent is working. The next check is in 12s." (the Live wording). The orchestrator
tile is still there.

**Chat off** (`--no-chat`): no orchestrator tile and no 💬 buttons.

**Asking the orchestrator from a tile.** 💬 on an agent tile sets the orchestrator tile's `about`
to that change and session (the same `About` the drawer gets from `openDrawer`), scrolls to the
orchestrator tile and focuses its box. The first message after that carries the context, exactly
as the drawer's does (`aboutPrefix`, `aboutOf`). Other pages keep opening the drawer.

**Live.** Live stays the overview: cards, up next, just finished. A card's **Watch** goes to
`/agents#<slug>:<seq>`, which scrolls to that tile and highlights it for a moment; **Message** goes
to the same place and focuses its box. The session page is unchanged and stays the deep view of one
agent (diffs, todo list, files, refused commands). The command palette's "Watch …" commands open
the tile too.

## Server: `GET /api/agents/stream`

New module `src/console/agents.ts`, routed in `server.ts` beside the session stream, with the same
`sse()` wrapper, host check and idle handling.

- It follows the running change sessions: the same set the hub's `running` snapshot (`RunningPhase`
  list) is made from, read from the trace about once a second. `_chat` sessions are left out; the
  orchestrator tile reads `/api/chat`.
- For each session it sends, as JSON frames:
  - `{ type: "open", key: "<slug>:<seq>", phase }` when it starts following it;
  - `{ type: "item", key, item }` for each transcript row;
  - `{ type: "end", key, phase }` when the session has ended and its file is read to the end.
  `phase` and `item` are the shapes the session stream already sends (`SessionMessage`).
- **One reader.** `streamSession` in `src/console/session.ts` is split: a core that follows one
  session and calls `(msg: SessionMessage, offset: number) => boolean` (false: stop), and the
  existing wrapper that frames each message with its offset as the event id for
  `/api/sessions/<slug>/<seq>/stream`. The agents stream runs the core once per session and adds
  the key.
- **Reconnect.** The agents stream sends no event ids. After a reconnect it sends `open` again for
  every session still running, and the page empties that tile and takes the rows again from the
  start: the same replay the session page does when it opens. Ended sessions are not sent again;
  instead, after its first look the stream sends `{ type: "sync", keys }` with every session it
  follows, and the page ends the running tiles that `sync` does not name (they ended while it was
  away; such a tile takes its result and cost from the steps just finished). It pings every 15 s,
  and the page opens it again after 20 s of silence, as it does the live stream. A session missing
  from the running ones for 5 s (a killed loop left its row running) is let go and sent `end`.
- **The page goes away**: every follower stops and the trace closes, as the other streams do.
- Why one stream: the console is HTTP/1.1, and a browser keeps at most six connections to one
  origin. The page already holds `/api/stream`; one EventSource per tile would reach that limit
  with five agents, and then Send and Stop would wait behind it.

## Browser

| File | What |
|---|---|
| `src/ui/agents.ts` | Pure tile state: `step(tiles, msg, now)` for `open`, `item`, `end`; `questions(tiles, changes)` to add and remove question tiles; `prune(tiles, now)` to drop finished tiles after 60s; `order(tiles)` as above. No DOM, unit-tested. |
| `src/ui/views/Agents.tsx` | The grid. Opens the agents stream on mount, closes it on unmount; batches rows ten times a second as `Session.tsx` does; reads `location.hash` to scroll, highlight and focus. |
| `src/ui/parts/AgentTile.tsx` | The tile frame: header, body, footer, and the finished state. |
| `src/ui/parts/ChatTile.tsx` | The orchestrator tile. |
| `src/ui/parts/Transcript.tsx` | Gains `compact`: fixed height, its own follow and "↓ live", edits shown as counts. |
| `src/ui/parts/Steer.tsx` | Gains `compact`: a one-line box, Send / Redirect / Stop with the same confirm, and a slot for 💬. |
| `src/ui/parts/Drawer.tsx` | Exports its `Chat` (thread, polling, send, draft) with an `autoFocus` prop. The drawer and the orchestrator tile both show it, on the same tab thread, so they are one conversation. |
| `src/ui/parts/Actions.tsx` | The answer form is used by question tiles as it is (its "moved on" handling included). |
| `src/ui/parts/Rail.tsx`, `router.ts`, `app.tsx`, `shortcuts.ts` | The `/agents` route, the rail item and its badge, `g w`. |
| `src/ui/views/Live.tsx` | Watch and Message point to `/agents#<slug>:<seq>`. |
| `src/ui/theme.css` | The grid, the tile, the compact transcript, the fade. |

## Failure handling

- The agents stream drops: tiles keep their rows and the grid shows "Reconnecting…" until it is
  back; then `open` refreshes each running tile.
- A session with no `raw.jsonl` yet: its tile says "Starting…" until rows come.
- A send or stop fails: the text stays in the box and a toast says so (what `steer()` does now).
- A question answered elsewhere (Slack, the Inbox, another tab): the question tile leaves when the
  change's summary no longer has the question.
- Agent output is untrusted and escaped, as everywhere in the console.

## Tests

- `tests/unit/console-agents.test.ts`, against a fake trace and fake `raw.jsonl` files: two
  running sessions give `open` and tagged `item` frames; one ends and gives `end` after its last
  row; a third starting later gives `open`; `_chat` sessions are not followed; a closed page stops
  every follower and closes the trace; a reconnect sends `open` again for running sessions only.
- The split `streamSession`: the existing session stream tests pass unchanged.
- `tests/unit/agents-tiles.test.ts` for `src/ui/agents.ts`: order (questions, then start order,
  then the orchestrator); a new tile does not move existing ones; a finished tile stays 60s on an
  injected clock and then goes; `open` for a known key empties its rows; question tiles come and go
  with the summaries.
- Page tests (as in `console-page.test.ts`): `/agents` is served and routed; the rail shows it; Live's
  Watch and Message link to `/agents#key`.
- A browser check against the fake loop used for part 3: three agents and a question at once,
  message, redirect, stop and answer from tiles, 💬 into the orchestrator tile, a reconnect.

## Out of scope

- Arranging, pinning, resizing or hiding tiles.
- Past sessions: the grid shows what is active; finished work stays on Live, Changes and Activity.
- Inline diffs and the todo list on a tile (the session page has them).
- Steering chat sessions themselves.
