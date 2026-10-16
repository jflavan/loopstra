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
shadow mode, G parallel intents).

## Config

```yaml
speed:
  parallel_checks: false
  overlap_judges: true
  plan_ahead: true   # the first plan is written while the spec is being checked
```

`src/config.ts`, in the existing strict `speed` object:

```ts
/** The first plan is written while the spec's check runs; kept only if the spec passes, used only if nothing it read changed. */
plan_ahead: z.boolean().default(true),
```

It is on by default for the same reason as `overlap_judges`: the plan step does the same work behind
the same gates, so quality cannot drop. The only cost is a wasted plan session when the spec is
rejected, and that can be read from the trace. "Off" means off: no new plan is written ahead, and a
plan already kept is not used.

`templates/config.yaml` gains `plan_ahead: true` in the `speed:` line, plus one comment line:
`# plan_ahead: the first plan is written while the spec is being checked; it is thrown away if the
spec does not pass, and used only if nothing it read has changed.`

The README `speed` bullet gains one sentence: "`plan_ahead` (on) writes the first plan while the spec
is being checked. The plan is thrown away if the spec does not pass, and it is used only if nothing
it read has changed by the time planning starts. It follows the same daily budget rule."

## When it runs

The plan runs ahead only when **all** of these hold, checked when the spec's judge starts
(`plansAhead` in `src/stages/plan.ts`):

- `speed.plan_ahead` is on.
- `gates.spec.human` is `none`. If a person is on the spec gate, the plan would wait hours or days
  for them, they may edit spec.md, and main will likely move on in the meantime. It would almost
  always be thrown away. Running nothing ahead also keeps the person's review free of a plan already
  written.
- `stages.plan.before` is empty. Those commands run between the spec gate and the plan session, and
  they could change what the plan reads without the key noticing. This is the same rule as
  `stages.review.before` for the early review.
- `roomForTwo(cfg, trace)`: there is no daily budget, or there is a session cap and at least two
  caps are left of the day.

It needs no check for `gates.spec.agent: false`. Without a judge there is nothing to run alongside.

It runs only where the judge runs: inside the judge check of the spec gate. That means:

- If the headings check fails, the judge is never reached, so no plan is written for a spec that is
  about to be rewritten.
- After an automatic rewrite, a new plan runs alongside the second `spec-check` on the new spec. No
  special code is needed.
- `together()` runs the between-phases merge boundary once, before both sessions, so no merge
  touches main while they run.
- `stages.design.after` runs after the spec is written and before the judge, so both sessions see
  what it did, exactly as the plan step would. It does not turn plan ahead off.

## Mechanics

### `src/stages/artifact.ts` (generic, small)

1. **`writerPhase(ctx, s, a, findings): AgentPhaseSpec & { name: W }`** (exported), taken out of
   `write()`: `{ name: s.stage, model: cfg.model, permissionMode: "plan", tools: "read", vars: s.vars(a, findings), skills: cfg.skills }`.
   `write()` and plan ahead both build their session with it, so the request made ahead is built by
   the same function as the one the plan step makes. `reviewPhase` plays this role for the early
   review.
2. **Two optional fields on `ArtifactStage`**, each with a doc comment that points at plan.ts:
   ```ts
   /** Work for the next stage, run alongside the judge and kept only if the whole gate passes (design: planAhead in plan.ts). */
   ahead?: { what: string; when: (ctx: StepContext) => boolean; run: (ctx: StepContext, a: Artifacts) => Promise<string | null>; keep: (ctx: StepContext, kept: string) => void };
   /** An answer written earlier, used in place of the writing session when it would ask the same (plan: takePlanAhead). */
   take?: (ctx: StepContext, phase: AgentPhaseSpec & { name: W }) => Promise<AgentPhaseResult<W> | null>;
   ```
3. **`write()`**: `const phase = writerPhase(ctx, s, await artifacts(ctx), findings); const r = (await s.take?.(ctx, phase)) ?? await agentPhase(ctx, phase);`.
   The rest stays as it is: block on `!r.ok`, `writeArtifact`, after commands.
4. **`JudgePayload`** becomes `{ broken } | { findings } | { ahead: string }`. In `settle()`, the
   failure branch reads findings with `p && "findings" in p ? p.findings : []`.
