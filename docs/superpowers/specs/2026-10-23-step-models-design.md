# Models for every step

Today each of the five stages, and chat, picks one of three named models (`cheap`, `default`,
`strong`). Several smaller steps ignore that choice and are fixed in code: intake and lessons always
run on `cheap`, the spec check, plan challenge and done-check always on `strong`, and fix and revise
follow the build stage. The only way to change any of it is `loopstra setup models` or editing
`loopstra/config.yaml` by hand.

This change lets a person choose the model for every step, and change it later in two places that
offer exactly the same choices:

1. **The console:** a new Settings page, with Models as its first section.
2. **Setup run again:** `loopstra setup models` (or the whole of `loopstra setup`) in a repo that is
   already set up, starting from what the config says now.

It also adds a fourth named model, `max`, and makes the named models track the newest Claude models
without Loopstra releases.

## Why

The person running Loopstra wants to spend where it matters and save where it doesn't. Examples:
put the done-check on the most capable model, or the lessons on a cheaper one. They want to make
that change from the console while the loop runs, without opening YAML. A model choice also must
not go stale when Anthropic ships a new model or Claude Code changes how it names them.

## Goals

- Every step listed below can be given its own model, in the console and in setup.
- Four named models: `cheap` (latest Haiku), `default` (latest Sonnet), `strong` (latest Opus),
  `max` (latest Fable).
- "Latest" follows Claude Code, not Loopstra: a named model holds an alias that Claude Code resolves.
- A change made in the console applies to the next agent session that starts. A running session is not
  disturbed.
- The console shows which model each named model actually ran on, so a moved alias or a bad name is
  visible.
- Existing configs keep working unchanged and run exactly as before.

## Non-goals

- Other settings (budgets, gates, commands, chat transports) on the Settings page. The page is
  built so they can be added later, but this change only adds Models.
- Picking a full model name per step. A step picks one of the four named models. A named model can
  hold any name (see "Named models"), so a pinned version is still possible, by pinning the named
  model.
- More than four named models, or ones a person names. *(My call: fixed four keeps setup, the
  console and the config simple. A new model family goes into whichever of the four fits.)*
- Choosing the model of the probe that checks whether the assistant is back (it stays on `cheap`,
  or on the model that failed, as today) or of the cheaper judge (it stays on `default`). These are
  plumbing, not steps a person thinks about.
- Effort levels, fallback models (`--fallback-model`), or per-change model choices.

## Anti-goals

- **`max` is never used unless a person picked it for a step.** No default, suggestion, setup
  answer taken with `--defaults`, or upgrade puts a step on `max`. A test holds this.
- No list of known model names inside Loopstra that has to be kept up to date.
- No change to which model any step uses for a repo that does not touch the new settings.

## Named models

```yaml
claude:
  models:
    cheap: haiku
    default: sonnet
    strong: opus
    max: fable      # new
```

