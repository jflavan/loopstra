# Standards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a team write rules in `loopstra/standards/*.md` that every change is checked against at the spec, plan, review, merge and done gates, with exceptions only a person grants, per-change scope changes, tool checks, a console workflow, a setup section and an onboarding step.

**Architecture:** A new layer-3 module `src/standards.ts` parses standard files from a commit of `main` and a change's `intent/<slug>/standards.md` record (`src/standards-record.ts`). `StepContext` reads them once per step at `readCommit()`. Stages pass a `standards` prompt variable and add code checks to their gates, using the hooks that already exist (`ArtifactStage.checks`, `passMergeGate`, `testLoop`, the done-check envelope). The console and setup follow the Agents pattern: read-only views from the server, and writes as requests the loop commits.

**Tech Stack:** Bun 1.4.4+, TypeScript (strict), zod, `yaml`, Preact for the console, `bun test` via `bun run test`.

**Spec:** `docs/superpowers/specs/2026-10-28-standards-design.md`. Read it before any task. This plan names the files, signatures and tests; the spec has the wording of every note, prompt line and record.

## Global Constraints

- Repository without `loopstra/standards/`: prompts, headings, gate rows and records are byte-for-byte what they are today (golden test in Task 4).
- Text a person reads is plain sentences; owner notes copied verbatim from the spec.
- Every JSON file, request and front matter is parsed with zod; types come from `z.infer`.
- Every external process goes through `spawnBounded`/`runCommand`/`projectCommand` (bounded, killable).
- **Layers** (`docs/architecture.md`): a module imports only from its own layer or below.
  - `src/standards.ts` and `src/standards-record.ts` are layer 3, so they may import only from `text`, `ids`, `paths`, `fsutil`, `stop`, `git`, `shell` and `config`.
  - Anything they need from a higher layer moves down first; Tasks 1 and 13 say which.
- **The browser bundle** (`src/ui/*`, bundled from `src/ui/index.html`, under 80 KB gzipped per `tests/unit/console-page.test.ts`) imports nothing that uses Bun, git or `yaml`. Parsing, rendering and glob checks of standards happen on the server, through the routes.
- Writes to `main` go through `commitRecord` (directly or via `writeArtifact`/`setStatus`); the console never writes the repository.
- Rule label: `^[A-Z][A-Za-z0-9._-]{0,30}[A-Za-z0-9]$` or a single capital letter; at most 32 characters; unique across all files. Standard name: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Front matter keys: `applies_to` (string list, Bun.Glob), `needs_person` (boolean, default false), `check` (string); unknown keys are errors.
- `bun run check` (typecheck, lint, deadcode, tests) passes after every task; no unused exports (knip).
- Never run `npm publish` or change `version` in `package.json` (CLAUDE.md).

## Spec deviations (decided here; recorded in docs/decisions.md in Task 20)

- **Where standards are read.** Every step reads them at `ctx.readCommit()`, which is already the commit `main`'s Claude setup comes from for branch steps (#89).
- **Which files the done step judges by.** The done step uses the set the merge gate recorded (run-folder marker `standards.applied`), falling back to the plan's Files that change. It does not diff a merge commit: Loopstra does not keep the merge commit's sha for every path (a pull request merged by hand, say).
- **No tool checks at start.** `loopstra start` does not run tool checks on `main`, since that would delay every start. The warning for a check that fails on `main` comes from `loopstra setup --check`, the console, and the block note.
- **Tests run again at merge.** When standards with a `check` apply, the merge checks' "tests" step runs again once even if the build tested the same commit. The tested marker now includes the tool checks, and the build never runs them.
- **The prompts' standards text lives in code.** The shipped prompt templates are not changed. The standards instructions for each phase live in code (`src/standards-prompt.ts`), and `phasePrompt` appends them, with the standards, only when the repository has standards. A template without standards would otherwise render new text, `(none)` included, for every repository. A repository's own prompt may still place `{{standards}}` itself; then the block goes there, not at the end.
- **No "send back to planning" in the scope dialog.** It has no mechanism from `building` or `reviewing`, since send-back covers only review statuses. The dialog says instead that a standard added after the plan is checked in review, at merge and after the merge.
- **Where `standards-untouched` runs.** It is the first of the merge checks (in `checkMerge`), so it blocks before any fix is spent. It is still a merge-gate row.
- **Standards checked as a whole set.** The console and the loop check a standard file to be saved together with `main`'s other standards, so one save cannot make the whole set unreadable (a label already used elsewhere, say).

## Review Focus

1. A standard file saved with CRLF line endings (Windows, or `core.autocrlf`) must parse the same as LF. Test in Task 1.
2. Agents write labels decorated: `- **ARCH-1**: …`, `` - `ARCH-1`: … ``, `- ARCH-1 — …`. The section reader must accept these, with labels compared exactly (case kept). Test in Task 2.
3. A standard named in a change's `standards.md` (Added or Removed) is deleted from `main` mid-change. The record line becomes a problem under Needs attention, never a crash or a silent drop. Test in Task 6.
4. Changed files with spaces or non-ASCII characters must match `applies_to` patterns. Reuse the `-z` numstat parser from `src/risk.ts` and do not split on lines. Test in Task 8.
5. A `check` written with `"$LOOPSTRA_BASE"` must expand on every platform. Commands run through `bun exec` (Bun shell), so the env must actually contain `LOOPSTRA_BASE` as a sha. Test in Task 9, which asserts the command saw a 40/64-hex value.

---

## Part A: the files and the gates

### Task 1: Parse standard files

**Files:**
- Create: `src/standards.ts`
- Modify: `src/agent-files.ts` (move `splitFrontmatter` down to `src/text.ts`, layer 1, and import it back; behaviour unchanged)
- Test: `tests/unit/standards.test.ts`, `tests/unit/properties.test.ts` (add one property)

