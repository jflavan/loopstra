# Cheaper judges (speed, part D)

Three judges run on the strong model (opus): the spec check (`spec-check`), the plan challenge
(`plan-challenge`) and the review (`review`). This change adds a cheaper judge on the `default`
model (normally sonnet). It sits beside or in front of the strong one, and quality does not drop:

1. **shadow**: the cheaper judge measures. It runs alongside the strong judge on the same
   question and its verdict is recorded. The strong judge still decides.
2. **first**: the cheaper judge decides a pass on its own, but only for a judge whose record shows
   it caught what the strong judge caught. Anything it rejects, or is unsure of, goes to the strong
   judge, which then decides.

The gates, what each judge is shown, the prompts and the envelopes all stay as they are.

This is part D of the speed changes (A: concurrent work, F: speculative plan, D: cheaper judges,
G: parallel intents). Like every part, it can be switched off in config, and it is off by default.

## Which judges

- **spec-check, plan-challenge, review:** yes. Each one only when its model is the `strong` alias
  and the cheaper model has a different name. If `stages.review.model` is `default` or `cheap`, or
  `claude.models.default` is the same as `claude.models.strong`, there is nothing cheaper to
  compare, and that judge runs as with `off`.
- **done-check: no, not in this change.** It runs the project's commands in a throwaway copy of
  main (`.loopstra/verify/<slug>`). A second judge would either run the same commands in the same
  folder at the same time (the shared output-folder problem `parallel_checks` is off for) or need a
  second copy of main with its own install. It runs once per change, after the merge, and already
  overlaps with lessons, so it would save little for many moving parts. The rule for a later change
  is written down: it passes when there are no `unmet` items, since `needs-person` never blocks.

## Config

`src/config.ts`, inside the existing `speed` object:

```ts
/** A cheaper judge (claude.models.default) for the spec check, plan challenge and review. off: none. shadow: it judges alongside the strong judge and is only recorded. first: it decides a pass alone once its record has earned it. */
cheap_judges: z.enum(["off", "shadow", "first"], { error: "must be off, shadow or first" }).default("off"),
```

`templates/config.yaml`:

```yaml
# Work that runs at the same time to save waiting. Only cheap_judges: first changes who decides:
# once earned, a cheaper judge's pass stands.
# parallel_checks: ...            (unchanged)
# overlap_judges: ...             (unchanged)
# plan_ahead: ...                 (unchanged)
# cheap_judges: off | shadow | first. A cheaper judge (claude.models.default) for the spec check,
# the plan challenge and the review. shadow: it judges alongside the strong one on the same question
# and only the strong one decides; `loopstra judges` shows how often they agreed. first: once the
# cheaper judge has also rejected the last 30 things the strong one rejected, it judges alone and a
# pass stands; anything it rejects or is unsure of goes to the strong judge. Until then, first runs
# as shadow.
speed:
  parallel_checks: false
  overlap_judges: true
  plan_ahead: true
  cheap_judges: off
```

`speed` is a block mapping: with the new key, the one-line flow form would pass the yaml printer's
80-column width, and the stamped config must read back exactly.

- **Off by default.** Shadow makes nothing faster by itself. It spends more of the day's budget and
  of the subscription's usage limit, so outage pauses come sooner. An engineer turns it on on
  purpose.
- **One switch, not one per judge.** In practice `first` is already per judge: each judge must earn
  it with its own record, and loses it on its own miss. An engineer who does not want a cheap
  verdict to stand anywhere keeps `shadow`.
- **`first` is never a config error.** A judge that has not earned it runs as shadow and says why,
  in the trace and in `loopstra judges`. There is no override. The evidence threshold is a constant,
  so it cannot be set to zero.
- The cheaper judge is always `claude.models.default`. Haiku is not offered.
- `loopstra setup` does not ask about it. Like the rest of `speed`, it is edited by hand.

## How verdicts are compared

New file `src/judges.ts`. The verdict is the gate's own rule, and the stages call the same function,
so the comparison cannot drift away from the gate.

```ts
export type JudgeName = "spec-check" | "plan-challenge" | "review";
/** The gate's rule: does this envelope pass the gate? */
export function passes<J extends JudgeName>(judge: J, e: Envelope<J>): boolean
/** A pass that contradicts itself: the cheaper judge is unsure, and first sends it to the strong judge. */
export function contradicts<J extends JudgeName>(judge: J, e: Envelope<J>): boolean
```

