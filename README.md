# Loopstra

An unattended development loop built on Claude Code. Code owns the loop; agents own bounded phases; people own the decisions they choose to keep.

A product owner writes a plain-language `intent/<slug>/intent.md` and sets its status to `accepted`. Loopstra then designs, plans, builds, tests, reviews, merges and verifies the change, one step at a time, with a gate at every stage boundary. Every artifact is a Markdown file in git, and every step is recorded in a trace you can read from a terminal or a local dashboard. Instead of writing the intent by hand, you can also talk a change through with Loopstra's orchestrator in the terminal, the dashboard, Slack or Discord; it writes the intent up for you as a draft (see Chat).

There are two audiences and two surfaces:

- **Engineers** configure the machinery once: test command, gates, prompts, limits. All of it is in `loopstra/config.yaml` and `loopstra/prompts/`.
- **Product owners** only write plain markdown (the intent) and a status line, or talk to the orchestrator in chat. Notes addressed to them are plain sentences with retry advice, never commands, branch names or raw output.

## Requirements

- [Bun](https://bun.sh) 1.4.2 or later
- git 2.28 or later
- Claude Code CLI (`claude` on PATH), signed in with a subscription. Loopstra drives the CLI, not the API, so no API key is needed.
- GitHub CLI (`gh`), signed in, when the repo has a remote. `loopstra start` refuses to run otherwise.
- Optional, for chat on Slack or Discord: a Slack app or a Discord bot of your own (see Chat).

Windows, macOS and Linux are all supported; see Platforms.

## Install

Loopstra is installed once, globally, from a clone of this repo:

```
git clone <this repo> loopstra
cd loopstra
bun install
bun link
```

`bun link` puts a `loopstra` command on your PATH (in `~/.bun/bin`; make sure that folder is on PATH). Check it from any other directory:

```
loopstra help
```

The runtime stays in this checkout; repos only get config, prompts and a skill. To upgrade, pull and run `bun install` again.

## Set up a repo

```
cd your-repo
loopstra init
```

`init` needs a git repository (outside one it says "This folder is not a git repository; run git init first." and writes nothing). It is deterministic and never overwrites a file that already exists. It detects your test, lint, build and run commands and writes:

- `loopstra/config.yaml` and `loopstra/prompts/*.md` (one prompt per phase, including `orchestrator.md` and `write-intent.md` for chat)
- `intent/README.md` (the owner's guide) and `intent/queue.md`
- `REVIEW.md` (what the reviewer looks for) and a Commands block in `CLAUDE.md`
- `.claude/skills/loopstra/` (an operator skill for drafting intents, reading status and unblocking)
- a hook, wired into `.claude/settings.json`, that stops fix sessions editing tests to make them pass. Tests the change itself added or changed on its branch stay editable; when a fix is refused an edit, the block note names the file. Claude Code runs it through its own shell (`bun "$CLAUDE_PROJECT_DIR/.claude/hooks/loopstra-protect-tests.ts"`, Git Bash on Windows), so `bun` must be on the PATH Claude Code sees
- `.loopstra/` in `.gitignore`

Then:

`main_branch` in the config is the branch the repository is on when you run `init` (for a detached checkout, git's `init.defaultBranch`, else `main`).

1. Commit everything `init` wrote, on that branch. The loop works in its own checkouts, which only see what is committed, and `loopstra start` refuses until the config, prompts and hook are committed.
2. Open `loopstra/config.yaml` and confirm `commands.test`: the one command that runs your tests and exits non-zero on failure.
3. Choose which gates get a person (see Configuration). By default, only accepting an intent needs one.

You can also open Claude Code in the repo and ask the `loopstra` skill to walk you through this. The skill never runs the loop.

If you set the repo up before chat existed, run `loopstra init` again to stamp the two chat prompts (it keeps every file that exists), and commit them. Until then chat uses the shipped copies.

## Ask for a change

Either talk it through in chat (see Chat), which writes the intent for you, or write it yourself:

Make `intent/<slug>/`, where the slug is lowercase words joined by dashes, like `add-numbers`. Copy the template from `intent/README.md` into `intent.md` inside that folder (a Markdown file loose in `intent/` is listed as unreadable, with how to fix it):

```markdown
---
status: draft
# priority: low, normal, high or urgent. Leave it out and Loopstra fills it in.
# depends_on: [another-change] (optional: changes that must be merged first)
author: Your name
opened: 2026-01-01
note: ""
---
# Intent: a short title

## Problem
## Proposed outcome
## Done when
## Affected users and systems
## Constraints
## Open questions
```

Write it in your own words. "Done when" is a list someone could check. When it is ready, change `status: draft` to `status: accepted`. That is the only step a person must always take. Saving the file is enough; you do not need to commit it.

One change gets one spec, one plan and one build session, within `timeout_minutes` and `max_budget_usd`. Split larger work into several changes. When a change needs another to be in main first, list it under `depends_on`: the change is not started (or continued) until each one it names is in main: `merged`, `verifying` or `done`, or blocked or closed after it merged. A blocked dependency keeps it waiting, and `status`, `queue.md` and the dashboard say which change it waits for. A name that matches no change, a change closed before it merged, or two changes that wait for each other shows under "Needs attention".

Problem, Proposed outcome and Done when are required. An accepted request without them is blocked at once with a note like "This request is missing a Proposed outcome and a Done when section. Add them to intent.md, then set status to accepted."

## Run

```
loopstra start          # the loop; one step per tick, sleeps poll_seconds between ticks
loopstra start --once   # one tick, then exit (for cron or a scheduler)
```

`start` checks that the folder is set up (`loopstra/config.yaml` exists), that git and `claude` are installed, that you are on `main_branch`, that Loopstra's own files are committed, and (with a remote) that `gh` is signed in. It prints a plain message and exits if any is not true. `status`, `tail`, `ui` and `chat` in a folder that is not set up say "This folder is not set up for Loopstra. Run loopstra init first." and create nothing.

The loop never dies on a bad edit or a failed step; the problem is traced and the next tick comes. It runs one change at a time.

**Stopping.** Press Ctrl-C once to stop gracefully: nothing new starts, a running session is killed, and the change keeps its in-progress status and resumes on the next start. Press Ctrl-C a second time to exit at once; any process Loopstra started that is still running (a session, a project command, git) is killed with everything it started. SIGTERM does the same as Ctrl-C, and so does closing the terminal (SIGHUP) on macOS and Linux.

**From cron or a scheduler.** Run `loopstra start --once` from the repository, with an explicit PATH: cron's is short and usually lacks `~/.bun/bin` and wherever `claude` is installed. For example:

```
*/10 * * * * cd /home/me/your-repo && PATH=/home/me/.bun/bin:/home/me/.local/bin:/usr/local/bin:/usr/bin:/bin loopstra start --once >> .loopstra/cron.log 2>&1
```

The PATH must reach `bun`, `git`, `claude` and (with a remote) `gh`. Loopstra also puts the folder of the `bun` it runs on first on the PATH of every session and project command it starts.

**When the assistant is unavailable** (signed out, usage limit, overload, network), nothing is blocked. The loop pauses and retries after 1, 2, 4, 8, 16, then 30 minutes, resetting after the next success. The pause survives a restart (`.loopstra/paused.json`) and shows as "The assistant is unavailable ... Retrying at 14:32." in `status`, `tail` and the dashboard; a stopped loop adds "the next start waits until 14:32". If it keeps pausing, check that `claude` works in a terminal. When the same step pauses three times in a row with the same message, the loop sends one tiny test request ($0.05 at most): if that gets through, the step's own failure blocks the change like a crash, so a step that only looks like an outage cannot pause the loop forever.

## Watch

```
loopstra status         # loop state, what needs a person, then every change: priority, where it is, last phase, cost, note
loopstra tail           # live events; `loopstra tail <slug>` for one change
loopstra ui             # dashboard at http://127.0.0.1:4646 (--port <n>), with a chat panel (see Chat)
```

The loop line reads Running, Paused, Stopping, Stopped, "Stopped — it did not shut down cleanly" (the loop process is gone: killed or crashed; start it again), or "Not responding" (the process is there but has not checked in: hung, or the machine slept).

Under it, `status` prints a "Needs attention" block, or "Nothing needs you right now.": a pause, failing tests on main (before main has ever passed, that they have not passed yet), main out of step with GitHub, a settings problem, blocked changes, unreadable intents, and changes waiting for a person (drafts, and reviews with a person on the gate). The dashboard shows the same list, labelled "Blocked" or "Waiting for you". Long notes wrap to the terminal's width.

The dashboard is one local page, polling every couple of seconds. It shows the loop's heartbeat, the needs-attention list, costs for today, this week and all time, the queue, and per-change drill-down: the change's own documents (intent.md, spec.md, plan.md, review.md, outcome.md, lessons.md, read-only), each phase with duration, cost and any commands the session was refused, gate results with evidence, and the event log. The costs include what chat spent. It also has the chat panel (see Chat); apart from posting chat messages, it is read-only. `queue.md` in `intent/` is a generated view of the same queue; its "Needs a person" list matches.

## Chat

Instead of writing intents by hand and reading `status`, you can talk to Loopstra's orchestrator:

```
loopstra chat               # in the terminal (Ctrl-D or /quit to leave)
loopstra chat --no-terminal # only the Slack and Discord bots, for a server or a service manager
loopstra ui                 # the dashboard has the same chat as a panel (--no-chat to leave it out)
```

Ask it how things are going ("what's blocked?", "what merged this week?") and it answers from the intents, `loopstra status` and the recent history of the main branch, which Loopstra hands it. Talk through something new and it asks what done looks like, who it affects, and whether it should be split. When you agree, it proposes a brief and asks "Shall I write this up as a pull request?". Only a plain yes from the person it asked goes ahead, within a day; anything else carries on the conversation. A separate writer, which sees only the brief, then writes one or more intents (with `depends_on` when it splits the work), Loopstra checks them the way the loop would, and:

- with a remote, they go up as a pull request on a branch `intent-proposal/<slug>`, made in a throwaway checkout (your main checkout is never touched). Merging it adds them to the queue as **drafts**, and chat says so in the conversation;
- without one, the loop adds them to `intent/` as drafts on its next tick.

Nothing starts until someone accepts a draft. You can still set `status: accepted` yourself, or ask in chat ("start csv-export"): Loopstra asks "Start work on csv-export now?" and, on a yes, leaves a request that the loop applies at the start of its next tick (`loopstra(<slug>): accepted by <name> from chat`). If you changed the status yourself meanwhile, your edit wins. Apart from that the orchestrator is read-only: for anything else (approving a spec, retrying a blocked change, closing one) it tells you what to edit.

It also tells you things without being asked: each new "Needs attention" item (the same words as `status`), a change reaching the main code, a change done, and a chat pull request merged or closed. Bots post these to their `announce_to` channel; the terminal and the dashboard show them while open.

One conversation goes on as long as you like and can hand off many times. Each chat turn and writer run is a Claude Code session on your subscription, traced under `_chat` (`loopstra tail _chat`); their cost counts in the dashboard's totals and is capped by `chat.max_budget_usd_per_day`, of which one session may hold at most `chat.max_budget_usd_per_session`, so several conversations can run at once. The prompts are `loopstra/prompts/orchestrator.md` and `write-intent.md` (a repository set up before chat existed uses the shipped ones).

**Slack and Discord.** Set them up under `chat.transports` in `loopstra/config.yaml`; tokens are read from the environment variables the config names, never from the file. Each top-level message in the channel starts a conversation in its thread. `allow` lists who may chat (empty: anyone in the channel); `acceptors` who may also start drafts (empty: nobody from there). At the terminal and the dashboard, which only listen on this machine, you may always start drafts. Put long numeric ids (Discord's) in quotes: as YAML numbers they lose digits, so Loopstra refuses them.

The orchestrator and the writer can read the repository's files, but not change anything, and have no git commands (Loopstra gives them the recent commit subjects itself, since `git show` could read any file's past content); they are also kept away from the usual places secrets live (`.env` files, keys, `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude` and the like). That is a guard, not a sandbox: anyone who can chat can ask what the repository holds, so keep `allow` lists to people who may see it.

- Slack uses Socket Mode, so nothing needs a public address: an app-level token with `connections:write` and a bot token with `chat:write`, `channels:history` and `users:read`, with the `message.channels` event subscribed.
- Discord uses the gateway: a bot token, the Message Content intent turned on, and permission to read, send messages and create public threads in the channel.

## When something needs a person

The `status` and `note` lines at the top of `intent.md` say what to do; `intent/README.md` has the full table for owners.

- `blocked`: read the `note`. It says in plain words what went wrong and which status to set to try again (for example back to `plan-approved`), or you can set `closed`. A passing hiccup (the assistant crashed or took too long) says "To try again, set status to ..."; anything else says "When that is sorted out, ...". Loops are bounded (test-fix 3, review-revise 2), and an exhausted budget blocks; an engineer may need to raise the limit.
- `spec-review`, `plan-review`: the automatic checks passed and a gate is set to wait for a person. Read `spec.md` or `plan.md`, then set `spec-approved` or `plan-approved`, or say what is wrong in the note and set the earlier status. Stepping a review status never advances it.
- `merge-review`: checks passed and the change is waiting to go into the main code. Follow the note: with nobody on the merge gate it waits for the checks on GitHub (nothing to do); with `pr`, approve the pull request on GitHub; with `status`, read `review.md` and set `merge-approved`.
- `merged`: the change is in the main code.
- `verifying`: with a person on the done gate, look at the result and set `done`.
- `outcome.md` may have "For a person to confirm": things the system could not check itself. They never hold a change up.

A person's edits win. If you change the status while a step is running, that step writes nothing and the next tick follows your status. Hand-editing a status cannot skip a stage: the artifacts it implies must exist.

## GitHub

With a remote, the approving review pushes the change's branch and opens a pull request instead of merging locally. What happens next follows `gates.merge.human`:

- `none`: merge when the PR's checks pass. A failed check or closed PR blocks.
- `pr`: also needs an approval on the PR (or a person setting `merge-approved`).
- `status`: a person sets `merge-approved`, and the PR's checks must pass.

Merges go through `gh pr merge`, never twice. A PR that is merged or closed on GitHub is noticed in any mode. Loopstra waits while any check is still running, and blocks when any fails or is cancelled. A PR with no checks at all merges; if the branch has workflows under `.github/workflows/`, it first waits up to 5 minutes after the PR opens or Loopstra pushes to it, for GitHub to start them. After a merge, Loopstra deletes the branch on GitHub and keeps the local one until `main` has the change. The change is recorded as merged, and its done-check runs, only once local `main` has the PR's merge commit; until the sync can bring it in (for example while the main checkout has unsaved changes), the change waits and the `main_sync` signal says why. Without a remote the same checks run and Loopstra merges locally.

Each tick, Loopstra fetches and rebases local `main` onto the remote's. It shares `main` once, at the end of the tick (and just before it pushes a change's branch for its pull request), and only when every unpushed commit is its own (bookkeeping under `intent/`). Your own unpushed commits are never pushed for you; it waits until you push them. In `intent/`, the remote's version wins.

Loopstra's bookkeeping commits on `main` (`loopstra(<slug>): ...`) end with `[skip ci]`, so they do not start CI; the change's own merge commit does. `intent/queue.md` is rewritten every tick but committed only along with another of Loopstra's commits, so a quiet tick adds no commit; an unsaved `queue.md` never holds up a merge or the sync.

## Lessons

When a change is verified, Loopstra writes `intent/<slug>/lessons.md` for engineers: what was learned and proposed additions to `CLAUDE.md`. To adopt them:

```
loopstra apply-lessons <slug>
```

This copies the bullets under "Proposed CLAUDE.md additions" into a `## Lessons` section of `CLAUDE.md`, skipping any already there. Review the diff and commit it.

## How it works

Status moves through:

```
draft -> accepted -> designing -> spec-review -> spec-approved
      -> planning -> plan-review -> plan-approved
      -> building -> reviewing -> merge-review -> merge-approved -> merged
      -> verifying -> done
any status -> blocked | closed
```

- **Design and plan** sessions are read-only and return content; the runtime writes `spec.md`, `plan.md`, `review.md`, `outcome.md`. Only the build session edits code, in a worktree on its own branch `intent/<slug>`, and the runtime makes every commit and merge. The build session may run the configured commands (test, lint, build, run, install) on top of `claude.allowed_tools`. Sessions run with background tasks turned off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), so a long command runs in the foreground and no task is left pending for the next session that resumes it. A chained command (`a && b`, `||`, `;`) is allowed whole and part by part, since Claude Code checks each part on its own.
- **Merge checks** bring the branch up to date with `main`, make sure the tests pass (not run again when they already passed on the same code, since `main` only gained records), and read the newest review.
- **Gates** sit at every boundary. Each is a list of checks: deterministic code, a fresh-context agent reviewer, or a person. A gate's checks run in the step that produced the artifact; a pass goes straight to the approved status, or to the review status if a person is set. A failure gets one automatic rewrite with the findings, then blocks.
- **After a merge**, the done-when criteria are checked, `outcome.md` and `lessons.md` are written, and main's tests are run. If main goes from green to red, a new draft intent describing the breach is opened.
- **The trace** is in `.loopstra/` (gitignored): `trace.db` (SQLite), and per change `runs/<slug>/events.jsonl` plus a folder per phase holding the prompt, the result envelope and the raw session. `status`, `tail` and `ui` read it, and it stays on your machine. Chat sessions are traced there too, under `_chat`, with their state in `.loopstra/chat/`. The only things that leave it are what you set up: pull requests on GitHub, and chat messages and announcements posted to Slack or Discord.
- **Chat** is a separate process (`loopstra chat`, or the dashboard). It never runs a stage or writes the main checkout: what it needs there (starting a draft, or adding written intents when there is no remote) it leaves as a request the loop applies right after syncing main at the start of a tick.

The full design is in `docs/superpowers/specs/2026-09-28-loopstra-design.md`, with chat in `docs/superpowers/specs/2026-10-01-orchestrator-chat-design.md`; `docs/decisions.md` records why.

## Configuration

`loopstra/config.yaml` is commented and validated on load with plain error messages; unknown keys are errors. It is re-read every tick, so edits take effect without a restart. Only `commands.test` is required. It sets:

- `main_branch`, `poll_seconds`
- `commands`: test (required), install, lint, build, run
- `claude`: models (default, cheap, strong), timeout, budget per session, and `allowed_tools` for build sessions (the configured commands are always added; anything else a build needs, like `"Bash(make *)"`, goes here)
- `gates`: spec, plan, merge, done, each with `human` (`status` or `none`; merge also `pr`) and `agent` (independent reviewer); merge also `method` (`squash` or `merge`)
- `stages`: per-stage model, skills, `before`/`after` commands, and loop limits
- `signals`: how often main's health check runs
- `chat`: the orchestrator's model, a daily budget for chat, and the Slack and Discord bots (see Chat)

## Platforms

Loopstra runs on Windows, macOS and Linux; the suite runs on all three in CI. Requirements are the same everywhere: Bun 1.4.2+, git 2.28+, Claude Code, and `gh` when the repo has a remote.

- **Project commands** (`commands.*`, `before`/`after`) run in Bun's own shell on every system, not in `sh` or `cmd`. Write them portably: `bun test`, `npm test`, `make test`, `&&`, `$VAR`. Avoid sh-only builtins such as `source` or `set -e` (Bun's shell does not have them), or put that in a script the command calls.
- **Git** runs in the C locale, so its messages are English whatever the machine's language.
- **Paths are case-sensitive.** A plan that names `src/Widget.ts` for `src/widget.ts` fails its check on every system, not only on Linux.
- **Ctrl-C**: see Stopping. On Windows, the process trees Loopstra starts are ended with `taskkill /T /F`; on macOS and Linux each child runs in its own process group, which gets SIGTERM, a moment, then SIGKILL, along with anything that left the group.
- **Network drives.** The trace database uses SQLite's WAL mode. Where the file system cannot do WAL (some network drives), it falls back to the default journal mode and traces a note once; keep the repository on a local disk if you can.

## Development

```
bun install
bun run test        # the suite in four parallel shards; bun run test:serial runs it in one process
bun run typecheck
```

Tests run the whole loop in a temporary git repo against a fake `claude` executable (and a fake `gh` with a bare repository as the remote), so they do not call Claude or GitHub. The fake `claude` can answer a phase differently on each call (`<phase>-<n>.jsonl` in `LOOPSTRA_FAKE_FIXTURE_DIR`), which the chat tests use for conversations. The Slack and Discord bots are tested against stub servers, through `LOOPSTRA_SLACK_API` and `LOOPSTRA_DISCORD_API`.
