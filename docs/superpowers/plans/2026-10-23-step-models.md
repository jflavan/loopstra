# Models for Every Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person choose one of four named models (`cheap`, `default`, `strong`, `max`) for every step of the five stages and chat. They can do it in `loopstra setup models` and on a new console Settings page. A change applies to the next session that starts.

**Architecture:**
- **The step table.** `src/models.ts` holds the step table and resolves a step to its named model. The config gains `claude.models.max` and per-stage `steps` maps.
- **Resolving a model.** Agent phases no longer carry a model. `attempt` in `src/phases.ts` resolves it before each session, from the model settings read fresh. A tracked config file and "only the loop writes main" mean console saves are a new `settings` request kind. The loop commits it through the existing record machinery, widened to name explicit paths.
- **Recording what ran.** What each session actually ran on goes into a new `model_runs` trace table, which the Settings page reads.

**Calls made while planning (deviations from the spec's wording, same intent):**
- The spec puts "the named model each session ran on" on the phase's trace row. The plan uses a separate `model_runs` table (Task 4) instead. It is a new table, so it needs no schema migration, and it serves *last ran on* with one indexed query.
- The spec's `version` check is kept as written. To make two quick picks work, the page sends one change at a time and re-reads after each result (Task 8).

**Tech Stack:** Bun, TypeScript (TS 7 via `@typescript/native`), zod, `yaml`, bun:sqlite (Trace), Preact + signals (console UI), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-23-step-models-design.md`

## Global Constraints

- Named models: `cheap` → `haiku`, `default` → `sonnet`, `strong` → `opus`, `max` → `fable` (schema defaults, passed verbatim to `claude --model`).
- A named model's name: one word, no spaces (existing message: "A model name has no spaces, like sonnet or claude-opus-5-5.").
- No default, suggestion, `--defaults` answer, template or upgrade puts any step on `max`.
- Every step's built-in default reproduces today's model exactly (the step table in Task 1).
- Loopstra keeps no list of known model names.
- Writable settings paths: `claude.models.<ref>`, `stages.<stage>.model`, `stages.<stage>.steps.<key of that stage>`, `chat.model`, `chat.steps.write-intent`. Nothing else.
- Console writes need the page's Origin and JSON (existing `jsonWrite`). Only the loop commits to main.
- Work in the worktree `/var/home/jflavan/repos/loopstra-step-models` (branch `feat/step-models`). Never in the main checkout.
- Run `bun run check` (tests, typecheck, lint) before each commit. Match the surrounding code's comment density and plain-words style.
- Never run `npm publish` or touch release files (see CLAUDE.md).

## Review Focus

1. **A hand-made typo in `steps` while the loop runs** (`stages.design.steps.intak: max`): the next tick reports the config problem as today. A session that starts mid-tick keeps the tick's models instead of failing. Test in Task 2.
2. **Uncommitted hand edits to `loopstra/config.yaml` in the main checkout** when a console setting arrives: the loop must not commit the person's unsaved edits along with it. It refuses with plain words. Test in Task 6.
3. **The shipped template's flow-style stage maps** (`design: { model: strong, skills: [], ... }`): a step setting written into one must load and keep the file's comments. Test in Task 6.
4. **Two picks in a row on the page**: the second must not be refused as stale because the first changed the file's version. The page sends one change at a time, then re-reads. Test in Task 8.
5. **A pending setting while the loop is stopped**: the page says it is waiting, offers Cancel, and other pickers wait. It is not stuck forever. Test in Task 8.

---

### Task 1: Named models, the step table, and the config schema

**Files:**
- Create: `src/models.ts`
- Modify: `src/config.ts` (the `modelRef` enum, `claude.models`, the `stage` schemas, `chat`, `ModelRef`, `modelFor`)
- Test: `tests/unit/models.test.ts` (new), `tests/unit/config.test.ts`

**Interfaces:**
- Produces (`src/models.ts`):
  - `MODEL_REFS = ["cheap", "default", "strong", "max"] as const`; `type ModelRef = (typeof MODEL_REFS)[number]`
  - `STAGE_NAMES = ["design", "plan", "build", "review", "verify"] as const`; `type StageName`
  - `type StepGroup = StageName | "chat"`
  - `STEP_KEYS = ["intake", "design", "spec-check", "plan", "plan-challenge", "build", "reconcile", "fix", "review", "revise", "verify", "done-check", "lessons", "orchestrator", "write-intent"] as const`; `type StepKey`
  - `type StepDefault = { ref: ModelRef } | { follows: StepGroup }`
  - `interface StepInfo { key: StepKey; group: StepGroup; what: string; byDefault: StepDefault }`
  - `STEPS: readonly StepInfo[]`, in table order
  - `stepsOf(group: StepGroup): readonly StepInfo[]`
  - `type ModelSettings = Pick<Config, "claude" | "stages" | "chat">` (type-only import from config)
  - `groupModel(cfg: ModelSettings, group: StepGroup): ModelRef`. It returns `stages.<g>.model`, or `chat.model` for chat.
  - `ownStepModel(cfg: ModelSettings, step: StepKey): ModelRef | null`. It returns `orchestrator` → `chat.model`, `write-intent` → `chat.steps["write-intent"]`, any other step → `stages.<group>.steps[key]`, and null when unset.
  - `stepModel(cfg: ModelSettings, step: StepKey): ModelRef`
  - `withModels(base: Config, fresh: ModelSettings): Config`. It returns `base` with `claude.models`, each stage's `model` and `steps`, and `chat.model` and `chat.steps` taken from `fresh`.
- Produces (`src/config.ts`): `export type { ModelRef } from "./models"`, kept so existing imports work. `modelFor(cfg: Pick<Config, "claude">, ref: ModelRef): string`.

The step table, exactly (`what` is the "What it is" column of the spec):

| key | group | byDefault |
|---|---|---|
| intake | design | `{ ref: "cheap" }` |
| design | design | `{ follows: "design" }` |
| spec-check | design | `{ ref: "strong" }` |
| plan | plan | `{ follows: "plan" }` |
| plan-challenge | plan | `{ ref: "strong" }` |
| build | build | `{ follows: "build" }` |
| reconcile | build | `{ follows: "build" }` |
| fix | build | `{ follows: "build" }` |
| review | review | `{ follows: "review" }` |
| revise | review | `{ follows: "build" }` |
| verify | verify | `{ follows: "verify" }` |
| done-check | verify | `{ ref: "strong" }` |
| lessons | verify | `{ ref: "cheap" }` |
| orchestrator | chat | `{ follows: "chat" }` |
| write-intent | chat | `{ follows: "design" }` |

- [ ] **Step 1: Write the failing tests** in `tests/unit/models.test.ts`:

```ts
test("every step's default is today's model", () => {
  const got = Object.fromEntries(STEP_KEYS.map((k) => [k, stepModel(DEFAULTS, k)]));
  expect(got).toEqual({
    intake: "cheap", design: "strong", "spec-check": "strong", plan: "strong", "plan-challenge": "strong",
    build: "default", reconcile: "default", fix: "default", review: "strong", revise: "default",
    verify: "default", "done-check": "strong", lessons: "cheap", orchestrator: "default", "write-intent": "strong",
  });
});
test("a step that follows a stage moves with it", () => {
  const cfg = validateConfig({ ...BASE, stages: { build: { model: "strong" } } });
  expect([stepModel(cfg, "reconcile"), stepModel(cfg, "fix"), stepModel(cfg, "revise")]).toEqual(["strong", "strong", "strong"]);
});
test("a step's own setting wins", () => {
  const cfg = validateConfig({ ...BASE, stages: { verify: { steps: { "done-check": "max" } } }, chat: { steps: { "write-intent": "cheap" } } });
  expect(stepModel(cfg, "done-check")).toBe("max");
  expect(stepModel(cfg, "write-intent")).toBe("cheap");
  expect(ownStepModel(cfg, "lessons")).toBeNull();
});
test("nothing is on max unless a person put it there", () => {
  expect(STEP_KEYS.map((k) => stepModel(DEFAULTS, k))).not.toContain("max");
  expect(STAGE_NAMES.map((s) => DEFAULTS.stages[s].model)).not.toContain("max");
  expect(DEFAULTS.chat.model).not.toBe("max");
  expect(DEFAULTS.claude.models.max).toBe("fable");
});
test("every agent phase name is a step key", () => {
  // Type-level: PhaseName extends StepKey. Runtime: every Envelopes key is in STEP_KEYS.
  for (const name of Object.keys(Envelopes)) expect(STEP_KEYS as readonly string[]).toContain(name);
});
```

Add these to `tests/unit/config.test.ts`:
- `stages: { design: { steps: { lessons: "cheap" } } }` fails to load. The message names `stages.design.steps` and `lessons`, because lessons belongs to verify.
- `stages: { design: { steps: { intake: "huge" } } }` fails to load with a message naming `stages.design.steps.intake`.
- `chat: { steps: { orchestrator: "max" } }` fails to load, because the orchestrator is `chat.model`.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/models.test.ts tests/unit/config.test.ts`. Expected: FAIL (cannot find `../../src/models`).

- [ ] **Step 3: Implement `src/models.ts` and the schema changes in `src/config.ts`.**
  - `modelRef = z.enum(MODEL_REFS)`.
  - `claude.models` gains `max: modelName("fable")`.
  - Each stage schema gains `steps: z.object(<keys of stepsOf(stage)> → modelRef.optional()).strict().prefault({})`.
  - `chat` gains the same, with only `write-intent`.
  - Update the comment on `chat.model` to "The orchestrator's model; write-intent is chat.steps (default: stages.design.model)."
  - `src/models.ts` imports `Config` as a type only, so no import cycle runs.

- [ ] **Step 4: Run the tests and see them pass.** Run `bun test tests/unit/models.test.ts tests/unit/config.test.ts`. Expected: PASS.

- [ ] **Step 5: Run `bun run check`.** Expected: all pass. The schema only adds keys, so nothing else changes yet.

- [ ] **Step 6: Commit**: `git add src/models.ts src/config.ts tests/unit/models.test.ts tests/unit/config.test.ts && git commit -m "feat(models): four named models and a model for every step in the config"`

---

### Task 2: Stages, judges and chat resolve each session's model through the step table, read fresh

**Files:**
- Modify: `src/context.ts` (`StepContext.models()`)
- Modify: `src/phases.ts` (the `AgentPhaseSpec.model` type, `phaseModel`, and `attempt` lines 449–503)
- Modify: `src/stages/design.ts:37`, `src/stages/artifact.ts:104,274`, `src/stages/build.ts:43,73,99,153,193`, `src/stages/review.ts:69`, `src/stages/early-review.ts:19-30`, `src/stages/verify.ts:42,102`, `src/stages/plan.ts:59-61`
- Modify: `src/judges.ts` (`judgeModel`, `notComparable`, `comparison`)
- Modify: `src/chat/agents.ts` (`ChatPhase`, `ChatAgentInput`, `runChatAgent`), `src/chat/orchestrator.ts:259,265`, `src/chat/writer.ts:124`
- Test: `tests/unit/phases.test.ts`, `tests/unit/judges-run.test.ts`, `tests/unit/chat-orchestrator.test.ts`, plus whichever stage tests assert `--model`

**Interfaces:**
- Consumes: `stepModel`, `withModels`, `ModelRef`, `StepKey` from Task 1.
- Produces:
  - `AgentPhaseSpec.model?: ModelRef`. It overrides the step table, and only the cheaper judge sets it (`model: "default"`). Every other spec drops `model`.
  - `StepContext.models(): Promise<Config>` returns `withModels(this.cfg, await loadConfig(this.root))`. If the load throws, it returns `this.cfg` and calls `this.trace.eventOnChange("_loop", "error", <key>, { where: "models", error }, "error")` once per distinct error.
  - `phaseModel(ctx: StepContext, spec: Pick<AgentPhaseSpec, "name" | "model">): Promise<{ ref: ModelRef; name: string }>` in `src/phases.ts`.
  - `ChatPhase = Extract<StepKey, "orchestrator" | "write-intent">`. `ChatAgentInput` loses `model`, and `runChatAgent` uses `modelFor(o.cfg, stepModel(o.cfg, o.name))`. Chat already loads the config on every message (`orchestrator.ts:199`), which is fresh enough.

- [ ] **Step 1: Write the failing tests.**
  - `phases.test.ts` › "a setting saved mid-step reaches the next session". Build a `StepContext` on a temp repo with `stages.verify.steps.done-check` unset. Rewrite `loopstra/config.yaml` to set it to `max` and `claude.models.max: claude-fable-5-1`. Expect `await phaseModel(ctx, { name: "done-check" })` to equal `{ ref: "max", name: "claude-fable-5-1" }` while `ctx.cfg` still says otherwise.
  - `phases.test.ts` › "a config that stops loading mid-tick keeps the tick's models". Write `stages.design.steps.intak: max` to the file. Expect `phaseModel(ctx, { name: "intake" })` to equal `{ ref: "cheap", name: "haiku" }`. Expect one `error` event with `where: "models"`. Call it twice and still expect only one such event.
  - `phases.test.ts` › "the override wins". Expect `phaseModel(ctx, { name: "spec-check", model: "default" })` to give `ref` `"default"`.
  - Using the fake claude's recorded args (as the existing phase tests do), assert that a `lessons` session runs with `--model haiku` under defaults, and with `--model sonnet` after `stages.verify.steps.lessons: default` is written to the file.
  - `judges-run.test.ts` › "a judge on max gets no cheaper judge". Set `speed.cheap_judges: shadow` and `stages.design.steps.spec-check: max`. Expect one session (no `-cheap` trace row), and expect `notComparable` text containing "already runs on fable".
  - `chat-orchestrator.test.ts` › "write-intent follows chat.steps". Set `chat.steps.write-intent: cheap`. Expect the writer session's `--model` to be `haiku`.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/phases.test.ts tests/unit/judges-run.test.ts tests/unit/chat-orchestrator.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `attempt`, call `const m = await phaseModel(ctx, spec)` once, before `startPhase`. Use `m.name` for `--model`, for `AssistantUnavailable`'s `model` and for `assistantReached`.
  - `planKey` and `reviewKey` become async and use `(await phaseModel(ctx, phase)).name`. Await them at their call sites.
  - `judgeModel(cfg, judge)` becomes `stepModel(cfg, judge)`. `comparison` uses `(await phaseModel(ctx, phase))` for both the `!== "strong"` test and `strong_model`.
  - Remove `model:` from every listed stage spec, keeping `skills` from `ctx.cfg.stages.x`.
  - Find out whether Claude Code accepts `--resume <id>` with a different `--model`. Check the CLI docs first. If they say nothing, run one cheap session: start on haiku, then resume on sonnet. If it is accepted, `fix`, `reconcile` and `revise` keep resuming the build's session (`buildSession` in `src/stages/shared.ts`). If it is refused, they start a fresh session whenever their model differs from the build's. Add a test for whichever behavior applies. Note the finding for Task 9's decisions entry.

- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expected: PASS.

- [ ] **Step 5: Run `bun run check`.** Expected: all pass. Fix any stage tests that built specs with `model:` by removing it.

- [ ] **Step 6: Commit**: `git commit -am "feat(models): each session's model comes from the step table, read fresh"` (add the new test files if any).

---

### Task 3: A model name Claude Code does not accept is its own failure, not an outage

**Files:**
- Modify: `src/claude.ts` (`FailureReason`, its doc comment, and classification near lines 112–145 and 555–575)
- Modify: `src/phases.ts` (`ownerNote` and `attempt`'s failure branch). Make sure `"model"` is not in `RETRIED`.
- Modify: `src/models.ts` (`badModelNote`)
- Modify: `src/chat/orchestrator.ts` (the failed-turn reply)
- Test: `tests/unit/claude-classify.test.ts`, `tests/unit/phases.test.ts`, `tests/unit/chat-orchestrator.test.ts`

**Interfaces:**
- Produces:
  - `FailureReason` gains `"model"`, and `unavailable("model") === false`.
  - `MODEL_PATTERN = /issue with the selected model|model[_ ]not[_ ]found|not_found_error[^\n]*model/i`. It is matched like the environment patterns (error result text always, stderr only when the session never answered), and checked before them.
  - `badModelNote(ref: ModelRef, name: string, step: StepKey): string` gives exactly: ``"`" + ref + "` is `" + name + "`, which Claude Code does not accept as a model (step " + step + "). Change it in Settings or `loopstra setup models`, then retry."``
  - `ownerNote("model")` gives the general form: "Claude Code did not accept this step's model. Change it in Settings or `loopstra setup models`, then retry."

- [ ] **Step 1: Write the failing tests.**
  - `claude-classify.test.ts` › "a bad model name is reason model". An error result with text `There's an issue with the selected model (opuss). It may not exist or you may not have access to it.` classifies as `model`, and `unavailable("model")` is false.
  - `phases.test.ts` › "a bad model blocks the step with words that name it". Use a fake-claude fixture that answers the error result above, with `claude.models.strong: opuss`. A `spec-check` phase returns `{ ok: false, reason: "model" }` with note `` `strong` is `opuss`, which Claude Code does not accept as a model (step spec-check). Change it in Settings or `loopstra setup models`, then retry. ``. It is not retried (one session row), and no pause is written.
  - `chat-orchestrator.test.ts` › "a bad orchestrator model is said in chat". Set `chat.model: strong` and `claude.models.strong: opuss`. The reply to the person is `badModelNote("strong", "opuss", "orchestrator")`.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/claude-classify.test.ts tests/unit/phases.test.ts tests/unit/chat-orchestrator.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the reason, the pattern, `badModelNote` and its use in `attempt` (the note when `out.reason === "model"`) and in the orchestrator's failed turn. Add a fixture `tests/fake-claude/fixtures/bad-model.jsonl` if no existing one fits.

- [ ] **Step 4: Run the tests and see them pass.** Expected: PASS.

- [ ] **Step 5: Run `bun run check`, then commit**: `git commit -am "feat(models): a model Claude Code does not accept blocks the step with plain words"` (include the new fixture).

---

### Task 4: Record which model each named model actually ran on

**Files:**
- Modify: `src/claude.ts` (`Collected.models`, built in `finish()`)
- Modify: `src/trace.ts` (a `model_runs` table in `SCHEMA`, `recordModelRun`, `lastModelRuns`)
- Modify: `src/sessions.ts` (`TracedSession.ref?: ModelRef`, recorded when the session ends)
- Modify: `src/phases.ts` (`attempt` passes `ref: m.ref`), `src/chat/agents.ts` (passes `ref`)
- Test: `tests/unit/claude-parse.test.ts`, `tests/unit/trace.test.ts`, `tests/unit/sessions.test.ts`

**Interfaces:**
- Produces:
  - `Collected.models: string[]`: the init event's `model` first, then the keys of the result event's `modelUsage` object, without duplicates. Each value is checked to be a string, since the CLI's shape is not trusted.
  - Table: `CREATE TABLE IF NOT EXISTS model_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, asked TEXT NOT NULL, ran TEXT, result TEXT NOT NULL, slug TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL); CREATE INDEX IF NOT EXISTS model_runs_ref ON model_runs (ref, id);`. It is a new table, so no migration is needed.
  - `interface ModelRun { ref: ModelRef; asked: string; ran: string | null; result: "ok" | "bad-model"; slug: string; seq: number; ts: string }`
  - `Trace.recordModelRun(r: Omit<ModelRun, "ts">): void`
  - `Trace.lastModelRuns(): Partial<Record<ModelRef, ModelRun>>`: the newest row per ref. Rows are written only when the session got through (`ok`) or failed with reason `model` (`bad-model`). Other failures say nothing about the model, so they are not written.

- [ ] **Step 1: Write the failing tests.**
  - `claude-parse.test.ts` › "the models a session ran on". With an init event `{ model: "claude-opus-5-5" }` and a result with `modelUsage: { "claude-opus-5-5": {...}, "claude-haiku-5-5": {...} }`, expect `["claude-opus-5-5", "claude-haiku-5-5"]`.
  - `trace.test.ts` › "the last run per named model". Record `strong` ok, then `strong` bad-model, then `cheap` ok. Expect `lastModelRuns().strong.result` to be `"bad-model"`, `cheap.ran` to be the recorded name, and `max` to be undefined.
  - `sessions.test.ts` › "a traced session with a ref records its run". A successful fake session with `ref: "default"` and `run.model: "sonnet"` writes one `model_runs` row, `{ ref: "default", asked: "sonnet", ran: <init model>, result: "ok" }`. A `crash` failure writes none.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/claude-parse.test.ts tests/unit/trace.test.ts tests/unit/sessions.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** as specified. `ran` is `models[0] ?? null`.

- [ ] **Step 4: Run the tests and see them pass, run `bun run check`, then commit**: `git commit -am "feat(models): record the model each named model actually ran on"`

---

### Task 5: Setup asks for max and, when asked, each step's model

**Files:**
- Modify: `src/setup/sections/models.ts`
- Modify: `src/setup/document.ts` (public `unset(path)`, used here and in Task 6)
- Test: `tests/unit/setup-models.test.ts` (update the answer lists of the existing tests for the new questions)

**Interfaces:**
- Consumes: `MODEL_REFS`, `STAGE_NAMES`, `stepsOf`, `ownStepModel`, `StepGroup` from Task 1.
- Produces: `ConfigDocument.unset(path: Path): void` removes the key if present, and also removes a parent `steps` map that is left empty. It marks the document dirty.

The question order (this is the answer order in tests):
1. The intro line. It adds: "An alias (haiku, sonnet, opus, fable) follows Claude Code to the newest model of its family; a full name like claude-opus-5-5 pins one."
2. The four named-model questions, in the order `cheap`, `default`, `strong`, `max`. *(Changed from today's default, cheap, strong: the order of cost.)*
3. For each of design, plan, build, review, verify: `Model for the <stage> stage` (pick from 4), then `Choose models for <stage>'s steps one by one?` (yesNo, suggestion false). On yes, for each step of that stage: `Model for <key> (<what>)`, picked from `["default", ...MODEL_REFS]`. The word "default" means the step's own setting is removed. The suggestion is the step's own setting, or "default".
4. `Model for chat's orchestrator` (pick from 4), then `Choose models for chat's steps one by one?` (it asks only `write-intent`).
5. `covers` becomes `["claude.models", "stages.*.model", "stages.*.steps", "chat.model", "chat.steps"]`.

- [ ] **Step 1: Write the failing tests.**
  - "names the four models and picks one for each stage and chat". Answers: `["", "", "claude-opus-5-5", "", "", "", "", "", "strong", "", "", "", "", "", "cheap", ""]`. Expect `claude.models` to be `{ strong: "claude-opus-5-5" }`, `stages` to be `{ build: { model: "strong" } }` and `chat` to be `{ model: "cheap" }`. Nothing is written under `steps`.
  - "steps one by one". Answer yes for verify, then `max` for done-check and `default` for the others. Expect `stages.verify.steps` to equal `{ "done-check": "max" }`.
  - "run again, it suggests what the config says". Start from a config with `stages.verify.steps.done-check: max`. `--defaults` (via `DefaultsPrompt`) leaves the file's `steps` unchanged.
  - "default removes a step's own setting". With `done-check: max` in the file, answer yes for verify and `default` for done-check. `stages.verify` no longer has `steps`.
  - "--defaults never picks max". From `BASE`, run with defaults. The saved text does not contain `max:` except under `claude.models` (and only if it was already written there).

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/setup-models.test.ts tests/unit/setup-document.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add a `setup-document.test.ts` case for `unset`: the key is removed, the comments around it stay, and an emptied `steps` map goes.

- [ ] **Step 4: Run the tests and see them pass. Run `bun run check`, including `tests/integration/setup.test.ts`, whose answer lists may also need the new questions.**

- [ ] **Step 5: Commit**: `git commit -am "feat(setup): the max model and each step's model in setup models"`

---

### Task 6: A `settings` request the loop applies and commits

**Files:**
- Create: `src/settings.ts`
- Modify: `src/setup/document.ts` (`static fromText(path: string, text: string): ConfigDocument`, sharing `load`'s parsing and CRLF detection)
- Modify: `src/record-draft.ts` (`RecordDraft` takes an optional `paths`)
- Modify: `src/context.ts` (`commitRecord` `opts.paths`, and `landed`'s `paths` parameter)
- Modify: `src/actions.ts` (`REQUEST_KINDS` gains `"settings"`), `src/requests.ts` (schema), `src/apply.ts` (`applyOne`, `anyLanded`, every `req.slug` use that assumes a change)
- Test: `tests/unit/settings.test.ts` (new), `tests/unit/apply.test.ts`, `tests/unit/record-draft.test.ts`, `tests/unit/records.test.ts`

**Interfaces:**
- Produces (`src/settings.ts`):
  - `CONFIG_REL = "loopstra/config.yaml"`, `SETTINGS_SLUG = "_settings"` (used for the trace and record marker only)
  - `configVersion(text: string): string`: the sha256 hex of the file's text
  - `settingPath(dotted: string): string[] | null`: the path if it is one of the writable paths in Global Constraints, else null
  - `settingProblem(path: string[], value: string | null): string | null`. A named model needs a string with no spaces (the existing message). The others need one of `MODEL_REFS`. `null` is allowed only under `steps`.
  - `applySetting(file: string, text: string, path: string[], value: string | null): { ok: true; text: string } | { ok: false; problem: string }`. It uses `ConfigDocument.fromText(file, text)`, then `unset` for null or set otherwise, then `validate()`. A `ConfigError` gives its message as `problem`.
- Produces (`src/context.ts`): `commitRecord(..., opts: { request?: string; trace?: Trace; paths?: string[] })`. When `paths` is given, the record's paths are exactly those (instead of `intent/<slug>` and `intent/queue.md`), and its draft may write only those. `landed(root, main, id, slug, since?, paths = [`intent/${slug}`])`.
- Produces (`src/requests.ts`): kind `settings`: `{ kind: "settings", path: string, value: string | null, version: string }`.
- `applySettings(root, cfg, trace, req)` in `src/apply.ts`:
  1. If `landed(root, main, req.id, SETTINGS_SLUG, req.at, [CONFIG_REL])`, it is done.
  2. If the main checkout's `loopstra/config.yaml` differs from main's (`git diff --quiet HEAD -- loopstra/config.yaml` fails), refuse with: "loopstra/config.yaml has changes in the main checkout that are not committed. Commit or undo them first, then change the setting again."
  3. Otherwise, `commitRecord(root, main, SETTINGS_SLUG, "<path> → <value ?? 'default'> by <byWhom>", write, { request: req.id, trace, paths: [CONFIG_REL] })`. `write` reads `CONFIG_REL` from the draft and refuses on a `configVersion` mismatch or an `applySetting` problem (returning false). Otherwise it writes the new text.
  4. Results:
     - ok: "Saved: <path> is now <value ?? 'its default'>. Sessions that start from now on use it."
     - stale: "The settings changed since the page read them (in a terminal, or another tab), so nothing changed. The page shows them as they are now."
     - problem: "That setting was not saved: <problem>"
     - Every result has `status: null` and is traced under `_loop` as `request` with `result`.

- [ ] **Step 1: Write the failing tests.**
  - `settings.test.ts`:
    - `settingPath` accepts `"stages.verify.steps.done-check"`, `"chat.steps.write-intent"`, `"claude.models.max"` and `"chat.model"`.
    - It refuses `"stages.verify.steps.intake"`, `"chat.steps.orchestrator"`, `"claude.timeout_minutes"` and `"stages.build.max_fix_loops"`.
    - `settingProblem(["claude","models","strong"], "claude opus")` gives the no-spaces message. `settingProblem(["stages","build","model"], null)` is not null.
    - `applySetting` on `templates/config.yaml`'s text (flow-style stages) with `stages.design.steps.intake = "max"` gives text that `validateConfig(parse(...))` loads, with `stepModel` giving `"max"`. The template's comment lines are all still present.
    - `applySetting` with `claude.models.strong = "opus[1m]"` loads back as `"opus[1m]"`.
  - `apply.test.ts`:
    - "a settings request lands as one commit". The main `HEAD` subject is `loopstra(_settings): stages.verify.steps.done-check → max by …` with a `Loopstra-Request:` trailer. Only `loopstra/config.yaml` changed. The result is ok.
    - "a settings request with an old version is refused". Nothing is committed and the result text is the stale sentence.
    - "uncommitted config edits are never committed by a setting". Write a hand edit to `loopstra/config.yaml` without committing. The request is refused with the sentence above, and the file still holds the hand edit.
    - "a settings request killed after landing is finished as applied". Use the existing `landed` pattern in `apply.test.ts`.
  - `record-draft.test.ts`: a draft with `paths: ["loopstra/config.yaml"]` may write that path and throws for `intent/x/intent.md`.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/settings.test.ts tests/unit/apply.test.ts tests/unit/record-draft.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `apply.ts`, `"slug" in req` already guards most trace calls. Make `anyLanded` and `finishLanded` handle `settings` explicitly, and leave other kinds unchanged. Remote sync needs no change: a conflict on `loopstra/config.yaml` while replaying is reported as a clash, as any non-`intent/` conflict is today.

- [ ] **Step 4: Run the tests and see them pass. Run `bun run check`, including `tests/integration/remote.test.ts` and `lanes-remote.test.ts`, which cover records.**

- [ ] **Step 5: Commit**: `git commit -am "feat(settings): a settings request the loop applies to config.yaml as one commit"` (add `src/settings.ts` and the new test).

---

### Task 7: The console's settings API

**Files:**
- Create: `src/console/settings.ts`
- Modify: `src/console/types.ts` (`SettingsView`), `src/console/server.ts` (the `/settings` page route and the `GET /api/settings` data route), `src/console/writes.ts` (`parse` and `action` for kind `settings`)
- Test: `tests/unit/console-server.test.ts`, `tests/unit/console-settings.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1, 4 and 6.
- Produces (`src/console/types.ts`):

```ts
export interface SettingsView {
  version: string | null;           // configVersion of the file; null when it cannot be read
  problem: string | null;           // why the config does not load; the page shows this instead of pickers
  models: Array<{ ref: ModelRef; name: string; last: { ran: string | null; result: "ok" | "bad-model"; ts: string } | null }>;
  groups: Array<{
    group: StepGroup; model: ModelRef; path: string;  // path: "stages.design.model" or "chat.model"
    steps: Array<{ key: StepKey; what: string; path: string | null; own: ModelRef | null; effective: ModelRef; byDefault: string }>;
  }>;
}
```

  - `path` is null for `orchestrator`, which is the group's own picker.
  - `byDefault` is the muted text: `"follows build: default"` for a step that follows a group, or `"strong"` for a fixed one.
  - `settingsView(root: string, trace: Trace): Promise<SettingsView>` in `src/console/settings.ts`.
  - `parse` in `writes.ts` checks `kind === "settings"` before the slug check:
    - `path` must pass `settingPath`, else 400 "That is not a setting the console can change."
    - `value` must pass `settingProblem`, else 400 with the problem.
    - `version` must be a string.
  - `action` for settings:
    - If the current file's `configVersion` differs from `version`, refuse with 409 and the stale sentence from Task 6.
    - Otherwise call `submitRequest` and answer `{ id, loop }` with 202, as other actions do.

- [ ] **Step 1: Write the failing tests.**
  - `console-settings.test.ts`:
    - Under defaults the view has four models, in the order cheap, default, strong, max.
    - It has six groups, design…verify then chat.
    - `done-check` has `own: null`, `effective: "strong"` and `byDefault: "strong"`.
    - `revise` has `byDefault: "follows build: default"`.
    - After `recordModelRun` for strong, `models[2].last.ran` is that name.
    - A broken config gives a non-null `problem` and no groups.
  - `console-server.test.ts`:
    - `GET /api/settings` is 200 with a `version`.
    - A `POST /api/requests` of `{ kind: "settings", path: "stages.verify.steps.done-check", value: "max", version }` with the page's Origin is 202 and leaves a request file of kind settings.
    - The same POST with a stale `version` is 409. With `path: "claude.timeout_minutes"` it is 400. Without Origin it is 403.
    - `GET /settings` serves the page.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/console-settings.test.ts tests/unit/console-server.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Read the file once per view, parsing it with `validateConfig(parse(text))` so the view's `version` and values come from the same text.

- [ ] **Step 4: Run the tests and see them pass, run `bun run check`, then commit**: `git commit -am "feat(console): the settings view and settings requests"`

---

### Task 8: The Settings page

**Files:**
- Create: `src/ui/views/Settings.tsx`, `src/ui/settings.ts` (pure helpers)
- Modify: `src/ui/router.ts` (`{ name: "settings" }`), `src/ui/app.tsx` (render it), `src/ui/parts/Rail.tsx` (an entry after Spend: `{ href: "/settings", label: "Settings", icon: "settings", on: ["settings"] }`), `src/ui/parts/Icon.tsx` (a `settings` glyph in the style of the others), `src/ui/requests.ts` (export `sendSetting`), `src/ui/theme.css` (only if existing classes do not cover it; use existing tokens)
- Test: `tests/unit/ui-logic.test.ts`

**Interfaces:**
- Consumes: `SettingsView` from Task 7.
- Produces:
  - `sendSetting(body: { kind: "settings"; path: string; value: string | null; version: string }, onDone: (d: { ok: boolean; text: string }) => void): Promise<{ ok: true; id: string; loop: string } | { ok: false; error: string }>` in `src/ui/requests.ts`, built on the file's existing `post` and `follow`.
  - `cancelSetting(id: string): Promise<boolean>`, which reuses `cancel`.
  - In `src/ui/settings.ts`:
    - `pickerChoices(row: { path: string | null; own: ModelRef | null }): Array<{ value: string | null; label: string }>`: for a step row, `Default` (null) first, then the four refs; for a group or named model, the four refs only.
    - `pendingText(loop: string): string`: "Saved when the loop next runs." when `loop` is `stopped` or `not-responding`, else "Saving…".

Page behavior (the spec's "The console's Settings page"):
- **Named models section.** Each row has a text input with the current name. It is sent on Enter or blur when changed, and checked with the no-spaces rule before sending. Each row also shows *last ran on* as `<name> → <ran>, <relative time>`, `failed: not a model`, or `not used yet`.
- **Stages section.** It has six groups. Each group has its own picker: the stage model, or for chat "Orchestrator". Below it, the step rows, where a step without its own setting shows `byDefault` in muted text.
- **One change at a time.** While a request is pending, every picker and input is disabled. The pending row shows `pendingText(loop)` and a Cancel button that calls `cancelSetting`. When the result arrives, the page shows it as a toast (ok in info, refused in bad), then re-reads `/api/settings`, so the next change carries the new version. A refused change puts the picker back.
- **The explanation line** under the heading: "Changes apply to sessions that start after they are saved; a session already running finishes on its model."
- `max` appears in every picker and is never preselected.
- **A config problem:** if `problem` is set, the page shows it in a callout instead of the pickers.

- [ ] **Step 1: Write the failing tests** in `ui-logic.test.ts`:
  - `parseRoute("/settings")` gives `{ name: "settings" }`, and `routePath` gives it back.
  - `pickerChoices({ path: "stages.verify.steps.lessons", own: null })` has labels `["Default", "cheap", "default", "strong", "max"]`, and the group form has the four refs.
  - `pendingText("stopped")` and `pendingText("running")` give the two strings above.

- [ ] **Step 2: Run them and see them fail.** Run `bun test tests/unit/ui-logic.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the helpers, the route, the Rail entry, the icon, `sendSetting`/`cancelSetting` and `Settings.tsx`. Follow `Spend.tsx` for loading and failure, and `theme.css` tokens for the look.

- [ ] **Step 4: Run the tests and see them pass, then run `bun run check`.**

- [ ] **Step 5: Check it in a browser (Review Focus 4 and 5).**
  1. Seed a demo repo the way the console memory describes. Run `bun src/cli.ts ui --port 4747 --no-chat` from it, with no loop running.
  2. Pick `max` for done-check. The row shows "Saved when the loop next runs." with Cancel, and the other pickers are disabled. Cancel it, and everything comes back.
  3. Start `bun src/cli.ts start` in the demo repo. Pick `max` for done-check, then `default` for lessons right after the first confirms. Both land as two commits (`git log --oneline -2`).
  4. Light and dark both read well.
  5. Use the `run` skill if available.

- [ ] **Step 6: Commit**: `git commit -am "feat(console): the Settings page for every step's model"` (add the new files).

---

### Task 9: Docs, template and decisions

**Files:**
- Modify: `templates/config.yaml`:
  - `claude.models` gains `max: fable`, with a comment: "aliases follow Claude Code's newest model; a full name pins one".
  - A commented example under `stages:`: `# steps: { done-check: max }  # a step's own model; see the step table in the README`.
  - The `chat.model` comment becomes "the orchestrator; write-intent: chat.steps (default: stages.design.model)".
- Modify: `README.md`:
  - The `claude` line (around 301) lists the four models and how to pin them.
  - Add a "Models for each step" paragraph with the step table: key, stage, default.
  - Explain the Settings page, and that saves become commits by the loop.
  - Mention that `ANTHROPIC_DEFAULT_*_MODEL` variables still apply.
  - The setup paragraph (around 308) mentions steps.
- Modify: `docs/decisions.md`. Add one entry per decision, in the file's existing format: aliases rather than ids; four fixed named models; `max` never a default; the step table in one place; console saves through a request; model settings read fresh per session; one change at a time with a version check; no cheaper judge for a judge on `max`; resume across models (record what Task 2 found about `--resume` with another `--model`).
- Test: `tests/unit/templates.test.ts` and `tests/unit/templates-roundtrip.test.ts` keep passing. Add one assertion: the template loads, and no step resolves to `max`.

- [ ] **Step 1: Write the template assertion and see it fail.** Run `bun test tests/unit/templates.test.ts`. Expected: FAIL (`max` is missing from the template's models).
- [ ] **Step 2: Edit the template, README and decisions.**
- [ ] **Step 3: Run `bun run check`.** Expected: all pass. Also check that the upgrade tests still pass (`tests/unit/upgrade-*.test.ts`), since they compare templates.
- [ ] **Step 4: Commit**: `git commit -am "docs: models for every step"`
