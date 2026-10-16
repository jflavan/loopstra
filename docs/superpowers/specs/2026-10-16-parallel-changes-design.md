# More than one change at a time (speed, part G)

Today each tick picks one change and runs one step for it. A step that only looked at a pull
request (`waiting`) lets the next change run in the same tick. Every change already has its own
branch and worktree, so the build, test and review sessions of two changes do not share files.
What they do share is the main checkout, a few files under `.loopstra/`, some module-level state,
and the daily budget. This change lets up to N changes run a step at the same time, and says how
each piece of shared state is handled.

This is part G of four speed changes (A: concurrent work, F: speculative plan, D: cheaper judges
in shadow mode, G: parallel changes). With the default of 1 the loop works as it does today.

It builds on parts A, F and D as merged. Work runs side by side through `alongside(ctx, main,
{ what, run, wanted })` and part F's `alongsideFirst(ctx, main, extra)`, and both share
`startAlongside`. A group's state lives in an `AsyncLocalStorage` per call chain, and a nested
group knows the group it runs inside of (part D). Extra work has `early-…` rows (`early-review`,
`early-lessons`, `early-plan`), and cheaper judges have `…-cheap` rows. The budget already has
`roomFor(cfg, trace, sessions)`, `mayOverlap` and `noSessionCap` on the shared `loopDayLeft`.

## Config

`src/config.ts`, inside the existing `speed:` object:

```ts
/** How many changes may each run a step at the same time. 1 = one at a time (as before). */
max_parallel_changes: z.number().int("must be a whole number").min(1, "must be 1 or more").max(4, "must be 4 or less").default(1),
```

`templates/config.yaml`, in the existing `speed:` block:

```yaml
# max_parallel_changes: how many changes may each run a step at the same time (1 to 4). Raise it
# only if the project's commands (test, lint, build, install) can run twice at once on this
# machine: no fixed ports, no shared test database, no output outside the worktree. Each command
# gets LOOPSTRA_SLUG, so it can pick its own port or database name. More changes at once also
# spend the daily budget and the subscription's usage limits faster.
speed:
  ...
  max_parallel_changes: 1
```

The README's `speed` bullet under Configuration (a list, not a table) gets the same advice.
`loopstra setup` does not ask about it, like the other speed switches.

## The model in one paragraph

A tick still does its tick-start work on its own: stale locks, the off-main check, the sync with
GitHub, chat requests, the main health check, the scan and its consistency blocks, `queue.md`,
cleanup of closed and merged changes, and the pause and day checks. It then starts up to N
**lanes**. Each lane runs today's pick loop over one shared list of runnable changes. The tick
waits for every lane, handles a stop, an outage or the day's budget once, and ends as today. Four
rules hold:

1. **One step per change at a time.** Lanes and the between-phases merge share one set of
   claimed changes.
2. **Git in the main checkout runs one command at a time**, and a few sequences run as one unit
   (the main lock).
3. **One merge at a time** (the merge lock): without a remote from the merge checks to the merge;
   with a remote from the up-to-date check to `gh pr merge`.
4. **Main is rebased onto GitHub's main in the middle of a tick only while one lane is running.**
   Otherwise the next tick's start does it.

Why the tick waits for every lane, instead of a pool that keeps refilling: everything that runs
"between steps" today (the sync, chat requests, consistency blocks, cleanup of closed changes,
the pause check) still runs while no step runs, so none of it needs a lock or a second look. The
cost is lanes sitting idle while the slowest step finishes. The trace records that idle time per
tick, so a rolling pool can be added later if the numbers show it is worth it.

## Mechanics

### New file `src/lanes.ts`: all concurrency state

It is the only place that holds concurrency state, and it imports nothing from the rest of
Loopstra. All locks are in-process, which is correct because one loop process runs per repository.

```ts
import { AsyncLocalStorage } from "node:async_hooks";

/** The locks the current async context holds (by name). Re-entering one it holds goes straight in. */
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** A first-come, first-served lock. Re-entrant within one async context. Released when fn ends, however it ends. */
function lock(name: string): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  let holder: string | null = null;
  let pending = 0;
  const heldHere = () => heldNames().has(name);
  const run = <T>(fn: () => Promise<T>, who = ""): Promise<T> => {
    if (heldHere()) return fn();
    const mine = new Set([...heldNames(), name]);
    pending++;
    const go = tail.then(() => { holder = who; return held.run(mine, fn); });
    const done = () => { holder = null; pending--; };
    tail = go.then(done, done);
    return go;
  };
  // Null at once, without running fn, when anyone else holds or waits for the lock.
  const tryRun = <T>(fn: () => Promise<T>, who = ""): Promise<T | null> =>
    !heldHere() && pending > 0 ? Promise.resolve(null) : run(fn, who);
  return { name, run, tryRun, heldHere, busy: () => pending > 0, holder: () => holder };
}
```

What it exports:

- `onMain(root, fn)`: the **main lock**. One lock per main checkout, keyed by the folder's real
  path (links, slashes, and case on Windows resolved). It covers the main checkout's index and
  files (`intent/**`, `queue.md`), refs, `.git/config`, the worktree list, and the remote refs.
- `mainLockKey(cwd)`: the key for a folder, or null for a folder inside a `.loopstra` folder (the
  change worktrees, the done-check and health copies of main). A worktree's index and branch
  belong to one change, and a change runs one step at a time.
- `onMainKey(key, fn)`: `onMain` for a key already worked out (`Git` works its key out once).
- `oneMerge`: the **merge lock**, with `run(fn, slug)` and a `tryRun(fn, slug)` that returns null
  without waiting when another change holds it or waits for it.
- `claim(slug)` (false when already claimed), `release(slug)`, `othersRunning(slug)` (claimed
  changes other than this one).
- `laneStarted()`, `laneEnded()`, `lanesRunning()`.
- `holdsLock()`: true when the current context holds either lock (for the phase boundary).
- `assertNoLock(where)` and `assertNoMainLock(where)`: throw a programming error.

**Lock order:** merge lock, then main lock. Taking the merge lock while holding a main lock throws a
programming error. No main-lock section contains an agent session or a merge gate, so the two
locks can never wait for each other.

