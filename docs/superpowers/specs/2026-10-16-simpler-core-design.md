# A simpler core: main moves once, a pull request watcher, snapshots, record locks

Date: 2026-10-16. Follows the speed work (parts A, F, D and G) and the review of the whole of `main`
that came after it. It changes how Loopstra works underneath, not what a person sees: gates,
statuses, notes and settings stay the same. Five changes, each removing a group of special cases.

## 1. Main is replayed in a separate worktree, then moved once

**Before.** `syncMain` rebased local `main` onto GitHub's `main` inside the main checkout. During the
rebase the checkout briefly held GitHub's main without the local records not pushed yet, so rule 4
said main may only be rebased in the middle of a tick while one lane runs (`syncMain({ rebase })`,
`lanesRunning()`, a quiet `waiting` outcome with no signal, the "because other changes are being
worked on" wait in `finishRemoteMerge`). A loop killed mid-rebase left main detached with a rebase in
progress that nothing detected; `git checkout main` then let a later abort reset main to a stale
commit.

**After.**

- The fetch runs first, outside the checkout lock.
- When local main is behind and has nothing of its own, its new commit is GitHub's main itself (a fast-forward).
- Otherwise the local commits are replayed on top of GitHub's main in a throwaway detached worktree
  (`.loopstra/sync`). The rule for conflicts is unchanged: a conflict inside `intent/` takes the
  remote's side, and any other conflict leaves main as it was ("main_sync: clash").
- Main is then moved once, under the checkout lock: `git reset --keep <new>` in the main checkout. If
  main gained a record while the replay ran, those commits are replayed onto the result first, in
  the same worktree, still under the lock.
- A move that fails part way (Windows refuses to replace a file someone has open) is put back.
  Every file the move touched gets `from`'s content again, and its index entry too. A file whose
  content is neither `from`'s nor `to`'s is a person's edit and is left alone.
- A move cut short by a kill leaves `.loopstra/moving-main` behind. The next tick puts it back
  before anything else, or pauses with a plain note while it cannot.
- The local merge uses the same move. Both merge methods build their commit with `git commit-tree`
  (the merge checks make sure the branch contains main), so no merge runs in the main checkout.
  That also makes "lands whole or not at all" true.

**Removed:** rule 4, `syncMain`'s `rebase` option and its quiet outcome, `lanesRunning`,
`laneStarted`/`laneEnded`, and the in-place `rebaseMain`/`replayMain`. A pull request merged
mid-tick is recorded at once instead of on the next tick. The wait for the remote's main
(`remote-ahead`) stays only for when the sync cannot bring it in (unsaved changes in the checkout,
GitHub out of reach): the up-to-date check syncs main first.

## 2. A pull request watcher beside the lanes

**Before.** With a remote, a global phase-boundary hook ran before every phase of every step, and
merged other changes whose pull requests were ready (`setPhaseBoundary`, `mergeReadyChanges`). It
needed:

- `boundary()`'s exceptions inside `alongside` groups and under locks;
- the rule that `alongsideFirst`'s `rest` must be called before any other phase, and the group's
  `hold`/`release`;
- `ownTime`/`boundaryClock`, so a judge's time left out merges run inside it;
- the `mergingBetweenPhases` flag;
- `ctx.betweenPhases`;
- a `boundary()` call before the plan step compared a kept plan's code.

**After.** With a remote, the tick runs one watcher beside its lanes. It is the only runner of
changes at `merge-review` and `merge-approved`, which the lanes no longer take.

- **When it looks.** At the start of the lanes, again every `poll_seconds` while any lane runs, and
  once more when the last lane has ended.
- **What one look does.** It runs the merge step of each such change, in queue order, under that
  change's claim, so it never runs a change a lane is running.
- **Bringing a pull request up to date.** A look may bring a pull request up to date (the merge
  checks again: rebase, tests, fixes; `speed.max_parallel_changes` above 1 only, changed by the review
  fixes of 2026-10-18 to every value) only while no more
  than `speed.max_parallel_changes` changes run a step, counting this one. Otherwise it waits for a
  later look; the one after the last lane ends always has room.
- **Problems.** A stop, an outage or the day's budget in a watched step is handled like a lane's:
  it ends the watcher, no lane starts another step, and the tick handles it once.
- **What the tick reports.** Its steps are in `TickResult.steps`, with at most one "waiting for
  GitHub" per change per tick.

Lanes never get a "waiting" step any more, so a lane runs one step and ends.

**Removed:** `setPhaseBoundary`, `boundary`, `ownTime`, the group's `running`/`hold`/`release`, the
"call rest first" rule, `mergingBetweenPhases`, `mergeBetweenPhases` and `ctx.betweenPhases`.

## 3. One snapshot per step for read-only sessions

**Before.** The intake, design, spec-check, plan, plan-challenge and lessons sessions (and the
plan written ahead) read the live main checkout. They saw a person's uncommitted edits, and main
could move under them. Plan ahead fingerprinted the working tree (`codeState`: the diff of tracked
files plus every untracked file's contents) before and after its session, and again in the plan
step.

**After.**

- **Which commit.** A step's read-only sessions read one commit: main's when the step first needs
  it (`ctx.readCommit()`).
- **Where.** They run in a detached worktree of that commit (`.loopstra/snapshots/<slug>`), made
  the first time a session needs it and removed when the step ends. A session with a `cwd` of its
  own (build, fix, review, the verifier, the done-check) is unchanged.
- **What they no longer see.** Uncommitted files in the main checkout: a person's edits, or what a
  `before` command leaves uncommitted.
- **Plan ahead.** A plan written ahead records the commit it read. The plan step uses it only if its
  own commit has the same code: `git diff --quiet <base> <now>`, leaving out `intent/`, `.loopstra/`
  and `loopstra/config.yaml`.
- **Leftovers.** Snapshots a killed loop left behind are removed at the next tick's start.

**Removed:** `codeState` and the before-and-after comparison around the plan written ahead.

## 4. Locks follow what is written

**Before.** One main lock per main checkout, taken automatically by every git command run there. That
included `git worktree add` and `remove` (about 3 s each on a 10k-file repository), `fetch`, `push`
and `ls-remote`, so one change's checkout or network call stalled every other change's bookkeeping.
`mainLockKey` also gave no lock at all to a repository that lives under any folder named `.loopstra`.

**After.** Four locks, always taken in this order (any other order is a programming error): the
merge lock, the sync lock, the checkout lock, the remote lock.

- **The merge lock** is unchanged: one merge at a time.
- **The sync lock**: one sync of main with the remote at a time, since each replays main in the same
  worktree. The tick's start and the pull request watcher are the only callers, so it is never
  waited for in practice, but it makes that structural rather than a coincidence of call sites.
- **The checkout lock** (one per main checkout) covers what is written in the main checkout: its
  index, its files and its `main` branch. `Git` takes it for the commands that write or refresh the
  index or the files there:
  - `add`, `commit`, `status`, `diff`, `checkout`, `reset`, `merge`, `rebase`, `rm`, `restore`,
    `stash`, `cherry-pick`, `apply`, `read-tree`, `update-index`.

  Sections take it explicitly:
  - the record writer;
  - moving main;
  - the local merge;
  - before and after commands that run in the main checkout.
- **The remote lock** covers what `fetch` and `push` write: the remote-tracking refs. Network calls
  wait only for each other.
- **No lock** for worktree administration, branch creation and deletion, `ls-remote`, or reads of
  refs and objects. Git protects a worktree being added from a concurrent prune itself (its
  "initializing" lock).
- **Which checkouts lock.** A linked worktree (its `.git` is a file: a change's worktree, a
  snapshot, the done-check, health and sync copies) has its own index and takes no lock.

**One record writer.** `setStatus`, `writeArtifact`, `writeIntentPriority`, recording a person's
edits, the chat requests and the main-health intent each wrote files under `intent/<slug>` and
committed them in a section of their own. They now all call `commitRecord`:

- it takes the checkout lock and checks the checkout is on main;
- it writes, then commits `intent/<slug>` with `intent/queue.md`;
- once writing has begun, the commit's git commands are not stopped by a stop request (they are
  still bounded by the git time limit), so a stop never leaves a record written but not committed.

## 5. Smaller items

- **Trace indexes.** The trace gains indexes for its hot lookups:
  - `events (slug, type, id)`, for `lastEvent`, which scanned every `_loop` row;
  - `signals (name, id)`;
  - `gates (slug, gate, check, id)`;
  - `phases (started)`.
- **One session runner.** `runChatAgent` and `attempt()` share one traced-session core
  (`src/sessions.ts`). It writes the phase folder, runs the session, reads its report, ends its row
  and records the commands it was refused. Chat used to drop that last part on an unreadable report.
- **Duplicate helpers.** One copy of each:
  - the "a, b and c" joiner, in `src/text.ts`;
  - `humanGates`, the merged statuses and `pidAlive`;
  - "trace this when it changed".
- **Unused code.** Two unused names are gone.

## What stays

- Gates, statuses, notes, settings and the trace's shape.
- Claims, the merge lock, the budget rules, `alongside` and `alongsideFirst` (minus the boundary
  rules), the early review, cheaper judges, plan ahead.
- The tick waits for every lane, and now for the watcher too.

## Tests

- **The main sync:**
  - a fast-forward;
  - a replay that keeps local records on top of GitHub's main, and takes GitHub's side inside
    `intent/`;
  - a clash that leaves main untouched;
  - a record committed while the replay ran is kept;
  - a move cut short (files written, the index half written, the branch not moved) is put back at
    the next tick's start, and a person's file is never touched;
  - one that cannot be put back yet (git's lock still there) pauses the tick, and settles once the
    lock is gone;
  - a move that cannot land leaves main, its files and a person's file as they were.
- **The local merge:** both methods land through the move.
- **The watcher:**
  - a pull request that passes its checks while another change's build runs merges during that
    build's test command;
  - a watched change is never run by a lane, and merges once;
  - a pull request it brought up to date is not looked at again in the same tick;
  - with every lane busy it does not bring a pull request up to date;
  - an outage in a lane ends it too.
- **Snapshots:**
  - read-only sessions run in `.loopstra/snapshots/<slug>` and never see an uncommitted file of
    the main checkout;
  - the snapshot is gone after the step;
  - plan ahead is used when only records changed, and not when code changed.
- **Locks:**
  - a worktree add never waits for the checkout lock, nor the checkout lock for a fetch;
  - a repository under a folder named `.loopstra` still locks its main checkout;
  - a stop between a record's write and its commit leaves nothing uncommitted.
- **The rest:** the trace's indexes exist, and the shared session runner records refused commands
  for chat too.
