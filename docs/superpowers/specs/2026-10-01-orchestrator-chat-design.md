# Orchestrator chat: talk to Loopstra, get intents as pull requests

Status: built (see the README's Chat section, and `docs/decisions.md` for how). Replaces the earlier "intent sources" proposal (raw chat messages turned straight into draft intents).

## Problem

Today a person feeds Loopstra by writing `intent/<slug>/intent.md` by hand, and finds out how things are going with `loopstra status`, `tail` or the dashboard. The operator skill helps, but only inside a Claude Code session in the repo.

What we want instead is one agent to talk to, from wherever we are:

- **Updates.** "What's in flight?", "Why is add-csv-export blocked?", "What merged this week?" It answers from the repo and the trace, and it tells us when something needs us without being asked.
- **Requirements.** "I want people to be able to export their reports." It talks it through: asks what done looks like, who it affects, whether it should be split, what it depends on. It does not write anything until we agree.
- **Hand-off.** When we agree, it passes an agreed brief to a separate writing agent, which writes one or more intent files and opens a pull request with them. Merging that PR is how the work enters the queue.

## Pieces

```
 person ──chat──▶  transport (dashboard panel, terminal, Slack, Discord)
                        │
                        ▼
                  ORCHESTRATOR  (one conversation per thread, read-only)
                   │        ▲
     reads repo,   │        │  announcements: "needs you" items as they appear
     trace, status │        │
                   ▼        │
              handoff(brief) ── person confirms ──▶ WRITER (fresh context, no chat history)
                                                       │ returns intent(s) as structured output
                                                       ▼
                                                 RUNTIME: worktree, commit, push, gh pr create
                                                       │
                                                       ▼
                                          PR reviewed + merged ──▶ syncMain ──▶ loop picks it up
```

Three roles, each kept to what it is good at, the same split the loop already uses:

1. **Orchestrator (agent).** Converses. Reads; never writes. Decides when a conversation has produced something worth handing off, and says so. Its one action is asking the runtime to accept a draft, for a named acceptor (see "Accepting from chat").
2. **Writer (agent).** Turns an agreed brief into intents that pass the loop's own consistency check. Fresh context, so it writes from the brief alone and the brief has to be complete (the same reason gates use fresh-context reviewers).
3. **Runtime (code).** Holds conversations, runs both agents, asks for confirmation, writes the files, makes the branch, commit and pull request, and posts announcements. Agents propose, the runtime writes.

## The orchestrator

### Process

A new command, `loopstra chat`, runs separately from `loopstra start`. The loop stays exactly as it is: one deterministic process, one change at a time. The orchestrator never touches the main checkout, never runs stages, and never changes a status; if it did, it would be racing the loop. It reads the same files and `trace.db` the dashboard reads (SQLite WAL already allows that).

`loopstra chat` serves whichever transports are configured (see Transports). `loopstra ui` also starts it (unless `--no-chat`) so the dashboard has a chat panel without a second command.

### A turn

Each user message is one headless `claude -p` call, using the runner that already exists in `src/claude.ts`:

- `--resume <session id>` for that thread, so the conversation carries over. Session ids are kept with each thread's state in `.loopstra/chat/threads/`. Subscription auth, no API key, as everywhere else.
- `cwd` is the repo root, read-only tools: `Read`, `Glob`, `Grep`, `Bash(loopstra status)` (with or without arguments). No `Edit`, no `Write`, and no git: `git show <rev>:<path>` and `git log -p` would read any file's past content around the read rules, so the runtime puts the main branch's newest commit subjects in each message's context instead.
- A new `loopstra/prompts/orchestrator.md` system prompt carrying what the operator skill already knows: the state machine, what each status means for a person, how big one intent can be, when to split and use `depends_on`, plain language for owners.
- `--json-schema` so the turn returns structured output, like every phase:

```ts
type OrchestratorTurn = {
  reply: string;                 // what the person sees
  handoff: null | {
    title: string;               // for the PR
    brief: string;               // everything agreed: problem, outcome, done-when, users, constraints,
                                 // open questions, suggested split, depends_on, priority
    updates: string[];           // slugs of existing draft intents this changes; empty for new work
  };
  accept: null | { slug: string };  // the person asked to start this draft (see "Accepting from chat")
};
```

**A running thread.** A thread is not finished by a hand-off. The same conversation can go on to the next feature, refine something already handed off, or accept it once its PR merges. The thread's state file keeps, besides the session id, the hand-offs made from it (title, slugs, PR link and state), and each turn's prompt is prefixed with that list, so the orchestrator knows what this thread has already produced even after its context is compacted.

Each turn is traced as a phase under the `_chat` slug, so its cost shows in the dashboard's totals and `loopstra tail _chat` shows the conversation's activity.

### Confirming the hand-off

The orchestrator can only propose a hand-off; it never triggers one on its own say-so. When a turn returns `handoff`, the runtime (not the agent) shows the brief and asks a fixed question: "Shall I write this up as a pull request?" Only a plain yes from the person starts the writer. Anything else goes back into the conversation as the next message. This keeps an off-hand "sounds good" mid-discussion from opening PRs, and makes the step a person approves visible and deterministic.

### Announcements

The orchestrator should tell us things, not only answer. `src/attention.ts` already computes the "Needs attention" list for `status` and the dashboard. Each chat process re-reads it every `poll_seconds`; the one holding `.loopstra/chat/announcer.lock` (taken over when its holder dies or stops polling for five minutes) compares it with the last poll (kept in `.loopstra/chat/announcer.json`) and appends each new item to `.loopstra/chat/announcements.jsonl` as one plain message: blocked with its note, waiting for a person, main's tests failing, the loop paused. Plus events people care about that are not "attention": a change merged, a change done, and (told in the thread that opened it, from a check of GitHub every minute) an intent PR the writer opened was merged or closed. Every chat process passes new log entries to its own surfaces.

Announcements go only where configured: each bot transport posts to its `announce_to` channel. The terminal and the dashboard panel show them while they are open; they do not queue up for later.

Announcements are code, not agent turns: no cost, and the wording is the same as `status`. They are also appended to the thread's session as context, so "why?" after an announcement works.

## The writer

A fresh `claude -p` session per hand-off, read-only tools, `loopstra/prompts/write-intent.md`, given:

- the brief, delimited as the agreed requirements;
- `intent/README.md` (the template and the owner's guide);
- the list of existing slugs and their statuses, for unique slugs and correct `depends_on`;
- for `updates`, the current text of those intents.

It returns structured output:

```ts
type WriterResult = {
  intents: Array<{
    slug: string;                // checked against SLUG and existing slugs by the runtime
    priority?: "urgent" | "high" | "normal" | "low";
    depends_on?: string[];
    title: string;
    sections: Record<"Problem" | "Proposed outcome" | "Done when" | "Affected users and systems"
                     | "Constraints" | "Open questions", string>;
  }>;
  summary: string;               // for the PR body
};
```

The runtime renders each intent with `serializeIntentFile`, then runs `checkConsistency` on it before anything is committed. A failure goes back to the writer once with the problem (the same one-rewrite rule gates use); a second failure is reported in the chat and no PR is opened.

## The pull request

The runtime, not an agent:

1. Fetches, then adds a detached worktree under `.loopstra/chat/worktrees/` at `origin/<main_branch>` (the existing `withDetachedWorktree`) and checks the writer's work against it. The main checkout the loop uses is never touched.
2. Writes `intent/<slug>/intent.md` for each intent, commits (`intent(<slug>): propose <title>`, no `[skip ci]`), pushes to a free branch `intent-proposal/<slug>` (`-2`, `-3` when taken), and opens the PR with `GitHub.createPr`. The body is the writer's summary, the brief, and a link back to the conversation where the transport has one.
3. Replies in the chat with the PR link, and later announces when it merges or closes.
4. Removes the worktree. The remote branch is GitHub's to delete on merge.

### What status the files carry

Decided: **merging is filing.** The PR's files carry `status: draft`. Merging puts them in the queue and nothing starts until someone accepts, either by editing the status line as today or by telling the orchestrator (next section).

### Without a remote

No PR is possible. Since only the loop writes the main checkout, `loopstra chat` leaves the rendered files in a request under `.loopstra/chat/requests/`, and the loop moves them into `intent/` as `draft` at the start of its next tick and commits them as bookkeeping (the same path as accept requests). The chat says so, and the loop then treats them like any hand-written draft.

### Changing an existing intent

When the brief names `updates`, the writer returns the new text for those slugs and the PR edits them. Only intents still in `draft` may be changed this way; for anything further along, the orchestrator explains that the change should be closed and a new one written, or a person should edit it. The runtime enforces this, not the prompt.

## Accepting from chat

The orchestrator is read-only with one exception: moving a `draft` to `accepted` when an acceptor asks.

- **Who.** Only people on the transport's `acceptors` list (`chat.transports.<bot>.acceptors`, user ids), and whoever uses the terminal or the dashboard, which only listen on this machine. Anyone on the transport's `allow` list can talk to it, ask for updates and agree requirements; only acceptors can start work.
- **How it is asked.** The orchestrator returns `accept: { slug }` in its structured output when the person asks for it. As with a hand-off, the runtime, not the agent, then asks a fixed question, "Start work on add-csv-export now?", and only a yes from an acceptor goes ahead. A person not on the list is told plainly that they cannot accept, and who can.
- **Who writes.** Not the chat process. The loop is the only writer of the main checkout, and keeping it that way avoids two processes committing on `main` at once. `loopstra chat` drops a request in `.loopstra/chat/requests/` (who, when, which thread). At the start of its next tick, right after `syncMain`, the loop applies each request with `writeIntent(intent, { status: "accepted" }, { expectStatus: "draft" })`, so a person's edit in the meantime wins, commits it as bookkeeping (`loopstra(<slug>): accepted by <name> from chat [skip ci]`), traces who accepted, and deletes the request.
- **Reporting back.** The loop leaves a result in `.loopstra/chat/results/`, and the chat process serving that thread replies "Started ..." in it. A request the loop could not apply (the status was no longer `draft`, the intent is not on main yet because its PR is unmerged) gets a plain reply saying why. If the loop is not running, the reply says the change will start when it is.

## Transports

The orchestrator and writer do not know where the chat is. A transport is a small adapter:

```ts
interface Transport {
  name: string;                    // part of every thread key: terminal, dashboard, slack, discord
  via: string;                     // in words, for prompts and intents: "Slack"
  /** Delivers incoming messages: thread, author id and name, text, and whether the author may start drafts. */
  start(onMessage: (m: { thread: string; authorId: string; authorName: string; text: string; canAccept: boolean; acceptors: string }) => Promise<void>): Promise<void>;
  send(thread: string, text: string): Promise<void>;
  announce?(text: string): Promise<void>;   // where this transport shows announcements, if anywhere
  announceFrom?: "now" | "kept";            // only while open, or a cursor kept across restarts
  stop(): Promise<void>;
}
```

All four are wanted. Built in this order, each on the same core:

1. **Terminal.** `loopstra chat` is a plain REPL (alongside any bots; `--no-terminal` leaves it out). Quickest place to get the orchestrator's prompt right.
2. **Dashboard panel.** A chat box in `loopstra ui`, one thread per browser tab, posting to `/api/chat` and reading the thread back with `GET /api/chat`. Local only (127.0.0.1), no credentials; posts only from the page's own origin.
3. **Slack.** Bot in one channel; each top-level message starts a thread, replies continue it. Socket Mode (an outbound websocket) works without a public address, so it still runs on a laptop. Tokens in environment variables named in config, never in the file.
4. **Discord.** Gateway connection, same thread model; needs the Message Content intent.

Only people on `allow` (per transport, user ids) can talk to it; others are ignored. Terminal and dashboard are local, so whoever runs them is allowed and is an acceptor.

## Config

```yaml
chat:
  model: default                  # orchestrator; writer uses stages.design.model
  max_budget_usd_per_day: 5       # chat turns + writer runs; past it the orchestrator replies that it is out for today
  transports:
    slack:
      token_env: LOOPSTRA_SLACK_APP_TOKEN
      bot_token_env: LOOPSTRA_SLACK_BOT_TOKEN
      channel: C0123ABCD
      allow: [U01AAA, U01BBB, U01CCC]   # may chat
      acceptors: [U01AAA]               # may also accept drafts
      announce_to: C0123ABCD
    discord:
      token_env: LOOPSTRA_DISCORD_TOKEN
      channel: "1234567890"
      allow: []
      acceptors: []
      announce_to: "1234567890"
```

The block is optional; without it, `loopstra chat` is the terminal REPL and `loopstra ui` gets the panel. Validated on load like the rest of the file; unknown keys are errors.

## Safety

- The orchestrator cannot write files. Its levers are proposing a hand-off and asking to accept a draft; code shows each to a person and waits for a yes, and acceptance needs a person on `acceptors`.
- The writer cannot write files either; the runtime checks slugs, renders the template and runs the consistency check.
- Every intent reaches the loop through a reviewed, merged PR (with a remote), and still starts only when a person accepts it. Chat text never becomes build instructions without a person approving it in chat, on the PR, and again by accepting.
- Only the loop writes the main checkout; the chat process only leaves requests for it.
- `allow` lists gate who can talk to it at all; Slack and Discord messages are untrusted text and are delimited as such in prompts.
- A daily budget caps what chat can spend, separate from the loop's per-session budget.

## Testing

The fake `claude` and fake `gh` executables the suite already uses cover both agents and the PR. New cases: a hand-off is never acted on without a yes; a writer result that fails `checkConsistency` gets one rewrite, then a chat message and no PR; slug clashes; updates refused for intents past `draft`; announcements once per new attention item; a dashboard `/api/chat` round trip; accept requests from a non-acceptor refused, from an acceptor applied once by the next tick, and lost to a person's edit when the status already moved; the loop and `loopstra chat` running together without touching each other's checkout. Slack and Discord adapters get a stub server via a base-URL environment variable.

## Rollout

1. Orchestrator turn + prompt, terminal REPL, read-only Q&A about status. Useful on its own.
2. Hand-off, confirmation, writer, PR with `draft` files. Running threads.
3. Accepting from chat: request files, the loop applying them, acceptors.
4. Announcements.
5. Dashboard panel.
6. Slack, then Discord.

All six shipped together on 2026-10-01.

## Decisions

- **PR files are drafts.** Merging an intent PR files the intents; it does not start them.
- **Accepting from chat** is allowed, for people on `acceptors`, confirmed with a yes, applied by the loop.
- **Otherwise read-only.** No retrying, closing or other status changes from chat; it tells the person what to edit.
- **Running threads.** One conversation can hand off many times.
- **All four surfaces**, built terminal, dashboard, Slack, Discord.
- **Announcements** go to each bot's configured channel, and show in the terminal and dashboard while open.