**No parallel work inside a lock.** Child promises inherit the "held" set, so two children would
both think they hold the lock. An `alongside` or `alongsideFirst` group (through their shared
`startAlongside`) calls `assertNoLock`, and `attempt()` in `src/phases.ts` calls
`assertNoMainLock`. Agent sessions may run under the merge lock (the merge checks run fix
sessions); they never run under the main lock.

### The main lock: every command, plus a few sequences

1. **Every git command in a main checkout.** `Git` works out `mainLockKey(cwd)` once in its
   constructor. `Git.run` then runs the spawn inside that lock. Worktree `Git` objects get no key
   and take no lock, so builds, test runs and worktree rebases really run in parallel. This one
   change covers `createBranch`, `deleteBranch`, `worktree add/remove/prune`, `fetch`, `push -u`
   (which writes `.git/config`), and every bookkeeping command, without wrapping each method.
2. **Sequences that are only correct if main does not move in between.** Each is one `onMain`
   section (re-entrant, so the commands inside go straight through). Inside `src/git.ts` this is
   `Git.section(fn)`: `fn` under the checkout's main lock, or with no lock inside `.loopstra`.
   - `setStatus`, `writeArtifact` and `writeIntentPriority` in `src/context.ts`: from
     `assertRootOnMain`, through the file write, to the commit. `block` goes through `setStatus`.
     Without this, a commit could land halfway through another lane's sync rebase (HEAD
     detached), or `assertRootOnMain` would see the detached HEAD and wrongly block an innocent
     change with `OFF_MAIN_NOTE`.
   - `syncMain` and `shareMain` in `src/remote.ts`, whole.
   - In `src/stages/merge.ts`: `recordPersonEdits`. In `finishRemoteMerge`, the person-edits
     commit, the sync and the "main has it" check are one section, so nothing commits between them.
     `mergeNow` is one section: `rootReady`, the catch-up rebase, the `MERGING` marker, the
     `codePhase("merge")` and the merge. `cleanupChange` is one section.
   - In `src/git.ts`: `ensureWorktree` (exists check, remove, add) and `removeWorktree`.
     `withDetachedWorktree` takes the lock for its setup (remove, then add) and for its teardown,
     never around `fn`, so the done-check session runs without it.
   - Build's `branch` phase: `createBranch` plus `ensureWorktree` in one section. `install` runs
     after the section, in the worktree.
   - **Before and after commands that run in the main checkout** (the design, plan and verify
     stages: `runHookCommands` with `cwd === ctx.root`). These hold the main lock inside their
     code phase. They may write files or run git there, and running them alongside another
     change's sync, commit or merge would produce false "unsaved changes" waits, or a merge
     blocked with `DIRTY_ROOT_NOTE`. This is the one project command run under the lock. It only
     happens when such commands are configured, and the command time limit bounds it. Build and
     review commands run in the change's own worktree and take no lock.

Reads of a change's records (`artifacts()`, `readArtifact`, `readIntent`) take no lock. With rule
4, the working tree of main only ever moves forward while lanes run (bookkeeping commits, a local
fast-forward merge). So a read sees either the old or the new copy of a file, and never a
half-rebased main.

### The merge lock

- **Without a remote:** `mergeGate(ctx, onPass)` runs inside `oneMerge.run(…, ctx.slug)`. That
  covers `checkMerge` (rebase onto main, tests or `alreadyTested`, findings) and `mergeNow`. So
  between the merge checks and the merge, main can only gain records under `intent/`, which is
  what the existing "catch up again" rebase in `mergeNow` already assumes. The second change's
  `checkMerge` then rebases onto the first change's code. `alreadyTested` sees code outside
  `intent/` that changed, so the tests run again. A conflict blocks with the existing
  `UPDATE_FAILED_NOTE`.
- **With a remote:** the merge checks only open a pull request; nothing merges there. So
  `mergeGate` takes no lock with a remote. The lock covers the moment the merge actually happens,
  in `runRemoteMerge` (see "Pull requests that went out of date").
- When a change has to wait for the merge lock, the trace says so once, for example `waits for
  add-numbers to finish merging first`. The lock records who holds it.

### Rule 4: main is rebased in the middle of a tick only while one lane runs

`syncMain(root, cfg, trace, { rebase = true })` gets an option. When it is false and main is
behind GitHub, it fetches, does not rebase, returns `"waiting"`, and records no `main_sync`
signal, because this is not a sync problem. `finishRemoteMerge` passes
`rebase: lanesRunning() <= 1`. If main does not have the merged pull request yet, the step waits
as it does today (the existing `MAIN_BEHIND` marker, traced once). Its trace text for this case
says "main here is brought up to date at the start of the next check, because other changes are
being worked on". The next tick's start syncs with no lane running, and the merge watch then
records the merge.

Why: design, plan, intake, spec-check, plan-challenge and lessons sessions read the main
checkout directly. During a rebase, the main checkout briefly holds GitHub's main without the
local commits that have not been pushed yet. Another change's spec or plan, written this tick,
would be missing for a moment. A lock cannot cover a running agent session. Today this never
happens, because the between-phases merge runs only at a phase boundary, when no session of the
running step is going. At N=1 there is always one lane, so nothing changes.

### Module-level state in `src/phases.ts` and `src/scheduler.ts`

- **`phaseBoundary`**: set once per tick before the lanes start, cleared in `finally` after
  every lane has ended. All lanes share one closure.
- **Groups** need no change. Parts A and D keep an `alongside` group's state in an
  `AsyncLocalStorage` per call chain, so a group in one change already leaves the between-phases
  merge on for every other change. There is no `StepContext.groups`.
- **`boundary(ctx)`** does nothing inside a running group (as today), and also when the current
  context holds the merge lock or a main lock (`holdsLock()`). Without the merge-lock skip, a
  change holding the merge lock that waits on its boundary, while the boundary waits on another
  change that waits on the merge lock, would deadlock.
- **`mergingBetweenPhases`** stays, as the process-wide guard that only one between-phases merge
  pass runs at a time. It is checked and set synchronously, so it is safe on one thread.
- **`mergeReadyChanges`**:
  - skips changes that are claimed, and claims each change it runs, releasing it afterwards;
  - reads each change again from disk before running it;
  - runs each change under `oneMerge.tryRun(…, slug)`, so if another change is merging it skips
    the rest of the pass and those changes merge later;
  - and a lane that finds a change claimed by it marks the change taken for the rest of the tick,
    so no lane runs it again in that tick;
  - sets `ctx.betweenPhases = true` (a new field on `StepContext`) on the steps it starts.