- Each value is passed verbatim to `claude --model`. It may be an alias (`haiku`, `sonnet`, `opus`,
  `fable`, `best`, `opus[1m]`, ...) or a full name (`claude-opus-5-5`, `us.anthropic.claude-opus-4-8`
  on Bedrock, a gateway's name). Validation stays as today: one word, no spaces.
- The defaults are the aliases above. Claude Code resolves an alias to the newest model of that
  family (Claude Code 2.1.309 maps them to Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1), and the
  mapping moves when Claude Code updates. Loopstra adds nothing on top.
- Claude Code's own overrides (`ANTHROPIC_DEFAULT_HAIKU_MODEL`, `_SONNET_`, `_OPUS_`, `_FABLE_`)
  keep working, because Loopstra passes its environment through. Nothing to build; it is documented.
- A config with no `max` key gets `fable` from the schema default. No upgrade step is needed.
- `ModelRef` becomes `"cheap" | "default" | "strong" | "max"` everywhere it is used: the config
  schema, `AgentPhaseSpec.model`, the chat agents, `modelFor`.

## Steps

Each step has a key, a stage it belongs to, and a built-in default. The built-in default is either
a fixed named model or "follow a stage's model". The table is the complete list. Its defaults are
today's behavior exactly.

| Stage | Step key | What it is | Built-in default |
|---|---|---|---|
| design | `intake` | reads a new intent before the spec | `cheap` |
| design | `design` | writes the spec | the design stage |
| design | `spec-check` | judges the spec | `strong` |
| plan | `plan` | writes the plan (also the plan written ahead) | the plan stage |
| plan | `plan-challenge` | judges the plan | `strong` |
| build | `build` | writes the code | the build stage |
| build | `reconcile` | reconciles after the base moved | the build stage |
| build | `fix` | fixes after failed checks, and after a failed verify | the build stage |
| review | `review` | reviews the code (also the early review) | the review stage |
| review | `revise` | changes the code after review findings | the build stage |
| verify | `verify` | runs and reads the checks | the verify stage |
| verify | `done-check` | judges whether the change did what it said | `strong` |
| verify | `lessons` | notes lessons from the change | `cheap` |
| chat | `orchestrator` | chat's orchestrator | the chat model |
| chat | `write-intent` | writes a new change up as an intent | the design stage |

The table lives in one place in code (a `STEPS` constant next to the config schema). Setup, the
console and the stages all read it, so the three cannot drift. Each stage looks up its phase's model
through one function, `stepModel(cfg, step)`, instead of naming a model or reading
`cfg.stages.x.model` directly. A test checks that every agent phase the stages run uses a key from
the table.

`revise` and `fix` are listed under the stage they run in (`revise` under review) or the one they
belong to (`fix` under build). Their built-in default follows the build stage, as today.

## The config

A stage keeps its `model`. It gains an optional `steps` map of step key to named model:

```yaml
stages:
  design:
    model: strong
    steps:
      intake: default
      spec-check: max
  verify:
    model: default
    steps:
      done-check: max
chat:
  model: default
  steps:
    write-intent: strong
```

- A step that is not in `steps` uses its built-in default. A step whose default follows a stage
  follows that stage's `model`, so changing `stages.build.model` still moves build, reconcile, fix
  and revise together, as today.
- `steps` only accepts the keys that belong to that stage (the table above). Anything else fails to
  load with a clear message (the schemas are `.strict()`). An unknown named model fails the same
  way.
- `chat.model` stays the orchestrator's model. The `orchestrator` row in the table is that same
  setting, shown as a step. It is not a second place to set it.

## The console's Settings page

A new page at `/settings`, with a Rail entry under Spend. Its one section for now is Models:

- **Named models:** four rows (cheap, default, strong, max). Each shows its name, editable as text,
  and *last ran on*: the model the most recent session using it actually started on, with how long
  ago (for example `opus → claude-opus-5-5, 2h ago`), or "not used yet".
- **Stages:** one group per stage, and chat. The stage's own model is a picker of the four. Under it
  each step is a row with a picker. A step that has no setting of its own shows its default in a
  muted way ("follows build: default", or "strong") and offers it as "Default". Picking a named
  model writes `steps.<key>`. Picking "Default" removes the key.
- `max` is in every picker, and is never preselected.

Saving goes through a request, like every other console write. `loopstra/config.yaml` is tracked
on main, and only the loop writes the main checkout (see `src/requests.ts`). A file edited in place
would also stop the loop syncing main (`checkoutReady` in `src/remote.ts`) until someone committed
it by hand.

- Each change saves on its own, with no Save button. The page sends it as a new request kind,
  `settings`, through `/api/requests` (Origin checked, JSON only, as today). Its body is
  `{ kind: "settings", path, value, version }`, where `value: null` removes a step's own setting.
- The loop's applier (`src/apply.ts`, which picks a request up within about 2 seconds while the loop
  runs) edits `loopstra/config.yaml` through `ConfigDocument` and commits it as one record, like
  other requests: "settings: stages.verify.steps.done-check → max". Comments, key order and line
  endings are kept. A config that would not load is refused, with the reason as the request's result.
- Only the model paths in this change may be written (`claude.models.*`, `stages.*.model`,
  `stages.*.steps.*`, `chat.model`, `chat.steps.*`). The console refuses anything else, and the
  applier refuses it again.
- `version` is a hash of the file as the page last read it. The console checks it when the request
  is sent (409 at once) and the applier checks it again before writing. If the file changed in
  between (setup in a terminal, a hand edit, another tab, another request), the request is refused,
  and the page reloads the settings and says so. Nothing is merged silently.
- The page shows the change as pending until its result arrives, then confirms it or shows the
  refusal and puts the picker back. When the loop is not running, the request waits like any other,
  and the page says "saved when the loop next runs". *(My call: one write path for the console, and
  no exception to "only the loop writes main".)*
- `GET /api/settings` returns the current named models, stage and step settings with their
  defaults, the step table, *last ran on* per named model, and `version`. If the config does not
  load, it returns the problem, and the page shows that problem instead of the pickers.

Setup in a terminal still writes the file in place, as it does today. Committing that stays with the
person, also as today.

### When a change applies

A change applies to the next agent session that starts, not only the next tick. A tick can last a
whole build, and within one stage step the build, fixes, verify, done-check and lessons share one
`ctx.cfg`. So `stepModel` reads the model settings fresh from `loopstra/config.yaml` before each
session. If that read fails (the file stops loading mid-tick), it uses the tick's copy and traces
the problem once. Every other setting keeps being read once per tick, as today. Chat's agents use
`stepModel` too, so chat picks up a change on its next turn.

A session that is already running finishes on the model it started with. The page says this in one
line.

### Sessions that resume the build

