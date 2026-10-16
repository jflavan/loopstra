# Concurrent phases (speed, part A)

One intent runs 10 to 15 cold `claude -p` sessions and several project commands, all one after
another. Some of them do not depend on each other. This change runs those at the same time. It
does not change what is checked, which judge decides, or what a judge is shown.

This is part A of four speed changes (A: concurrent work, F: speculative plan, D: cheaper judges in
shadow mode, G: parallel intents). Each part can be switched off in config.

## What runs together

1. **Lessons with the done-check** (verify stage). `lessons` reads the review and the failed phases
   so far; it never reads the done-check's result. Both start at once. If the done-check cannot be
   completed, the change blocks as before and the lessons result is dropped.
2. **The first review with the verifier** (build stage). Once the tests pass, `verify` and
   `review-1` start together on the same tested commit. Both are read-only judges.
   - If verify passes, the review's result is kept in the run folder (`review.early`: the round,
     the commit it reviewed, and its report). When the merge step starts the review rounds, round 1
     uses it instead of running a new review, but only when the branch is still on that commit.
     Anything else (a restart that committed leftover edits, a new build) runs round 1 as before.
   - If verify fails, the review is dropped and its cost is lost; the fix, retest and verify-2 run
     as before, and round 1 runs later on the fixed code.
   - A review that fails to run is ignored: round 1 runs again in the review rounds.
   - Not when `stages.build.after` or `stages.review.before` has commands: those must run between
     the two.
3. **Test, lint and build commands** (every test run). Off by default, because some projects'
   commands write the same output folder. When on, all three start together inside the one
   `test-N` phase; the runtime waits for all of them and reports the first failure in the usual
   order (test, lint, build).

## Config

```yaml
speed:
  parallel_checks: false  # test, lint and build commands at the same time
  overlap_judges: true    # 1 and 2 above
```

## Mechanics

- `together(ctx, [fn, fn])` in `src/phases.ts` runs phase functions at the same time. It runs the
  phase boundary (the between-phases merge of other ready pull requests) once, before the group,
  and not inside it, so no merge touches main while two phases run. It waits for every function to
  settle; if any threw, it throws the first error in list order (a stop, an outage, a used-up day
  still reach the scheduler, after the other phase has ended and recorded its row).
- Phase rows already get their own `seq` and folder. A session holds `min(session cap, what is left
  of the day)`, so with a daily budget two sessions overlap only when the day covers two whole
  session caps (`roomForTwo`); with a daily budget and no session cap they never overlap.
- The work that runs alongside (lessons, the early review) is optional: anything it throws but a
  stop request drops it (`optional` in `src/phases.ts`) instead of ending the step.
- The dashboard's "working on" names every running phase (`verify + review-1`).

## Tests

- `together` runs both functions before either finishes, runs the boundary once, waits for the
  slower one when the other throws, and rethrows the first error.
- Verify stage: done-check and lessons overlap in time (fake sessions that take a moment); with
  `overlap_judges: false` they run one after another.
- Build stage: `review-1` runs during the build step with verify; the merge step's round 1 uses it
  and runs no new review; a failed verify drops it; hooks turn it off; a moved branch ignores it.
- `parallel_checks`: commands overlap; the reported failure is the first in order.