| Judge | Passes (today's rule) | Unsure (a pass that contradicts itself) |
|---|---|---|
| spec-check | `approved` (as in `checks()` in artifact.ts) | `approved`, but some finding has `met: false` |
| plan-challenge | `approved`; non-blocking concerns never fail the gate | `approved`, but some concern has `blocking: true` |
| review | no finding with `severity: "important"` (as in `runReviewRounds`; the reviewer's `approved` flag is trace-only) | no important findings, but `approved: false` |

Each session's verdict is one word:

- **Strong judge:** `pass`, `reject`, or `failed`. Failed means the session ended `ok: false`: an
  invalid envelope, an agent-fail, a timeout, or a crash.
- **Cheaper judge:** `pass`, `unsure`, `reject`, or `failed`. Unsure means `passes` is true and
  `contradicts` is true.

Outcomes, for a comparison where neither side `failed`:

- **Agreed:** both `pass`, or the strong judge `reject` and the cheaper one `reject` or `unsure`.
  Unsure is never a decision on its own, because first sends it on.
- **False pass (the dangerous case):** cheaper `pass`, strong `reject`. In first, this pass would
  have stood.
- **False reject:** cheaper `reject` or `unsure`, strong `pass`. In first this costs time and money
  (both sessions run), never quality.

Only the verdict is compared, not the findings lists. Findings differ in wording, so comparing them
would need fuzzy matching, and the verdict is what decides the gate. Both envelopes stay in their
phase folders, so an engineer can diff them.

No confidence field is added to any envelope. It would change the schema and the prompt for the
strong judge too ("same prompt" would break), and a model's own confidence is not evidence.

## What each setting does

All of this is `runJudge` in `src/judges.ts`:

```ts
export const FIRST_NEEDS = 30;        // strong rejections the cheaper judge must also have caught
export const AUDIT_EVERY = 5;         // in first, every 5th call of a trusted judge runs as shadow

export type JudgeResult<J extends JudgeName> = AgentPhaseResult<J> & { decidedBy: "strong" | "cheap" };
export async function runJudge<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, opts: { alongside?: number } = {}): Promise<JudgeResult<J>>
```

- **The cheaper phase:** `{ ...phase, model: "default", traceName: `${name}-cheap`, retry: false }`,
  where `name` is `phase.traceName ?? phase.name`. Only these fields change: same `name` (so
  `LOOPSTRA_PHASE` and the prompt file are the same), same vars, tools, cwd and skills.
  `phasePrompt` does not read the model, so both sessions get the same `prompt.md`.
- **Trace names:** `spec-check-cheap`, `plan-challenge-cheap`, `review-1-cheap`. Each is an
  ordinary phase row with its own folder and cost, so the change's cost includes it. The cheaper
  phase is never retried, so there is no `-cheap-retry`.
- **Who decides:** `decidedBy` says who decided this verdict. It is `strong` unless a trusted
  cheaper judge passed on its own.

### off, or not applicable

`agentPhase(ctx, phase)` with `decidedBy: "strong"`. Exactly as today. Not applicable means the
judge's model is not `strong`, the two model names are the same, or the prompt file is missing. A
missing prompt gives today's missing-prompt failure, and no cheaper session starts.

### shadow (and first while not earned, and first's audits)

1. **Room:** `roomFor(cfg, trace, 2 + (opts.alongside ?? 0))`. Without room, only the strong judge
   runs, and a `judge` event says "not compared: today's budget has no room for another session".
   Shadow always gives way to the deciding judge and to the overlaps that already exist.
2. **Run together:**
   ```ts
   together(ctx, [
     () => timed(phase),
     () => optional(ctx, cheapName, () => timed(cheapPhase)),
   ])
   ```
   The between-phases merge boundary runs once, before both.
3. **No cut-short:** the cheaper session is never retried (`retry: false`) and is bounded by
   `claude.timeout_minutes` like any session. The cheaper model is normally the faster one, so it
   rarely outlasts the strong judge; plumbing an abort signal through the process layer was not
   worth the code for a mode that is off by default.
4. **Record:** when both returned (neither threw), one `judges` row is written with
   `how = 'shadow'` and a `judge` event (see Trace). This happens even when either side `failed`,
   and such rows are left out of the counts.
5. **Result:** the strong result is returned unchanged, with `decidedBy: "strong"`. The stage
   uses it exactly as today: its gate row, its findings for the rewrite or revision, its
   review.md.

How the pieces behave when something throws:

- **The cheaper session throws anything but a stop:** an outage, its own usage limit, the day's
  budget, a git failure. `optional` drops it and traces `<name>-cheap: dropped`. No row is written.
- **The strong session throws:** `together` waits for the cheaper one, then rethrows, with a stop
  request first. No row is written. The pause, block or day-budget handling is exactly today's.

### first

1. **Is it earned?** See the next section. If the judge has not earned it, it runs as shadow
   (above). The `judge` event says why, in words. For example:
   - "first: running as shadow; the cheaper judge decides alone only after it has also rejected
     the last 30 things the strong judge rejected (12 so far)"
   - "first: running as shadow; it passed something the strong judge rejected on 14 Oct (add-numbers), so it needs 30 newer ones"
2. **Is an audit due?** An audit is due when, since this judge's newest shadow row (same models
   and template), it has had at least `AUDIT_EVERY - 1` first-mode rows (`alone` or `escalated`).
   If one is due and there is room, the call runs as shadow: both run, the strong judge decides,
   and the row is an ordinary shadow row. Without room, the strong judge decides alone, as shadow
   does without room ("not compared"), and the audit stays due: the cheaper judge decides alone
   again only after an audit has run. With a daily budget and no session cap an audit never has
   room, so there the cheaper judge never decides alone, even with first earned under an earlier
   budget setting.
3. **Otherwise the cheaper judge runs alone** (`retry: false`), one session after the other, so no
   extra budget room is needed:
   - **A clean `pass`:** it decides. Row `how = 'alone'`, `strong` NULL. The result is returned
     with `decidedBy: "cheap"`.
   - **`reject`, `unsure` or `failed`:** the strong judge runs afterwards and decides, findings
     and all. Row `how = 'escalated'`. Returned with `decidedBy: "strong"`.
   - **The cheaper session throws `AssistantUnavailable`** (for example its own usage limit): its
     row is already ended as interrupted. It is treated as `failed` and the strong judge runs. If
     the strong judge is unavailable too, that one throws and the loop pauses as today. A limit
     on the cheaper model alone therefore never pauses the loop or lowers quality; it only costs
     more.
   - **`StopRequested` or `LoopBudgetReached`:** passed on as today. No row is written.

## When first is earned

`firstStanding(rows, key)` in `src/judges.ts` is pure, and works over `trace.judgeRows()`. The key
is the judge, `cheap_model`, `strong_model` and `template_sha`, all as they are now.

**Evidence** is the rows that match the key and have:

- `how = 'shadow'` (audits included), and
- `strong = 'reject'`, and
- `cheap != 'failed'`.

Walk them from newest to oldest, counting each `prompt_sha` once (the newest row for it):

- A prompt with `cheap = 'pass'` in any of its rows is a miss, so a newer caught row asking the
  same never hides one. The walk stops: not earned, and the standing says when and
  where the miss was.
- Otherwise the row is caught (`reject` or `unsure`).
- First is earned when 30 rows have been caught before any miss.

`firstStanding` also returns how many have been caught so far, and whether an audit is due.

Why this rule:

- **It counts strong rejections, not all comparisons.** A false pass can only happen where the
  strong judge rejects. A cheaper judge that passes everything would earn trust under a rule that
  counts agreeing passes, whenever rejections are rare. It can never earn it under this rule.
- **It uses only shadow rows.** In first, the strong judge only sees what the cheaper one rejected
  (escalations), and those rows can never show a miss. Counting them would only pad the record.
  Audits are unbiased samples, so they count both ways.
- **Each prompt counts once.** A restarted step that asks the same judge the same question does
  not count twice. The review's prompt does not name the commit it judges, so for the review the
  head commit is part of `prompt_sha`: each round of a change is its own question.
- **What 30 means:** a clean record of 30 shows, at about 95% confidence, that the cheaper judge
  misses fewer than about 1 in 10 of what the strong judge catches (the rule of three: 3/30). This
  is acceptable only because later gates stand behind every judge: the plan check, tests, the
  verifier, the review and the done-check. `loopstra judges` and the decision record say so
  plainly.
- **It heals itself.** One miss sends that judge back to shadow until 30 newer rejections are
  caught. Audits (1 call in 5) keep measuring after it is earned, so drift shows up as a miss and
  switches first back to shadow by itself. Drift here means a model update behind the same alias,
  or a different kind of work.
- **It starts over** when the cheaper or strong model name changes, when
  `loopstra/prompts/<judge>.md` is edited (`template_sha`), or when trace.db is moved aside as
  damaged. These are all the safe direction.

## Mechanics

### src/judges.ts (new)

`JudgeName`, `passes`, `contradicts`, `runJudge`, `firstStanding`, `cheapMayDecide(ctx, phase)`
(first is on and earned now, for the early review) and `judgeReport(cfg, rows, templates)` (pure,
for the report; `templates` maps each judge to the sha256 of its current prompt template).

- `timed(spec)` wraps `agentPhase` and measures milliseconds.
- A session's cost comes from `AgentPhaseResult.costUsd` when it is ok, and is null otherwise.
- `template_sha` is the sha256 of the template file text. `prompt_sha` is the sha256 of
  `phasePrompt(ctx, phase)`, with the head commit of the phase's folder before it for the review.

### src/phases.ts

- `AgentPhaseSpec` gains `retry?: boolean` (default true). `agentPhase` retries a timeout or crash
  only when it is not false.
- `AgentPhaseSpec` gains `endsPause?: boolean` (default true). A session that ends ok clears the
  outage pause only when it is not false; the cheaper judge sets it false, so with only the strong
  model out the back-off keeps climbing instead of restarting at one minute.
- `together` and `optional` are unchanged.
- **Nested groups:** the early review's shadow runs a `together` inside the build step's
  `together`. The inner group skips the boundary because `groups > 0`.
- `src/claude.ts` and `src/shell.ts` do not change (there is no cut-short).

### src/budget.ts

- `roomForTwo(cfg, trace)` becomes
  `roomFor(cfg: Config, trace: Trace, sessions: number, now = new Date()): boolean`:
  `>= sessions * cap` in place of `>= 2 * cap`, and `sessions <= 1` is always true. Part G reuses it.
- The callers in build.ts and verify.ts pass 2.
- Room is checked before the group starts, so inside the build step's group a session that is
  already running is counted as held. That only errs towards skipping the shadow.

### src/trace.ts

- `SCHEMA` gains a table. Old databases get it through `IF NOT EXISTS`, as `gates` did.
  ```sql
  CREATE TABLE IF NOT EXISTS judges (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
    judge TEXT NOT NULL, trace_name TEXT NOT NULL, ts TEXT NOT NULL,
    mode TEXT NOT NULL,            -- the setting: shadow | first
    how TEXT NOT NULL,             -- shadow | alone | escalated
    cheap_model TEXT NOT NULL, strong_model TEXT NOT NULL, template_sha TEXT NOT NULL, prompt_sha TEXT NOT NULL,
    cheap TEXT NOT NULL,           -- pass | unsure | reject | failed
    strong TEXT,                   -- pass | reject | failed; NULL when the cheaper judge decided alone
    cheap_usd REAL, strong_usd REAL, cheap_ms INTEGER, strong_ms INTEGER);
  ```
- `EventType` gains `"judge"`.
- `judge(slug, row)` inserts the row and writes a `judge` event: the row plus a plain `note`.
  Examples:
  - "the cheaper judge (sonnet) agreed with the strong judge (opus): rejected"
  - "the cheaper judge (sonnet) passed what the strong judge (opus) rejected; the strong judge decided"
  - "decided by the cheaper judge (sonnet): passed"
  - "the cheaper judge (sonnet) was unsure, so the strong judge (opus) decided: rejected"
- `judgeRows(): JudgeRow[]` returns all rows, oldest first. They are few, and judges.ts filters them.
- `intentSummary`'s last phase skips rows whose name ends in `-cheap`, so the status table never
  shows `spec-check-cheap` as where a change is. Cost still counts every phase, because it is real
  spending.

### Call sites

- **`src/stages/artifact.ts` `checks()`:**
  - The judge check calls `runJudge(ctx, { name: s.judge.name, model: "strong", permissionMode: "default", tools: "read", vars: s.judge.vars(a) })`.
  - The pass test is `passes(s.judge.name, r.envelope)` in place of `e.approved`. It means the
    same thing, now from one source.
  - When `decidedBy` is `cheap`, the evidence reads `"<summary> (decided by the cheaper judge, sonnet)"`.
  - The broken-judge path and the rewrite findings are unchanged. Findings always come from the
    deciding envelope, which is the strong judge's whenever the verdict is a reject.
- **`src/stages/review.ts`:**
  - **`runReviewRounds`:**
    - Calls `(await takeEarlyReview(ctx, phase)) ?? await runJudge(ctx, phase)`.
    - Pass is `passes("review", envelope)`. The `important` list is still built for the message
      and the revision.
    - When the cheaper judge decided, the gate summary adds "; decided by the cheaper judge (sonnet)".
      The PR body's last-review line shows it too, because it reads that gate row.
    - review.md, the gate row and the findings all come from the deciding envelope.
  - **`reviewAhead`:**
    - Calls `runJudge(ctx, phase, { alongside: 1 })`. It already runs next to the verifier, so a
      shadow here needs room for three sessions. Without this, round 1, the most informative
      review, would almost never be measured, because it usually reuses the early review.
    - It keeps `{ key, envelope, decidedBy }`.
    - A comparison made here is recorded even if the verifier then fails and the review is thrown
      away. It was the same question about the same commit, so it is still valid evidence.
  - **`takeEarlyReview`:**
    - A kept review with `decidedBy: "cheap"` is used only if `cheapMayDecide(ctx, phase)` is true
      now. Between the build step and the review step, another change's audit may have found a
      miss, or the setting may have moved. It uses the same rule as `runJudge` (first earned, and
      not a daily budget with no session cap), less the due audit: the kept review's own row can
      be what made the audit due.
    - Otherwise it is dropped with the note "not used: it was decided by the cheaper judge, which
      is no longer trusted to decide alone", and round 1 runs.
    - A review the strong judge decided stays valid under any setting, as long as the existing key
      matches. `reviewKey` is unchanged.
    - An old marker without `decidedBy` counts as strong.
- **`src/stages/verify.ts`:** lessons' `previous` input leaves out phases whose name ends in
  `-cheap`, so a cheaper judge's failure is never presented to lessons as the change's failure.
  `roomForTwo` becomes `roomFor(…, 2)`.
- **`src/stages/build.ts`:** `roomForTwo` becomes `roomFor(…, 2)`. Nothing else changes.

## Where an engineer sees it

- **`loopstra judges`:**
  - A new `src/commands/judges.ts` with `renderJudges(root)`, a case in `src/cli.ts`, and a HELP
    line: `judges    how often the cheaper judges agreed with the strong ones`.
  - It is read-only. In a folder that is not set up, it prints `NOT_SET_UP` and exits 1.
  - Example:
  ```
  Cheaper judges: first (sonnet before opus). Only comparisons with these two models and the current prompts count.
  Judge           Compared  Agreed  Passed what opus rejected  Rejected what opus passed  Unsure  Could not answer  Avg cost (sonnet / opus)  First would cost  Goes first?
  spec-check      41        39      0                          2                          1       1                 $0.09 / $0.31             41%               yes (decided alone 18 times, audited 4)
  plan-challenge  12        12      0                          0                          0       0                 $0.07 / $0.25             28%               not yet: 3 of 30 rejections caught
  review          40        35      2                          3                          1       1                 $0.22 / $0.80             52%               no: missed one on 14 Oct (add-numbers); 6 of 30 caught since
  Spent on cheaper judges so far: $9.40. 17 older comparisons with other models or prompts are not counted.

  Passed what the strong judge rejected (newest first):
  - 14 Oct, add-numbers, review-1: opus rejected, sonnet passed.
  ```
  - **Compared, Agreed, false passes, false rejects, Unsure:** from shadow rows where neither side
    failed. **Could not answer** counts the cheaper judge's `failed`.
  - **Average costs and minutes:** only non-null values, as an `Avg cost` and an `Avg time`
    column (the example leaves the time column out for width). A time is the session's own: each
    judge session runs as a group of one, so the between-phases merge boundary runs before its
    clock starts, in first as in shadow.
  - **First would cost:** worked out over the shadow rows as (cheaper + strong whenever the
    cheaper judge did not pass) / strong, as a percentage. This is measured, not guessed from
    prices, and tells whether first pays.
  - **Spent on cheaper judges:** the sum of the cost of every `-cheap` phase.
  - **Goes first?:** shown only when the setting is shadow or first. Under shadow, an earned judge
    reads "it would: it caught the last N rejections" (N can pass 30). "Audited" counts only audits:
    a first-mode shadow row right after an alone or escalated row, not the shadow calls that earn
    first back after a miss.
  - **Why a judge cannot be compared**, spelled out in words:
    - "review already runs on sonnet; there is nothing cheaper to compare"
    - "with claude.max_budget_usd_per_day set and no claude.max_budget_usd, both judges never run
      at once; set a session limit"
  - **With no rows:** "No comparisons yet. Set speed.cheap_judges to shadow to start measuring."
- **Dashboard:** `buildState` adds `judges` (the setting, both model names, `judgeReport` rows and
  the newest five false passes) to `UiState`. `src/ui/index.html` shows the same table as
  "Cheaper judges", under health, only when the setting is not off or rows exist. `runningPhase`
  already shows "review-1 + review-1-cheap".
- **Trace:** `judge` events appear in `loopstra tail` and in events.jsonl. Each cheaper session has
  its own folder (prompt.md, envelope.json, raw.jsonl), next to the strong one's.
- **`loopstra status` and the attention list are unchanged.** They are for the owner, and nothing
  needs a person: in shadow the strong judge decided, and in first a miss sends the judge back to
  shadow by itself.

## Test support

`tests/fake-claude/claude.ts`:

- It reads the model from the `--model` argument.
- Before the existing candidates it tries:
  - `$LOOPSTRA_FAKE_FIXTURE_DIR/<phase>@<model>-<n>.jsonl`, counted in `.count-<phase>@<model>`;
  - `<phase>@<model>.jsonl`.
- A test can then give `spec-check@sonnet.jsonl` and `spec-check@opus.jsonl` different verdicts.
  The plain `<phase>-<n>` sequence is unchanged, but it is not reliable for two sessions of one
  phase that start at the same time, so shadow tests use the model files.

## Edge cases

- **Stop (Ctrl-C) while both run:** `together` waits, both rows end interrupted, `optional`
  rethrows the stop, and no row is written. The step resumes and asks both again.
- **Stop while first's escalation runs:** interrupted. No row is written, because rows are written
  just before `runJudge` returns. The step resumes.
- **Process killed:** rows are left running, their holds go stale as today, and no comparison is
  written. A kill after the row but before the gate row gives a duplicate with the same
  `prompt_sha`, which counts once.
- **The strong model is unavailable while the cheaper one answers:** the loop pauses as today. The
  cheaper result is thrown away, unrecorded, and it does not end the pause, so the back-off climbs.
- **Only the cheaper model is unavailable:** shadow drops it, and first sends the question to the
  strong judge. The loop is never paused because of it.
- **Shadow, the cheaper session ends `ok: false`** (invalid envelope, agent-fail, a timeout):
  the row records `failed` and is counted only under "Could not answer". Its phase row
  shows as failed in the dashboard, but lessons and the status table's last phase leave it out.
- **Shadow, the strong judge ends `ok: false`:** today's broken-judge path (artifact block, or
  review block). A cheaper pass is never used as a fallback. The row records `strong = 'failed'`
  and is left out of the counts.
