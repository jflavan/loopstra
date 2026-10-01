# Orchestrator chat: talk to Loopstra, get intents as pull requests

Status: proposal. Nothing here is built yet. Replaces the earlier "intent sources" proposal (raw chat messages turned straight into draft intents).

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

1. **Orchestrator (agent).** Converses. Reads; never writes. Decides when a conversation has produced something worth handing off, and says so.
2. **Writer (agent).** Turns an agreed brief into intents that pass the loop's own consistency check. Fresh context, so it writes from the brief alone and the brief has to be complete (the same reason gates use fresh-context reviewers).
3. **Runtime (code).** Holds conversations, runs both agents, asks for confirmation, writes the files, makes the branch, commit and pull request, and posts announcements. Agents propose, the runtime writes.

## The orchestrator

### Process

A new command, `loopstra chat`, runs separately from `loopstra start`. The loop stays exactly as it is: one deterministic process, one change at a time. The orchestrator never touches the main checkout, never runs stages, and never changes a status; if it did, it would be racing the loop. It reads the same files and `trace.db` the dashboard reads (SQLite WAL already allows that).

`loopstra chat` serves whichever transports are configured (see Transports). `loopstra ui` can also start it so the dashboard has a chat panel without a second command.

### A turn

Each user message is one headless `claude -p` call, using the runner that already exists in `src/claude.ts`:

- `--resume <session id>` for that thread, so the conversation carries over. Session ids are kept in `.loopstra/chat/<thread>.json`. Subscription auth, no API key, as everywhere else.
- `cwd` is the repo root, read-only tools: `Read`, `Glob`, `Grep`, `Bash(loopstra status)`, `Bash(git log *)`, `Bash(git show *)`. No `Edit`, no `Write`.
- A new `loopstra/prompts/orchestrator.md` system prompt carrying what the operator skill already knows: the state machine, what each status means for a person, how big one intent can be, when to split and use `depends_on`, plain language for owners.
- `--json-schema` so the turn returns structured output, like every phase:

```ts
type OrchestratorTurn = {
  reply: string;                 // what the person sees
  handoff: null | {
    title: string;               // for the PR
    brief: string;               // everything agreed: problem, outcome, done-when, users, constraints,
                                 // open questions, suggested split, depends_on, priority
    updates?: string[];          // slugs of existing draft intents this changes, if any
  };
};
```

Each turn is traced as a phase under the `_chat` slug, so its cost shows in the dashboard's totals and `loopstra tail _chat` shows the conversation's activity.

### Confirming the hand-off

The orchestrator can only propose a hand-off; it never triggers one on its own say-so. When a turn returns `handoff`, the runtime (not the agent) shows the brief and asks a fixed question: "Shall I write this up as a pull request?" Only a plain yes from the person starts the writer. Anything else goes back into the conversation as the next message. This keeps an off-hand "sounds good" mid-discussion from opening PRs, and makes the step a person approves visible and deterministic.

### Announcements

The orchestrator should tell us things, not only answer. `src/attention.ts` already computes the "Needs attention" list for `status` and the dashboard. `loopstra chat` re-reads it every `poll_seconds` and, for items that are new since the last announcement (kept in `.loopstra/chat/announced.json`), posts one plain message to the configured announcement thread: blocked with its note, waiting for a person, main's tests failing, the loop paused. Plus two events people care about that are not "attention": a change merged, and an intent PR the writer opened was merged (so its work is now queued).

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

1. Fetches, then adds a worktree at `.loopstra/worktrees/_chat-<slug>` on a new branch `intent-proposal/<slug>` from `origin/<main_branch>` (the existing `Git.worktreeAdd`). The main checkout the loop uses is never touched.
2. Writes `intent/<slug>/intent.md` for each intent, commits (`intent(<slug>): propose <title>`, no `[skip ci]`), pushes, and opens the PR with `GitHub.createPr`. The body is the writer's summary, the brief, and a link back to the conversation where the transport has one.
3. Replies in the chat with the PR link, and later announces when it merges or closes.
4. Removes the worktree. The remote branch is GitHub's to delete on merge.

### What status the files carry

Two options; this is the main decision to make.

