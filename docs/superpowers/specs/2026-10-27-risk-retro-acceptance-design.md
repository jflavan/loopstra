# Risky changes, `loopstra retro`, and acceptance tests

2026-10-27. Three features that make the loop safer to leave alone and easier to tune. The user chose them from a list of ideas and asked Claude to make every decision; each decision below is Claude's call, recorded in `docs/decisions.md` when it is built.

## Why

Loopstra's goal is a loop that runs unattended, stays simple, and keeps human-readable records. Today a person picks between two blunt settings: a person on every merge (slow), or nobody on any merge (fast, but a change to CI, dependencies or migrations goes in unseen). The done-check that decides whether a change did what the owner asked is an agent's judgment, made after the merge. And the trace records everything, but nothing reads it back to say how the loop is doing or what to change.

1. **Risky changes need a person.** Merges stay unattended, except for changes that touch files an engineer named as risky. Those wait for a person, whatever `gates.merge.human` says.
2. **`loopstra retro`.** A plain report over the trace for the last days: what shipped, where changes blocked, how the gates did, what it cost, how long people kept changes waiting, and concrete config suggestions with their evidence.
3. **Acceptance tests from Done when.** Before the build, a separate session writes tests from the owner's Done when list. The build may not change them, so they hold it to what was asked, and the done-check reads them as evidence.

## Goals

- Each feature is off unless configured, or (acceptance tests) on only for repos set up after it ships, so an upgrade changes no running loop's behaviour.
- Every decision is in a file a person can read: the intent's frontmatter and note, a gate row in the trace, `acceptance.md`.
- No new long-running process, no new storage. Retro reads the trace that exists.

## Non-goals

- No agent judging risk. Risk is facts about the diff (paths, size), so it is predictable and testable.
- Retro does not change the config. It suggests; a person edits.
- Retro is not posted to chat or shown in the console in this change (a follow-up).
- Acceptance tests do not replace the project's own test suite or the verifier.

## Anti-goals

- A risky change must never merge with nobody looking because of a stale or missing record. When in doubt, a person decides.
- Acceptance tests must never leave a change stuck with no way out: a wrong acceptance test has to be named in the block note with what to do.

---

## 1. Risky changes need a person

### Config

```yaml
gates:
  merge:
    human: none
    method: squash
    risky:
      paths: [".github/**", "package.json", "bun.lock", "**/migrations/**"]
      lines: 1500
      human: pr
```

- `risky.paths`: glob patterns (Bun.Glob, matched against repo-relative paths with `/`). Default `[]`. A bare name like `package.json` matches only at the top; `**/package.json` matches anywhere. Each entry must be a non-empty string.
- `risky.lines`: optional positive whole number. A change whose added plus deleted lines (outside `intent/`, binary files not counted) exceed it is risky. Unset: size never makes a change risky.
- `risky.human`: `pr` (default) or `status`: who decides a risky change. Without a GitHub remote, `pr` acts as `status`: there is no pull request, so a person sets `merge-approved`. (Claude's call: a risky change in a repo without a remote should wait, not block.)

Nothing is risky when `paths` is empty and `lines` is unset, which is the default, so existing configs behave as before.

### When it is decided

At the one place the merge gate passes its automated checks, `passMergeGate` in `src/stages/merge.ts`. Every change Loopstra makes to a branch (build, fix, revise, a fix during the merge checks) goes through another review and then through this point, so the decision is made again on the code that will merge. Commits a person pushes to the pull request on GitHub are a person's work and are not scored again (Claude's call: simpler, and a person is already involved).

The diff is the branch against main (merge base), outside `intent/`: `git diff --numstat -z <main>...<branch>` in the worktree.

### What it records

