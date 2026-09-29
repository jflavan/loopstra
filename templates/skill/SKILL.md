---
name: loopstra
description: Operate the Loopstra development loop in this repo. Use when asked to set up or onboard Loopstra, draft an intent, check loop status, unblock a change, tune stages or gates, or apply lessons to CLAUDE.md. Never runs the loop itself.
---

# Loopstra operator

Loopstra is an unattended development loop. A Bun runtime (`loopstra start`) owns the loop; Claude Code sessions do bounded work inside it. You are the operator console: you help people set it up, feed it, read it, and unblock it. You never run stages by hand and never run `loopstra start`.

Files that matter: `loopstra/config.yaml` (engineer settings), `loopstra/prompts/*.md` (one prompt per phase), `intent/<slug>/` (one folder per change: `intent.md`, `spec.md`, `plan.md`, `review.md`, `outcome.md` for the owner, `lessons.md` for engineers), `intent/queue.md` (generated), `.loopstra/` (runtime state and trace, gitignored). A change's folder name is lowercase words joined by dashes, like `add-numbers`.

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
1. Run `loopstra init` and read what it printed. Files it reports as "kept" already existed and were left alone. Commit what it wrote on main: the loop works in its own checkouts, which only see what is committed, and `loopstra start` refuses until the config, prompts, and hook are committed.
2. Open `loopstra/config.yaml`. Confirm `commands.test` is the one command that runs the tests and exits non-zero on failure; add `install`, `lint`, `build`, `run` if the repo has them.
3. A person always accepts an intent (draft to accepted). Ask which other gates should have a person: spec, plan, merge, done. Set `human: status` for them; the merge gate can instead use `human: pr` (approval of its GitHub pull request). The defaults are unattended after acceptance.
4. Ask which skills in `.claude/skills/` each stage should load and list them under `stages.<stage>.skills`.
5. Read `CLAUDE.md`; make sure its Commands block matches the config.
6. Tell them to start the loop in a terminal with `loopstra start` and to watch it with `loopstra status` or `loopstra ui`.

## Draft an intent
Interview the person in plain language: what is wrong today and for whom, what should be true when it is done, how they would check it is done, who and what it touches, any constraints, and open questions. Write `intent/<slug>/intent.md` from the template in `intent/README.md` with a short hyphenated slug they agree to. Leave `status: draft`. Tell them to set `accepted` when they are ready. Do not design or plan anything.

## Status
Run `loopstra status`. Explain each row in one sentence: what the change is, where it is, and whether anyone needs to do anything. For a blocked change, read its note aloud and offer the options below.

If the loop line says "Paused", the assistant could not be used (signed out, a usage limit, or the network). Nothing is blocked; the loop retries by itself at the time shown, waiting longer after each failure (up to 30 minutes). If it keeps pausing, check that `claude` works in a terminal (sign in again, or wait for the limit to reset). The detail is in the `pause` events (`loopstra tail`).

## Unblock
Read the `note` in the change's `intent.md`. Explain the choices: retry from the last approved state (set `status` to the value in `resume_from`), fix something first and then retry, or `closed`. Make the edit only when the person says which. For details, read `.loopstra/runs/<slug>/events.jsonl` or the phase folders under `.loopstra/runs/<slug>/phases/`.

## Tune
Edit `loopstra/prompts/<phase>.md` or `loopstra/config.yaml`. Changes take effect on the next pass. Keep prompts short and explicit; keep gate defaults deterministic.

## Apply lessons
Run `loopstra apply-lessons <slug>` to copy the proposed CLAUDE.md additions from that change's `lessons.md` into `CLAUDE.md` under a Lessons heading, then show the diff for review.
