# Risky changes, retro, and acceptance tests: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three features: a merge gate that brings in a person for risky diffs, a `loopstra retro` report over the trace, and acceptance tests written from Done when before each build.

**Architecture:** The three parts are independent and are built in parallel, each in its own worktree branched from `feat/risk-retro-acceptance`, then merged back. Part A (risk) changes the merge gate and the readers of a change's merge gate. Part B (retro) is a new read-only command over new Trace read methods. Part C (acceptance) adds a step to the build stage, a hook rule and a done-check variable.

**Tech Stack:** Bun, TypeScript (strict), zod, bun:sqlite, bun:test, the fake `claude` and `gh` in `tests/`.

**Spec:** `docs/superpowers/specs/2026-10-27-risk-retro-acceptance-design.md`. Read it first; this plan does not repeat its wording rules or copy.

## Global Constraints

- Read `CLAUDE.md` and `docs/architecture.md` (layers, rules, TypeScript practices) before coding. Respect the layer order: a module imports only from its layer or below.
- `bun run check` (typecheck, lint, deadcode, tests) must pass before the part is done. During development run single test files: `bun test tests/unit/<file>.test.ts`.
- Text a person reads is plain sentences: no stack traces, no raw commands. Owner notes never name branches except where the spec says.
- Every new JSON or frontmatter shape is a zod schema; types come from `z.infer`.
- Comments match the codebase: a short doc comment on each exported function saying what it is for, in plain words.
- No new dependencies.
- Each part adds its own README text and its own section to `docs/decisions.md` (append at the end, heading `## <Part name> (2026-10-27)`), plus the template/skill text the spec lists for it.
- Commit in small steps on your part's branch with messages like `feat(risk): ...`, each ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run `npm publish` or touch release files; `package.json` stays `0.0.0-dev`.

## Review Focus

1. A risky change merged by the PR watcher before `merge_gate` is visible: the watcher reads the change's frontmatter fresh each look (ctx.intent), so the field must be written in the same record as the move to merge-review. Test: after passMergeGate on a risky change with `human: none` and a remote, one more merge step does not merge an unapproved PR.
2. Paths with spaces, non-ASCII names, renames (`old => new` in numstat) in the risk diff. Use `-z` output; test a renamed file into a risky path counts as risky.
3. `loopstra retro` on an empty or brand-new trace, and on a trace that has only `_chat` rows: prints the empty-window text, exits 0.
4. Acceptance step on a resumed build (status `building`, marker present): must not run twice. Test with the fake claude call log.
5. The hook on Windows paths (backslashes, case) for acceptance files: reuse the hook's existing `slashes`/`same` helpers; test a backslash path is refused.

---

## Part A: Risky changes need a person (branch `feat/risk-gate`)

### Task A1: Config and risk scoring

**Files:**
- Modify: `src/config.ts` (gates.merge gains `risky`)
- Create: `src/risk.ts` (layer 2-3: imports `git.ts` and `config.ts` types only)
- Test: `tests/unit/risk.test.ts`, `tests/unit/config.test.ts`