**Interfaces:**
- Produces:
  ```ts
  export const STANDARDS_DIR = "loopstra/standards";
  export const RULE_LABEL: RegExp;           // see Global Constraints
  export const STANDARD_NAME: RegExp;
  export interface Rule { label: string; text: string; line: number }
  export interface Standard {
    name: string; path: string; title: string;
    appliesTo: string[] | null; needsPerson: boolean; check: string | null;
    rules: Rule[]; body: string;             // body: the file without front matter
  }
  export interface StandardsProblem { path: string; line: number | null; text: string }
  export interface StandardsRead { standards: Standard[]; problems: StandardsProblem[]; ignored: string[] }
  export function parseStandard(name: string, text: string): { ok: true; standard: Standard } | { ok: false; problems: StandardsProblem[] };
  export function parseStandards(files: { path: string; text: string }[]): StandardsRead; // names from paths; non-<name>.md → ignored; cross-file duplicate labels → problems
  export function problemText(p: StandardsProblem): string; // "loopstra/standards/soc2.md cannot be read: the rule on line 14 has no rule label (write it as `- LABEL: text`)."
  export interface StandardForm { name: string; title: string; patterns: string[]; needsPerson: boolean; check: string; rules: { label: string; text: string }[]; context: string }
  export function formToMarkdown(f: StandardForm): string;          // the one renderer: setup and the console's server both use it
  export function standardToForm(s: Standard): StandardForm;
  ```

- [ ] **Step 1: Write failing tests** in `tests/unit/standards.test.ts`:
  - `parses the spec's example`: the spec's architecture example has title `Service architecture`, `appliesTo` `["services/**","api/**"]`, `needsPerson` false, `check` set, and rules `ARCH-1` and `ARCH-2`. ARCH-1's text joins its continuation line with one space.
  - `no front matter means every change, no check`: `appliesTo === null`, `check === null`.
  - `CRLF parses the same as LF`: `parseStandard("a", lf.replace(/\n/g, "\r\n"))` deep-equals the LF result, except `body`'s line endings.
  - `each unreadable shape is a problem with its line`:
    - no `# ` title;
    - no `## Rules`;
    - an empty Rules section;
    - `- no label here`, and `- arch-1: lower case`;
    - a label of 33 characters;
    - an unknown key `owner: x`;
    - `applies_to: "src/**"` (not a list);
    - an invalid glob `applies_to: ["["]`;
    - YAML that does not parse.

    Each gives `ok: false`, and `problems[0].line` is the 1-based line, where one exists.
  - `a label used in two files is a problem in both`, via `parseStandards`.
  - `other files are ignored`: `loopstra/standards/README.txt` and `Bad_Name.md` land in `ignored`.
  - `problemText` gives exactly the spec's sentence for a missing label.
  - `formToMarkdown` round trip: `standardToForm(parseStandard(n, formToMarkdown(f)).standard)` deep-equals `f` for the spec's example. An empty `patterns` writes no `applies_to`, and an empty `check` writes no `check`.
- [ ] **Step 2:** Run `bun test tests/unit/standards.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `src/standards.ts`.
  - Split the front matter with `splitFrontmatter` from `src/agent-files.ts`.
  - Parse the front matter with a strict zod object.
  - Validate globs by constructing `new Bun.Glob(p)` inside try.
  - A rule starts at a line matching `^- (\S+?):\s+(.*)$` inside `## Rules`, which ends at the next `## `. Indented following lines continue it.