- **`WATCHING_PR`** is a constant, not state.

### Tick loop shape (`src/scheduler.ts`)

```ts
// after the loopDayUsedUp check, replacing the single pick loop
const human = humanGates(cfg);
const candidates = ordered.filter((i) => isRunnable(i, human, hasRemote) && !waitingOn(i, ordered).length && !holds.has(i.slug));
const lanes = lanesFor(cfg, trace);                     // 1..max_parallel_changes, see Budget
traceLanes(trace, cfg, lanes);                          // only when fewer than configured: once a day per number
if (hasRemote) setPhaseBoundary((ctx) => mergeReadyChanges(root, cfg, trace, ctx));
const shared: TickLanes = { taken: new Set(), halt: false, problems: [] };
const started = Date.now();
const perLane = await Promise.all(Array.from({ length: lanes }, () => runLane(root, cfg, trace, candidates, shared, human, hasRemote)));
out.steps = perLane.flat();
// N=1 callers unchanged: the first lane's last step (the one that did real work, or the last that only looked).
const last = perLane.find((l) => l.length)?.at(-1);
out.picked = last?.slug ?? null; out.result = last?.result;
if (lanes > 1 && out.steps.length) trace.event("_loop", "command", { command: "changes worked on together", lanes, steps: out.steps.map((s) => s.slug), durationMs: Date.now() - started, busyMs: sum(out.steps.map((s) => s.durationMs)) });
return await afterLanes(root, cfg, trace, out, shared.problems, candidates);   // stop, outage, day budget: once, below
```

`out.picked` is not `steps[0]`: with one lane, `steps[0]` may be a merge watch that only waited
before the step that did real work. The "changes worked on together" event needs a step, so idle
polls add none.

`holds` is the map of same-file waits (see below), computed before `writeQueue`. It is empty at
N=1.

```ts
/** Runs steps one after another until one does real work. Never rejects. */
async function runLane(...): Promise<LaneStep[]> {
  const done: LaneStep[] = [];
  laneStarted();
  try {
    for (;;) {
      if (shared.halt || stopRequested()) return done;       // a stop, an outage or the day's budget: start nothing new
      // Taken for this tick and claimed in one synchronous go: two lanes never take one change, and a
      // change the between-phases merge has claimed is not taken again this tick.
      const next = candidates.find((i) => takeChange(shared, i.slug));
      if (!next) return done;
      heartbeatWorkingOn(root, next.slug);
      const t0 = Date.now();
      try {
        // Read again: a between-phases merge may have moved it since the scan. Null (traced) when unreadable.
        const fresh = await readFresh(root, trace, next.slug);
        if (!fresh || !isRunnable(fresh, human, hasRemote)) continue;
        const result = await runStepGuarded(new StepContext(root, cfg, trace, fresh));
        done.push({ slug: next.slug, result, durationMs: Date.now() - t0 });
        if (!(result.ok && result.waiting)) return done;
      } catch (e) {
        done.push(laneProblem(trace, shared, next.slug, e, Date.now() - t0));
        return done;
      } finally {
        release(next.slug);
        heartbeatDoneWith(root, next.slug);
      }
    }
  } finally {
    laneEnded();
  }
}
```

`laneProblem` handles the errors `runStepGuarded` passes on, plus an unreadable intent:

- `StopRequested`: traces `stop` for that change, then `{ slug, stopped: true }` and `halt`.
- `AssistantUnavailable`: records `{ slug, e }` and sets `halt`.
- `LoopBudgetReached`: records the slug and sets `halt`.
- An intent that cannot be read now (`readFresh`): traces `error { where: "lane" }`, and the lane
  moves on to the next candidate. The next scan reports it.
- Anything else: traces `error { where: "lane" }`, and the tick sets `crashed`.

A stop requested outside the lanes (at tick start) is traced under `_loop`.

After every lane has ended, `afterLanes` does the following:

- **A stop** (any lane): `out.stopped = true`. `endOfTick` skips as today.
- **An outage:** `afterUnavailable(root, cfg, trace, out, cause)` runs **once**. Its cause is the
  first change in queue order that met the outage, so the same change keeps being the cause and
  its repeat count grows. This is the same back-off as with one change: one more failure per
  tick, not one per lane. The probe and its block run here, after every step, so they never race
  a step.
- **The day's budget:** `afterDayBudget(root, cfg, trace, out, slugs)` runs once with every change
  that ran out. `dayPaused` is written once.

`afterUnavailable` takes the cause's slug and `afterDayBudget` the slugs, instead of reading
`out.picked`. `endOfTick` re-renders the queue when `out.steps.length > 0`. `start()` logs one
line per entry in `r.steps` that has a result, worded as today, so at N=1 a merge watch that only
waited followed by a real step now gives two lines instead of one.

The tick start also runs `git -c gc.autoDetach=false gc --auto --quiet` while no lane runs (see
the shared-state table). It may fail; a failure is only traced.

## Shared state, one item at a time

