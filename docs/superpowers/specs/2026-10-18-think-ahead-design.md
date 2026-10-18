# Think ahead: design and plan beside the lanes

## The problem

Seen live in ai-chan (`speed.max_parallel_changes: 1`, the default): 45-atom-feeds was building,
and 46-suite-under-ten-minutes had just been accepted, at high priority. Nothing ran for 46 until
45's build step ended, so the change sat at "accepted" with no agent on it. The orchestrator could
only guess why ("it seems to work on one change at a time").

Three things make the loop this linear:

1. **One lane.** At `max_parallel_changes: 1` one change runs a step at a time. Raising it is not
   safe for every project: ai-chan's tests include Docker e2e, which may not run twice at once.
2. **The tick waits for every lane.** A lane runs one step per tick, so even at N=2 a three-minute
   design step leaves its lane idle until the other lane's forty-minute build ends. The
   parallel-changes design accepted that cost for simplicity, and said a rolling pool could come
   once the numbers showed it was worth it. This is that evidence.
3. **The wait between ticks.** Design, plan and build of one change are three ticks, with
   `poll_seconds` of sleep between each.

But design and plan steps never run the project's commands. Their sessions use read-only tools
(`tools: "read"`, plan mode) on a snapshot of main, and their records are written under the
checkout lock, as with any lane. What `max_parallel_changes` guards (two test runs at once) does
not apply to them.

## The change

`speed.think_ahead` (on by default). Beside the lanes, like the pull request watcher, a
**thinker** runs design and plan steps one at a time while any lane runs a step:

- **What it takes.** A change whose status is a design or plan step (`accepted`, `designing`,
  `spec-review`, `spec-approved`, `planning`, `plan-review`), that is a lane's to run (runnable,
  not held, no open question), waits for no other change (`depends_on`), and is not claimed. Not
  when that step's stage has `before` or `after` commands: those are the project's own commands,
  so the step stays a lane's.
- **When.** It looks when the lanes start, takes the first such change in queue order, runs its
  step, and looks again at once. With nothing to take, it looks again every `poll_seconds` (a
  change accepted mid-build is picked up then). It starts no step once every lane has ended: the
  next tick's lanes take over. A step it has started still finishes first.
- **One change, many steps.** It scans the intents afresh each look, so a change it designed is
  planned in the same tick, and is ready to build when the build lane frees.
- **Budget.** It starts a step only when the day's budget has room for its session beside the
  others running (`roomBeside`), so never with a daily budget and no session limit.
- **Problems.** A stop, an outage or the day's budget in its step ends it like a lane
  (`laneProblem`), and the tick handles it once.

Lanes now take build, review, merge and verify steps before design and plan steps (the order
within each group is the queue's). A lane with no such step to run still takes a design or plan
step, so two designs can run at once, one a lane's and one the thinker's.

**Bringing a pull request up to date** (merge step) runs tests, so it waits while
`max_parallel_changes` other changes run a step. The thinker's steps run no commands, so they do
not count there (`othersRunningCommands`). They count for the budget (`roomBeside`).

**The orchestrator** is told how the loop takes changes: how many changes may run a step at once,
whether design and plan run beside them, and which changes are being worked on now (the
heartbeat). It no longer has to guess why a change waits.

## What stays the same

- `max_parallel_changes` still bounds the changes whose steps can run project commands.
- One step per change at a time (claims). Locks, records, snapshots: as for any lane.
- `think_ahead: false` is the path from before this change.

## Tests

- N=1, a change at `plan-approved` and one `accepted`: one tick builds the first, and designs and
  plans the second (it reaches `plan-approved`), the second's first session starting before the
  build ends.
- The thinker does not start a step after the lanes have ended.
- `think_ahead: false`: as before (the existing N=1 test, with the setting off).
- A stage with `before` commands: its step is left to a lane.
- The thinker's claim does not count in `othersRunningCommands`, and does in `othersRunning`.
- The orchestrator's context names the rule and what is running.
