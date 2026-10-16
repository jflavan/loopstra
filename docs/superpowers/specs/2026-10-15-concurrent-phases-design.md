# Concurrent phases (speed, part A)

One intent runs 10 to 15 cold `claude -p` sessions and several project commands, all one after
another. Some of them do not depend on each other. This change runs those at the same time. It
does not change what is checked, which judge decides, or what a judge is shown.

This is part A of four speed changes (A: concurrent work, F: speculative plan, D: cheaper judges in
shadow mode, G: parallel intents). Each part can be switched off in config.

## What runs together

1. **Lessons with the done-check** (verify stage). `lessons` reads the review and the failed phases
   so far; it never reads the done-check's result. Both start at once; the lessons row is
   `early-lessons`. If the done-check cannot be completed, lessons is cancelled and the change
   blocks as before. If a done-check attempt failed while lessons ran (and its retry passed),
   lessons missed that failure in its fix history, so `lessons` runs again after the done-check.
2. **The first review with the verifier** (build stage). Once the tests pass, `verify` and
   `early-review` start together on the same tested commit. Both are read-only judges. The review
   reads a throwaway detached copy of that commit (`.loopstra/review/<slug>`), not the worktree,
   where the verifier runs project commands that may change files while the review reads them.
   - If verify passes, the review's result is kept in the run folder (`review.early`: its report,
     and a hash of the commit, the review model and the whole rendered prompt). When the merge step
     starts the review rounds, round 1 uses it instead of running a new review, but only when the
     hash matches and the worktree has nothing uncommitted. Anything else (a restart that committed
     leftover edits, a new build, a new prompt) runs round 1 as before.
   - If verify fails, the review is cancelled at once (its session is killed), so the fix,
     retest and verify-2 do not wait for it; round 1 runs later on the fixed code.
   - A review that fails to run is ignored: round 1 runs again in the review rounds.
   - Not when `stages.build.after` or `stages.review.before` has commands: those must run between
     the two.
3. **Test, lint and build commands** (every test run). Off by default, because some projects'
   commands write the same output folder. When on, all three start together inside the one
   `test-N` phase and their results are read in the usual order (test, lint, build). Once one
   fails, every one before it has ended, so it is the failure to report and the rest are cancelled.

## Config

```yaml
speed:
  parallel_checks: false  # test, lint and build commands at the same time
  overlap_judges: true    # 1 and 2 above
```

## Mechanics

- `alongside(ctx, main, { what, run, wanted })` in `src/phases.ts` runs a phase function and, at
  the same time, optional extra work. It returns both results; the extra's is null when it was
  dropped or cancelled.
  - The phase boundary (the between-phases merge of other ready pull requests) runs once, before
    them, and inside only for a phase that starts after the other work ended (a `-retry`, say), so
    no merge touches main while two phases run.
  - Group state lives in an `AsyncLocalStorage`, per call chain, not in a module-wide counter:
    phases outside the group (another change's, once intents run in parallel) are not affected.
  - The extra work is optional: anything it throws but a stop request is dropped and traced, so it
    never ends the step; the main phase meets the same trouble on its own.
  - Once the main phase ends, the extra is cancelled unless `wanted(main's result)`; also when main
    throws. Cancelling aborts a signal that `runPhase` and `runCommand` take, which kills the
    session or command and throws `Cancelled`; its row ends `interrupted`.
  - It waits for both, so each phase ends its own row; then it throws a stop request from either
    (the loop stops rather than pauses), else the main phase's error.
  - A session that succeeds inside the group ends the loop's pause (`paused.json`) only once both
    ended, and not when the main phase found the assistant unavailable, so the back-off keeps
    growing and the probe still runs when only the strong model is out.
- Phase rows already get their own `seq` and folder. A session holds `min(session cap, what is left
  of the day)`, so with a daily budget two sessions overlap only when the day covers two whole
  session caps (`roomForTwo`, from `loopDayLeft`); with a daily budget and no session cap they never
  overlap. `mayOverlap` is the one check both stages use.
- Rows of the extra work are named `early-…`. The fix history lessons is shown leaves them out, and
  `loopstra status` names the newest phase that is not one, so a blocked change shows the phase
  that failed.
- The dashboard's "working on" names every running phase (`verify + early-review`).

## Tests

- `alongside` starts both before either finishes, runs the boundary once and again for a phase that
  starts after the other ended, leaves work outside the group alone, drops what the extra throws,
  waits for the slower one when the main throws, prefers a stop request, cancels an unwanted extra,
  and keeps the pause while the main phase finds the assistant unavailable.
- Verify stage: done-check and lessons overlap (fake sessions that take a moment); with
  `overlap_judges: false` they run one after another; a done-check usage limit keeps the pause; a
  done-check retry reruns lessons with the full history, which leaves out `early-` rows.
- Build stage: `early-review` runs during the build step with verify, in a copy of the commit; the
  merge step's round 1 uses it and runs no new review; a failed verify cancels it; hooks turn it off;
  a moved branch ignores it; a git failure deciding whether to run it leaves verify to run alone.
- `parallel_checks`: commands overlap; the reported failure is the first in order; a known failure
  cancels the commands still running.