| Shared state | Today's assumption | How it is handled |
|---|---|---|
| Main checkout index (`commitPaths`: add, diff --cached, commit) | One writer | The main lock on every root command, plus `setStatus` / `writeArtifact` / `writeIntentPriority` as one section each. |
| `writeIntentPriority` leaves `intent.md` uncommitted through the whole design session | Only this step makes main dirty | It commits at once (`record priority`). Otherwise another change's mid-tick sync finds "unsaved changes to tracked files", and its merge waits a tick. This also helps at N=1, where a between-phases merge hits the same wait. |
| Intent records (`writeIntent` with `expectStatus`) | n/a | Each record belongs to one change, and only one step per change runs. `PersonChangedStatus` still catches a person's edit, or the remote's copy winning in `rebaseMain`. No change needed. |
| `queue.md` | Written at tick start and end, carried along by runtime commits | Unchanged. It is written only while no lane runs. Lane commits take along the copy on disk. |
| Sync and rebase of main at tick start | Nothing else touches main | No lane runs at that point. In the middle of a tick: rule 4. |
| `recordPersonEdits` | One writer | A main-lock section. In `finishRemoteMerge` it shares one section with the sync. |
| Local merge (`mergeNow`) | No commit lands between the checks and the merge | The merge lock from the checks to the merge, and the main lock across `mergeNow`. |
| Worktree and branch admin (shared `.git/worktrees`, refs, `packed-refs`) | One caller | Root commands are locked automatically. `ensureWorktree`, `removeWorktree`, the `withDetachedWorktree` setup and teardown, and `cleanupChange` are sections. |
| Commands inside worktrees (`saveWork`, `rebaseOnto`) | n/a | Each worktree has its own index and HEAD, so no lock is needed. Automatic `git gc` and maintenance are turned off for runtime commits, fetches and the fast-forward of a local merge (`-c gc.auto=0 -c maintenance.auto=false`, `NO_AUTO_MAINTENANCE`, part of `RUNTIME_COMMIT_CONFIG`); a fetch would otherwise start it in the background, outliving its main-lock section. Otherwise one change's commit could pack refs while another change commits or deletes a branch, and fail with "cannot lock ref". The tick start runs `git gc --auto --quiet` itself while no lane runs (allowed to fail, traced only on failure). |
| Read-only git on root (`isAncestor`, `ls-files`, `ls-tree`) | n/a | They go through the same per-command lock. They are short, so this costs little. |
| Run folders, `.loopstra/verify/<slug>`, `sessions.json`, phase folders | n/a | Each belongs to one change. Nothing to do. |
| `phaseBoundary`, `alongside` groups, `mergingBetweenPhases`, `mergeReadyChanges` | One step | See "Module-level state" above. |
| Heartbeat `current` (one change) | One step | `Heartbeat.working: string[]`, in the order the steps started, with `current` still written as the first entry for older readers. `LoopBeat.workingOn(slug)` adds and the new `doneWith(slug)` (`heartbeatDoneWith(root, slug)`) removes. `tickStarted`, `tickEnded` and `stopped` clear the list. |
| Pause (`paused.json`), probe | One cause at a time, and any success clears it | Handled once per tick, after the lanes. `clearPause(root, slug?)`: a success by the paused change itself (or with no cause recorded, or with no slug given, as the probe does) clears the pause as today. A success by another change ends the wait and resets the back-off (`until` = now, `failures` = 0), but **keeps the cause and its repeat count**. A change whose own phase keeps failing with outage-like words still reaches `PROBE_AFTER` and is blocked, even when other changes get through in between. |
| Daily budget holds (`startPhase`, `phaseStartWithin`) | One step, at most two sessions | Holds are already one transaction across sessions. Lanes and overlaps are sized so that concurrent steps cannot starve each other (see Budget). |
| Stop (process-wide `requested`) | One step | Every lane's next spawn or git call throws `StopRequested`. Each lane traces `stop` for its change. A lane waiting on a lock goes on once the lock is free, and its first git call throws. A cleanup call (`rebase --abort`) runs in the context that holds the lock, so it re-enters it. Locks live in memory and disappear with the process. |
| `depends_on` | Computed once per tick | `candidates` leaves out changes still waiting. A dependency that merges in the middle of a tick starts its dependants on the next tick: never early. |
| Chat requests | Applied at tick start | Unchanged. They wait at most for the tick's longest step, as they wait for the single step today. |
| `.loopstra/health-pending` (one slug) | One merge per tick, mostly | One slug per line, appended and without repeats (a single merge still writes just the slug). `mainHealthDue` returns every slug (`afterSlugs`). A failing check opens one draft intent that names every change merged since the last check ("after the changes a and b merged"), with its slug taken from the first. |
| Trace (`bun:sqlite`, one connection per tick) | n/a | Calls are synchronous and `phaseStartWithin` is one immediate transaction. The tick closes the trace only after every lane has ended. |
| Project commands in several worktrees (ports, a shared database, caches) | One at a time | The runtime cannot detect this. The default stays 1, the config comment and README state the condition for raising it, and `LOOPSTRA_SLUG` lets a project keep the changes apart. |
| Design and plan sessions reading the main checkout | Main does not move under them | Main only moves forward while lanes run (rule 4). A session that sees a newer main is the same as one that started a moment later. |
| The chat process (a separate process) | n/a | Unchanged. It leaves requests that the loop applies at tick start, and its pull-request copies are its own worktrees. |

## Budget: concurrent steps cannot starve each other (`src/budget.ts`)

- `roomFor(cfg, trace, sessions)`:
  - true when there is no daily budget;
  - false with a daily budget and no session cap, unless `sessions <= 1`;
  - otherwise `left >= sessions * cap`, where `left` already subtracts what running phases hold.
  It exists since part D; `mayOverlap` asks it for 2.
- `roomBeside(cfg, trace, slug, sessions)` is new: `roomFor(cfg, trace, sessions +
  othersRunning(slug))`.
- `lanesFor(cfg, trace)`:
  - `max_parallel_changes` when it is 1, or when there is no daily budget;
  - 1 with a daily budget and no session cap, because the first session would hold the rest of
    the day;
  - otherwise `min(N, max(1, floor(left / cap)))`.

  It is worked out once per tick. Every lane can then start its first session, and no second
  lane is started only to find it cannot.
- Every overlap counts the other running changes through `roomBeside`:
  - `mayOverlap` (part A: lessons beside the done-check, the early review beside verify) asks for
    2 of its own;
  - `plansAhead` (part F: the plan beside spec-check) asks for 2;
  - the cheaper judges' shadow and audit room in `judgeFirst` (part D) asks for 2, plus 1 when
    the judge already runs beside other work.

  One change's overlap can then never take the cap another running change needs for its next
  session. This counts a change already holding a session twice, on purpose. At N=1 it is
  exactly `roomFor(cfg, trace, sessions)`, as before.
- When `lanesFor` gives fewer lanes than configured, the trace says so once each time the
  number changes, and again on a new day: "Today's budget has room for 1 change at a time instead
  of 2." The number can go back up during a day (a killed session's hold stops counting once it
  is stale, or the owner raises the day's budget), and then the line comes again when it drops.
- When the day runs out in the middle of a step, as it can today, that change ends with
  `LoopBudgetReached`, the other lanes start nothing new, and `afterDayBudget` handles every
  change that hit it.