- **A. Merging is accepting.** Files are written with `status: accepted`. Reviewing and merging the PR is the person's acceptance, so the change starts on the next tick after the merge reaches main. One step for the person, and the review happens in the place engineers already review. The rule "a person always accepts" still holds; the act just moves from editing a status line to approving a PR. Branch protection decides who may accept.
- **B. Merging is filing.** Files are written as `status: draft`. Merging only puts them in the queue; someone still sets `accepted`. Two steps, but nothing starts without the status line, exactly as today.

Recommendation: A, with a config switch (`chat.pr_status: accepted | draft`, default `accepted`) for teams that want B.

### Without a remote

No PR is possible. The runtime writes the files as `draft` straight into `intent/` on the main checkout's working tree (not committed, as a person would) and says so in the chat. The loop treats them like any hand-written draft.

### Changing an existing intent

When the brief names `updates`, the writer returns the new text for those slugs and the PR edits them. Only intents still in `draft` (or `accepted` with A, before the loop has started them) may be changed this way; for anything further along, the orchestrator explains that the change should be closed and a new one written, or a person should edit it. The runtime enforces this, not the prompt.

## Transports

The orchestrator and writer do not know where the chat is. A transport is a small adapter:

```ts
interface Transport {
  name: string;
  /** Delivers incoming messages: (thread id, author id, text). */
  listen(onMessage: (m: { thread: string; author: string; text: string }) => Promise<void>): Promise<void>;
  send(thread: string, text: string): Promise<void>;
}
```

Proposed order:

1. **Dashboard panel.** A chat box in `loopstra ui`, one thread per browser tab, posting to `/api/chat`. Local only (127.0.0.1), no credentials, easiest to test. Good place to get the orchestrator's prompt right.
2. **Terminal.** `loopstra chat` with no transports configured is a plain REPL. Nearly free once 1 exists.
3. **Slack.** Bot in one channel; each top-level message starts a thread, replies continue it. Socket Mode (an outbound websocket) works without a public address, so it still runs on a laptop. Token in an environment variable named in config, never in the file.
4. **Discord.** Gateway connection, same thread model; needs the Message Content intent.

Only people on `chat.allow` (per transport, user ids) can talk to it; others are ignored. Announcements go to `chat.announce_to` (a channel or thread per transport).

## Config

```yaml
chat:
  model: default                  # orchestrator; writer uses stages.design.model
  pr_status: accepted             # or draft; see "What status the files carry"
  max_budget_usd_per_day: 5       # chat turns + writer runs; past it the orchestrator replies that it is out for today
  transports:
    slack:
      token_env: LOOPSTRA_SLACK_APP_TOKEN
      bot_token_env: LOOPSTRA_SLACK_BOT_TOKEN
      channel: C0123ABCD
      allow: [U01AAA, U01BBB]
      announce_to: C0123ABCD
```

The block is optional; without it, `loopstra chat` is the terminal REPL and `loopstra ui` gets the panel.

## Safety

- The orchestrator cannot write files or change statuses. Its only lever is proposing a hand-off, which code shows to a person and waits for a yes on.
- The writer cannot write files either; the runtime checks slugs, renders the template and runs the consistency check.
- Every intent reaches the loop through a reviewed, merged PR (with a remote). Chat text never becomes build instructions without a person approving it twice: once in the chat, once on the PR.
- `allow` lists gate who can talk to it at all; Slack and Discord messages are untrusted text and are delimited as such in prompts.
- A daily budget caps what chat can spend, separate from the loop's per-session budget.

## Testing

The fake `claude` and fake `gh` executables the suite already uses cover both agents and the PR. New cases: a hand-off is never acted on without a yes; a writer result that fails `checkConsistency` gets one rewrite, then a chat message and no PR; slug clashes; updates refused for intents past `accepted`; announcements once per new attention item; a dashboard `/api/chat` round trip; the loop and `loopstra chat` running together without touching each other's checkout. Slack and Discord adapters get a stub server via a base-URL environment variable.

## Rollout

1. Orchestrator turn + prompt, terminal REPL, read-only Q&A about status. (Useful on its own.)
2. Hand-off, confirmation, writer, PR. Option A for status.
3. Announcements.
4. Dashboard panel.
5. Slack, then Discord.

## Open questions

- A or B for the status the PR's files carry?
- Should one conversation be able to hand off more than once (a running "product thread"), or does a hand-off end the thread?
- Should the orchestrator be able to do the small owner actions it can see the need for (set `closed`, retry a blocked change from its `resume_from`) behind the same yes-confirmation, or stay strictly read-only and tell the person what to edit?
