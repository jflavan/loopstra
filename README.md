# Loopstra

An unattended development loop built on Claude Code. Code owns the loop; agents own bounded phases; people own the decisions they choose to keep.

A product owner writes a plain-language `intent/<slug>/intent.md` and sets its status to `accepted`. Loopstra then designs, plans, builds, tests, reviews, merges and verifies the change, one step at a time, with a gate at every stage boundary. Every artifact is a Markdown file in git, and every step is recorded in a trace you can read from a terminal or a local dashboard.

There are two audiences and two surfaces:

- **Engineers** configure the machinery once: test command, gates, prompts, limits. All of it is in `loopstra/config.yaml` and `loopstra/prompts/`.
- **Product owners** only write plain markdown (the intent) and a status line. Notes addressed to them are plain sentences with retry advice, never commands, branch names or raw output.

## Requirements

- [Bun](https://bun.sh)
- git
- Claude Code CLI (`claude` on PATH), signed in with a subscription. Loopstra drives the CLI, not the API, so no API key is needed.
- GitHub CLI (`gh`), signed in, when the repo has a remote. `loopstra start` refuses to run otherwise.

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

`init` is deterministic and never overwrites a file that already exists. It detects your test, lint, build and run commands and writes:

- `loopstra/config.yaml` and `loopstra/prompts/*.md`
- `intent/README.md` (the owner's guide) and `intent/queue.md`
- `REVIEW.md` (what the reviewer looks for) and a Commands block in `CLAUDE.md`
- `.claude/skills/loopstra/` (an operator skill for drafting intents, reading status and unblocking)
- a hook, wired into `.claude/settings.json`, that stops build sessions editing tests to make them pass
- `.loopstra/` in `.gitignore`

Then:

1. Commit everything `init` wrote, on `main`. The loop works in its own checkouts, which only see what is committed, and `loopstra start` refuses until the config, prompts and hook are committed.
2. Open `loopstra/config.yaml` and confirm `commands.test`: the one command that runs your tests and exits non-zero on failure.
3. Choose which gates get a person (see Configuration). By default, only accepting an intent needs one.

You can also open Claude Code in the repo and ask the `loopstra` skill to walk you through this. The skill never runs the loop.

## Ask for a change

Make `intent/<slug>/`, where the slug is lowercase words joined by dashes, like `add-numbers`. Copy the template from `intent/README.md` into `intent.md`:

```markdown
---
status: draft
priority: normal      # low, normal, high, urgent; optional
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

## Run

```
loopstra start          # the loop; one step per tick, sleeps poll_seconds between ticks
loopstra start --once   # one tick, then exit (for cron or a scheduler)
```

`start` checks that git and `claude` are installed, that you are on `main_branch`, that Loopstra's own files are committed, and (with a remote) that `gh` is signed in. It prints a plain message and exits if any is not true.

The loop never dies on a bad edit or a failed step; the problem is traced and the next tick comes. It runs one change at a time.

**Stopping.** Press Ctrl-C once to stop gracefully: nothing new starts, a running session is killed, and the change keeps its in-progress status and resumes on the next start. Press Ctrl-C a second time to exit at once.

**When the assistant is unavailable** (signed out, usage limit, overload, network), nothing is blocked. The loop pauses and retries after 1, 2, 4, 8, 16, then 30 minutes, resetting after the next success. The pause survives a restart (`.loopstra/paused.json`) and shows as "The assistant is unavailable ... Retrying at 14:32." in `status`, `tail` and the dashboard. If it keeps pausing, check that `claude` works in a terminal.

## Watch

```
loopstra status         # loop state, then every change: priority, where it is, last phase, cost, note
loopstra tail           # live events; `loopstra tail <slug>` for one change
loopstra ui             # dashboard at http://127.0.0.1:4646 (--port <n>)
```

The dashboard is one local page, polling every couple of seconds. It shows the loop's heartbeat (running, paused, stopped, not responding), a "needs attention" list, costs for today, this week and all time, the queue, and per-change drill-down: each phase with duration, cost and any commands the session was refused, gate results with evidence, and the event log. `queue.md` in `intent/` is a generated view of the same queue.

## When something needs a person

The `status` and `note` lines at the top of `intent.md` say what to do; `intent/README.md` has the full table for owners.

- `blocked`: read the `note`. It says in plain words what went wrong and which status to set to try again (for example back to `plan-approved`), or you can set `closed`. Loops are bounded (test-fix 3, review-revise 2), and an exhausted budget blocks; an engineer may need to raise the limit.
- `spec-review`, `plan-review`: the automatic checks passed and a gate is set to wait for a person. Read `spec.md` or `plan.md`, then set `spec-approved` or `plan-approved`, or say what is wrong in the note and set the earlier status. Stepping a review status never advances it.
- `merge-review`: checks passed; with a GitHub pull request, approve it there; when the note says so, set `merge-approved`.
- `verifying`: with a person on the done gate, look at the result and set `done`.
- `outcome.md` may have "For a person to confirm": things the system could not check itself. They never hold a change up.

A person's edits win. If you change the status while a step is running, that step writes nothing and the next tick follows your status. Hand-editing a status cannot skip a stage: the artifacts it implies must exist.

## GitHub

With a remote, the approving review pushes the change's branch and opens a pull request instead of merging locally. What happens next follows `gates.merge.human`:

- `none`: merge when the PR's checks pass. A failed check or closed PR blocks.
- `pr`: also needs an approval on the PR (or a person setting `merge-approved`).
- `status`: a person sets `merge-approved`, and the PR's checks must pass.

Merges go through `gh pr merge`, never twice. A PR that is merged or closed on GitHub is noticed in any mode. Without a remote the same checks run and Loopstra merges locally.

Each tick, Loopstra fetches and rebases local `main` onto the remote's, and pushes `main` only when every unpushed commit is its own (bookkeeping under `intent/`). Your own unpushed commits are never pushed for you; it waits until you push them. In `intent/`, the remote's version wins.

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

- **Design and plan** sessions are read-only and return content; the runtime writes `spec.md`, `plan.md`, `review.md`, `outcome.md`. Only the build session edits code, in a worktree on its own branch `intent/<slug>`, and the runtime makes every commit and merge.
- **Gates** sit at every boundary. Each is a list of checks: deterministic code, a fresh-context agent reviewer, or a person. A gate's checks run in the step that produced the artifact; a pass goes straight to the approved status, or to the review status if a person is set. A failure gets one automatic rewrite with the findings, then blocks.
- **After a merge**, the done-when criteria are checked, `outcome.md` and `lessons.md` are written, and main's tests are run. If main goes from green to red, a new draft intent describing the breach is opened.
- **The trace** is in `.loopstra/` (gitignored): `trace.db` (SQLite), and per change `runs/<slug>/events.jsonl` plus a folder per phase holding the prompt, the result envelope and the raw session. `status`, `tail` and `ui` read it; nothing leaves your machine.

The full design is in `docs/superpowers/specs/2026-09-28-loopstra-design.md`; `docs/decisions.md` records why.

## Configuration

`loopstra/config.yaml` is commented and validated on load with plain error messages; unknown keys are errors. It is re-read every tick, so edits take effect without a restart. Only `commands.test` is required. It sets:

- `main_branch`, `poll_seconds`
- `commands`: test (required), install, lint, build, run
- `claude`: models (default, cheap, strong), timeout, budget per session, allowed tools
- `gates`: spec, plan, merge, done, each with `human` (`status` or `none`; merge also `pr`) and `agent` (independent reviewer); merge also `method` (`squash` or `merge`)
- `stages`: per-stage model, skills, `before`/`after` commands, and loop limits
- `signals`: how often main's health check runs

## Development

```
bun install
bun test
bun run typecheck
```

Tests run the whole loop in a temporary git repo against a fake `claude` executable, so they do not call Claude.