- `HAD_THE_DAY` is unchanged. When changes share a day it is harder to reach, so a too-big step
  pauses rather than blocks. That is the safe direction, and it matches the README ("one that
  other changes left less of the day only waits").

## Merge ordering and conflicts between parallel branches

### Without a remote

The merge lock serialises the merge checks and the merge (see above). The lock is first come,
first served, and lanes start in queue order, so merges follow priority. A change waiting in
`merge-review` for a person is rebased and tested again when its `merge-approved` step runs.
That is existing behaviour.

### Pull requests that went out of date (with a remote, N > 1 only)

After the first of two ready pull requests merges, the second one's base no longer has the
first one's code. Its checks never saw the two together. In `runRemoteMerge`, once the checks
have passed (and approval, where needed), and just before `mergeOnGitHub`, this code
(`mergeWhenUpToDate`) runs inside `oneMerge.run`:

1. `git fetch` (main lock, no automatic gc or maintenance). If it fails, the failure is traced
   and the step waits.
2. What GitHub would merge is judged, not the branch here: the pull request's branch as GitHub
   has it, `<remote>/<branch>` after the fetch. When the branch here has commits that copy lacks
   (`not pushed`: a bring-up-to-date rebased it, then a stop, an outage, the day's budget or a
   failed push ended the step before its push), go to step 6. Otherwise GitHub would merge the old
   head, which never met the other change.
3. `outOfDate(ref, pushed)` for `main`, then for `<remote>/<main>`. A ref is out of date when
   GitHub's copy of the branch does not contain it and the ref gained code outside `intent/`
   since their merge base. The new Git helper is `gainedCodeSince(base, ref, ["intent/"])`.
4. Neither ref is out of date: merge on GitHub as today, still inside the lock.
5. Only the remote's main is ahead: wait. The next tick's sync brings it in. The trace says once
   (a run-folder marker, cleared when the change is brought up to date or merges) that main here
   gets those changes at the start of the next check, and that the `main_sync` signal says why if
   it does not.
6. Local main is ahead, or the branch here is not pushed:
   - If this step was started between another change's phases (`ctx.betweenPhases`), it waits
     for its own turn.
   - Otherwise it leaves the lock and runs the merge checks again through `checkAgain`, the
     re-check the `merge-approved` path already used. It keeps unreviewed edits left in the
     worktree on the branch and sends them to review; otherwise it runs `mergeGate` (a rebase,
     the tests, the findings), then a push through `openPullRequest(ctx, false)`, which
     force-pushes with lease and keeps the pull request open. The step then returns `waiting`,
     with no status change.
   - The trace says, in plain words, "Brought up to date with changes merged meanwhile; waiting
     for the automatic checks on GitHub again."
   - Fixes made by those checks go back for a review round (`anotherRound`, then `reviewing`).
     A conflict blocks with `UPDATE_FAILED_NOTE`.

At N=1 this is off, so today's behaviour is kept exactly.

### Same files: a change waits instead of building into a conflict (N > 1 only)

A change at `plan-approved` waits when its plan's "Files that change" list
(`parsePlanFiles`) shares a file with another change that:

- is at `building`, `reviewing`, `merge-review` or `merge-approved`; or
- is at `plan-approved`, earlier in the queue, and not waiting on its own `depends_on`.

Blocked, closed and merged changes hold nobody. A change whose plan has no file list never
waits and holds nobody.

- **No deadlock:** a holder is either past `plan-approved` (and never waits for this reason) or
  earlier in the queue and free of dependency waits.
- **Where it is computed:** the pure rule is `fileHolds(ordered, files)` in `src/intents.ts`.
  `sameFileHolds(root, lanes, ordered)` in `src/scheduler.ts` reads the plans and calls it (it
  takes `speed.max_parallel_changes` as a number and returns nothing at 1). It is async, because
  it reads `plan.md`, and runs before `writeQueue` and again in `endOfTick`. It returns
  `Map<slug, holder>`. A plan that cannot be read counts as one with no file list.
- **The owner note:** `renderQueue(…, holds)` adds the note through `shownNote`: "Waits for
  add-numbers to be merged first, because both change the same files." Only `queue.md` shows it;
  `status` and the dashboard do not.
- **Why:** each rebase conflict blocks the change for an engineer. This only ever adds waiting,
  so no gate changes and quality cannot drop.

## What the owner sees

- **Loop line** (`status`, dashboard, `tail`):
  - "Running — working on add-numbers, last check 20s ago";
  - "Running — working on add-numbers and say-goodbye, …";
  - "… working on a, b and c, …".
- **Dashboard pill:** `LoopStatus.current` becomes `working: Array<{ slug, phase }>`.
  `buildState` in `src/commands/ui.ts` calls `runningPhase` for each change. `renderLoop` in
  `src/ui/index.html` appends "(a: build; b: verify + early-review)" through a pure `loopText`;
  with one change it keeps "(build)", and it leaves out a change with no running phase.
  `heartbeatState` still reads an old heartbeat that only has `current`.
- **`tail`:** its change key joins the slugs, so it prints when the set changes.
- **New owner notes:** the same-file wait, and the "brought up to date" trace line. The trace also
  records waits for the merge lock, fewer lanes than configured because of the budget, and one
  "changes worked on together" event per tick with lanes, steps, duration and busy time.

## Edge cases

- **`max_parallel_changes: 1`:** one lane, the same pick loop, the same `out.picked` and `result`,
  and the sync rebase allowed. No same-file waits and no out-of-date check. Small, deliberate
  differences:
  - the intake priority gets its own commit;
  - another change's success no longer resets a looping change's repeat count;
  - automatic gc runs at tick start instead of after runtime commits;
  - the health check names every change merged since the last check;
  - the pick re-reads the change before running it, which only matters when a between-phases
    merge already moved it.
- **Fewer runnable changes than lanes:** the extra lanes find nothing and end at once.
- **A step only looked** (a merge watch waiting on GitHub): its lane takes the next unclaimed
  change, as the single loop does today.
- **The between-phases merge merges a change a lane has not reached yet:** the lane reads it
  again, and either skips it or runs its next step. There is no false "a person changed the
  status".
- **The between-phases merge would run a change a lane is running:** the claim stops it. If it is
  called while its own step holds the merge lock or a main lock, it does nothing. If another
  change is merging, `tryRun` skips the pass.
- **Two lanes reach a local merge together:** the second waits (traced once), then rebases onto
  the first change's code and runs the tests again. A conflict blocks with `UPDATE_FAILED_NOTE`
  and main keeps only the first change.
- **A lane runs `finishRemoteMerge` while another lane is running:**
  - main is fetched but not rebased;
  - the step waits;
  - the next tick's start syncs, or a merge between another change's phases does once only one
    lane is left (rule 4 allows a rebase then);
  - the merge is recorded on the following watch;
  - no session ever sees a half-rebased main.
- **The remote's copy of an in-flight change's `intent.md` wins at a tick-start sync:** that
  lane's next `setStatus` hits the `expectStatus` mismatch and gives `PersonChangedStatus`, as
  today.
- **B depends on A, and A merges in another lane:** B starts on the next tick.
- **One change keeps failing with outage-like words while others succeed:** its repeat count
  still grows, and after `PROBE_AFTER` the probe runs and the change is blocked as a crash.
- **A real outage:**
  - every lane meets it on its own (unavailable sessions cost nothing);
  - lanes start nothing new;
  - one pause is written, and back-off grows one step per tick, as with one change;
  - the probe fails and the loop keeps backing off.
- **The day runs out in one lane:** that change pauses (or blocks under the existing two-day
  rule). The other lanes finish their current step and start nothing new.
- **A daily budget with no session cap:** one lane whatever `max_parallel_changes` says, traced
  once.
- **A stop while lanes run:**
  - every running phase is marked interrupted;
  - every change keeps its status;
  - there is one `stop` event per change;
  - `tick.stopped` is set;
  - no lock is left held, so a second tick in the same process runs normally.
- **A git command hangs while holding the main lock:** other lanes wait up to `GIT_TIMEOUT_MS`,
  then that change is blocked with `GIT_TIMEOUT_NOTE` and the lock is released in `finally`.
- **Design or plan before/after commands are configured:** they run one at a time and never
  alongside another change's commit, sync or merge. Other lanes' bookkeeping waits for them,
  bounded by the command time limit.
- **Two build steps start together:** branch creation and worktree add/prune run one at a time.
  Both worktrees are created, and neither prune removes the other's half-made worktree.
- **A person switches the main checkout to another branch during a tick:** each lane's next write
  gets `MainCheckoutMoved` and returns `OFF_MAIN_NOTE`, as today.
- **A person has uncommitted edits in the main checkout:** as today, the sync waits and a local
  merge blocks with `DIRTY_ROOT_NOTE`.
- **Two changes' project commands fight over a port or database:** this cannot be detected.
  Raising N above 1 requires that this cannot happen (config comment, README).
- **A person closes a change while its build runs:** its step ends with `PersonChangedStatus` at
  its next write. Its worktree is removed at the next tick's start, after the step has ended.
- **An old heartbeat with only `current`:** the dashboard, `status` and `tail` still show it.

## Out of scope

- A rolling pool that refills lanes freed by real work in the middle of a tick. This is a
  follow-up only if the per-tick busy and idle numbers show enough idle lane time.
- Cancelling other lanes when one meets an outage.
- Resolving rebase conflicts automatically, or rebuilding a conflicted change by itself.
- Giving each lane its own port or environment for project commands. `LOOPSTRA_SLUG` already
  exists.
- More than one loop process per repository, and an instance lock. True today as well; tracked
  separately.
- The out-of-date pull-request check at N=1.
- Re-checking `alreadyTested` inside `mergeNow` after its catch-up rebase. With the merge lock,
  only records can land there.

## Tests

Unit:

- `lanes.test.ts`:
  - the lock serves callers in arrival order;
  - entry and exit records from 5 concurrent callers never overlap;
  - a nested call in the same context goes straight in;
  - a parallel context waits;
  - a throw (including `StopRequested`) releases the lock;
  - `holder()` names the holder;
  - `tryRun` returns null when the lock is busy;
  - taking the merge lock while holding a main lock throws;
  - `claim` refuses a second claim and `release` allows it again;
  - `lanesRunning` counts.
- `git.test.ts`:
  - a `Git` for a main checkout takes the main lock on every command;
  - a `Git` for `.loopstra/worktrees/x` does not;
  - runtime commits carry `gc.auto=0` and `maintenance.auto=false`.
- **Stress test** (temporary repo): 20 changes run `setStatus` plus `writeArtifact` at the same
  time.
  - Every commit succeeds and there is no `index.lock` error.
  - `git status --porcelain` is clean apart from `queue.md`.
  - Each commit holds only its own `intent/<slug>` paths plus `queue.md`.
  - Run once by hand without the per-command lock in `Git.run`, to show the test catches the
    bug (it fails with `index.lock` errors). It passes with only the sections removed, because
    the per-command lock already keeps those commits apart; the next test covers the sections.
- **Sync against `setStatus`:** the remote's main is ahead. Run `syncMain` and `setStatus` on
  another change together, 20 times. Never `MainCheckoutMoved`, both commits on main, no rebase
  left in progress. It fails without the sections.
- `budget.test.ts`, `roomFor`, `roomBeside` and `lanesFor`:
  - no daily budget gives N;
  - a daily budget with no cap gives 1;
  - day $10 and cap $4 gives 2;
  - day $10 with $7 spent and cap $2 gives 1;
  - a running hold of another change lowers the count;
  - never below 1;
  - N=1 always gives 1;
  - `roomBeside(…, 2)` with one other change running needs 3 caps.
- `heartbeat.test.ts`:
  - `workingOn(a)` then `workingOn(b)` gives `working` [a, b] and "working on a and b";
  - three changes give "a, b and c";
  - `doneWith(a)` leaves [b];
  - `tickEnded` clears the list;
  - an old heartbeat with `current` still renders;
  - `clearPause(root, otherSlug)` ends the wait and keeps slug, phase, line and repeats, and the
    next pause with the same cause gives repeats + 1;
  - `clearPause(root, causeSlug)` clears the pause completely.
- `signals.test.ts`: two merges leave both slugs in `health-pending`, and a failing check opens
  one draft that names both.
- `context.test.ts`: `writeIntentPriority` commits (`record priority`) and leaves main clean.
- `phases.test.ts`:
  - a group in change A does not stop change B's boundary (already true since parts A and D,
    kept as a guard);
  - the boundary does nothing while the context holds the merge lock or a main lock;
  - an `alongside` or `alongsideFirst` group under any lock, and an agent session under a main
    lock, throw a programming error; a session under the merge lock is allowed.
