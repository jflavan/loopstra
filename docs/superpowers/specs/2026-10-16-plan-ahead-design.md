# Plan ahead (speed, part F)

Today the design step ends at `spec-approved`, and the first plan is written on the next tick, in the
plan step. The plan writer is a read-only session. What it reads is all known once spec.md has been
written and has passed its headings check: the intent, the spec, the plan prompt, the plan stage's
model and skills, and the code in the main checkout. So it can run while `spec-check` is still
judging the spec.

With `speed.plan_ahead` on, the design step starts the first plan session at the same time as
`spec-check`, on the same spec. The plan is kept in the run folder only if the whole spec gate
passes. The plan step uses it in place of its first plan session, once, and only if that session
would have asked exactly the same thing of the same code. This is the same rule as the early review
(part A).

Nothing about gates, statuses, who decides, or what any judge sees changes:

- The status flow stays `designing → spec-approved | spec-review → planning → plan-approved | plan-review`.
  Design and plan stay separate steps.
- plan.md is written to `intent/<slug>/` only in the plan step, after `planning`, through
  `writeArtifact`. Nobody sees a plan before the spec has passed.
- The plan gate always runs in the plan step: `headings`, `files` (`git ls-files` at that moment) and
  `plan-challenge`, then the human gate. A failed plan gate still gets one automatic rewrite with the
  concerns (a fresh `plan` session), then blocks.
- `stages.plan.after` still runs after plan.md is written.

