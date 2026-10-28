# Changes that run at the same time without getting in each other's way

`speed.max_parallel_changes` lets up to four changes run a step at once. Each already has its own
branch and worktree (`.loopstra/worktrees/<slug>`). Design and plan sessions read a snapshot of
main, and the early review reads a throwaway copy of the tested commit. The "same files" rule keeps
a change from building into files another change is still working on. Two gaps are left:

1. **Shared machine resources.** Two changes' test commands can still collide outside their
   worktrees: on `/tmp`, on tool caches, and on ports. Today loopstra hands out `LOOPSTRA_SLOT`,
   but each project has to turn it into ports and folders itself.
2. **Merge conflicts.** Before a merge, the merge checks rebase the branch onto main. A conflict
   aborts the rebase and blocks the change ("An engineer needs to look at it"). Nothing tries to
   resolve it, and a change waiting for a person never finds out it no longer merges.

This change closes both gaps.

## Goals

- Every change that runs commands gets its own temp folder, and its own block of free ports.
  Its own cache folders are available when the project turns them on.
- A merge conflict with main is resolved by an agent rather than blocking the change. The
  resolution is tested and reviewed before anything merges.
- A change waiting at the merge gate (for a person, or as an open pull request) is kept mergeable.
  When main moves on and the change no longer applies cleanly, it is resolved, tested and reviewed
  again, so the person always approves code that will merge.
- A failed resolution blocks with enough detail for an engineer to pick it up: the files, what the
  agent tried, and why it stopped.

## Non-goals

- Changing the "same files" rule. It stays as it is: avoiding a conflict we can see coming is
  better than resolving it. Resolution covers what the plans did not predict.
- Resolving the catch-up rebase inside the local merge (`mergeIntoMain`). It runs under the merge
  lock, after the merge checks brought the branch up to date. Main can only have gained records
  under `intent/` since then, so it cannot conflict with the change's code. It keeps blocking as
  it does today.
- Isolating anything the project's own configuration shares (a database server, Docker networks).
  `LOOPSTRA_SLOT`, `LOOPSTRA_SLUG` and the new port block are what a project uses for those.

## Anti-goals

- A resolution that merges unseen. Every resolution is tested and then reviewed. The reviewer sees
  each conflicting section as it was, with both sides, and the agent's account of what it chose.
- A change chasing a busy main forever. Resolutions per build are capped.
- Losing a person's commits, or overwriting a pull request branch that someone else pushed to. The
  existing lease rules still apply to every push.

## Part 1: Per-change resources

All of this goes in a new module, `src/resources.ts`. It owns the per-change environment that every
project command, hook command and command-running session of a claimed change receives. Today
those three call sites (`projectCommand` and `runHookCommands`, plus `tracedSession` for the
`build` and `read+commands` tool sets) each add `slotEnv(slug)`. They switch to one async
`changeEnv(ctx)` that returns:

| Variable | Value | When |
|---|---|---|
| `LOOPSTRA_SLOT` | as today (`slotEnv`) | the change is claimed |
| `TMPDIR`, `TMP`, `TEMP` | `<system temp>/loopstra-<8 hex of the repo path>/s<slot>/` (created on first use; short, for Unix socket paths) | the change is claimed |
| `LOOPSTRA_PORT_BASE`, `LOOPSTRA_PORT_COUNT` | the first port and the size of the change's block | `speed.ports_per_change` > 0 and the change is claimed |
| `XDG_CACHE_HOME`, `npm_config_cache`, `BUN_INSTALL_CACHE_DIR`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `GOCACHE` | folders under `.loopstra/cache/slot-<n>/` | `speed.own_caches: true` and the change is claimed |