- The stage tests: `mayOverlap`, `plansAhead` and the cheaper judges' room count another
  running change.
- `intents-queue.test.ts`, the same-file wait:
  - a `plan-approved` change listing a file that a `building` change lists gets the note;
  - an earlier `plan-approved` change holds a later one;
  - a holder that is blocked, closed, or waiting on `depends_on` holds nobody;
  - a plan without a file list never waits;
  - nothing at N=1.
- `config.test.ts`: 0, 1.5 and 5 each give a plain error. The template round-trip covers the new
  key.
- `ui.test.ts` and `tail.test.ts`: `buildState().loop.working` lists both changes with their
  running phases, and `tail` prints when the set changes.

Integration (`LOOPSTRA_FAKE_DELAY_MS`):

- The fake claude reads `$LOOPSTRA_FAKE_FIXTURE_DIR/<LOOPSTRA_SLUG>/` first when that folder
  exists, with its own `.count-<phase>` files, so concurrent sessions of one phase in different
  changes get the right fixtures. A unit test runs two such calls at once.
- **N=1 golden:** the existing loop test's phase names and status changes come out in the same
  order.
- **N=2, two accepted changes:** both reach their next status in one tick. B's intake
  `phase_start` id is lower than A's last `phase_end` id: judged by start order, as in 1a72341,
  not by time overlap. With the default of 1, B is untouched after the tick.