5. **The judge check's `run`** in `checks()`:
   ```ts
   const judge = () => agentPhase(ctx, { name: s.judge.name, model: "strong", permissionMode: "default", tools: "read", vars: s.judge.vars(a) });
   const ahead = s.ahead?.when(ctx) ? s.ahead : undefined;
   const [r, early] = ahead
     ? await together(ctx, [judge, () => optional(ctx, ahead.what, () => ahead.run(ctx, a))] as const)
     : [await judge(), null];
   ```
   - The judge failed to run: the existing `broken` payload. If `early` is set, trace
     `<what>: not kept: the spec could not be checked`.
   - Not approved: the existing findings payload. If `early` is set, trace
     `<what>: not kept: the spec did not pass its check`.
   - Approved: `{ result: "pass", evidence, payload: early ? { ahead: early } : undefined }`.

   The plan's vars come from the same `a` the judge was given, read after `design.after` ran. So the
   plan written ahead is based on exactly the spec the judge approved.
6. **`settle()`**: when `outcome.result === "pass"`, after `clearMarker(ctx, s.marker)` and
   **before** `setStatus`, run `for (const p of outcome.payloads) if ("ahead" in p) s.ahead?.keep(ctx, p.ahead);`.
   `payloads` exists only when the whole gate passes, so only a whole-gate pass keeps the plan. That
   stays true if more spec checks are added later. Writing it before the status commit means a crash
   right after the commit does not lose the plan.

### `src/stages/plan.ts` (the plan-specific part)

- `export const PLAN_AHEAD = "plan.ahead";` is the run-folder file. Its JSON is `{ key, base, envelope }`.
- `planKey(ctx, phase)` returns `[modelFor(ctx.cfg, phase.model), await phasePrompt(ctx, phase)].join("\n")`,
  or null when the prompt file is missing. The rendered prompt already holds the intent, the spec,
  `{{concerns}}` (empty for a first write), the skills line, `commands`, `slug`, `main_branch` and the
  template text.
- `plansAhead(ctx)` holds the four rules under "When it runs". It is synchronous.
- `planAheadRun(ctx, a)`:
  ```ts
  const phase = { ...writerPhase(ctx, PLAN, a, ""), traceName: "plan-ahead" }; // traceName is not part of the prompt
  const key = await planKey(ctx, phase);
  const base = await ctx.git.headSha(); // taken before the session starts
  const r = await agentPhase(ctx, phase);
  return key !== null && r.ok ? JSON.stringify({ key, base, envelope: r.envelope }) : null;
  ```
  `LOOPSTRA_PHASE` stays `plan`, because it is the plan session.
- `export const planAhead = { what: "plan ahead", when: plansAhead, run: planAheadRun, keep: keepPlanAhead };`
  where `keepPlanAhead` calls `writeMarker(ctx, PLAN_AHEAD, kept)` and traces
  `plan ahead: kept for the plan step`.
- `takePlanAhead(ctx, phase)`, set as `PLAN.take`:
  1. `readMarker(ctx, PLAN_AHEAD)`. If there is none, return null with no event.
  2. `clearMarker(ctx, PLAN_AHEAD)`. It is used once, whatever happens next.
  3. Check each rule below in order. The first one that fails traces `plan ahead: not used: <reason>`
     and returns null:
     - The JSON does not parse, or `Envelopes.plan.safeParse(saved.envelope)` fails: "it could not be read".
     - `!cfg.speed.plan_ahead`: "speed.plan_ahead is switched off".
     - `cfg.stages.plan.before.length`: "the plan stage has before commands".
     - `saved.key !== await planKey(ctx, phase)`: "the intent, the spec, the plan prompt or its model
       changed". This also catches non-empty concerns (a rewrite), new skills, a new `claude.models`
       mapping, and an edited `loopstra/prompts/plan.md`.
     - `(await ctx.git.run(["diff", "--quiet", saved.base, "--", ".", ":(exclude)intent"], true)).code !== 0`:
       "the code on main changed". This compares `base` with the main checkout's working tree for
       tracked files. It catches other changes that merged, remote code brought in by a sync, and a
       person's uncommitted edits to tracked files. The loop's own status and artifact commits, and
       queue.md, are all under `intent/` and do not count. A missing `base` object also gives a
       non-zero exit, so it is not used.
  4. If every check passes, trace `plan ahead: the plan step uses the plan written while the spec was
     being checked` and return `{ ok: true, envelope, sessionId: null, costUsd: 0 }`. Plan sessions
     are never resumed, so a null session id loses nothing.

  The take runs inside `write()`, with no phase row of its own. The between-phases merge boundary
  does not run before it. A pull request that becomes ready merges at the next boundary, before
  `plan-challenge`. A normal run can do the same thing (nothing merges before `plan`, then something
  merges before `plan-challenge`), so this order is one a normal run could produce.