`fix`, `reconcile` and `revise` resume the build's session today (`buildSession` in
`src/stages/shared.ts`). They keep resuming it when their model differs from the build's, so the
build's context carries over. The cost is that the prompt cache is per model, so the first turn on
the new model reads the transcript at full price. *(My call: the context is why these steps resume
at all.)* Builder: check that Claude Code accepts `--resume` with a different `--model`. If it
refuses, start a fresh session for that step when the models differ, and record that in
`docs/decisions.md`.

The page uses the console's existing look (`src/ui/theme.css` tokens) and parts. No new design
language.

## Setup

`loopstra setup models` keeps its flow and adds to it:

1. The four named models, each suggested from the config's current value or the default (now
   including `max`). Its intro line says aliases follow Claude Code's latest and that a full name
   pins a version.
2. Each stage's model, as today, now offered from four.
3. After each stage (and chat): "Choose models for <stage>'s steps one by one? (y/N)". No, the
   default, keeps the step settings as they are. Yes asks each of that stage's steps, suggesting its
   current setting or "default". Answering "default" removes the step's own setting.
4. `--defaults` takes every suggestion, so a fresh setup has no `steps` maps, and an existing one
   keeps what it has.

Run again in a set-up repo, setup starts from the config's values, as every section does today.
`covers` gains `stages.*.steps` and `chat.steps`, so a config problem under those paths is offered
for fixing in this section.

## When a model name is wrong

Claude Code does not check `--model` up front. A bad name fails on the first request with "There's
an issue with the selected model". Today that would read as an ordinary failure or, worse, an
outage.

- Add this wording to the failure patterns in `src/claude.ts` as its own reason (`model`), not as
  `environment`. It must not pause the loop or start the outage back-off.
- The step fails with a plain block that names the named model, the name it holds and the step:
  "`strong` is `opuss`, which Claude Code does not accept as a model (step spec-check). Change it in
  Settings or `loopstra setup models`, then retry." It lands in the inbox like other blocks, and
  retry works as it does for them.
- *Last ran on* shows the failure for that named model ("failed: not a model") until a session on it
  gets through.
- Chat's agents (`orchestrator`, `write-intent`) are not change steps and leave no block. There the
  same sentence is chat's reply to the person, and the turn ends. *(My call.)*

## Recording what ran

Sessions already record the model from Claude Code's `system/init` event in the trace. That event
is not documented as carrying the model, so also read the documented `modelUsage` from the session's
result, and record the model names from it. *Last ran on* reads the most recent recorded model per
named model. A cheap read of the trace is enough: the newest session for each named model, not a
full scan. *(Builder: choose the read. Keep it fast enough for the page's load.)*

Each phase's trace row also gains the named model it ran on (`ref: "strong"`), so the timeline and
spend can be read per named model later. Nothing in this change displays that beyond *last ran on*.

## Cheaper judges

The cheaper judge (`speed.cheap_judges`, on `default`) still applies only to a judge that runs on
`strong`. A judge a person put on `max` gets no cheaper judge, in `shadow` or `first`, just like a
judge set to `default` or `cheap` today. *(My call: someone who picked `max` for a judge wants that
model to decide, and `first` would let `default` pass things alone.)*

`judgeModel` in `src/judges.ts` reads the judge's step through `stepModel` instead of assuming
`strong`. The comparison's check `phase.model !== "strong"` already gives this behavior once a
judge's phase carries its configured model.

## Docs and decisions

- The config reference (wherever `stages.*.model` is described now) gains `claude.models.max`,
  `steps`, and the step table.
- `docs/decisions.md` records: aliases rather than ids, why four fixed named models, why `max` is
  never a default, the step table living in one place, console saves going through a request, model
  settings read fresh per session, and the 409 on a changed file.

## Tests

- The step table's defaults reproduce today's model for every phase, with an unchanged config.
- No default, `--defaults` setup or schema default puts anything on `max`.
- `steps` with an unknown key, or an unknown named model, fails to load with a clear message.
- Console and applier: a `settings` request changes only the requested path, keeps the file's
  comments, and lands as one commit. An old `version` gets 409 from the console, and is refused by
  the applier if the file changed after the request was sent. A path outside the model paths is
  refused by both. A write without the page's Origin is refused.
- A setting changed mid-tick reaches the next session of a running stage step (a fix after the
  build, say). A config that stops loading mid-tick leaves the tick's models in place.
- Setup: run again on a config with `steps`, it suggests the current values. `--defaults` leaves
  them. "default" removes a step's own setting.
- The bad-model wording is classified as `model`, does not pause the loop, and gives the block text
  above.
- A judge on `max` gets no cheaper judge, in `shadow` or `first`.

## Left to the builder

- Component structure and the exact layout of the Settings page, within the existing look.
- How *last ran on* is read from the trace, and whether it is cached.
- How to name the `model` failure reason internally, and where its block text is built.
- Whether the plan-written-ahead and early-review keys need anything beyond reading their step's
  model (they hash the model name already).