- [ ] **Step 4: Add the property test** in `properties.test.ts`: `fc.array` of distinct valid labels and single-line texts, rendered as a Rules list, parses back to the same `(label, text)` pairs.
- [ ] **Step 5:** Run `bun test tests/unit/standards.test.ts tests/unit/properties.test.ts`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(standards): parse standard files`.

### Task 2: Read from a commit, applicability, rendering, the Standards section, the change's record

**Files:**
- Modify: `src/standards.ts`, `src/context.ts` (add `standards()` and `standardsRecord()` to `StepContext`), `src/stop.ts` (`StandardsUnreadable`, counted by `notTheStepsFault`)
- Create: `src/standards-record.ts`
- Test: `tests/unit/standards.test.ts`, `tests/unit/standards-record.test.ts`, `tests/unit/context.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  export async function readStandards(git: Git, commit: string): Promise<StandardsRead>; // ls-tree + cat-file of STANDARDS_DIR at commit; none → empty
  export interface Scope { added: string[]; removed: string[] }          // standard names
  export interface Applying { standard: Standard; why: "every" | "files" | "added"; files: string[] }
  export function applying(standards: Standard[], files: string[], scope?: Scope): Applying[]; // file order of standards kept; removed wins over every/files; added applies whatever the files
  export interface Excepted { label: string; reason: string }
  export function renderStandards(list: Applying[], opts?: { scoped?: Standard[]; excepted?: Excepted[] }): string; // "" when list and scoped are empty
  export type BulletKind = "keeps" | "not-applicable" | "exception";
  export interface SectionBullet { label: string; kind: BulletKind; text: string }
  export function readStandardsSection(markdown: string): SectionBullet[] | null; // null: no "## Standards" heading; "None." → []
  export function checkStandardsSection(section: SectionBullet[] | null, required: string[], known: ReadonlySet<string>): { ok: boolean; evidence: string };
  export function standardsBytes(r: StandardsRead): number;
  export interface OutcomeLine { label: string; title: string; result: string; evidence: string }
  export function readOutcomeStandards(outcome: string): OutcomeLine[]; // parses Task 10's outcome section
  // src/stop.ts
  export class StandardsUnreadable extends Error {}                    // notTheStepsFault(e) is true for it
  // src/standards-record.ts (layer 3)
  export const STANDARDS_RECORD = "standards.md";
  export interface Decision { name: string; note: string; by: string; via: string; date: string }
  export interface ApprovedException { label: string; gate: "spec" | "plan"; reason: string; by: string; via: string; date: string }
  export interface ChangeStandards { added: Decision[]; removed: Decision[]; exceptions: ApprovedException[]; problems: string[] }
  export function parseRecord(text: string | null, known?: ReadonlySet<string>): ChangeStandards; // forgiving; bad lines, and names not in `known`, become problems
  export function renderRecord(slug: string, r: ChangeStandards): string | null; // null when all empty
  export function scopeOf(r: ChangeStandards): Scope;
  // StepContext:
  standards(): Promise<StandardsRead>;        // memoized per step at readCommit(); reset by dropSnapshot(); throws StandardsUnreadable when problems
  standardsRecord(): ChangeStandards;         // the change's intent/<slug>/standards.md as on disk now
  ```

- [ ] **Step 1: Write failing tests:**
  - `readStandards reads only the commit`: a temp repo (`tempGitRepo` from `tests/helpers.ts`) commits one standard, then edits it uncommitted. `readStandards` returns the committed text.
  - `applying`:
    - every / files: the matched files are listed, renames included when passed both paths;
    - removed beats both;
    - added applies with no matching file and `why: "added"`;
    - a path with a space and `é` matches `services/**`.
  - `renderStandards`:
    - the heading line `### Service architecture (loopstra/standards/architecture.md)`, then `Applies because the change touches a and b.`;
    - `Applies to every change.` for an unscoped standard;
    - scoped standards come under the spec's sentence "These apply only to changes that touch the files named.";
    - excepted rules are listed under "Rules under an approved exception:" with their reasons;
    - empty input gives `""`.
  - `readStandardsSection accepts decorated labels`: `- **ARCH-1**: x`, `` - `ARCH-1`: x ``, `- ARCH-1 — x` and `- ARCH-1: does not apply: why` all read. The last is kind `not-applicable`, and `- ARCH-1: exception: why` is kind `exception`. `None.` gives `[]`, and no heading gives `null`.
  - `checkStandardsSection`:
    - missing heading → `{ok:false, evidence:"no Standards section"}`;
    - an unknown label → `"no rule called SEC-9"`;
    - missing required → `"missing SEC-2, SEC-4"` (both joined by `; `);
    - all present → `"all 14 rules addressed"` when required is non-empty, else `"3 rules addressed, 1 exception"`.
  - `StepContext.standards reads once per step`: two calls give the same object, and a commit to main in between does not change it.
  - `an unreadable standard at the step's commit throws StandardsUnreadable`: `notTheStepsFault` is true for it, and in a stage test the change keeps its status and is not blocked.
  - `standards-record`:
    - the spec's example parses and renders back unchanged;
    - a line naming a standard not in `known` gives the problem `standards.md names payments, which is not a standard on main.`;
    - malformed bullets give problems;
    - `renderRecord` gives `null` for an empty record.
  - `readOutcomeStandards` reads back what Task 10's format writes. Use the spec's three line forms as fixtures.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** In `readStandards`, use `git.run(["ls-tree", "-z", "--name-only", commit, "--", STANDARDS_DIR + "/"])` and `cat-file blob`, the way `src/agent-files.ts:140` does. In `StepContext`, add the private `reading` memo pattern, as for `readCommit`, and clear it in `dropSnapshot`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): read from main's commit, applicability, section reader`.

### Task 3: Fail closed on unreadable standards

**Files:**
- Modify: `src/scheduler.ts` (in `tick`, after `syncMain`, `applyRequests` and `armApplier` and before the queue is read; and `preflight`, `src/scheduler.ts:~939`), `src/attention.ts`
- Test: `tests/unit/status.test.ts`, `tests/integration/standards-tick.test.ts` (new)

**Interfaces:**
- Consumes: `readStandards`, `problemText`.
- Produces:
  - The tick traces `trace.eventOnChange("_loop", "error", '"where":"standards"', { where: "standards", problems: string[] }, "error")`. That is an existing event type with a `where`, as the config problem uses.
  - `attention` reads the standards live, with `readStandards` at `main`'s commit, never from the trace, so a fix clears it at once. It lists them as kind `"standards"` with the first problem's sentence plus " Fix it on main and commit; until then no change moves on."
  - A change's unreadable `standards.md` lines (`parseRecord` problems) are listed the same way, naming the change.

- [ ] **Step 1: Write the failing integration test** `one tick with an unreadable standard on main starts no step`.
  - Set up a repo with an accepted intent and `loopstra/standards/bad.md` with no Rules section, then run `tick`.
  - Expected: `picked` is null, the trace has the `standards` error, and the intent stays `accepted`.
  - Then submit an `agent-files` request that fixes the file (Task 14 adds the path; until then, write the request with `submitRequest` and commit the fix by hand in the test): the next tick applies it, and picks the change.
- [ ] **Step 2: Write the failing unit tests** `attention lists unreadable standards` (with the exact sentence) and `attention clears once main is fixed`.
- [ ] **Step 3: Implement.** In `tick`, after requests are applied, read the standards at `main`'s commit (`git rev-parse <main>^{commit}`). If there are problems, trace them and start no steps; signals, syncing and the request applier keep running. In `preflight`, refuse with `problemText` of the first problem.
- [ ] **Step 4:** Run `bun test tests/integration/standards-tick.test.ts tests/unit/status.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): the loop does nothing while a standard cannot be read`.

### Task 4: Prompt variable and the spec gate

**Files:**
- Create: `src/standards-prompt.ts` (layer 5: each phase's standards instructions, the spec's wording)
- Modify: `src/prompts.ts` (`PROMPT_VARS` += `"standards"`), `src/phases.ts` (`phasePrompt`), `src/envelopes.ts` (`requirement.standard`), `src/stages/shared.ts` (`stageStandards`), `src/stages/artifact.ts` (the `standards` hook), `src/stages/design.ts`. The shipped templates under `templates/prompts/` are NOT changed (see Spec deviations).
- Test: `tests/unit/phases.test.ts`, `tests/unit/stages-design.test.ts`, `tests/fake-claude/` fixtures as needed

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```ts
  // src/standards-prompt.ts
  export const STANDARDS_HEADING = "Standards this repository holds every change to:";
  export const STANDARDS_INSTRUCTIONS: Partial<Record<PhaseName, string>>; // design, spec-check, plan, plan-challenge, build, resolve, review, done-check
  export function standardsBlock(phase: PhaseName, standards: string): string; // "" when standards is ""; else heading, instructions, standards
  // src/stages/shared.ts
  export interface StageStandards { read: StandardsRead; list: Applying[]; scoped: Standard[]; excepted: Excepted[]; text: string; labels: string[] } // labels: every rule label of `list`, minus the excepted ones
  export async function stageStandards(ctx: StepContext, files: string[] | null): Promise<StageStandards>;
  // src/stages/artifact.ts, ArtifactStage:
  standards?: (ctx: StepContext, a: Artifacts) => Promise<StageStandards>; // write() and checks() call it once per artifact
  ```
  - `phasePrompt`: when `vars.standards` is non-empty, it renders `{{standards}}` in place when the template has it, else appends `standardsBlock(spec.name, vars.standards)`. When it is empty, the prompt is unchanged, byte for byte.
  - `requirement` gets `standard: z.string().optional()`.
  - `stageStandards(ctx, null)` is the spec view: unscoped standards apply and scoped ones go in `scoped`. Given files, it is the plan view, with `parsePlanFiles(plan)?.map((f) => f.path) ?? []` at its callers.
  - The change's scope (`scopeOf(ctx.standardsRecord())`) and its approved exceptions are applied.
  - It reads the standards through `ctx.standards()`, which throws `StandardsUnreadable`.

- [ ] **Step 1: Write failing tests:**
  - `a repository without standards renders the same prompts` (golden): render design, spec-check, plan, plan-challenge, build, review and done-check for a fixture change, before and after. Equal strings. The fixture's prompts are stored as files, made by running the test once on `main` before this change.
  - `an override without {{standards}} gets them appended`.
  - `stages-design`:
    - a spec without `## Standards` fails the `standards` check with evidence `no Standards section`, and is rewritten once;
    - a spec with `## Standards` and `None.` passes;
    - a spec naming `SEC-9` fails with `no rule called SEC-9`;
    - a spec-check finding with `standard: "SEC-3"` reaches the rewrite's findings as `SEC-3: …` and the gate evidence.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `DESIGN.standards` is `(ctx) => stageStandards(ctx, null)`.
  - `write` adds `standards: s.text` to the writer's vars, and `checks` adds it to the judge's vars, plus a `{ name: "standards", run }` check only when `read.standards.length > 0`. That check is `checkStandardsSection(readStandardsSection(text), [], allLabels)`.
  - `judge.findings` prefixes `${f.standard}: ` when it is set.
  - The instructions for design and spec-check in `STANDARDS_INSTRUCTIONS` are the spec's paragraphs under "Spec (design and spec-check)".
- [ ] **Step 4:** Run `bun test tests/unit/phases.test.ts tests/unit/stages-design.test.ts tests/unit/prompts.test.ts tests/unit/templates.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): the spec gate checks the Standards section`.

### Task 5: The plan gate

**Files:**
- Modify: `src/stages/plan.ts` (`PLAN.standards`, the check, `planAheadRun` and `takePlanAhead`), `src/envelopes.ts` (`plan-challenge` concern `standard`), `src/standards-prompt.ts` (plan and plan-challenge instructions)
- Test: `tests/unit/stages-plan.test.ts`

**Interfaces:**
- Consumes:
  - **The plan writer** sees the spec view, `stageStandards(ctx, null)`: it has no file list yet. Its instructions say a scoped standard applies when the plan lists a file its patterns match.
  - **The gate's check and `plan-challenge`** use `stageStandards(ctx, paths)`, with `paths = parsePlanFiles(a.plan)?.map((f) => f.path) ?? []` (null: no Files section, which the headings check reports), and `checkStandardsSection(section, s.labels, allLabels)`.
  - **Plan written ahead:** `planAheadRun` (it calls `writerPhase` directly, `plan.ts:~104`) passes the same spec-view `standards` var, so its key matches the planning step's.

- [ ] **Step 1: Write failing tests:**
  - `the plan's scoped standards come from its file list`: a plan listing `services/billing/api.ts` must cover ARCH-*. One listing only `docs/x.md` need not.
  - `a plan missing a rule that applies fails` with `missing ARCH-2`.
  - `a concern with standard and blocking fails the gate`, with the label in the evidence.
  - `plan-ahead is still used when the standards did not change`.
  - `plan-ahead's key changes when standards change`: commit a standard between design and plan, and the kept plan is not used.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `standards` check after `files`, reading the same `parsePlanFiles`.
- [ ] **Step 4:** Run `bun test tests/unit/stages-plan.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): the plan gate covers every rule that applies`.

### Task 6: The change's record, and exceptions

**Files:**
- Modify: `src/standards-record.ts`, `src/intents.ts` (front matter `spec_gate`, `plan_gate`; `BLANK_LEFT_OUT`; `changeGates`), `src/stages/artifact.ts` (pass → review when exceptions await a person; the status check at line ~93 uses `changeGates`), `src/stages/shared.ts` (`recordApprovals`), `src/apply.ts` (approve records exceptions), `src/stages/plan.ts` and `src/stages/build.ts` (record status-edit approvals on entry), `src/attention.ts` ("Waiting for you: exception to …")
- Test: `tests/unit/standards-record.test.ts`, `tests/unit/stages-design.test.ts`, `tests/unit/stages-plan.test.ts`, `tests/unit/apply.test.ts`, `tests/unit/intents-frontmatter.test.ts`

**Interfaces:**
- Consumes: Task 2's record types.
- Produces:
  ```ts
  // src/standards-record.ts
  export function exceptionsToApprove(artifact: string, gate: "spec" | "plan", r: ChangeStandards): SectionBullet[]; // exception bullets not approved for the same label with the same reason
  export function exceptionNote(gate: "spec" | "plan", bullets: SectionBullet[], titles: Map<string, string>): string; // spec's note text
  export function withApprovals(r: ChangeStandards, gate: "spec" | "plan", bullets: SectionBullet[], who: { by: string; via: string }, date: string): ChangeStandards;
  // src/stages/shared.ts
  export async function recordApprovals(ctx: StepContext, gate: "spec" | "plan", who: { by: string; via: string }): Promise<void>; // writes standards.md via writeArtifact when anything is new
  ```
  - Front matter: `spec_gate` and `plan_gate`, each `z.enum(["status"]).optional()`, blank read as absent and left out when blank. `changeGates` sets `spec`/`plan` to `"status"` when the config has `none` and the field is set.
  - When an artifact passes with exceptions to approve, the review status's note is `exceptionNote`, whether the person comes from the config's gate or from the field.

- [ ] **Step 1: Write failing tests:**
  - `exceptions`:
    - a spec with an exception and `gates.spec.human: none` ends in `spec-review` with `spec_gate: status` and the spec's note;
    - approving by request writes `## Exceptions approved` with the request's person and `from the console`;
    - the plan repeating the same exception goes straight to `plan-approved`;
    - a new or reworded exception in the plan waits in `plan-review`;
    - approval by a status edit is recorded `by a status edit` when the next stage starts;
    - with `gates.plan.human: status`, a plan with an exception waits with `exceptionNote`, not the usual note, and no `plan_gate` is written.
  - `changeGates` with `spec_gate`/`plan_gate`; `waitsForPerson` is true for such a change.
  - `attention`: an exception wait is labelled `Waiting for you: exception to ARCH-1`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `settle`, after the pass, read the artifact's section and the record. If `exceptionsToApprove` is non-empty and the effective gate is `none`, call `setStatus(ctx, s.review, exceptionNote(...), {}, { set: { [`${s.gate}_gate`]: "status" } })`.
  - On every other pass, remove the field.
  - `applyStatus` for `approve` from `spec-review`/`plan-review`: in the same record (`commitRecord` draft), write `standards.md` with the newly approved exceptions.
  - The plan and build steps, on entering from `spec-approved`/`plan-approved`, call `recordApprovals(ctx, gate, { by: "a status edit", via: "intent.md" })` for exceptions not yet recorded.
- [ ] **Step 4:** Run the tests above. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): exceptions wait for a person and are recorded`.

### Task 7: Build, resolve and review get the standards

**Files:**
- Modify: `src/stages/build.ts` (build vars), `src/stages/catch-up.ts` (resolve vars), `src/stages/early-review.ts` and `src/stages/review.ts` (review vars, `review.md` lists `standard`), `src/envelopes.ts` (`finding.standard`), `src/standards-prompt.ts` (build, resolve and review instructions), `templates/REVIEW.md` (its Standards pass: this file is the repository's, written by `init`, not a phase prompt)
- Test: `tests/unit/stages-build.test.ts`, `tests/unit/stages-review-merge.test.ts`, `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes:
  - build and resolve: `stageStandards(ctx, plan files)`;
  - review: `stageStandards(ctx, diff files)`, with diff files from a new `export async function changedFiles(wt: Git, main: string): Promise<string[]>` in `src/risk.ts` (the numstat `-z` parser, outside `intent/`, both rename paths).

- [ ] **Step 1: Write failing tests:**
  - the build prompt holds the plan's standards and the line "Keep every rule below. If the plan would make you break one, ask a question rather than break it.";
  - the review prompt holds the diff's standards and the important-finding sentence;
  - a review finding with `standard: "SEC-3"` is important, and `review.md` lists it as `- important · SEC-3 · src/pay.ts:42: <finding>` (the runtime writes this line format under `## Findings`; Task 15 reads it);
  - excepted rules show as excepted in the build and review prompts;
  - `templates/REVIEW.md` has the Standards pass.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** as the interfaces say. `changedFiles` is shared with Task 8.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): build, resolve and review are held to the standards`.

### Task 8: The merge gate's standards checks

**Files:**
- Modify: `src/stages/merge.ts` (`passMergeGate`, a new `standards-untouched` check in `checkMerge`, the `standards` gate row, the `standards.applied` marker), `src/risk.ts` (`scoreRisk` takes extra patterns; `riskNote` names the standard)
- Test: `tests/unit/risk.test.ts`, `tests/unit/stages-review-merge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RiskSource { patterns: string[]; standard?: { title: string; path: string } }
  export async function scoreRisk(wt: Git, main: string, cfg: Config, extra?: RiskSource[]): Promise<Risk>; // Risk gains `standards: { title: string; path: string; files: string[] }[]`
  export const STANDARDS_APPLIED = "standards.applied"; // run-folder marker, JSON { commit, applying: { name, why, files }[] }
  ```
  `standards-untouched` blocks with the spec's note, naming the files under `loopstra/standards/`.

- [ ] **Step 1: Write failing tests:**
  - `a diff touching loopstra/standards/ blocks` with the note, and the gate row names `loopstra/standards/soc2.md`;
  - `a needs_person standard makes the change wait`: with `gates.merge.human: none` it waits in `merge-review` with `merge_gate` set and the spec's note naming the standard;
  - `a person already on the gate is unchanged`: with `gates.merge.human: pr` and the same change, there is no risk row;
  - `a needs_person standard without applies_to makes every change risky`;
  - `needs_person is scored with the default config` (empty `risky.paths`, no `lines`);
  - `the merge gate records standards.applied and a standards row`;
  - `risk matches names with spaces and é`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `riskOf` builds the `extra` list from applying standards with `needsPerson`. Patterns are the standard's `appliesTo`, or `["**"]` when it is null.
  - `riskOf` returns early on `!riskySet(ctx.cfg)` (`merge.ts:~195`). It must not do so when `extra` is non-empty, since `risky.paths` is empty by default. Add a test with the default config.
  - Put `standards-untouched` first among the checks in `checkMerge`, before `up-to-date`, so it blocks before any fix is spent.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): the merge gate protects standards and asks a person where they say`.

### Task 9: Tool checks

**Files:**
- Modify:
  - `src/stages/build.ts`: `testLoop` and `runChecks` take extra checks;
  - `src/stages/shared.ts`: `testedMarker`, `alreadyTested` and `testResult` include them;
  - `src/stages/merge.ts`: the "tests" check, and a `check:<name>` gate row per tool check;
  - `src/phases.ts`: `AgentPhaseSpec.commands?: string[]`, passed into `toolsFor`/`setTools` and `commandsFor`, both at the `toolsFor(ctx, spec.tools, setup)` call in the session runner (`phases.ts:~554`) and at `phasePrompt`'s `commandsFor`;
  - every phase spec with `tools: "build"`: `grep -n 'tools: "build"' src/stages/` finds build (`build.ts:~62`), reconcile (`~93`), the verify fix (`~118`), the test-loop fix (`~212`), revise (`review.ts:~91`), and resolve (`catch-up.ts`). Each passes the applying standards' checks.
- Test: `tests/unit/stages-build.test.ts`, `tests/unit/stages-review-merge.test.ts`, `tests/unit/phases.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolCheck { command: string; title: string; path: string }
  export async function testLoop(ctx: StepContext, prefix: string, extra?: ToolCheck[]): Promise<{ ok: true } | Failure>;
  export function testedMarker(ctx: StepContext, sha: string, extra?: ToolCheck[]): string;
  export async function alreadyTested(ctx: StepContext, wt: Git, extra?: ToolCheck[]): Promise<boolean>;
  export async function toolCheckEnv(ctx: StepContext, wt: Git): Promise<Record<string, string>>; // LOOPSTRA_SLUG, changeEnv(ctx), LOOPSTRA_BASE = merge-base sha
  ```
  Past the fix budget on a tool check, the note is the spec's sentence naming the standard. When the command does not contain `LOOPSTRA_BASE`, it also gets the spec's main hint.

- [ ] **Step 1: Write failing tests:**
  - `a failing check at merge goes to a fix, then to review`: the fake check fails once and then passes;
  - `past the fix budget it blocks naming the standard`, with the hint only when the command lacks `$LOOPSTRA_BASE`;
  - `a passing check is not run again on the same code`;
  - `the check sees LOOPSTRA_BASE as a commit`: `bun -e "process.exit(/^[0-9a-f]{40,64}$/.test(process.env.LOOPSTRA_BASE ?? '') ? 0 : 1)"` passes, including after `main` moved on, and after a conflict resolution squashed the branch;
  - `each tool check writes a merge check:<name> gate row`, with pass written again ("already passed on this code") when `alreadyTested` skips the run;
  - `testResult tells the judges the tests passed` after a merge-check run that included tool checks;
  - `build sessions may run the checks`: `toolsFor(ctx, "build", …)` holds `Bash(<check> *)` when the spec passes `commands`;
  - `standards without checks leave the tested marker as it was`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** `runChecks` runs the extra commands after test, lint and build, through `projectCommand(ctx, cmd, wt, { seq, env })`. The merge "tests" check passes the applying standards' checks. Build, fix, reconcile and revise specs get `commands`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): tool checks run in the merge checks`.

### Task 10: Done-check and outcome.md

**Files:**
- Modify: `src/stages/verify.ts`, `src/envelopes.ts` (`done-check.standards`, default `[]`), `templates/prompts/done-check.md`
- Test: `tests/unit/stages-verify.test.ts`, `tests/unit/envelopes.test.ts`

**Interfaces:**
- Consumes: the `STANDARDS_APPLIED` marker (falling back to the plan's files), the record, and the gate rows `merge`/`check:<name>`.
- Produces: `export function standardsSection(commit: string, items, applying, record, checks): string`. It is the outcome's `## Standards`, in exactly the spec's format, with the commit shortened to 7 characters.

- [ ] **Step 1: Write failing tests:**
  - `an unmet rule blocks` with the spec's standards-only note, and with both criteria and rules unmet, `Done when criteria and engineering rules`;
  - `a needs-person rule goes under For a person to confirm with its label`;
  - `outcome.md has the runtime's Standards section`, with the first line naming the commit, then the rules, the exceptions, the tool checks and the scope changes;
  - `gates.done.agent: false` lists the rules with "not checked automatically";
  - `an envelope without standards still parses`.
  - **Integration** (`tests/integration/standards-run.test.ts`): one change runs from accepted to done in a repository with one standard for every change and one scoped standard. The fake claude answers each phase with a Standards section. `outcome.md`'s Standards section lists both standards' rules, and the gate rows `standards` exist on spec, plan, merge and done.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): the done-check judges each rule; outcome.md records them`.

### Task 11: The hook protects the standards

**Files:**
- Modify: `templates/hooks/loopstra-protect-tests.ts`
- Test: `tests/unit/hook.test.ts`

- [ ] **Step 1: Write a failing test:** an Edit or Write of `loopstra/standards/x.md` exits 2 in each of the phases acceptance, build, fix, reconcile, revise and resolve, and the stderr says standards are changed by a person on main. Outside those phases it exits 0.
- [ ] **Step 2:** Run `bun test tests/unit/hook.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `resolve` to the phases the hook runs for, and check the standards path before every other rule. The refusal writes only to stderr and never to `$LOOPSTRA_PROTECTED_LOG`, so a block note never calls a standard a protected test. Add an assertion that the log is untouched.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): no session of the loop edits loopstra/standards/`.

### Task 12: The `standards-scope` request

**Files:**
- Modify: `src/requests.ts`, `src/apply.ts`, `src/actions.ts` (an offer for the console only; chat never offers it)
- Test: `tests/unit/apply.test.ts`, `tests/unit/requests.test.ts`

**Interfaces:**
- Produces: `{ kind: "standards-scope", slug, expect: status, action: "add" | "remove", name: string, note: string }`. Applied as one record, `loopstra(<slug>): standard <name> added|removed by <who> from the dashboard`, writing `standards.md`.

- [ ] **Step 1: Write failing tests:**
  - adding writes `## Added` with the note;
  - removing without a note is refused with "Say why this standard does not apply to this change.";
  - an unknown standard is refused;
  - adding one already added is a no-op that reports so;
  - a request for a change that is `done` or `closed` is refused, and nothing is written;
  - the next step's `stageStandards` reflects the change;
  - the trace has a `standards-scope` row;
  - chat's action list never contains it.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): add or remove a standard for one change`.

### Task 13: `loopstra standards`, and tool checks on main

**Files:**
- Create: `src/commands/standards.ts`, `src/standards-check.ts` (layer 5: `checkOnMain`, shared by setup and the console)
- Modify:
  - `src/shell.ts`: move `missingProgram` down from `src/setup/sections/commands.ts:~80` and import it back;
  - `src/cli.ts`: register the command;
  - `src/commands/args.ts`, if it needs to;
  - `src/setup/index.ts`: `--check` runs the standards checks even with no section named.
- Test: `tests/unit/standards-command.test.ts`, `tests/unit/setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CheckOnMain { ok: boolean; timedOut: boolean; code: number; durationMs: number; lastLines: string; missingProgram: string | null; failsOnMain: string | null } // failsOnMain: the spec's warning text
  export async function checkOnMain(root: string, cfg: Config, command: string): Promise<CheckOnMain>; // throwaway checkout, install first, LOOPSTRA_BASE = main's commit
  export function baseAware(command: string): string | null; // the base-aware form for gitleaks/semgrep, else null
  ```

- [ ] **Step 1: Write failing tests:**
  - `loopstra standards` lists title, file, scope with the count of matching files, needs person, check and labels, plus problems, ignored files and uncommitted edits. It exits 0 even with problems.
  - `loopstra standards` says a `needs_person` standard without `applies_to` makes every change wait for a person, like `gates.merge.human: pr`.
  - `setup --check` lists unreadable standards under "To fix" and exits 1.
  - `setup --check` warns with the spec's sentence for a check that fails on main, suggesting `baseAware` for gitleaks and semgrep.
  - `setup --check` warns when a check names a missing program.
  - Over 40 KB of standards gives the warning.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Extract the throwaway-checkout run from `testOnMain` in `src/setup/sections/commands.ts` into a shared helper, and use it in both.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(standards): loopstra standards, and tool checks tried on main`.

## Part B: the console

### Task 14: Console writes to standard files

**Files:**
- Modify: `src/agent-library.ts` (`repoPath` also accepts `loopstra/standards/<name>.md`), `src/apply.ts` (`applyAgentFiles` refuses a standard that would not read, and words its record `standards: edit <file>`)
- Test: `tests/unit/apply.test.ts`, `tests/unit/agent-library.test.ts`

- [ ] **Step 1: Write failing tests:**
  - an `agent-files` request writing a valid standard lands as `loopstra(_settings): standards: edit architecture.md by J. from the dashboard`;
  - one that would not read is refused with the problem and nothing committed. "Would not read" means `parseStandards` of `main`'s other standards with this one written or removed: a label that another file already uses is refused too;
  - a stale `base` is refused;
  - `loopstra/standards/../x` and `loopstra/standards/a/b.md` are refused.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(console): standard files through agent-files requests`.

### Task 15: Standards routes

**Files:**
- Create: `src/console/standards.ts`
- Modify: `src/console/server.ts` (routes), `src/console/types.ts` (views), `src/console/detail.ts` (the change's standards panel data, in `ChangeDetail`)
- Test: `tests/unit/console-standards.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface StandardRow { name: string; path: string; title: string; scope: string; matches: number | null; needsPerson: boolean; check: string | null; rules: { label: string; text: string }[]; inProgress: string[]; text: string; version: string }
  export interface StandardsView { standards: StandardRow[]; problems: string[]; ignored: string[]; uncommitted: string[] }
  export interface DraftCheck { problems: StandardsProblem[]; matches: { pattern: string; count: number; sample: string[] }[] }
  export interface ExceptionRow { label: string; title: string; slug: string; reason: string; by: string; via: string; date: string; gate: "spec" | "plan" }
  export interface ScopeRow { name: string; slug: string; action: "added" | "removed"; note: string; by: string; via: string; date: string }
  export interface ChangeStandardsView { applying: { name: string; title: string; why: string; rules: { label: string; text: string; spec?: string; plan?: string; findings: string[]; result?: string }[]; check?: string }[]; waiting: SectionBullet[]; record: ChangeStandards }
  ```
  - **Routes:**
    - `GET /api/standards`;
    - `POST /api/standards/check`, with body `{ name, text } | { name, form: StandardForm }`. It returns `DraftCheck & { text: string; form: StandardForm | null }`, so the page converts form ⇄ Markdown through the server, and validates and counts patterns there. The draft is checked together with `main`'s other standards;
    - `POST /api/standards/try`, with body `{ name } | { name, text }`. It runs only that standard's or draft's `check`, never a command the page sends, and returns `CheckOnMain`;
    - `GET /api/standards/exceptions`, returning `{ exceptions: ExceptionRow[]; scope: ScopeRow[] }`;
    - `POST /api/standards/scope`, which submits a `standards-scope` request.
  - Each route has the Host check, and every POST also has the Origin check, through `jsonWrite` in `src/console/routes.ts:~65`, as `/api/agents/files` does.
  - **`ChangeDetail`** gains `standards?: ChangeStandardsView` when the repository has standards. Its per-rule data comes from:
    - `readStandardsSection` of `spec.md` and `plan.md`;
    - `review.md`'s `- important · LABEL · …` lines (Task 7's format);
    - the trace's `merge`/`check:<name>` gate rows;
    - `readOutcomeStandards(outcome.md)`;
    - the change's `standards.md`.

- [ ] **Step 1: Write failing tests,** using `tests/console-helpers.ts`:
  - each route's JSON on a fixture repo;
  - a wrong Host is refused, and a POST with a foreign Origin is refused;
  - `try` with a body carrying `command` runs nothing it was sent: it runs only the named standard's `check`;
  - `try` leaves the repository's status unchanged;
  - `check` refuses a draft whose label another file already uses;
  - `exceptions` reads three changes' records, newest first;
  - the change detail carries `standards` only when the repository has some.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement,** following `src/console/agent-settings.ts`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(console): standards routes`.

### Task 16: Settings › Standards and Exceptions granted

**Files:**
- Create: `src/ui/views/StandardSettings.tsx`, `src/ui/views/Exceptions.tsx`, `src/ui/standards.ts` (pure logic with no Bun, git or `yaml`: label checks, save enabling, panel rows; Markdown conversion goes through `POST /api/standards/check`)
- Modify: `src/ui/views/Settings.tsx` (third section), `src/ui/router.ts` and `src/console/server.ts` (`/settings/exceptions` page path)
- Test: `tests/unit/ui-standards.test.ts`, `tests/unit/console-page.test.ts`

**Interfaces:**
- Consumes: Task 15 routes; the `agent-files` submit as in `AgentSettings.tsx`.
- Produces:
  ```ts
  // src/ui/standards.ts: StandardForm's shape is declared again in src/console/types.ts (the bundle may not import src/standards.ts)
  export function fieldProblems(f: StandardForm, serverProblems: StandardsProblem[]): Partial<Record<"name" | "title" | "patterns" | "check" | `rule:${number}`, string>>; // local: name and label shapes, labels used twice; patterns from the server
  export function canSave(f: StandardForm, check: DraftCheck | null): boolean;
  ```

- [ ] **Step 1: Write failing tests** (`ui-standards.test.ts`):
  - a label used twice, and one that is not valid, are each reported next to their own rule rows;
  - a server problem about a pattern lands on the patterns field;
  - Save is offered only when `fieldProblems` is empty and the server check has no problems;
  - the save notice names the changes in progress;
  - `console-page` serves `/settings/exceptions`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement the views,** in the style of `AgentSettings.tsx` (one write pending at a time, the `locked`/`wait` props).
- [ ] **Step 4:** Run `bun test tests/unit/ui-standards.test.ts tests/unit/console-page.test.ts`. Expected: PASS. `console-page.test.ts` bundles `src/ui/index.html` and holds its scripts under 80 KB gzipped. Keep the new views small (no new dependencies), and if the limit is hit, split the Standards views into a lazily imported chunk rather than raise it.
- [ ] **Step 5:** Commit `feat(console): Settings › Standards and Exceptions granted`.

### Task 17: The change page's Standards panel

**Files:**
- Create: `src/ui/parts/StandardsPanel.tsx`
- Modify: `src/ui/views/Change.tsx`, `src/ui/views/Inbox.tsx` (the exception label)
- Test: `tests/unit/ui-logic.test.ts` (panel logic extracted into `src/ui/standards.ts`)

**Interfaces:**
- Produces:
  - `export function panelRows(v: ChangeStandardsView): PanelRow[]`;
  - `export function approveLabel(gate: "spec" | "plan"): string`, giving "Allow the exception and approve the plan" (or "…the spec").

- [ ] **Step 1: Write failing tests:**
  - waiting exceptions come first;
  - `why` texts are "touches services/billing/api.ts", "every change" and "added by J.";
  - the remove dialog requires a note;
  - the add dialog, at or after `plan-approved`, says "The plan does not cover it; review, the merge checks and the final check will.";
  - the inbox label is "Waiting for you: exception to ARCH-1".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Approve uses the existing `approve` request, and scope uses `POST /api/standards/scope`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(console): the change's Standards panel`.

## Part C: setup and onboarding

### Task 18: `loopstra setup standards`

**Files:**
- Create: `src/setup/sections/standards.ts`
- Modify: `src/setup/sections/index.ts` (append after `agents`), `src/setup/types.ts` if `files` needs nothing new (it should not)
- Test: `tests/unit/setup-standards.test.ts` (with `tests/setup-helpers.ts`)

**Interfaces:**
- Consumes: `parseStandards`, `formToMarkdown`, `standardToForm` (Task 1), `checkOnMain`, `baseAware` (Task 13), and `ctx.files` with `FileWrite` paths under `loopstra/standards/`, which Task 14's `repoPath` allows.
- Produces: `export const standards: Section` (`name: "standards"`, `covers: []`).

- [ ] **Step 1: Write failing tests,** using scripted answers:
  - in a full setup it asks "Set up standards, rules every change is checked against, now?" and answering no asks nothing more;
  - `loopstra setup standards` lists the existing ones;
  - add a blank one: name, title, patterns (with the match count), needs person, check, two rules, then done;
  - a label used twice is refused with the rule that has it;
  - an invalid pattern is asked again;
  - the check suggestion is the base-aware gitleaks form when a fake `gitleaks` is on PATH;
  - edit removes a rule and rewords another;
  - remove deletes the file;
  - a result that would not read saves nothing;
  - the check lists a tool check that fails on main under "To fix", with the warning;
  - `--defaults` adds none.
- [ ] **Step 2:** Run `bun test tests/unit/setup-standards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement,** following `src/setup/sections/agents.ts`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(setup): loopstra setup standards`.

### Task 19: The onboarding step in the operator skill

**Files:**
- Modify: `templates/skill/SKILL.md` (Onboard step 7, "Set up the standards", renumbering after it; Tune; the `description` mentions standards)
- Test: `tests/unit/templates.test.ts` (and `templates-roundtrip.test.ts` / `shipped.test.ts` if they pin the skill)

- [ ] **Step 1: Write a failing test:**
  - the skill has a step titled "Set up the standards" after "Set up the agents";
  - it names `loopstra setup --check`, `loopstra setup standards` and `$LOOPSTRA_BASE`;
  - it says the agent never commits;
  - Tune mentions standards.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Write the step** from the spec's "The onboarding agent" (steps 1 to 6 and the closing paragraph), in the skill's existing voice.
- [ ] **Step 4:** Run `bun test tests/unit/templates.test.ts tests/unit/shipped.test.ts tests/unit/upgrade-files.test.ts`. Expected: PASS. A changed shipped file may need its stamp fixture updated; follow how earlier skill changes did it (`git log -p templates/skill/SKILL.md`).
- [ ] **Step 5:** Commit `feat(skill): onboarding step for standards`.

### Task 20: Documentation

**Files:**
- Modify:
  - `README.md`: a Standards section with the two worked examples (architecture, SOC 2 technical controls with a base-aware secret-scanner check) and the limits; the change-management mapping; setup's sections list; the console's Settings; the step table's unchanged rows; Configuration's mention of `loopstra/standards/`;
  - `docs/architecture.md`: `standards.ts`, `standards-record.ts` and `standards-check.ts` in layer 3; the console and setup modules;
  - `docs/decisions.md`: a "Standards (2026-10-28)" section with every "Claude's call" from the spec and the deviations above;
  - `templates/intent-README.md`: unchanged (owners never see standards). Confirm this.
- Test: `bun run check`

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `bun run check`. Expected: PASS.
- [ ] **Step 3:** Commit `docs: standards`.