### `src/stages/design.ts`

- `DESIGN` gains `ahead: planAhead`, imported from `./plan`. Imports go design.ts → plan.ts →
  artifact.ts, and artifact.ts imports neither stage, so there is no cycle.
- `runDesignStep` calls `clearMarker(ctx, PLAN_AHEAD)` before `runArtifactStep`, always. A plan is
  kept only by a spec gate pass, which moves the status to `spec-approved`, and the design step never
  handles that status. So clearing is always safe. It means a new or resumed design never meets an
  older plan, for example after a crash between the keep and the status commit.
- The doc comment of `runDesignStep` says the first plan may be written alongside spec-check.

## What happens to the plan written ahead

| Event | What happens |
|---|---|
| spec-check approves (the whole spec gate passes) | Kept in `plan.ahead`, before the status commit. |
| spec-check rejects | Not kept (traced). The rewritten spec gets its own plan ahead alongside the second check. |
| spec-check rejects twice | Blocks as today with nothing kept. A person who sets `spec-approved` gets a fresh plan. |
| spec-check cannot run | Blocks as today ("The spec could not be checked"). Nothing kept. |
| Headings check fails | The judge never runs, so no plan runs ahead. |
| The plan written ahead fails (crash, timeout after its retry, invalid envelope, agent-fail) | `null`, nothing kept. The plan step plans as usual. |
| The plan written ahead meets an outage or the day's budget | `optional` drops it (`plan ahead: dropped: …`). spec-check meets the same trouble on its own. |
| Stop requested while both run | `together` waits for both and rethrows the stop. The status stays `designing` and nothing is kept. The next start redesigns and clears any marker. |
| Process killed while both run | Rows left running are ignored by the dashboard, and their budget holds go stale. The status is `designing`, so the next start redesigns and clears the marker. |
| Killed after the keep, before the `spec-approved` commit | The status is `designing`, so the design step clears the marker. |
| Killed after `spec-approved` | The marker survives in `.loopstra/runs/<slug>/`, and the next tick, or a cron `--once` run, takes it with the checks. |
| A person edits spec.md or the intent body before planning | The key misses, so it is not used. |
| A person changes the status during the design step | `accepted` means the next design step clears it. `closed` means it is never read. If `spec-approved` is set by hand, it is used only if the key and code match, which means it asks the same thing. |
| A person sets `spec-approved` again later to get a new plan | The marker was used up the first time, so a fresh plan is written. |
| `gates.spec.human` is `status` or `pr` | No plan runs ahead. |
| `stages.plan.before` set at design time, or added later | No plan runs ahead, or it is not used. |
| `stages.design.after` | Runs before both sessions, so nothing changes. |
| `stages.plan.after` | Runs after plan.md is written in the plan step, as today. |
| Plan model, skills, `claude.models` or the plan prompt changed | The key misses. |
| `speed.plan_ahead` switched off after a plan was kept | Not used. |
| Another change merged, remote code synced, or tracked files edited in the main checkout | The diff from `base` misses, so it is not used. |
| `stages.design.after` left tracked files edited and uncommitted | The diff from `base` misses, so it is not used. This is a lost hit, never a lost check. |
| Committed edits under `loopstra/` (config, prompts) | Counted as a code change, so it is not used. This is strict on purpose. |
| Only `intent/` bookkeeping changed on main | Still used. |
| The plan step is delayed by higher-priority changes or `depends_on` | The same checks apply whenever it runs. |
| `gates.plan.*` changed between the steps | The plan gate runs fresh with the config of that tick. |
| plan-challenge rejects a plan that was written ahead | The marker is already used up. The rewrite is a fresh `plan` session with the concerns, then the step blocks as today. |
| Restart in the plan step after the take, before plan.md | A fresh `plan` session runs. Only cost is lost. |
| Restart in the plan step after `planning`, before the take | It is taken with the same checks. |
| Marker corrupt, or the envelope schema changed in a Loopstra upgrade | Not used. |
| Untracked files in the main checkout | Not compared. Builds start from committed main and never see them either. |

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
its own row. Part G (parallel intents) breaks `roomForTwo`'s one-intent-at-a-time assumption and must
revisit it.

