---
name: loopstra
description: Operate the Loopstra development loop in this repo. Use when asked to set up or onboard Loopstra, draft an intent, check loop status, unblock a change, tune stages or gates, set up chat (terminal, dashboard, Slack or Discord), or apply lessons to CLAUDE.md. Never runs the loop itself.
---

# Loopstra operator

Loopstra is an unattended development loop. A Bun runtime (`loopstra start`) owns the loop; Claude Code sessions do bounded work inside it. You are the operator console: you help people set it up, feed it, read it, and unblock it. You never run stages by hand and never run `loopstra start`.

Files that matter: `loopstra/config.yaml` (engineer settings), `loopstra/prompts/*.md` (one prompt per phase), `intent/<slug>/` (one folder per change: `intent.md`, `spec.md`, `plan.md`, `review.md`, `outcome.md` for the owner, `lessons.md` for engineers), `intent/queue.md` (generated), `.loopstra/chat/` (chat's conversations, requests and announcements), `.loopstra/` (runtime state and trace, gitignored). A change's folder name is lowercase words joined by dashes, like `add-numbers`.

## The state machine
Status lives in the `status` line of `intent.md`; the `note` line says what to do. The runtime writes it, except where a person is asked to.

draft -> accepted -> designing -> spec-review -> spec-approved -> planning -> plan-review -> plan-approved -> building -> reviewing -> merge-review -> merge-approved -> merged -> verifying -> done. Any status may become `blocked` (with a note) or `closed`.

- A gate's automated checks run in the step that produced the artifact. When they pass and no person is set on that gate, the intent moves straight to the approved status. When a person is set, it stops at the review status.
- So `spec-review` and `plan-review` mean "automated checks passed, waiting for a person"; the person sets `spec-approved` or `plan-approved`. Stepping a review status never advances it.
- `merge-review` means "checks passed, waiting for a person" (or, when the merge gate has no person, waiting for the automatic checks on GitHub). With `merge.human: pr`, the person approves the pull request. With `merge.human: status`, the person sets `merge-approved`. With `none`, nobody does anything.
- `verifying` means "waiting for a person to confirm done" when the done gate has a person; the person sets `done`.
- `outcome.md` may have a section "For a person to confirm". Those items never block; mention them when you explain a finished change.
- `blocked`: the note always says in plain words what to do next. `resume_from` holds the last approved status so a person can retry from it.
- Nothing is written on the root checkout unless it is on `main_branch`; otherwise the loop pauses.

## Onboard
1. Run `loopstra init` and read what it printed. Files it reports as "kept" already existed and were left alone. The first steps are always in this order: setup, commit, start.
2. Have them run `loopstra setup` in a terminal (`init` offers it at the end). It walks through budgets, commands, gates, GitHub, chat and models (Enter takes the suggestion; `-` leaves an optional answer empty, and a command left out that way stays out), saves `loopstra/config.yaml` keeping its comments, and checks what it can: `claude`, `commands.test` on main, the git remote and `gh`, the chat tokens. "To fix" names the `loopstra setup <section>` to run again. One section at a time: `loopstra setup budgets` (or `commands`, `gates`, `github`, `chat`, `models`; `loopstra setup --help` lists them); `loopstra setup --check` changes nothing and only checks. If it says "Fix these in loopstra/config.yaml first:", those problems are outside what its questions ask (an unknown key, for example): help them fix the file, then run it again. Your part is to help them decide, in their context, and tell them which section to run; do not edit `config.yaml` yourself for anything setup asks.
   Build sessions may always run the configured commands; anything else they need (another tool, a script) goes in `claude.allowed_tools`, for example `"Bash(make *)"`. Setup does not ask about it, so that one is edited in the file. Refused commands show in the dashboard and `loopstra tail`.
3. A person always accepts an intent (draft to accepted). The other gates (spec, plan, merge, done) are unattended by default; setup's `gates` and `github` sections change that. With a git remote every change goes through a pull request, so `gh` must be signed in. Budgets are off by default (no limit; `timeout_minutes` still ends a session); suggest limits only if they pay per use with an API key or want a ceiling.
4. Ask which skills in `.claude/skills/` each stage should load and list them under `stages.<stage>.skills`.
5. Read `CLAUDE.md`; make sure its Commands block matches the config.
6. Commit what `init` wrote, with the config as setup left it and the edits above, on main: the loop works in its own checkouts, which only see what is committed, and `loopstra start` refuses until the config, prompts, and hook are committed. Commit the config again whenever setup changes it.
7. Tell them to start the loop in a terminal with `loopstra start` and to watch it with `loopstra status` or `loopstra ui`. Product owners can use `loopstra chat` or the dashboard's chat panel instead of writing intents by hand (see Chat).

## Draft an intent
Interview the person in plain language: what is wrong today and for whom, what should be true when it is done, how they would check it is done, who and what it touches, any constraints, and open questions. Write `intent/<slug>/intent.md` from the template in `intent/README.md` with a short hyphenated slug they agree to. One intent is designed, planned, and built in one build session within the stage's time limit (and any spending limit), so a request the size of a whole product will block partway: split it into several intents, each something one person could build in a day or two, and give each later one a `depends_on: [<earlier slug>, ...]` line so it waits until those are merged. Leave `status: draft`. Tell them to set `accepted` when they are ready. Do not design or plan anything.

## Chat
`loopstra chat` (terminal, plus the Slack and Discord bots under `chat.transports` in the config) and the panel in `loopstra ui` are the orchestrator: people ask it for updates and work out new changes with it. An agreed change is handed to a writer and arrives as draft intents through a pull request on `intent-proposal/<slug>` (without a remote, the loop adds them on its next tick). It is read-only except that an acceptor can ask it to start a draft, which the loop applies on its next tick. Its sessions are traced under `_chat` (`loopstra tail _chat`), with no spending limit unless one is set with `loopstra setup budgets`; its prompts are `loopstra/prompts/orchestrator.md` and `write-intent.md`. Nothing in chat ever runs the loop; the loop must be running for a start or (without a remote) new drafts to take effect.

To set up a bot, run `loopstra setup chat` (any time; Slack, Discord or both); it writes `chat.transports` in `loopstra/config.yaml`, checks the ids, and checks that the platform accepts each token. Each top-level message in its channel starts a conversation in a thread. `allow` lists the platform user ids that may chat (empty: anyone in the channel); `acceptors` those who may also start drafts (empty: nobody from there); `announce_to` the channel for announcements (blocked, waiting, merged, done). Tokens are never written in the config: `token_env` (and Slack's `bot_token_env`) name the environment variables that hold them, which must be set where `loopstra chat` runs; setup always writes those names, so the file says which to set. A new bot's `announce_to` defaults to its channel. Then run `loopstra chat --no-terminal` (or plain `loopstra chat` to also chat in the terminal).

- Slack: create an app with Socket Mode on; an app-level token with `connections:write`; a bot token with `chat:write`, `channels:history` and `users:read`; subscribe to the `message.channels` bot event; invite the bot to the channel. `channel` is the channel id (C...).
- Discord: create a bot, turn on the Message Content intent, and invite it with permission to read messages, send messages, and create public threads in the channel. `channel` is the channel id.

## Status
Run `loopstra status`. Start with its "Needs attention" block (the same list as the dashboard's): each line is something a person should do or know. Then explain each row in one sentence: what the change is, where it is, and whether anyone needs to do anything. For a blocked change, read its note aloud and offer the options below.

If the loop line says "Paused — " followed by "The assistant is unavailable", the assistant could not be used (signed out, a usage limit, or the network). Nothing is blocked; the loop retries by itself at the time shown, waiting longer after each failure (up to 30 minutes). If it keeps pausing, check that `claude` works in a terminal (sign in again, or wait for the limit to reset). The detail is in the `pause` events (`loopstra tail`). When the same step keeps pausing with the same message, the loop sends one tiny test request; if that gets through, the step's own failure blocks the change like any other.

"Paused: The loop has used today's budget" in "Needs attention", and the same on the loop line, means `claude.max_budget_usd_per_day` is reached. Nothing is blocked; a step stopped partway (even mid-session) keeps its status, and the loop resumes after local midnight. To change the limit, `loopstra setup budgets`. A pause saying the rest of today's budget "is held by a phase still running" needs nothing: it clears when that phase ends, or within `timeout_minutes` plus 10 minutes if its process was killed. A change blocked with "This step hit its spending limit (claude.max_budget_usd)", or with "This step needs more than the loop's daily budget" (on two days at the same status, with no status change between, it used at least 90% of the loop's daily budget itself and still ran out partway, so it would never finish; a change that others left less of the day only waits), needs that limit raised or removed the same way, then its status set back as its note says. A timeout's note points to `claude.timeout_minutes` instead.

"Stopped — it did not shut down cleanly" means the loop process was killed or crashed; start it again. "Not responding" means the process is still there but has not checked in; it may be hung or the machine was asleep.

## Unblock
Read the `note` in the change's `intent.md`. Explain the choices: follow the status the note names (it says which status to set to try again, or the two ways on); `resume_from`, the last approved state, is the fallback when the note names none; fix something first and then retry; or `closed`. Make the edit only when the person says which. For details, read `.loopstra/runs/<slug>/events.jsonl` or the phase folders under `.loopstra/runs/<slug>/phases/`.

## Tune
Edit `loopstra/prompts/<phase>.md` or `loopstra/config.yaml`. Changes take effect on the next pass. Keep prompts short and explicit; keep gate defaults deterministic.

## Apply lessons
Run `loopstra apply-lessons <slug>` to copy the proposed CLAUDE.md additions from that change's `lessons.md` into `CLAUDE.md` under a Lessons heading, then show the diff for review.