**Interfaces:**
- Produces:
  - `gates.merge.risky: { paths: string[]; lines?: number; human: "status" | "pr" }` in `Config` (defaults `[]`, unset, `"pr"`).
  - `export interface Risk { risky: boolean; files: string[]; lines: number; overLines: boolean }`
  - `export function riskySet(cfg: Config): boolean` — true when `paths` is non-empty or `lines` is set.
  - `export async function scoreRisk(wt: Git, main: string, cfg: Config): Promise<Risk>` — numstat `-z` of `main...HEAD` in the worktree, files outside `intent/`, Bun.Glob match on each path (for renames, the new path), binary lines count 0.
  - `export function riskEvidence(r: Risk): string` (gate row evidence: up to 10 files, then "and N more"; adds "N lines changed (over L)" when overLines).
  - `export function riskNote(r: Risk, human: "status" | "pr"): string` (spec's note; at most 3 names then "and N more").

- [ ] Step 1: Config tests: `risky` defaults; `paths: [""]` → problem at `gates.merge.risky.paths.0`; `lines: 0` → problem; `human: none` → problem; unknown key under risky → unknown-key problem.
- [ ] Step 2: Risk tests in a throwaway repo (see `tests/helpers.ts` for repo helpers): no settings → not risky; `.github/**` matches `.github/workflows/ci.yml`; `package.json` matches only at top; `**/migrations/**` matches `db/migrations/1.sql`; `intent/x/intent.md` never counts; `lines: 5` with 6 changed lines → overLines; a binary file adds 0; a rename into `.github/` counts; a path with a space and one with `é` match.
- [ ] Step 3: Implement; run `bun test tests/unit/risk.test.ts tests/unit/config.test.ts` → pass. Commit.

### Task A2: The effective merge gate everywhere

**Files:**
- Modify: `src/intents.ts` (Frontmatter gains `merge_gate`, BLANK_LEFT_OUT gains it; helper), `src/actions.ts`, `src/attention.ts`, `src/stages/plan.ts`, any console reader that takes `human.merge` for one change (`src/console/model.ts`, `src/console/detail.ts` via `changeSummary`), `src/chat/orchestrator.ts` and `src/console/writes.ts` (they call `offers`)
- Test: `tests/unit/intents-frontmatter.test.ts`, `tests/unit/actions.test.ts`, `tests/unit/intents-queue.test.ts`, `tests/unit/status.test.ts` as fits

**Interfaces:**
- Produces:
  - Frontmatter `merge_gate: "status" | "pr" | undefined` (blank or absent reads as undefined; anything else is a frontmatter problem).
  - `export function changeGates(human: HumanGates, fm: Frontmatter): HumanGates` in `src/intents.ts` — `human` with `merge` replaced by `fm.merge_gate` when `human.merge === "none"` and the field is set.
  - `waitsForPerson`, `isRunnable`, `offers`, `personReviews` apply `changeGates` themselves (their signatures do not change), so every caller gets the per-change gate.
  - `mayMergeFirst(cfg, fm)` in plan.ts takes the frontmatter.

- [ ] Step 1: Tests: a `merge-review` change with `merge_gate: pr` and config `none` waits for a person, is not runnable without a remote, is offered Approve; without the field it is not waiting; config `status` with `merge_gate: pr` keeps `status`.
- [ ] Step 2: Implement; run the touched test files → pass. Commit.

### Task A3: The merge stage decides and records

**Files:**
- Modify: `src/stages/merge.ts`, `src/context.ts` only if `setStatus` needs a way to patch `merge_gate` in the same record (add an optional `fields` patch to `statusPatch`/`setStatus` rather than a second record)
- Test: `tests/unit/stages-review-merge.test.ts` (or a new `tests/integration/risk-gate.test.ts` following the integration tests' style)

**Interfaces:**
- Consumes: `scoreRisk`, `riskySet`, `riskEvidence`, `riskNote` (A1); `changeGates` (A2).
- Produces: `function mergeHuman(ctx: StepContext, hasRemote: boolean): "none" | "status" | "pr"` (private): `changeGates(humanGates(ctx.cfg), ctx.intent.file.frontmatter).merge`, with `pr` read as `status` when there is no remote and the gate came from `merge_gate`.

- [ ] Step 1: Tests: (a) remote, config none, risky change → status merge-review, `merge_gate: pr`, note per spec, gate row `merge/risk waiting`; a following merge step with checks passing and PR not approved waits; after approval it merges. (b) Same, not risky → no field, gate row `pass "nothing risky"`, merges on checks. (c) No remote, risky, `human: pr` → merge-review, `merge_gate: pr` acting as status: waits until merge-approved, then merges. (d) Config `status` + risky → gate row only, no field. (e) A change sent back and rebuilt without risky files → the field is removed at its next pass.
- [ ] Step 2: Implement in `passMergeGate` (score in the worktree after the checks pass; write the field and note in the same record as the status), and replace each `ctx.cfg.gates.merge.human` read in merge.ts with `mergeHuman`.
- [ ] Step 3: Run the stage tests and `tests/integration` files that touch merging → pass. Commit.

### Task A4: Setup and docs

**Files:**
- Modify: `src/setup/sections/github.ts` (ask for risky paths when `human` ends up `none`), `src/setup/defaults.ts` if it holds the defaults, `templates/config.yaml` (a commented `risky:` example under gates), README (GitHub, Configuration, When something needs a person), `templates/intent-README.md` (what `merge_gate` means), `docs/decisions.md`
- Test: `tests/unit/setup-github.test.ts`

- [ ] Step 1: Tests: with `human: none`, the question is asked with the suggestion built from the files present (a repo with `package.json` and `go.mod` → `.github/**, **/migrations/**, package.json, go.mod`); Enter writes the list; `-` writes nothing; with `human: status` it is not asked.
- [ ] Step 2: Implement; run → pass. Docs. Commit.

---

## Part B: `loopstra retro` (branch `feat/retro`)

### Task B1: Trace reads

**Files:**
- Modify: `src/trace.ts`
- Test: `tests/unit/trace.test.ts`

**Interfaces:**
- Produces:
  - `statusChangesSince(since: string): Array<{ slug: string; ts: string; from: string; to: string; note: string }>` (all slugs except `_chat`, oldest first; payload parsed through a zod schema)
  - `eventsOfTypeSince(type: EventType, since: string): EventRow[]`
  - `gatesSince(since: string): Array<{ slug: string; gate: string; check: string; result: string; ts: string }>`
  - `phasesSince(since: string): PhaseRow[]` (started at or after `since`)

- [ ] Step 1: Tests seed a Trace in a temp dir and check each method's filtering and order. Step 2: implement. Step 3: run → pass. Commit.

### Task B2: The report

**Files:**
- Create: `src/retro.ts` (pure: builds a `Retro` from rows, config and judge report; no I/O), `src/commands/retro.ts` (opens trace and config, renders text)
- Modify: `src/cli.ts` (command `retro`, `--days N`, usage line, help line "retro     how the loop did lately, and what to change"), `src/context.ts`/stage files only to export the note constants retro classifies by
- Test: `tests/unit/retro.test.ts`, `tests/unit/cli.test.ts`

**Interfaces:**
- Produces:
  - `export type BlockKind = "timeout" | "crash" | "tests" | "review" | "verify" | "budget" | "conflicts" | "pr-checks" | "pr-closed" | "unmet" | "questions" | "other"`
  - `export function blockKind(note: string): BlockKind` — by `includes` of exported note constants.
  - `export function buildRetro(input: { since: string; now: Date; cfg: Config; changes: ...; blocks: ...; gates: ...; phases: PhaseRow[]; judges: JudgeReport; questions: EventRow[] }): Retro`
  - `export function retroText(r: Retro): string`
  - `export function suggestions(r: RetroFacts, cfg: Config): string[]` with the spec's rules and named threshold constants.
  - `export async function renderRetro(root: string, days: number): Promise<string>` in `src/commands/retro.ts`.

- [ ] Step 1: Tests for `blockKind` on each real note constant and an unknown note.
- [ ] Step 2: Tests for `buildRetro` on seeded rows: counts, block grouping order, first-try pass rate per gate check, median accepted→merged, phase name folding (`fix-2`→fix, `early-review`→review, `spec-check-cheap`→spec-check), chat cost on its own line, person waits median.
- [ ] Step 3: Tests for each suggestion rule firing and not firing at its threshold; "No suggestions" text; empty window text.
- [ ] Step 4: CLI test: `retro --days 0` is a usage error; `retro --days 3` in a set-up repo prints the header "The last 3 days"; outside a set-up repo says NOT_SET_UP.
- [ ] Step 5: Implement; run → pass. Commit.

### Task B3: Docs

- [ ] README Watch (`loopstra retro`), `templates/skill/SKILL.md` (read how the loop is doing with `loopstra retro`), `docs/decisions.md`. Commit.

---

## Part C: Acceptance tests (branch `feat/acceptance-tests`)

### Task C1: Config, step, envelope, prompt

**Files:**
- Modify: `src/config.ts` (`stages.build.acceptance_tests: boolean`, default false), `src/models.ts` (STEP_KEYS + STEPS entry `acceptance`, group build, "writes tests from Done when before the build", follows build; place after `plan-challenge`), `src/envelopes.ts` (`acceptance` envelope), `src/console/steerable.ts` (steerable), `templates/prompts/acceptance.md` (new), `templates/config.yaml` (`acceptance_tests: true` on the build line), `src/setup/sections/gates.ts` (the yes/no question, suggestion yes), anything that enumerates prompts or steps (`src/prompts.ts`, `src/shipped.ts`, `src/upgrade/*`, console settings page lists) — find them with `grep -rn '"reconcile"' src`
- Test: `tests/unit/config.test.ts`, `tests/unit/models.test.ts`, `tests/unit/envelopes.test.ts`, `tests/unit/setup-gates.test.ts`, `tests/unit/templates.test.ts`

**Interfaces:**
- Produces: `Envelopes.acceptance = base.extend({ commit_message: z.string(), tests: z.array(z.object({ criterion: z.string(), file: z.string(), test: z.string() })), not_testable: z.array(z.object({ criterion: z.string(), why: z.string() })) })`. Prompt variables: `done_when`, `spec`, `plan`, `test_command`, `conversation` (as work sessions get).

- [ ] Step 1: Tests: config default false and type error text; `stepModel(cfg, "acceptance")` follows build; envelope parses the spec's example; setup gates asks and writes `stages.build.acceptance_tests`; the shipped prompt renders with all its variables.
- [ ] Step 2: Implement; run → pass. Commit.

### Task C2: The hook

**Files:**
- Modify: `templates/hooks/loopstra-protect-tests.ts`
- Test: `tests/unit/hook.test.ts`

**Interfaces:**
- Consumes: env `LOOPSTRA_PHASE`, `LOOPSTRA_ACCEPTANCE` (JSON array of repo-relative paths; unreadable JSON reads as none).
- Behaviour: phase `acceptance` → refuse any path that is not a test path (message: "Loopstra: the acceptance step writes only tests and test fixtures (<path>)."). Phases `build`, `fix`, `reconcile`, `revise` → refuse a path in `LOOPSTRA_ACCEPTANCE` (logged to `LOOPSTRA_PROTECTED_LOG`; message per spec). The existing fix-phase rule is unchanged.

- [ ] Step 1: Tests for each rule, plus a backslash/case variant and malformed JSON. Step 2: implement. Step 3: run → pass. Commit.

### Task C3: The build runs the step and protects the files

**Files:**
- Modify: `src/stages/build.ts`, `src/stages/shared.ts` (marker name `ACCEPTANCE = "acceptance"`; `acceptanceFiles(ctx): string[]` reading it), `src/phases.ts` (env `LOOPSTRA_ACCEPTANCE` for every session from the marker; `protectedNote` words acceptance files per spec), `tests/fake-claude/fixtures/acceptance.jsonl` (writes `tests/accept.test.ts`, answers one test and one not-testable item)
- Test: `tests/unit/stages-build.test.ts`, `tests/unit/phases.test.ts`

**Interfaces:**
- Produces: `async function writeAcceptance(ctx, wt): Promise<void>` (private to build.ts): runs the phase, commits, writes the marker (JSON array of files), records `acceptance.md` via `writeArtifact`. `acceptance.md` is added to the artifacts the console lists (`ARTIFACTS` in `src/intents.ts`).

- [ ] Step 1: Tests: setting off → no acceptance call; on → the call happens before build (fake call log order), the commit `loopstra(<slug>): acceptance tests` is on the branch, `acceptance.md` on main matches the spec's layout, the build session's env has the file; a resumed build with the marker makes no second call; a new build from plan-approved clears and reruns; a failing acceptance session → trace error, acceptance.md says no tests were written, build goes on; drift leaves the acceptance file out (no reconcile call); a fix refused on the acceptance file blocks with the spec's note naming it.
- [ ] Step 2: Implement; run → pass. Commit.

### Task C4: Done-check reads acceptance.md

**Files:**
- Modify: `src/stages/verify.ts` (var `acceptance`; appended through `phasePrompt`'s missing-variable note when a customized prompt lacks it), `templates/prompts/done-check.md`
- Test: `tests/unit/stages-verify.test.ts`, `tests/unit/prompts.test.ts`

- [ ] Step 1: Tests: the done-check prompt contains the Covered list when acceptance.md exists, and "No acceptance tests were written for this change." when not; a customized done-check.md without the variable still gets the text. Step 2: implement. Step 3: run → pass. Commit.

### Task C5: Docs

- [ ] README (How it works, Configuration, the step table row `acceptance | build | the build stage's model`, Steering's list of work sessions), `templates/intent-README.md` (acceptance.md), `docs/decisions.md`. Commit.

---

## Integration (after the three parts)

- [ ] Merge `feat/risk-gate`, `feat/retro`, `feat/acceptance-tests` into `feat/risk-retro-acceptance`; resolve `docs/decisions.md`, README and `src/config.ts` conflicts.
- [ ] Retro's suggestions that name `gates.merge.risky` and `stages.build.acceptance_tests` work against the merged config (Part B writes them against those exact key names).
- [ ] `bun run check` → pass. `/code-review high`, fix, PR, CI green.