## Trace and dashboard

- Design step rows: `intake`, `design`, then `spec-check` and `plan-ahead` at the same time
  (`plan-ahead-retry` on a retry), each in its own folder. `phases/<seq>-plan-ahead/prompt.md` is
  the exact prompt that may be reused.
- Plan step rows when the plan is used: `plan-challenge` and the gate rows, with **no `plan` row**.
  When it is not used: `plan`, then `plan-challenge`, as today.
- Events (`command` type, `command: "plan ahead"`, plain words):
  `kept for the plan step`; `not kept: the spec did not pass its check`; `not kept: the spec could
  not be checked`; `dropped: <error>`; `the plan step uses the plan written while the spec was being
  checked`; `not used: <reason>`.
- The dashboard's "working on" already joins running rows started this tick: "spec-check +
  plan-ahead". `src/commands/ui.ts`, `src/ui/index.html` and `loopstra status` do not change.
- Measuring it: `kept` events followed by `the plan step uses`, and the cost of `plan-ahead` rows
  whose plan was not used, can both be read from trace.db or `loopstra tail <slug>`.
- Owner notes: none change. Plan ahead never blocks or pauses anything.

## Docs

- This file.
- `docs/decisions.md`: a new section "Plan ahead (speed, part F, 2026-10-16)", with the decisions
  listed below.
- README `speed` bullet, and `templates/config.yaml`, as under Config.

## Tests

- `config.test.ts`: `speed.plan_ahead` defaults to true and accepts false. An unknown key under
  `speed` is still rejected. `templates-roundtrip` includes `plan_ahead`.
- `stages-design.test.ts`:
  - With `LOOPSTRA_FAKE_DELAY_MS` and the default config, `runDesignStep` ends at `spec-approved`.
    `plan-ahead` starts before `spec-check` ends (judged by start order, as in part A).
    `.loopstra/runs/add-numbers/plan.ahead` exists, `intent/add-numbers/plan.md` does not, and a
    `plan ahead: kept` event is traced.
  - Existing phase-list expectations go through a `withoutPlanAhead` helper, in the style of
    `withoutEarlyReview`. Hard-coded seq paths such as `4-design` are updated or looked up by name.
    With `speed.plan_ahead: false` the lists are exactly as before.
  - Off-switch loop, each with no `plan-ahead` row: `speed.plan_ahead: false`;
    `gates.spec.human: status`; `stages.plan.before` set; `claude.max_budget_usd_per_day` with no
    `max_budget_usd`; `gates.spec.agent: false`.
  - Budget: a cap of 1 with a day of 10 runs both together; a cap of 1 with 1.5 left of the day does not.
  - spec-check rejects, then approves (`LOOPSTRA_FAKE_FIXTURE_DIR` with `spec-check-1` reject and
    `spec-check-2` approve): two `plan-ahead` rows, one `not kept` event, and the kept key contains
    the rewritten spec.
  - spec-check always rejects (human none): blocked, no `plan.ahead`, `not kept` events.
  - spec-check fails to run (`FIXTURE:budget`): blocked with "could not be checked", no `plan.ahead`.
  - Headings check fails: no `plan-ahead` row before the first rewrite.
  - Plan written ahead returns agent-fail or an invalid envelope (`plan-1.jsonl` in a fixture dir):
    `spec-approved`, no marker.
  - Plan written ahead hits `usage-limit` (`plan-1.jsonl`): the design step still reaches
    `spec-approved`, the `plan-ahead` row is `interrupted`, `plan ahead: dropped` is traced, and
    there is no marker.
  - Stop requested while both run: both rows `interrupted`, status `designing`, no marker.
  - A `plan.ahead` written by hand with status `designing`: `runDesignStep` clears it before writing.