- **The cheaper session hangs or runs long in shadow:** the step waits for it, up to
  `claude.timeout_minutes`; it is never retried, so a timeout ends it as `failed` and the strong
  verdict stands.
- **Daily budget too small:** without room for two sessions (three for the early review), only the
  strong judge runs, and a "not compared" event is traced. In first, a due audit without room
  means the strong judge decides alone too, so the cheaper judge never decides alone unaudited.
  With a daily budget and no session cap, shadow never runs, and first is never used (a judge that
  earned it under an earlier budget setting keeps its record, but the strong judge decides).
  `loopstra judges` explains why.
- **The day runs out during the cheaper session in first:** `LoopBudgetReached` is passed on as
  today. Shadow spending counts towards the change's `HAD_THE_DAY` share, because it is real
  spending.
- **The early review is shadowed and the verifier fails:** the review is thrown away, but the
  comparison row stays.
- **A cheap-decided early review after trust is lost** (an audit found a miss, the setting moved,
  or a model or template changed): not used, and round 1 runs on the current setting.
- **first, not earned:** runs as shadow, and the event says how many rejections have been caught.
- **first, earned, cheaper judge `unsure`:** for example spec-check approved with an unmet finding.
  The strong judge decides. Recorded as escalated.
- **first, earned, the cheaper judge passes:** only one session runs. Its envelope is the verdict.
  For review, its review_markdown goes to review.md. Its gate row says it was decided by the
  cheaper judge.