- A gate row: gate `merge`, check `risk`, result `pass` with evidence "nothing risky" (only when risky settings exist and nobody is on the config's merge gate), or `waiting` with evidence naming the matched files (up to 10) and the line count when that tripped it.
- Frontmatter field `merge_gate: pr | status` on the change, written by the runtime in the same record as the status move to `merge-review`, and removed by that record when the change is not risky. Runtime-managed, left out when blank (like `hold`). It is only written when it changes who decides, that is when `gates.merge.human` is `none`. When the config already has a person on the merge gate, risk is not scored at all (changed after review: a row there would change nothing).
- The note says why, in plain words: "This change touches files set to need a person before merging: .github/workflows/ci.yml and package.json. Approve the pull request on GitHub, or set status to merge-approved." (With `status`: "Read review.md. To let this change in, change the status line to merge-approved." with the same first sentence.) File names are allowed in this note (Claude's call): whoever approves a merge needs to know what to look at. At most 3 names, then "and N more".

### Who reads it

One helper decides the effective merge gate of a change: `gates.merge.human` when it is not `none`, else the change's `merge_gate`, else `none`. The readers that today use `human.merge` or `cfg.gates.merge.human` for a specific change use it instead:

- `waitsForPerson`, `isRunnable` (`src/intents.ts`), so the scheduler does not run a waiting risky change and `status`/`queue.md`/attention list it as waiting for a person.
- `offers`/`personReviews` (`src/actions.ts`), so the console and chat offer Approve and Send back.
- `attention.ts`, for its note.
- `src/stages/merge.ts`: `passMergeGate`, `watchPullRequest` (wait for an approval on GitHub, or for `merge-approved`), `runMergeStep` (no remote: merge-review waits), `mergeRetry`.
- `mayMergeFirst` in `src/stages/plan.ts` (a risky change in merge-review waits for a person, so it does not merge first).

A person who deletes the `merge_gate` line takes the change back to the config's gate; a person's edits win, as everywhere.

### Setup

`loopstra setup gates` asks, when the merge gate has nobody on it: "Files whose change needs a person before merging (comma-separated globs)". The suggestion is `.github/**` and `**/migrations/**`, plus each of these that exists at the top of the repo: `package.json`, `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `requirements.txt`, `Gemfile`, `Gemfile.lock`, `Dockerfile`. `-` leaves the list empty. `lines` and `human` are left to the file (and documented).

---

## 2. `loopstra retro`

```
loopstra retro            # the last 7 days
loopstra retro --days 30
```

Read-only. Plain text, like `loopstra judges`. Reads `.loopstra/trace.db` and the config. Leaves out `_chat` except in the spending line, where chat's cost is shown on its own.

### Sections

1. **Header.** "The last 7 days (since Oct 20)."
2. **What happened.** Changes that reached main (status moved to `merged`), finished (`done`), blocked (moved to `blocked`, counted once per change), closed. The median time from `accepted` (or the first status after it) to `merged`, for changes that got there in the window.
3. **Where changes blocked.** Each block in the window, grouped by kind, most common first, with the changes named: timed out, the assistant crashed, tests kept failing, the reviewer kept finding problems, the verifier found it did not work, the spending limit, merge conflicts, checks on GitHub failed, the pull request was closed, a Done when criterion not met, a question limit, and other (with its note). The kind comes from the block note: each recognized note is matched by the constant the runtime writes it from, exported where it is local today, never by a fresh regex on wording.
4. **Gates.** One line per gate check that ran in the window (spec check, plan challenge, review findings, pr-checks, done-check; merge risk is left out, since its `waiting` is a person deciding, not a failure): how many times it ran, how many changes passed it the first time. From the `gates` table.
5. **Spending.** Total for the loop, then by kind of step (phase names folded: `fix-2`, `test-3` → `fix`, `test`; `early-review` counts as review; `-cheap` as its judge), the five biggest, with the share of the total and the average per change. Chat on its own line.
6. **Waiting for people.** For each review status a person decides (spec-review, plan-review, merge-review, verifying) and for open questions: how many times a change waited there and the median wait. From `status_change` and `question` events.
7. **Suggestions.** Zero or more, each one sentence with its evidence and the setting to change. Rules (thresholds are named constants):
   - Cheaper judges: the setting is `shadow` and a judge's record has earned going first (`judgeReport`'s `goesFirst`): suggest `speed.cheap_judges: first`. The setting is `off` and judges cost at least 30% of the window's spending over at least 5 changes: suggest `shadow`.
   - Fix loops: at least 2 blocks of "tests kept failing": suggest `stages.build.max_fix_loops` one higher, or smaller changes.
   - Timeouts: at least 2 timeouts: suggest `claude.timeout_minutes` 50% higher (rounded to 5), or smaller changes.
   - Review rounds: at least 2 blocks of "reviewer still found": suggest `stages.review.max_rounds` one higher.
   - Spending limit: at least 1 block on the session's limit: suggest raising `claude.max_budget_usd` (with `loopstra setup budgets`).
   - Waits: a person-decided gate whose median wait is over 24 hours, where the automatic check of that gate passed every time in the window (at least 5): suggest the person could come off that gate.
   - Risky changes: `gates.merge.human: none` and nothing set under `gates.merge.risky`, with at least 1 change merged: suggest setting `risky.paths`.
   - Acceptance tests: off, and at least 1 change blocked on a Done when criterion not met: suggest `stages.build.acceptance_tests: true`.
   - None apply: "No suggestions: nothing in the trace points at a setting to change."

An empty window: "Nothing happened in the last 7 days." and the suggestions that apply anyway (none of the rules above fire without data).

### Trace queries

New read methods on `Trace` (no schema change): status changes since a time (across slugs), gate rows since a time, phases started since a time. Indexes exist for phases by start; events are filtered by type and time. The trace is small enough that a scan of events of one type is fine.

---

## 3. Acceptance tests from Done when

### Config

`stages.build.acceptance_tests: true | false`. The schema default is `false`, so an upgraded repo is unchanged. `templates/config.yaml` (what `loopstra init` writes) sets it to `true`, and `loopstra setup gates` asks "Write tests from Done when before each build? (Y/n)". (Claude's call: new repos get it, old repos opt in; the step costs one more session per change.)

A new step key `acceptance` in `STEPS` (group `build`, "writes tests from Done when before the build", model follows the build stage), so it has a model setting and an `agents.steps.acceptance` setting like the others.

### The step

At the start of `runBuildStep`, after the worktree is ready and the build's `before` commands ran, and before the build session, when `acceptance_tests` is on and this build has not written its acceptance tests yet (run-folder marker `acceptance`):

1. A fresh agent session `acceptance` in the change's worktree, `acceptEdits`, the build's tools, with the Done when list, the spec, the plan and the test command. It writes tests in the project's own style and test folders, one or more per Done when item it can test, runs them, and expects them to fail before the build. It must not change anything but tests and test fixtures. The test-protection hook enforces that in this phase: only paths it considers tests may be edited.
2. Its answer: `tests: [{ criterion, file, test }]` (the criterion in the owner's words, the file, the test's name) and `not_testable: [{ criterion, why }]`, plus `summary` and `commit_message`.
3. The runtime commits what it wrote on the branch (`loopstra(<slug>): acceptance tests`), writes the marker (the list of test files), and records `intent/<slug>/acceptance.md` on main:

   ```markdown
   # Acceptance tests

   Written from Done when before the build. The build may not change them.

   ## Covered by tests
   - Counting the words in "hello world" gives 2: `tests/count.test.ts`, "counts two words"

   ## Not covered by a test
   - People find the new page easy to read: needs a person.
   ```

4. A session that fails, or writes no test at all, does not block the change (Claude's call): the trace says why, acceptance.md says no tests were written, and the build goes on as without the setting. Acceptance tests are a help, not a gate.

A new build (status was not `building`: from `plan-approved`, a send-back) clears the marker, so its acceptance step runs again on the branch and may update what an earlier build's step wrote. A build resumed after a stop keeps the marker and does not run the step twice.

### Protection

Every session of the build that may edit (build, fix, reconcile, revise, also the fixes during the merge checks) gets the change's acceptance test files in `LOOPSTRA_ACCEPTANCE` (a JSON list, from the marker). The hook refuses edits to those files in those phases, logs them like today's refused tests, and says "this is an acceptance test written from Done when; fix the code, not the test". Today's rule (the fix phase may not edit tests the branch did not add) stays as it is.

When a session fails after the hook refused an acceptance test, the block note names it: "It was not allowed to edit the acceptance test `tests/count.test.ts`, written from Done when before the build. If the test is wrong, an engineer can fix it on the branch intent/count-words." The usual retry advice follows.

The drift check (files changed that the plan did not list) leaves the acceptance test files out, so they do not start a reconcile session.

### The done-check

The done-check's prompt gets `{{acceptance}}`: acceptance.md's "Covered by tests" list, or "No acceptance tests were written for this change." It is told: a criterion covered by an acceptance test that passes in this copy of main is met, with the test as its evidence. A customized `done-check.md` without the variable still gets the text appended, the way `{{feedback}}` reaches an older `build.md`.

### Steering

`acceptance` is a work session: it can be messaged, redirected and stopped like build. It does not ask questions (Claude's call: the Done when list is the owner's answer already).

---

## Docs and tests

- README: the merge gate's risky settings under GitHub and Configuration, `merge_gate` under "When something needs a person", `loopstra retro` under Watch, acceptance tests under How it works and Configuration, the new step in the models table.
- `templates/intent-README.md` (owners): what `merge_gate` and acceptance.md mean.
- `templates/skill/SKILL.md`: `loopstra retro` as a way to read how the loop is doing.
- `docs/decisions.md`: one section with each call above.
- Tests: config schema (each new key and its errors); risk scoring (globs, lines, binary files, intent/ left out); the effective gate in every reader; the merge step with and without a remote for a risky and a non-risky change; retro's grouping, medians and each suggestion rule, on a seeded trace; the hook's acceptance rule; the acceptance step (writes, commits, records, skips on resume, fails softly), protection and the block note; drift leaving acceptance files out; the done-check's variable; setup's new questions.