- `stages-plan.test.ts` (a design step first, then the plan step):
  - Used: the plan step's phases are `[plan-challenge]` with no `plan` row. plan.md equals the kept
    envelope's `plan_markdown`. The gates `headings:pass`, `files:pass` and `plan-challenge:pass` are
    recorded, the status is `plan-approved`, the marker is gone, and the "uses" event is traced.
  - Prompt equivalence: keep a plan, delete the marker, run the plan step. The fresh `plan` phase's
    prompt.md is byte-identical to `plan-ahead`'s.
  - Each of these gives a `plan` row, the matching `not used` reason, and a cleared marker: spec.md
    edited; intent body edited; `stages.plan.model` changed; `claude.models.strong` changed;
    `prompts/plan.md` edited; `speed.plan_ahead` turned off; `stages.plan.before` added (the
    before-command runs, then `plan`); corrupt JSON; an envelope missing `plan_markdown`.
  - Code: a commit to a tracked file outside `intent/` means not used. A commit that only touches
    `intent/` is still used. An uncommitted edit to a tracked file outside `intent/` means not used.
  - plan-challenge rejects a plan that was written ahead (reject, then approve): the second write is
    a fresh `plan` session whose prompt carries the concerns.
  - Restart: plan kept, status set to `planning` by hand, so it is used.
- `ui.test.ts`: a running `spec-check` plus a running `plan-ahead` started this tick render as
  "spec-check + plan-ahead".
- `tests/integration/loop.test.ts`: a full run with fake claude has a `plan-ahead` row and no `plan`
  row, and the day's cost includes `plan-ahead`. Tests that count `plan-N` fixture calls are updated,
  because the first plan call now happens in the design step.

## Out of scope

- Running plan-challenge ahead.
- Running a plan ahead while a person is on the spec gate.
- Stopping the plan written ahead early when spec-check rejects quickly (there is no per-phase abort;
  `together` waits).
- Writing plan.md or changing statuses early. Running the plan step in the same tick as design.
- A hit-rate figure in `status` or the dashboard.
- Applying "off means off" to the early review's `takeEarlyReview`. That would be a separate small
  change.
- Interaction with part G.

## Decisions

- Few moving parts: no extra code phase row, a synchronous `when`, and no up-front prompt check.
- The plan is kept through the gate payload on a whole-gate pass, in settle(), before the status commit, not inside the judge's approve branch: evaluateGate already returns `payloads` only on a pass, so this stays correct if spec checks are added later, and a crash right after the commit does not lose the plan.
- The take check runs inline in write(), with no `plan-early-check` code phase, because skipping one merge boundary gives an order a normal run could also produce (merges then happen before plan-challenge), so the extra row adds noise without adding safety.
- The code comparison uses `git diff --quiet <base> -- . :(exclude)intent` against the working tree, not HEAD to HEAD, because the plan session reads the main checkout's working tree; this fails closed on uncommitted tracked edits.
- Default is on: same prompt, same model, same code, same gates, so quality cannot drop; the only cost is a wasted session on a rejected spec, which the trace shows (the same reasoning as overlap_judges).
- Off means off: takePlanAhead refuses a kept plan once speed.plan_ahead is false, because an owner who switches a speed feature off expects it to stop; making the early review do the same is left out of scope.
- Switch name is `plan_ahead`, with the trace row `plan-ahead`, the marker `plan.ahead` and the event `plan ahead`: plain English, one word family everywhere.
- No plan runs ahead with a person on the spec gate: they may edit spec.md and take days while main moves on, so the plan would almost always be thrown away.
- No plan runs ahead when stages.plan.before is set, and a kept plan is refused if it is added later, because those commands run between the gate and the plan session where the key cannot see them (the same rule as review.before).
- stages.design.after does not turn plan ahead off, because it runs before the judge and so before both sessions, never between them.
- A plan also runs ahead alongside the second spec-check after an automatic rewrite, because that needs no extra code and the second check usually passes.
- The plan written ahead keeps agentPhase's normal timeout/crash retry; the plan step would retry the same way, so wall time gets worse only on the rejection path, and an extra option is not worth it.
- runDesignStep clears plan.ahead unconditionally at its start, because a plan is kept only by a pass that moves the status out of the design step, so clearing is always safe and covers crash-before-commit.
- plan-challenge is not run ahead: it would need a second keyed marker across steps and would break the gate timing rule (plan checks run in the step that wrote plan.md, after plan.after), for little saving.
- The trace gets specific `not used: <reason>` events and kept and not-kept events, because a readable trace is an owner value and each event is one line.
- writerPhase takes the judge's own `a`, so the plan written ahead is guaranteed to be based on exactly the spec the judge approved.
- No dashboard, status or owner-note changes, because part A's 'spec-check + plan-ahead' join already shows it and plan ahead never blocks or pauses anything.
- The decision gets its own spec file (2026-10-16-plan-ahead-design.md) plus a docs/decisions.md section, as part A did.