- **Temp folder:** one per change, always on. It is removed when the step releases the change (the
  scheduler's `release`). A step that crashes leaves it behind, so cleanup at tick start removes
  leftover temp folders of changes that are not claimed. Claude Code itself also runs with this
  `TMPDIR`, which does no harm.
- **Caches:** off by default (`speed.own_caches: false`). They are per *slot*, not per change, and
  are kept between changes. A slot belongs to one running change at a time, so two changes never
  share a cache folder, and the next change on the same slot finds it warm. *(My call: per slot
  rather than per change. The user chose "opt-in" because of slow installs, and per-slot keeps
  most of the warmth.)*
- **Ports:** `speed.ports_per_change` (default 10, 0 = none, at most 100). Block `i` starts at
  `speed.ports_from + i × ports_per_change` (`ports_from` default 20000). A change gets the lowest
  block that no other claimed change holds and whose ports all bind on `127.0.0.1` right now (the
  check binds each port and closes it straight away). It keeps the block until its step ends, like
  its slot. At most 50 blocks are tried; if none of them is free (or the ports run out at 65535),
  the change gets no port variables.
- Main's health check runs alone and gets none of this, as it gets no slot today.
- `lanes.ts` keeps holding the claims and slots. The port blocks and temp folders live in
  `resources.ts`, and are released from the same `release(slug)` call through a hook that
  `resources.ts` registers. That way `lanes.ts` still imports nothing from the rest of Loopstra.

Config (`speed:`):

```yaml
speed:
  ports_per_change: 10   # each running change gets LOOPSTRA_PORT_BASE..+count-1, checked free; 0: none
  ports_from: 20000      # where the first block starts
  own_caches: false      # true: tool caches per slot (XDG_CACHE_HOME, npm, bun, yarn, pip, go)
```

## Part 2: Resolving conflicts

### Where the branch is brought up to date

There are three places. All of them use one function, `catchUp(ctx, where)` in a new
`src/stages/catch-up.ts`:

1. **Review start** (`runReviewRounds`, only for a fresh set of rounds: no round marker yet). This
   runs when main has code outside `intent/` that the branch lacks (the same test as `outOfDate`).
   A branch behind only by records is left alone, so the early review the build step kept still
   matches the commit.
2. **The merge checks' `up-to-date` check** (`checkMerge`). Today a conflicting rebase fails this
   check. It now calls `catchUp`.
3. **While waiting at the merge gate**: `merge-review` with a person on the gate (no remote), or
   an open pull request waiting for a person (`gates.merge.human` `status` before `merge-approved`,
   or `pr` before it is approved). The step checks whether the branch still merges cleanly into
   main (`git merge-tree --write-tree`, git 2.38+; on an older git it never finds a conflict, and
   resolution waits for the merge checks). A branch that merges cleanly is left alone, even when
   it is behind. A conflicting branch is brought up to date with `catchUp`, and its status goes to
   `reviewing` with the note "Brought up to date with main; it is reviewed again before it comes
   back to you." From there the usual path reviews it, runs the merge checks, and (with a remote)
   pushes it to the same pull request and waits at `merge-review` again.
   - Without a remote, `merge-review` with a person on the gate is not runnable today. The tick
     works out which of these changes conflict with main, the same way it works out the same-file
     holds, and makes only those runnable.
   - With a remote, the watcher's look at a pull request waiting for a person does the check. It
     does the resolution only while no more than `speed.max_parallel_changes` changes run a step
     that may run commands (the same rule `mergeWhenUpToDate` uses); otherwise a later look does it.

### What `catchUp` does

In the change's worktree, which is clean (each caller saves or refuses unsaved edits first):

1. The branch already contains main → `"current"`.
2. `rebaseOnto(main)` succeeds → `"rebased"`.
3. The rebase conflicted, and this build has already used `stages.review.max_resolutions`
   (default 3) resolutions → fail with the conflict note (below).
4. Otherwise **squash, then replay**. The branch is moved to main (`reset --keep`), and the
   whole change since it parted from main is applied on top in one go (`merge --squash`, with
   `merge.conflictStyle=diff3` so each conflict shows main's side, the base and the change's side).
   The commit it makes (runtime identity) lists the original subjects, plus a `Co-authored-by:`
   trailer for each author who is not the runtime, so a person's commits taken from a pull request
   keep their credit.
   - Squashing means the agent resolves every conflict once, against the final code, instead of
     once per commit. It also often makes a conflict that only existed in an intermediate commit
     go away. *(My call. Per-commit resolution would run a session per conflicting commit, and the
     same lines often conflict again in each one.)*
   - If the squash applies cleanly → `"rebased"` (the history changed, but nothing was resolved).
5. It conflicted: the **resolve** session runs (below). Then the runtime checks its work:
   - the session reported `resolved: true`;
   - no file is still unmerged, and none of the conflicted files has a conflict marker line
     (`<<<<<<< `, `=======`, `>>>>>>> ` at the start of a line).

   If all of that holds, the runtime stages everything (`git add -A`), checks nothing is left
   unmerged, and commits → `"resolved"`. Otherwise it puts the branch back where it was before the
   squash (`reset --hard` to the old head, then `clean -fd`: the worktree was clean when it
   started), and fails with the conflict note.
6. Each resolve session that answers, whatever it said, counts against `max_resolutions`
   (run-folder marker `resolutions`, cleared by a new build). One cut short does not.
7. **Interruptions.** The old head is written to the run-folder marker `catching-up` before the
   branch moves. A stop, an outage, the day's budget or a crash part-way puts the branch back:
   in a `finally` around the resolution, and otherwise the next time the worktree is opened
   (`openBranchWorktree`) or a build starts.

The result: `{ ok: true, outcome: "current" | "rebased" | "resolved" } | Failure`.

### The resolve session

- Step key `resolve`, in the review group, default model `strong` (a new `STEPS` entry, so
  `stages.review.steps.resolve` can change it, and it shows up in setup and the console like the
  other steps).
- A fresh session (it does not resume the build session, which runs on the build model). It uses
  the `build` tool set, `acceptEdits`, and runs in the worktree, mid-rebase.
- Prompt template `templates/prompts/resolve.md`. It gets:
  - the change's spec and plan;
  - the conflicted files, each with its conflicting sections as they are in the file (markers and
    both sides), capped at 200 lines per file and 40 000 characters in all, with a note that the
    agent should read the file when the cap cuts it;
  - the commits on main since the branch parted from it that touched those files (`%h %s`). Where
    a commit's subject starts with another change's slug (`<slug>: <title>`, the local merge's
    message) and `intent/<slug>/spec.md` exists, it names that spec and plan so the agent can read
    the other change's intent;
  - the test command, which the agent may run.
  It is told to keep both changes' intent, to edit only what the conflict needs, never to run git
  commands that change history (commit, rebase, reset, checkout), and to answer `resolved: false`
  with a reason when it cannot do this safely.
- Envelope `resolve`: `{ status, resolved: boolean, summary_markdown: string, reason: string }`.

### After a resolution: tests, then review

- **Review start:** a `"resolved"` catch-up runs the test loop (`testLoop(ctx, "resolve-test")`,
  with its usual fix budget) before round 1, so the reviewer reads tested code.
- **Merge checks:** a `"resolved"` up-to-date check passes with `changed: true`. The tests check
  runs after it as usual. The gate then reports `changed`, which sends the change back for one
  more review round (`anotherRound`). Today's rule that nothing merges unseen does the rest.
- **Waiting:** the test loop (`resolve-test`) runs, then the change takes one more review round
  (as `anotherRound`, counted through `roundsAllowed`) and its status goes to `reviewing`. The review
  rounds and then the merge checks run, and it comes back to `merge-review`.
- **Approvals on GitHub:** with `merge.human: pr`, an approval from before the latest resolution
  reached GitHub does not count. The run-folder marker `resolved-at` is `pending` until the push
  that carries the resolution, then that push's time; only an approval whose `submittedAt` (from
  gh's `latestReviews`, of someone with a say) is newer merges it, and the wait says why.
- **Pull requests waiting for a person:** before resolving, the watcher syncs main and takes
  commits a person added to the pull request (`upToDate`, under the merge lock), so the resolution
  includes them.
- **Binary conflicts** block before the session runs (git leaves main's copy with no markers).
  New files the session's commands wrote are removed before saving; commits may be empty. GitHub keeps an approval through a
  push unless the repository dismisses stale ones, and the resolution is code the person has not
  seen. `PrInfo` gains `approvedAt`.
- **What the reviewer sees:** the resolution's record (run-folder marker `resolution.md`) goes
  into the review prompt as a new variable `{{resolution}}`. It holds the conflicting sections as
  they were (both sides), the main commits involved, and the agent's summary. It is cleared when a
  review passes, and by a new build. A repository's own `review.md` without `{{resolution}}`
  still gets it, appended as a note, the way `build.md` gets `{{feedback}}` (`phasePrompt`'s
  `note` fallback).
- **Rounds:** resolution reviews do not use up `review.max_rounds`. Every limit check on the rounds
  (`runReviewRounds`, `anotherRound`) uses `max_rounds + resolutions used`, through one helper,
  `roundsAllowed(ctx)`.

### When it fails

The change blocks, as today, but with a new note and detail:

- Note: "The change overlaps with other recent changes, and resolving the conflict automatically
  did not work. Nothing was merged. The details are in conflict.md. An engineer needs to look at
  it."
- `conflict.md` (an artifact under `intent/<slug>/`, so the person sees it beside `review.md`)
  lists the conflicted files, their conflicting sections (both sides), the main commits involved,
  and either the agent's summary and reason, or the runtime's reason (markers left, files still
  unmerged, the session failed, the resolutions used up). The block's `detail` names the files
  and the reason.
- The branch is left exactly as it was before the attempt.
- When the cap is reached, the agent does not run. The note says so ("…has already been brought
  up to date as many times as allowed…").

### Observability

- The catch-up is a code phase (`catch-up`), so it gets its own row. Its trace event records the
  outcome, the main commit, and the files.
- The resolve session is an agent phase (`resolve`), with its own row, cost and folder, like any
  other.
- The merge gate's `up-to-date` row says `rebased onto main`, `resolved conflicts in a.ts, b.ts`,
  or the failure.
- `loopstra status`, the dashboard and `queue.md` need no changes. They show `reviewing` with the
  new status note, and the block note when it fails.

### Questions the design review raised, and the answers (my calls)

1. *A resolve cut short leaves the worktree mid-resolution.* Undone, via `catching-up` (step 7
   above), and not counted against the limit.
2. *An old GitHub approval could cover a resolution.* It does not (see Approvals on GitHub).
3. *Squashing with `gates.merge.method: merge`.* Accepted: squashing happens only on a conflict,
   the branch's commits are mostly the loop's own, and the squashed commit lists their subjects
   and keeps people's credit. Recorded in `docs/decisions.md`.
4. *Is a waiting change's resolution tested before its review, and which round is it?* Tested
   first; it is one more round, which the resolution allowance pays for.
5. *Without a remote, the resolution runs under the merge lock.* Accepted: fix sessions in the
   merge checks already do, and resolving before the lock would leave a window for main to move
   again.

## Config summary

```yaml
speed:
  ports_per_change: 10
  ports_from: 20000
  own_caches: false
stages:
  review:
    max_resolutions: 3     # conflict resolutions per build; their reviews do not count against max_rounds
    # steps: { resolve: strong }   # the default
```

## Tests

- `resources`: temp folder per change, created and removed on release. Ports: blocks never overlap
  between claimed changes, a busy port skips its block, none when the setting is 0. Caches only
  with `own_caches`, per slot. The env reaches project commands, hook commands and `build` /
  `read+commands` sessions, and not `read` / `read+git` sessions.
- `catchUp` against real git repositories (the existing helpers make them): current, a clean
  rebase, a conflict that squashing removes, a conflict resolved by a fake session (fake-claude
  writes the resolved file), a session that says `resolved: false`, a session that leaves markers,
  a cap that is used up. Failure leaves the branch at its old head, and `conflict.md` is written.
  Co-authored-by trailers.
- Review start: main gained code and the branch conflicts → resolve, test, review with
  `{{resolution}}` filled in. Main gained only records → no rebase, and the early review is used.
- Merge checks: a conflict is resolved, then another review round runs that does not use up
  `max_rounds`.
- Waiting: local `merge-review` with a person; main moves with a conflicting change → the tick
  makes it runnable, it is resolved, and it goes to `reviewing`. A clean one stays put. Remote: a
  pull request waiting for approval that conflicts → resolved, reviewed, and pushed to the same
  pull request.

## Docs

The README's `speed` and `stages.review` sections, "How it works" (what happens on a conflict),
`templates/config.yaml`, and `docs/decisions.md`: squash-then-replay, per-slot caches, the
resolution allowance on top of `max_rounds`, and git 2.38 for the waiting check.