- **An audit finds a miss:** the strong verdict decides that call, and the next call for that judge
  runs as shadow again.
- **Model name change, or prompt template edit:** the record starts over, and first runs as shadow
  until it is earned again.
- **trace.db moved aside as damaged:** no evidence, so first runs as shadow.
- **Settings changed between ticks:** read from `ctx.cfg` every tick. first → off means only the
  strong judge.
- **Missing prompt file:** today's missing-prompt failure. The cheaper judge does not start.
- **`gates.<x>.agent: false`:** no judge, so no cheaper judge either.
- **A retry of the strong judge (`-retry`):** unchanged. The comparison uses whichever attempt
  returned.
- **A person changes the status while the judges run:** `setStatus` throws `PersonChangedStatus`
  afterwards, as today. A row already written stays valid.

## Tests

- **config:**
  - `speed.cheap_judges` defaults to off and accepts shadow and first.
  - `sometimes` is rejected with "speed.cheap_judges: must be off, shadow or first".
  - templates-roundtrip passes with the new key and comments.
- **judges `passes` / `contradicts`** (table tests):
  - spec-check: `approved: false` with every finding met is a reject; `approved: true` with an
    unmet finding is a pass that is unsure.
  - plan-challenge: approved with only non-blocking concerns is a clean pass; approved with a
    blocking concern is unsure.
  - review: `approved: true` with one important finding is a reject; `approved: false` with only
    nits is a pass (the runtime's rule), and unsure for the cheaper judge.
- **`firstStanding`** (pure, seeded rows):
  - 29 caught gives "29 so far"; 30 gives earned.
  - Rows with another model, another `template_sha`, `how` alone or escalated, or cheap `failed`
    are ignored.
  - Duplicates with the same `prompt_sha` count once; a miss followed by a caught row with the
    same `prompt_sha` is still a miss.
  - One miss among the newest 30 means not earned, with its date and slug; 30 newer caught after
    it means earned again.
  - An audit is due after 4 first-mode rows since the newest shadow row.
- **runJudge off:** one session, `--model opus` in `LOOPSTRA_FAKE_CALLS`, no judges row.
- **Not applicable:** with `models.default` equal to `models.strong`, or `stages.review.model:
  default`, under shadow there is one session and no row.
- **runJudge shadow:**
  - Two sessions. `LOOPSTRA_FAKE_PROMPTS` shows identical prompts and `--model sonnet` for
    `-cheap`.
  - With `LOOPSTRA_FAKE_DELAY_MS`, the second starts before the first ends (judged by start
    order).
  - The returned result is the strong one, with `decidedBy: "strong"`.
- **Shadow false pass** (stages-design):
  - `spec-check@sonnet` approves and `spec-check@opus` rejects.
  - The rewrite runs with opus's findings.
  - The judges row is cheap `pass`, strong `reject`.
  - The gates table has only the strong spec-check row.
  - The `judge` event note says the cheaper judge passed what the strong judge rejected.
- **Shadow, cheaper session fails** (stages-plan):
  - An invalid cheaper envelope gives a row with cheap `failed`, and the strong judge decides.
  - A cheaper `fake_exit` outage gives a `plan-challenge-cheap: dropped` event and no row. The
    step passes on the strong verdict, and the loop is not paused.
- **Shadow, strong judge unavailable:** the step throws `AssistantUnavailable` after the cheaper
  row has ended. No row is written, and the change keeps its status.
- **Shadow stop:** `requestStop` while both run. Both rows end interrupted, no row is written,
  and the status is unchanged.
- **Shadow room:**
  - With `max_budget_usd_per_day` and no `max_budget_usd`, only the strong session runs, and a
    "not compared" event is traced.
  - With room for two but not three, the early review runs without `review-1-cheap`.
- **first, earned (seeded 30 caught):**
  - A cheaper clean pass decides alone: no opus call, `how = 'alone'`, and the gate evidence names
    the cheaper judge.
  - For review, review.md holds the cheaper markdown and the merge findings gate passes.
- **first, escalation:**
  - The cheaper judge rejects, is unsure, gives an invalid envelope, or is unavailable (`fake_exit`
    outage on `@sonnet` only).
  - Opus starts after it ends, and decides.
  - The row is `how = 'escalated'`, and the loop is not paused.
- **first, not earned:** both run as shadow, and the event says "12 so far".
- **first, audit:**
  - The 5th call runs both together, and the strong judge decides.
  - When opus rejects and sonnet passed, the next call runs as shadow.
- **Early review** (stages-build):
  - Under shadow with no daily budget, verify, review-1 and review-1-cheap run in the build step,
    and a row is written.
  - With verify failing, the early review is dropped but the row remains.
  - A cheap-decided early review is dropped after a seeded miss, with the "not used" event, and
    review-1 runs on opus.
- **Lessons and status:** a failed `spec-check-cheap` row is not in lessons' `previous`, and
  `intentSummary().lastPhase` skips `-cheap` rows.
- **budget:**
  - `roomFor(cfg, trace, 3)` with and without daily and session limits.
  - The existing `roomForTwo` tests move to `roomFor(…, 2)`.
- **phases:** `retry: false` does not retry a crash or timeout, so there is no `-cheap-retry` row.
- **trace:** an old database gains the judges table on open, and `trace.judge` writes the row
  and a `judge` event to events.jsonl.
- **judgeReport and renderJudges:**
  - From seeded rows: compared, agreed, false passes, false rejects, unsure, could not answer,
    averages, and "first would cost" (hand-checked numbers).
  - Older pairs go into the "not counted" line, and the false-pass list is correct.
  - "Goes first?" says "not yet: 3 of 30 rejections caught".
  - With no rows, it prints the hint.
- **cli:** `loopstra judges` outside a set-up folder prints `NOT_SET_UP` and exits 1, and HELP
  lists `judges`.
- **ui:** `buildState` includes `judges`, and the page shows the table only when the setting is not
  off or rows exist.
- **fake claude:**
  - `<phase>@<model>.jsonl` is chosen for the matching `--model` only.
  - `<phase>@<model>-<n>.jsonl` sequences count per model.

## Out of scope

- The done-check (see above), and intake, verify and lessons, which are not judges in this sense.
- A setting per judge, a configurable threshold, and a configurable cheaper model.
- A confidence field, or any change to an envelope or prompt.
- Comparing findings rather than verdicts.
- Telling a new model behind the same alias apart by its resolved id. Audits catch the drift
  instead.
- Running both judges at once in first and killing the strong one on a cheaper pass.
- Loopstra editing config.yaml. Trust only decides what `first` does at run time.

## Docs

- `docs/decisions.md`: a new section, "Cheaper judges (speed, part D, 2026-10-16)". It records:
  - off by default;
  - one switch;
  - the verdict is the gate's own rule, and unsure is a pass that contradicts itself;
  - the evidence rule (30 caught strong rejections, shadow rows only, each prompt once) and what
    30 means;
  - audits every 5th call;
  - the record starts over on a model or template change;
  - the cheaper judge writes no gate rows and its findings never reach a rewrite;
  - the cheaper judge is never retried, and there is no cut-short;
  - shadow gives way on budget;
  - the early review is shadowed with room for three, and a cheap-decided one is rechecked before
    use;
  - the done-check is left out;
  - lessons and the status table leave out `-cheap` rows.
- README:
  - The Configuration `speed` bullet gets one sentence on `cheap_judges`.
  - The command list gets `loopstra judges`.
- This file: `docs/superpowers/specs/2026-10-16-cheap-judges-design.md`.

## Decisions

- Design 1 is the base: one switch, verdict equals the gate's own rule, evidence counted over strong rejections; Design 2's trust rule (checked cheap passes in a row) can trust a rubber-stamp judge when rejections are rare (an always-pass judge earns 30 clean passes 40% of the time at a 3% reject rate), so it was rejected.
- speed.cheap_judges defaults to off because shadow speeds nothing up on its own and spends day budget and usage limit the owner did not ask for.
- One switch, not per judge, because each judge already has to earn first with its own record and loses it on its own miss; a per-judge object can be added later without breaking configs.
- First refuses to take over until earned (runs as shadow and says why) rather than raising a config error, keeping the loop unattended; the threshold is a constant so it cannot be set to zero.
- Threshold raised from 20 to 30 caught strong rejections (rule of three: miss rate under about 1 in 10 at 95%), because earning slowly costs only money while quality is the owner's hard line.
- Each prompt_sha counts once and template_sha is part of the key, so restarts do not pad the record and a prompt edit starts it over; resolved model ids are not tracked because audits catch alias drift with less plumbing.
- First keeps auditing: every 5th call of a trusted judge runs as an ordinary concurrent shadow run (unbiased, strong decides), replacing Design 2's sequential recheck, so drift turns first off by itself at no wall-clock cost.
- A cheap pass that contradicts itself (spec-check approved with an unmet finding, plan-challenge approved with a blocking concern, review with no important findings but approved false) is 'unsure' and escalates; it is a pure function on the existing envelopes, so no confidence field or prompt change is needed.
- The done-check is left out because a second judge would need a second copy of main and install (or would share the output folder), and it runs once per change after the merge, so the saving is small.
- No cut-short: the cheaper model is normally the faster one, it is never retried, and `timeout_minutes` bounds it; plumbing an abort signal through the process layer was not worth the code for a mode that is off by default.
- In first mode, a cheaper session that throws AssistantUnavailable escalates to the strong judge rather than pausing the loop, since a per-model limit should only cost more, never stop work.
- First-mode escalation runs cheap then strong sequentially without a together wrapper, because the strong judge then sees exactly what it sees today and no extra concept is needed.
- The early review is shadowed (room for three) so round 1 gets measured; a kept review decided by the cheaper judge is used only if the judge is still trusted now, while strong-decided reviews keep today's key unchanged.
- Lessons' previous-failures input and the status table's last phase leave out -cheap rows, which Design 1 missed: otherwise a cheap judge's invalid envelope would be fed to lessons as the change's failure.
- Observability lives in a new `loopstra judges` command and a dashboard section; `loopstra status` and the attention list stay owner-only because a shadow false pass needs no person.
- Report costs are measured (phase rows and per-session cost/time) and 'first would cost' is computed from shadow rows, not from price tables, so the engineer sees whether first pays.
- Rows are read whole via trace.judgeRows() and filtered in pure functions in src/judges.ts, keeping trace.ts thin and the evidence and report logic unit-testable.
- Fake claude gains <phase>@<model>[-n].jsonl with per-model counters because the existing per-phase counter races when two sessions of one phase start together.