- **Main-commit stress through the loop:** N=3, three changes, fake sessions with no delay,
  5 ticks.
  - No trace error mentions `index.lock` and no change is blocked.
  - Main is clean apart from `queue.md`.
  - Every status change has its bookkeeping commit.
- **Local merge order:** two changes in `reviewing`, `merge.human: none`, N=2, both editing one
  file without conflict.
  - Both merge.
  - B's merge checks start after A's `merge` phase ends.
  - B ran its tests again (a `merge-test-1` phase) on a commit that contains A.
  - Conflicting variant: B is blocked with `UPDATE_FAILED_NOTE`, main has only A's change, and
    the index is clean.
- **Rule 4:** with a fake gh and a bare remote, N=2.
  - A's pull request merges while B's intake session is held (a `wait_for` fixture line, released
    once A's step has looked at main: order, not time). B's intake ends with a question, so B's
    step has no later phase: with one lane left, a merge between B's phases could rightly bring
    main up to date in that tick. A's step waits with the new trace text, main is not rebased
    during the tick (the trace has no `sync main` command before the tick ends), and the next tick
    records A as merged.
  - With N=1 (in a copy of the repository) the merge is recorded in the same tick, as today.
- **Out-of-date pull request** (fake gh, bare remote, N=2): two pull requests are both ready.
  - After the first merges, the second is not merged by gh. It is rebased, pushed again, keeps
    `merge-review`, and the trace has the "brought up to date" line.
  - It merges on a later tick once the checks pass.
  - Started between another change's phases, it waits for its own turn instead.
  - Looked at again while only the remote's main is ahead, it waits and the wait is traced once.
  - A branch rebased here but never pushed (a re-check that stopped before its push) is checked
    again and pushed, never merged with GitHub's old head.
  - With N=1 the behaviour is unchanged.
- **Claims:** with N=2, a `merge-review` change in one lane is never also run by the other lane's
  between-phases merge: exactly one `merge` phase and one change to `merged` for it, with up to
  two more ticks allowed for rule 4 to record the merge.
- The remote tests start at N=2: a changed `loopstra/config.yaml` is code outside `intent/`, so
  switching N in the middle of a test would put open pull requests out of date.
- **`depends_on`:** B depends on A, N=2, A at `plan-approved`. The tick builds A, and B has no
  phase rows. After A merges, B runs on the next tick, and its branch contains A's code.
- **Stop:** N=2 with two `hang` sessions; `requestStop` in the middle.
  - Both phases end `interrupted` and both changes keep their statuses.
  - `tick.stopped` is set and there is one `stop` event per change.
  - A second tick in the same process runs (no lock left held).
- **Outage in one lane:** A's build fails with a usage-limit line, and B is a delayed success.
  - Over 3 ticks the pause cause is A every time, its repeats reach 3, the probe runs, and A is
    blocked as a crash.
  - B keeps moving.
  - When both lanes fail, one pause is written per tick (failures + 1, not + 2) and no new change
    starts in that tick.
  - With a remote: a lane whose step only looked at a pull request (checks pending, GitHub's
    answer held until the other lane met the outage) starts no further change. This is the case
    the halt is for: any other lane ends after its own problem anyway.
  - The probe blocks a change that ran in the second lane: the tick's `picked` and `result` stay
    the first lane's step, and the block is on the second lane's step in `steps`.
- **Budget:** day $3, cap $2, N=2 gives one lane (the trace says "room for 1 change at a time
  instead of 2", once). Day $8 gives two lanes, and no lane hits `LoopBudgetReached` on its first
  session. (A $4 day gives floor(4/2) = 2 lanes on a fresh day.)
- **Worktrees:** two build steps start in the same tick. Both worktrees exist,
  `git worktree list` shows both, and neither step is blocked.
- **Before commands in the main checkout:** two changes with `design.before` commands that note,
  in order in one file, when they start and end and where main's HEAD is at each moment, and keep
  running 1.5 seconds in between. Each start is followed by its own end (the runs never overlap),
  and HEAD is the same at a run's start and end (no commit lands on main while it runs). Without
  the main lock around them the runs overlap.
- **Same-file wait:** N=2 and two `plan-approved` changes listing the same file. Only the first
  builds. The second shows the note in `queue.md` and builds after the first merges. Each change
  in the lanes tests has its own plan fixture listing the files its build writes, so changes
  that do not share files are not held.
- **Regression:** the existing suite passes unchanged at the default of 1, apart from tests that
  count bookkeeping commits around intake.

## Risks, and what covers each

- **A main-checkout sequence left without a section.** Single commands are covered automatically.
  A missed sequence would show up as `index.lock` errors or an innocent change blocked with
  `OFF_MAIN_NOTE`. Covered by the section list above, the 20-change stress test, the sync against
  `setStatus` test, and the N=3 loop stress test.
- **Untested code reaching main.** Covered locally by the merge lock and the local merge-order
  test. With a remote at N>1, by the out-of-date check and its test.
- **A session reading a half-rebased main.** Covered by rule 4 and its test.
- **Outage bookkeeping across lanes** (a looping failure never probed, or back-off growing per
  lane). Covered by the single `afterUnavailable` with a cause in queue order, the
  `clearPause(slug)` rule, and the one-lane outage test.
- **Deadlock between the boundary and the locks.** Covered by the fixed lock order, the boundary
  skipping under a lock, `tryRun` for the pass, the assertions, and the unit tests for each case.
- **Budget starvation.** Covered by `lanesFor`, `roomBeside`, and the budget tests. What
  is left is draining at the end of the day, as today.
- **Project commands fighting in parallel worktrees.** A quality risk code cannot fully remove:
  a fix session might "fix" a test that only failed because of the clash. Covered by the default
  of 1, the config comment, the README, and `LOOPSTRA_SLUG`.
- **Waiting for the slowest lane** makes the speed-up less than N. Measured by the per-tick
  "changes worked on together" event.
- **Long main-lock holds** (fetch or push in a sync, before/after commands in the main checkout)
  slow other lanes' bookkeeping. They are correct, bounded by the time limits, and visible in
  phase durations.

## Docs

- `docs/decisions.md` gets a section "Parallel changes (speed, part G)" covering:
  - the tick waiting for every lane, and why;
  - the two locks and what each covers;
  - the automatic per-command lock;
  - rule 4;
  - claims;
  - outage and day handling once per tick, and `clearPause(slug)`;
  - `lanesFor` and `roomBeside`;
  - the out-of-date pull-request check;
  - the same-file wait;
  - the cuts.
- README: "one step at a time" (the opening paragraph) becomes "one step per change at a time,
  for up to `speed.max_parallel_changes` changes at once". The line "It runs one change at a
  time." changes to match, and "How it works" gets a bullet on more than one change at a time.

## Decisions
- Base is Design 1 (lanes that each run today's pick loop, the tick waiting for every lane, onMain plus oneMerge, inFlight claims, the keep-repeats clearPause rule): it reuses the most existing code and keeps N=1 on the same path.
- The main lock is taken automatically by Git.run for any cwd outside a .loopstra folder (taken from Design 2), plus explicit sections for sequences: one change in Git.run covers every single admin command, so ~8 Git methods no longer need wrapping one by one.
- New rule (in neither design): main is rebased onto GitHub's main in the middle of a tick only while one lane is running. Design, plan and judge sessions read the main checkout directly, and a running agent session cannot be locked. Design 2's read locks therefore did not cover them, and Design 1 wrongly treated the rebase window as main simply moving forward.
- Outage and day-budget handling run once per tick after every lane has ended, with the outage cause taken as the first change in queue order. Back-off then grows one step per tick, as with one change, and the probe never races a step. This was Design 1's open question; Design 2's second-hand session hold was not taken, because a false outage in A would then end B's step on every tick.
- clearPause(root, slug): a success by another change resets the back-off but keeps the cause and its repeat count. This is Design 1's rule over Design 2's, because the assistant being reachable should end the back-off. It applies at N=1 too, since it is strictly a fix.
- The lane count is min(N, max(1, floor(left/cap))), and 1 with a daily budget but no cap (Design 2's formula). Every overlap (part A's mayOverlap, part F's plansAhead, part D's shadow and audit room) then asks for roomBeside, its own sessions plus othersRunning: simpler than Design 1's two caps per lane, and overlaps turn themselves off when the budget is tight.
- The merge lock wraps mergeGate only when there is no remote. With a remote it covers the out-of-date check plus gh pr merge, which is where the merge actually happens, so remote merge checks still run their tests in parallel.
- The out-of-date pull-request re-check before gh pr merge ships at N>1 only, so N=1 stays exactly as today. It runs the merge checks again outside the lock and waits when only the remote's main is ahead, which happens because rule 4 can delay the local rebase.
- The same-file wait at plan-approved ships in v1, at N>1 only, and uses the plan's file list without a drift check: it only ever adds waiting and saves an engineer for every rebase conflict. The tie-break and the depends_on exclusion make it deadlock-free.
- max_parallel_changes is capped at 4 (Design 2 proposed 8): subscription usage limits and contention between worktrees make more than 4 unlikely to help, and the cap can be raised later.
- No LOOPSTRA_LANE variable: LOOPSTRA_SLUG already gives project commands a stable way to keep changes apart.
- writeIntentPriority commits at once instead of making syncMain ignore Loopstra's own unsaved edits: one more bookkeeping commit per change is simpler than a second dirty-file rule, and it also helps at N=1.
- Runtime commits, fetches and the fast-forward of a local merge turn off automatic git gc and maintenance (gc.auto=0, maintenance.auto=false), and the tick start runs git gc --auto while no lane runs. Otherwise a pack-refs run during one change's commit can make another change's save fail and block it for an engineer.
- health-pending becomes a list of slugs, so the draft opened for failing tests names every change merged since the last check: plain-language accuracy matters to the owner, and the change is about 10 lines.
- Groups stay per call chain, as parts A and D already made them (an AsyncLocalStorage, with nested groups knowing their parent), so no StepContext.groups is added. The boundary also skips while the context holds either lock (from Design 2): this prevents a boundary/merge-lock deadlock once the merge checks hold the merge lock.
- Rejected from Design 2: reloading the config on every refill, a fresh scan on every launch, locking record reads, a step_start/step_end EventType, and the alreadyTested re-check inside mergeNow. Each adds code for a case that rule 4, the batch model or the merge lock already rules out.
- Rejected from Design 1: the LOOPSTRA_CHECK_MAIN_LOCK test-only check, made unnecessary by the automatic per-command lock (sequences are covered by the stress tests instead).
- No single-instance lock in G: running two loops on one repository is unsafe today as well, so it is tracked separately rather than widening this change.
- The rolling pool, cancelling other lanes on an outage, per-lane ports, automatic conflict resolution, and the out-of-date check at N=1 are cut, and recorded in decisions.md as follow-ups that the trace data can justify.