This is part F of the four speed changes (A concurrent work, F plan ahead, D cheaper judges in
shadow mode, G parallel intents). It is built on part A as merged (#25): `alongside`, `Cancelled`,
the `early-` row names, and `agentPhase(ctx, spec, rendered)`.

## Config

```yaml
speed:
  parallel_checks: false
  overlap_judges: true
  plan_ahead: true   # the first plan is written while the spec is being checked
```

`src/config.ts`, in the existing strict `speed` object:

```ts
/** The first plan is written while the spec's check runs; kept only if the spec passes, used only if the code it read is unchanged. */
plan_ahead: z.boolean().default(true),
```

It is on by default for the same reason as `overlap_judges`: the plan step does the same work behind
the same gates, so quality cannot drop. The only cost is part of a plan session when the spec is
rejected (it is stopped at once), and that can be read from the trace. "Off" means off: no new plan
is written ahead, and a plan already kept is not used.

`templates/config.yaml` gains `plan_ahead: true` in the `speed:` line, plus a comment. The README
`speed` bullet gains the same in a few sentences.

## When it runs

The plan runs ahead only when **all** of these hold, checked when the spec's judge starts
(`plansAhead` in `src/stages/plan.ts`):

- `ruledOut(cfg)` is null: `speed.plan_ahead` is on and `stages.plan.before` is empty. Plan before
  commands run between the spec gate and the plan session, and they could change what the plan reads
  without the key noticing (the rule `stages.review.before` has for the early review). The plan step
  asks the same `ruledOut` before using a kept plan, so the two can never disagree.
- `gates.spec.human` is `none`. If a person is on the spec gate, the plan would wait hours or days
  for them, they may edit spec.md, and main will likely move on in the meantime. It would almost
  always be thrown away. Running nothing ahead also keeps the person's review free of a plan already
  written.
- `roomForTwo(cfg, trace)`: there is no daily budget, or there is a session cap and at least two
  caps are left of the day.
- No other change may merge into main first (`mayMergeFirst`): none is `reviewing` or
  `merge-approved`, and none is `merge-review` with no person on the merge gate. Such a merge would
  change the code before the plan step, so the plan would be thrown away there, and every such change
  would pay for two plan sessions. A pull request waiting for a person is not counted: it may wait for
  days.

Deciding is optional too: if `when` throws (reading the queue fails), plan ahead is dropped
(`plan ahead: dropped: …`) and spec-check runs alone. It needs no check for `gates.spec.agent:
false`. Without a judge there is nothing to run alongside.

It runs only where the judge runs: inside the judge check of the spec gate. That means:

- If the headings check fails, the judge is never reached, so no plan is written for a spec that is
  about to be rewritten.
- After an automatic rewrite, a new plan runs alongside the second `spec-check` on the new spec. No
  special code is needed.
- The between-phases merge boundary runs once, before both sessions, and not inside the group while
  both may run (see `alongsideFirst`).
- `stages.design.after` runs after the spec is written and before the judge, so both sessions see
  what it did, exactly as the plan step would. It does not turn plan ahead off.

## Mechanics

### `src/phases.ts`: `alongsideFirst`

`alongside` waits for both pieces of work before it returns. For plan ahead that is wrong on both
paths:

- A rejected spec, or a judge that could not run, should not wait for a plan that will be thrown
  away. `alongside` already handles this: `wanted` says no, so the extra is cancelled at once
  (its session killed, its row `interrupted` with "cancelled: its result was no longer needed").
- An approved spec should be recorded at once. If the approval waited for the plan, a stop request
  during the rest of the plan session would kill the plan, `alongside` would rethrow the stop, and the
  status commit would never happen (after a stop, git refuses to start new commands). The next start
  would then redo intake, design and spec-check. With plan ahead off the status commit comes a moment
  after the judge, so this window did not exist.

`alongsideFirst(ctx, main, extra)` starts the same group as `alongside` (they share
`startAlongside`) and returns as soon as main ends with a result `extra.wanted` keeps:
`{ result, rest, cancel }`. `rest()` waits for the extra and gives its result (null when dropped or
cancelled), throwing a stop request that ended it; `cancel()` calls it off. Until `rest()` is called
the group still counts main as running, so a phase the extra starts later (a `-retry`) skips the
boundary: no merge touches main while the step is committing main's result. The caller calls `rest()`
before any other phase. When main's result is not wanted, or main throws, it waits for both exactly
as `alongside` does.

`boundary(ctx)` is exported, so a step can run the between-phases merge before deciding something
on main's code (see the take below).

### `src/stages/artifact.ts` (generic, small)

1. **`writerPhase(ctx, s, a, findings): AgentPhaseSpec & { name: W }`** (exported), taken out of
   `write()`. `write()` and plan ahead both build their session with it, so the request made ahead is
   built by the same function as the one the plan step makes.
2. **Two optional fields on `ArtifactStage`**:
   ```ts
   /** Work for the next stage, run alongside the judge and kept only if the whole gate passes (design: planAhead in plan.ts). */
   ahead?: AheadWork; // { what, when: (ctx) => Promise<boolean>, run: (ctx, a) => Promise<string | null>, keep, discard }
   /** An answer written earlier, used in place of the writing session when it would ask the same `prompt` (plan: takePlanAhead). */
   take?: (ctx, phase, prompt: string | null) => Promise<AgentPhaseResult<W> | null>;
   ```
3. **`runArtifactStep`** calls `s.ahead?.discard(ctx)` first. Only a passing gate keeps work for the
   next stage, and a pass moves the status out of the step, so work found there was kept for an
   earlier artifact (a person sent the change back, say) and is never right to use.
4. **`write()`** renders the prompt once, `phasePrompt(ctx, phase)`, and hands it to both
   `s.take?.(ctx, phase, prompt)` and `agentPhase(ctx, phase, prompt)`, so a kept answer is matched
   against exactly what the session is sent.
5. **The judge check's `run`** in `checks()`: `aheadNow` asks `when` (optional: an error drops it);
   with work to run, `alongsideFirst(ctx, judge, { what, run: () => work.run(ctx, a), wanted: (j) =>
   j.ok && j.envelope.approved })`, and the `Beside` (`work`, `rest`, `cancel`) goes to settle through
   a holder. The plan's vars come from the same `a` the judge was given, read after `design.after`
   ran, so the plan written ahead is based on exactly the spec the judge approved.
6. **`settle()`**:
   - Pass: the status is committed first (`spec-approved`), then `keepAhead` waits for the plan and
     keeps it. A stop meanwhile kills the plan (`plan ahead: not kept: stopped by request`) and the step
     still ends with the spec approved. An error from `keep` (a full disk, a locked file) is traced
     (`not kept: …`) and loses only the plan.
   - Fail: the plan was already called off (or had ended); if it had given a plan, `not kept: the spec
     did not pass its check` (or `could not be checked`) is traced. Then the rewrite or the block, with
     no waiting.
   - An error from the gate or the status commit: the plan is called off and waited for, so its row
     ends, then the error goes on.

### `src/stages/shared.ts`

- **`takeKept(ctx, marker, name)`**: reads a kept answer and clears the file at once, so it is used
  at most once. Undefined when there is none; null when it does not parse, its envelope does not
  match the schema, its report says `status: fail`, or it has no string `key`; else `{ key, envelope,
  saved }`. The early review (`takeEarlyReview`) and plan ahead both use it; a corrupt early review is
  now traced as `not used: it could not be read`, as plan ahead's always was.
- **`codeState(git, base)`**: a SHA-256 fingerprint of the code in a checkout as it is now, measured
  from the commit `base`: `git diff --binary <base>` (tracked files, staged or not), and every
  untracked file git does not ignore, with its contents. It leaves out `intent/` (the loop's records),
  `.loopstra/` (run folders) and `loopstra/config.yaml` (what of it the plan session sees is in its
  prompt, and the rest does not touch the plan). The same fingerprint from the same base means the
  same code, whatever was committed in between. Null when base is not a commit there.

### `src/stages/plan.ts` (the plan-specific part)

- `PLAN_AHEAD = "plan.ahead"` is the run-folder file. Its JSON is `{ key, base, state, envelope }`.
- `planKey(ctx, phase, prompt)` is `[modelFor(ctx.cfg, phase.model), prompt].join("\n")`, with the
  prompt already rendered. It holds the intent, the spec, `{{concerns}}` (empty for a first write),
  the skills line, `commands`, `slug`, `main_branch` and the template text.
- `planAheadRun(ctx, a)`:
  ```ts
  const phase = { ...writerPhase(ctx, PLAN, a, ""), traceName: `${EARLY}plan` };
  const prompt = await phasePrompt(ctx, phase);
  const base = await ctx.git.headSha();
  const state = await codeState(ctx.git, base); // before the session
  const r = await agentPhase(ctx, phase, prompt);
  if (prompt === null || !r.ok) return null;
  if (state === null || state !== await codeState(ctx.git, base)) → traced "not kept: the code on main changed while it was written", null
  return JSON.stringify({ key: planKey(ctx, phase, prompt), base, state, envelope: r.envelope });
  ```
  `LOOPSTRA_PHASE` stays `plan`, because it is the plan session. The row is `early-plan`
  (`early-plan-retry` on a retry), like all work run alongside, so `loopstra status` and verify's
  lessons history (which leave out `early-` rows) never count a failed plan written ahead as one of
  the change's own failures.
- `planAhead = { what: "plan ahead", when: plansAhead, run: planAheadRun, keep, discard }`.
- `takePlanAhead(ctx, phase, prompt)`, set as `PLAN.take`:
  1. `takeKept(ctx, PLAN_AHEAD, "plan")`. If there is none, return null with no event.
  2. Check each rule below in order (`whyNotUsed`). The first one that fails traces
     `plan ahead: not used: <reason>` and returns null:
     - Not readable, or `base` is not a full commit id (40 or 64 hex digits), or there is no `state`:
       "it could not be read". A base like `--cached` or `--output=…` would otherwise reach git as an
       option.
     - `ruledOut(cfg)`: "speed.plan_ahead is switched off" or "the plan stage has before commands".
     - No prompt file: "the plan prompt is missing".
     - `kept.key !== planKey(ctx, phase, prompt)`: "the intent, the spec, the plan prompt or its model
       changed". This also catches non-empty concerns (a rewrite), new skills, a new `claude.models`
       mapping, and an edited `loopstra/prompts/plan.md`.
     - Then `boundary(ctx)`: pull requests that are ready merge first, as they would before a plan
       session. Without this the comparison would run on code about to change.
     - `codeState(ctx.git, base) !== state`: "the code on main changed". It catches other changes
       that merged, remote code brought in by a sync, a person's edits (committed or not) and new
       files. A file that was edited when the plan was written and is still edited the same way is
       not a change; one that has since been put back is.
  3. Trouble checking (a git timeout, say) is not the step's failure: it is traced as `not used: it
     could not be checked: …` and the plan step plans as usual. A stop request, an unavailable
     assistant or the day's budget still go on.
  4. If every rule holds, trace `plan ahead: the plan step uses the plan written while the spec was
     being checked` and return `{ ok: true, envelope, sessionId: null, costUsd: 0 }`. Plan sessions
     are never resumed, so a null session id loses nothing.

  The take runs inside `write()`, with no phase row of its own.

### `src/stages/design.ts`

- `DESIGN` gains `ahead: planAhead`, imported from `./plan`. Imports go design.ts → plan.ts →
  artifact.ts, and artifact.ts imports neither stage, so there is no cycle.

## What happens to the plan written ahead

| Event | What happens |
|---|---|
| spec-check approves (the whole spec gate passes) | `spec-approved` is committed, then the step waits for the plan and keeps it in `plan.ahead`. |
| spec-check rejects | The plan is cancelled at once (or, if it had finished, not kept); traced either way. The rewrite starts without waiting. The rewritten spec gets its own plan ahead alongside the second check. |
| spec-check rejects twice | Blocks as today with nothing kept, without waiting for either plan. |
| spec-check cannot run | Blocks at once ("The spec could not be checked"). The plan is cancelled. |
| Headings check fails | The judge never runs, so no plan runs ahead. |
| The plan written ahead fails (crash, timeout after its retry, invalid envelope, agent-fail) | `null`, nothing kept. The plan step plans as usual. Its `early-plan` row is left out of the change's failure history. |
| The plan written ahead meets an outage or the day's budget | `alongside` drops it (`plan ahead: dropped: …`). spec-check meets the same trouble on its own. |
| Its session changes the code it read (it should not; it is read-only), or something else does while it runs | `not kept: the code on main changed while it was written`. |
| Stop requested while both run | Both are killed; the stop goes on. The status stays `designing` and nothing is kept. The next start redesigns and discards any marker. |
| Stop requested after spec-check approved, while the plan runs | The approval is already committed. The plan is killed (`not kept: stopped by request`) and the step ends at `spec-approved`; the plan step plans as usual. |
| Process killed after the `spec-approved` commit, before the keep | No marker; the plan step plans as usual. |
| Killed after the keep | The marker survives in `.loopstra/runs/<slug>/`, and the next tick, or a cron `--once` run, takes it with the checks. |
| Keeping it fails (disk full, locked file) | `not kept: <error>`; the spec stays approved. |
| A person edits spec.md or the intent body before planning | The key misses, so it is not used. |
| A person sends the change back to `accepted` | The design step discards the marker. |
| A person sets `spec-approved` again later to get a new plan | The marker was used up the first time, so a fresh plan is written. |
| `gates.spec.human` is `status` or `pr` | No plan runs ahead. |
| Another change is `reviewing`, `merge-approved`, or `merge-review` with no person on the merge gate | No plan runs ahead: it would merge first and the plan would be thrown away. |
| `stages.plan.before` set at design time, or added later | No plan runs ahead, or it is not used. |
| `stages.design.after` | Runs before both sessions, so nothing changes. If it leaves files edited, they are part of what the plan read: still used while they stay the same. |
| `stages.plan.after` | Runs after plan.md is written in the plan step, as today. |
| Plan model, skills, `claude.models` or the plan prompt changed | The key misses. |
| Other settings in `loopstra/config.yaml` changed (budgets, gates, signals) | Not a code change: still used. |
| `speed.plan_ahead` switched off after a plan was kept | Not used. |
| Another change merged (before or at the plan step's boundary), remote code synced, files edited or added in the main checkout | The fingerprint misses, so it is not used. |
| Only `intent/` bookkeeping changed on main | Still used. |
| Files git ignores changed | Not compared (the plan session's search tools skip them by default). |
| The plan step is delayed by higher-priority changes or `depends_on` | The same checks apply whenever it runs. |
| `gates.plan.*` changed between the steps | The plan gate runs fresh with the config of that tick. |
| plan-challenge rejects a plan that was written ahead | The marker is already used up. The rewrite is a fresh `plan` session with the concerns, then the step blocks as today. |
| Restart in the plan step after the take, before plan.md | A fresh `plan` session runs. Only cost is lost. |
| Restart in the plan step after `planning`, before the take | It is taken with the same checks. |
| Marker corrupt, its base not a commit id, its report a failure, or the envelope schema changed in a Loopstra upgrade | Not used. |

## What the plan step does

`runArtifactStep(PLAN)` keeps its shape: set the status to `planning`, run the before commands (none
when a plan was written ahead), then `write()`, which takes the kept plan or runs a session. Then it
writes plan.md through `writeArtifact`, runs the after commands, and calls `settle()`: `headings`,
`files`, and **`plan-challenge` always**. The gates, judge and inputs are the same as today.

## Plan-challenge is not run ahead

It needs the plan, so it would have to run after the plan written ahead, inside the design step.
The gate timing rule says plan gate checks run in the step that wrote plan.md, after
`stages.plan.after`. The `files` check reads `git ls-files` at that moment. Keeping a judge verdict
across steps would need a second keyed marker with rules of its own. The saving is one cheap-ish
session's wait, and that is not worth the extra rules. It stays one fresh session in the plan step.

## Budget

The pair starts only when `roomForTwo(cfg, trace)` holds. Each session still holds its own share
through `startPhase`. With a daily budget and no session cap, no plan runs ahead, so neither session
can be cut short by the day. The cost of the plan written ahead counts against the day and shows on
its own row. A rejected spec now costs only the part of the plan session that ran before the
rejection.

Two later parts touch this rule. D (cheaper judges) gives the judge an `alongside` option for a
shadow cheap judge: when plan ahead runs next to spec-check, spec-check passes `alongside: 1`, so the
shadow judge asks for room for three sessions. G (parallel changes) must count other running changes
in `plansAhead`'s room check.

## Trace and dashboard

- Design step rows: `intake`, `design`, then `spec-check` and `early-plan` at the same time
  (`early-plan-retry` on a retry), each in its own folder. `phases/<seq>-early-plan/prompt.md` is
  the exact prompt that may be reused. A plan called off before its session started has no row.
- Plan step rows when the plan is used: `plan-challenge` and the gate rows, with **no `plan` row**.
  When it is not used: `plan`, then `plan-challenge`, as today.
- Events (`command` type, `command: "plan ahead"`, plain words): `kept for the plan step`;
  `cancelled: its result was no longer needed`; `not kept: the spec did not pass its check`;
  `not kept: the spec could not be checked`; `not kept: stopped by request`; `not kept: the code on
  main changed while it was written`; `dropped: <error>`; `the plan step uses the plan written while
  the spec was being checked`; `not used: <reason>`.
- The dashboard's "working on" already joins running rows started this tick: "spec-check +
  early-plan". `loopstra status` shows the newest row that is not `early-…`.
- Measuring it: `kept` events followed by `the plan step uses`, and the cost of `early-plan` rows
  whose plan was not used, can both be read from trace.db or `loopstra tail <slug>`.
- Owner notes: none change. Plan ahead never blocks or pauses anything.

## Docs

- This file.
- `docs/decisions.md`: the section "Plan ahead (speed, part F, 2026-10-16)".
- README `speed` bullet, and `templates/config.yaml`, as under Config.

## Tests

- `config.test.ts`: `speed.plan_ahead` defaults to true and accepts false. An unknown key under
  `speed` is still rejected. `templates-roundtrip` includes `plan_ahead`.
- `phases.test.ts`: `alongsideFirst` returns once main wants the extra, and a phase the extra starts
  afterwards gets no boundary until `rest()` is called (then the next phase does); with a result not
  wanted, or a main that throws, it cancels the extra and waits for it; `rest()` throws a stop request
  that ended the extra.
- `stages-design.test.ts`:
  - With `LOOPSTRA_FAKE_DELAY_MS` and the default config, `runDesignStep` ends at `spec-approved`.
    `early-plan` starts before `spec-check` ends (judged by start order, as in part A).
    `plan.ahead` holds a key, a 40-digit base and a state; plan.md does not exist; `kept` is traced.
  - Existing phase lists go through `withoutPlanAhead` (at most one `early-plan` per `spec-check`).
    With `speed.plan_ahead: false` the lists are exactly as before.
  - Off switches, each with no `early-plan` row: `speed.plan_ahead: false`; `gates.spec.human:
    status`; `stages.plan.before` set; `claude.max_budget_usd_per_day` with no `max_budget_usd`;
    `gates.spec.agent: false`; another change at `merge-approved`, `reviewing`, or `merge-review` with
    no person on the merge gate. Still runs with another change at `building`, or at `merge-review`
    with a person on the merge gate.
  - Budget: a cap of 1 with a day of 10 runs both together; a cap of 1 with 1.6 left does not.
  - With plan sessions slower than the checks, spec-check rejects then approves: the first plan is
    cancelled, the second is kept, and the key holds the rewritten spec.
  - With plan sessions that hang until killed: spec-check always rejects → blocked, both plans
    cancelled, rows `interrupted`; spec-check fails to run → blocked at once, the plan cancelled.
  - With spec-check slower than the plan: a rejected spec's finished plan is traced `not kept`.
  - A stop a moment after `spec-approved` is committed, while the plan hangs: the step returns ok,
    the status is `spec-approved`, the `early-plan` row is `interrupted`, `not kept: stopped by
    request`, no marker.
  - A plan session that writes a file: `not kept: the code on main changed while it was written`.
  - Headings check fails: no `early-plan` row before the first rewrite.
  - Plan written ahead returns agent-fail or an invalid envelope: `spec-approved`, no marker.
  - Plan written ahead hits `usage-limit`: `spec-approved`, the row is `interrupted`, `dropped`.
  - Stop requested while both run: both rows `interrupted`, status `designing`, no marker.
  - A `plan.ahead` written by hand with status `designing`: discarded before the spec is written.
- `stages-plan.test.ts` (a design step first, then the plan step):
  - Used: phases `[plan-challenge]`, plan.md equals the kept `plan_markdown`, gates pass, status
    `plan-approved`, marker gone, "uses" traced.
  - Prompt equivalence: the fresh `plan` phase's prompt.md is byte-identical to `early-plan`'s.
  - Each of these gives a `plan` row, the matching `not used` reason, and a cleared marker: spec.md
    edited; intent body edited; `stages.plan.model` changed; `claude.models.strong` changed;
    `prompts/plan.md` edited; `speed.plan_ahead` off; `stages.plan.before` added; corrupt JSON; an
    envelope missing `plan_markdown`; a report with `status: fail`; a base of `--cached`; a commit
    outside `intent/`; an uncommitted edit; a new untracked file; a commit merged at the plan step's
    boundary (a fake boundary); a file edited when the plan was written and put back since.
  - Still used: only `intent/` changed; a file edited when the plan was written and still the same;
    a committed edit to a `loopstra/config.yaml` setting the plan does not see; a restart at
    `planning`.
  - plan-challenge rejects a plan that was written ahead: the second write is a fresh `plan` session
    whose prompt carries the concerns.
- `ui.test.ts`: a running `spec-check` plus a running `early-plan` render as "spec-check + early-plan".
- `tests/integration/loop.test.ts`: a full run with fake claude has an `early-plan` row and no `plan`
  row, and the day's cost includes it.

## Out of scope

- Running plan-challenge ahead.
- Running a plan ahead while a person is on the spec gate.
- Writing plan.md or changing statuses early. Running the plan step in the same tick as design.
- A hit-rate figure in `status` or the dashboard.
- Applying "off means off" to the early review's `takeEarlyReview`. That would be a separate small
  change.
- Comparing ignored files.

## Decisions

- The spec's approval is committed before waiting for the plan beside it (`alongsideFirst`), and a
  rejection calls the plan off at once (`alongside`'s `wanted`). Found in review: waiting on both
  made a stop during the plan throw away a passed spec gate, and made every rejection wait for a whole
  plan session (and its retry).
- The plan is kept after the status commit, not before: a crash in between loses only the plan, which
  the plan step then writes as usual.
- The take runs the between-phases merge boundary before comparing the code (found in review), so a
  pull request that is ready merges first and the plan is compared with the code a plan session would
  have read.
- The code comparison is a fingerprint of the working tree, untracked files included, from the same
  base, taken before and after the session (found in review). Comparing only HEAD's tracked files
  missed new files, kept a plan written on edits that were put back, and threw away every plan while
  a file stayed edited.
- `loopstra/config.yaml` is left out of the comparison (found in review): every part of it the plan
  session sees is in its prompt, and the rules that matter (`plan_ahead`, plan `before`) are checked
  on their own.
- No plan runs ahead while another change may merge first (found in review): in a busy queue that
  merge would throw the plan away almost every time.
- A kept plan's `base` must be a full commit id, and its report a success (found in review): a value
  like `--cached` would otherwise reach git as an option.
- Everything about the optional work stays optional (found in review): an error deciding whether to
  run it, keeping it, or checking it later loses only the plan, never blocks or rewrites the change.
- The row is `early-plan`, like part A's `early-review` and `early-lessons`, so its failures stay out
  of the change's history (found in review). The switch is `plan_ahead`, the marker `plan.ahead` and
  the event `plan ahead`.
- The prompt is rendered once in `write()` and passed to both the take and the session, so the key is
  compared with the prompt actually sent.
- `takeKept` and `codeState` are shared helpers; the early review uses `takeKept` too.
- Default is on: same prompt, same model, same code, same gates, so quality cannot drop.
- Off means off: takePlanAhead refuses a kept plan once speed.plan_ahead is false.
- No plan runs ahead with a person on the spec gate, or with plan before commands.
- stages.design.after does not turn plan ahead off: it runs before both sessions.
- A plan also runs ahead alongside the second spec-check after an automatic rewrite.
- The plan written ahead keeps agentPhase's normal timeout/crash retry, as the plan step would.
- plan-challenge is not run ahead.
- No dashboard, status or owner-note changes.
