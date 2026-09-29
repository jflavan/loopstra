# Loopstra design spec

Date: 2026-09-28. Status: approved for planning. Source of decisions:
`docs/decisions.md`. When this spec and that file disagree, fix this spec.

## 1. What Loopstra is

Loopstra is an unattended, continuously running software development loop
built on Claude Code. It takes a change from a plain-language intent through
design, planning, building, testing, review, merge, and verification, using
the six stages of Anthropic's AI-Native SDLC Playbook, and then keeps watching
the main branch so failures become new intents.

Three parts:

1. **The runtime**, a Bun process (`loopstra start`) that owns the loop. It
   decides what runs next, retries, gates, and records everything. Code owns
   sequencing, retries, and acceptance.
2. **Claude Code sessions**, spawned headlessly by the runtime one per phase.
   An agent owns only the work inside one bounded phase.
3. **The operator skill**, a Claude Code skill installed into the target repo
   so an interactive session can onboard, inspect, unblock, and tune. It never
   runs the loop.

Non-goals for v1: parallel intents, custom stages, continuous production
metrics, a hosted service, any UI beyond a local dashboard.

Design constants:

- **Two audiences, two surfaces.** Product owners only ever read and write
  plain-language markdown and one status line. Engineers configure machinery
  once at onboarding. No technical term appears on the owner surface.
- **The repo is the queue and the state.** Nothing about a change lives
  outside git except runtime scratch and the trace.
- **Agents propose, the runtime writes.** Artifacts are written by code from
  structured output. Only the build session edits code, in its own worktree.
- **Deterministic first.** A known command is a code phase, never an agent.
  Gates are lists of checks; human checks only where configured.
- **Subscription auth.** The runtime spawns the `claude` CLI so it works on a
  Claude subscription. It never requires an API key.

## 2. Files in a target repo

```
intent/
  README.md                       owner guide, written by init
  queue.md                        generated view of order and status, never edited
  <slug>/
    intent.md                     Stage 1, owner-authored, runtime-managed frontmatter
    spec.md                       Stage 2
    plan.md                       Stage 3
    review.md                     Stage 5 findings and resolutions
    outcome.md                    Stage 6 evidence and lessons
loopstra/
  config.yaml                     all machinery configuration
  prompts/<phase>.md              editable prompt per agent phase
REVIEW.md                         review policy read by the reviewer
CLAUDE.md                         maintained per the course; init adds a Commands block
.claude/
  skills/loopstra/SKILL.md        operator skill
  agents/verifier.md              fresh-context verifier subagent
  agents/reviewer.md              fresh-context reviewer subagent
  hooks/loopstra-protect-tests.ts hook: blocks test edits during fix phases
  settings.json                   hook wiring (merged, not overwritten)
.loopstra/                        gitignored
  trace.db                        SQLite trace
  runs/<slug>/                    per-intent runtime state
    sessions.json                 phase → claude session id
    events.jsonl                  append-only event log
    phases/<n>-<phase>/           prompt.md, raw.jsonl, envelope.json
  worktrees/<slug>/               git worktree for the intent branch
```

Slugs are lowercase words joined by hyphens, chosen by the owner, and are the
folder name, the branch name (`intent/<slug>`), and the PR title prefix.

## 3. The intent file

```markdown
---
status: draft
priority: normal          # low | normal | high | urgent, plain words
author: J. Ortiz
opened: 2026-09-28
note: ""                  # runtime writes plain-language guidance here
---
# Intent: claims status self-service

## Problem
Customers phone the contact center to ask where their claim is.

## Proposed outcome
Customers see claim status, next step, and expected date in the portal.

## Done when
- A customer with an open claim sees its status on the portal home page.
- The contact center's status-only calls are measurable, so we can watch them drop.

## Affected users and systems
Claims handlers, portal team, claims-core API.

## Constraints
No new PII in the portal session. Existing authentication only.

## Open questions
Do third-party loss adjusters need access too?
```

Required sections: Problem, Proposed outcome, Done when. The intake phase
blocks an intent that lacks them, with a note naming what is missing.

## 4. States

One field, `status`, in the frontmatter. Only the runtime writes it, except
that a person may set it at a human gate or to retry or close.

```
draft → accepted → designing → spec-review → spec-approved
      → planning → plan-review → plan-approved
      → building → reviewing → merge-review → merge-approved → merged
      → verifying → done
any → blocked | closed
```

| Status | Set by | Meaning |
|---|---|---|
| draft | owner or signals | Being written. Runtime ignores. |
| accepted | owner (intent gate) | Ready for design. |
| designing | runtime | Stage 2 running. |
| spec-review | runtime | Spec written and its automated checks passed; waiting for a person. |
| spec-approved | runtime or human | Spec gate passed. |
| planning | runtime | Plan phase running. |
| plan-review | runtime | Plan written and its automated checks passed; waiting for a person. |
| plan-approved | runtime or human | Plan gate passed. |
| building | runtime | Build, test, fix, verify running on the branch. |
| reviewing | runtime | Review and revise rounds running. |
| merge-review | runtime | Reviewed and its merge checks passed; waiting for a person. |
| merge-approved | runtime or human | Merge gate passed; the next step re-checks and merges. |
| merged | runtime | On main. Done-when checks, outcome, and lessons run from here. |
| verifying | runtime | Outcome written; waiting for a person to confirm. |
| done | runtime | Terminal. |
| blocked | runtime | Needs a person. `note` says what and why. |
| closed | human | Terminal. Dismissed. |

Runnable means: not draft, not blocked, not done, not closed, and not a
review status whose gate is waiting on a person or on external CI.

Consistency check before every step: the artifacts that a status implies must
exist (for example `spec-review` requires `spec.md`). A mismatch sets
`blocked` with a note. Hand-editing a status cannot skip a stage.

Retry: a person sets status back to the most recent approved state
(`accepted`, `spec-approved`, `plan-approved`, `merge-approved`, or `merged`). The runtime
resumes from there, reusing artifacts and the branch if present.

## 5. Queue order

Computed on every tick, written to `intent/queue.md` as a table. Order:

1. Status class: in-flight statuses first, then approved statuses, then
   `accepted`. (One intent in flight at a time; an in-flight intent that is
   waiting on a person or CI does not block the next from starting.)
2. Priority: urgent, high, normal, low.
3. `opened` date, oldest first.
4. Slug, alphabetical, as the tie-break.

`queue.md` also lists blocked intents with their notes, and done or closed
intents in a collapsed section. It is regenerated, never edited.

## 6. Configuration

`loopstra/config.yaml`, validated with a schema at every load. Unknown keys
are errors. Every key has a default except `commands.test`.

```yaml
version: 1
main_branch: main
poll_seconds: 60

commands:                       # exit code decides; run in the intent worktree
  test: bun test
  lint: bun run lint            # optional
  build: bun run build          # optional
  run: bun run start            # optional; used by the verifier subagent

claude:
  models:
    default: sonnet             # any alias or id the CLI accepts
    cheap: haiku
    strong: opus
  timeout_minutes: 30           # per phase; the process is killed past this
  max_budget_usd: 5             # per phase, passed to --max-budget-usd
  allowed_tools:                # for the build session; judges get read-only
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - Bash(bun *)
    - Bash(git *)

gates:
  intent: { human: status }                 # status | pr | none
  spec:   { human: none, agent: true }
  plan:   { human: none, agent: true }
  merge:  { human: none, method: squash }   # squash | merge; pr approval read when human: pr
  done:   { human: none, agent: true }

stages:
  design:  { model: strong,  skills: [], before: [], after: [] }
  plan:    { model: strong,  skills: [], before: [], after: [] }
  build:   { model: default, skills: [], before: [], after: [], max_fix_loops: 3 }
  review:  { model: strong,  skills: [], before: [], after: [], max_rounds: 2 }
  verify:  { model: cheap,   skills: [], before: [], after: [] }

signals:
  main_health:
    every_minutes: 30           # also runs after every merge
```

`before` and `after` are lists of commands. A non-zero exit from a `before`
command blocks the intent with the command's last output line as the note. A
non-zero `after` command is recorded and blocks likewise.

`skills` are names under `.claude/skills/`. The runtime mentions them by name
at the top of the phase prompt ("Use the `brand-guidelines` skill.") so the
session loads them.

## 7. Prompts and envelopes

Each agent phase has a prompt file in `loopstra/prompts/` rendered with a
small set of `{{variables}}`: `{{slug}}`, `{{intent}}`, `{{spec}}`,
`{{plan}}`, `{{review}}`, `{{previous}}` (the previous envelope as JSON),
`{{failure_output}}`, `{{skills}}`, and `{{done_when}}`. Missing variables
render as `(none)`. Prompts are stamped by init and edited like code.

Phases and their envelopes (all include `status: "success" | "fail"`,
`summary`, and `notes_for_next_phase`):

| Phase | Session | Tools | Envelope adds |
|---|---|---|---|
| intake | fresh, cheap | read-only | `priority`, `missing_sections[]`, `question` |
| design | fresh, strong | read-only | `spec_markdown`, `concerns[]` |
| spec-check | fresh, strong | read-only | `approved`, `findings[{requirement, met, evidence}]` |
| plan | fresh, strong, plan mode | read-only | `plan_markdown`, `files[{path, new}]` |
| plan-challenge | fresh, strong | read-only | `approved`, `concerns[{concern, blocking}]` |
| build | B, default | build tools | `changed_files[]`, `commit_message` |
| fix | resume B | build tools, test edits blocked | same as build |
| reconcile | resume B | build tools | `plan_markdown` |
| verify | fresh, cheap, verifier agent | Bash, Read | `passed`, `observations[]` |
| review | fresh, strong, reviewer agent | read-only | `approved`, `findings[{severity, file, line, finding}]`, `review_markdown` |
| revise | resume B | build tools | same as build |
| done-check | fresh, strong | read-only plus Bash of configured commands | `met`, `evidence[{criterion, met, evidence}]`, `outcome_markdown` |
| lessons | fresh, cheap | read-only | `lessons[]`, `claude_md_additions` |

Envelopes are Zod schemas in `src/envelopes.ts`. The JSON Schema passed to
`--json-schema` is generated from the Zod schema, so there is one definition.

## 8. Stage flows

Every step below is a phase: named, traced, fails by default. Any uncaught
error in a phase blocks the intent with the error's first line as the note and
the full error in the trace.

### Stage 1 and 2: intent to spec

1. `accepted` → runtime sets `designing`.
2. `before` commands for design.
3. **intake**: fills missing `priority`; if required sections are missing or
   `question` is set, block with that question as the note.
4. **design**: runtime writes `spec.md` from `spec_markdown`. Concerns go
   under an "Areas of concern" heading in the spec.
5. `after` commands. Commit `spec.md` on main.
6. Spec gate, in the same step: code check that required headings exist;
   **spec-check** if `gates.spec.agent`. Pass with no person on the gate →
   `spec-approved`. Pass with `gates.spec.human` set → `spec-review` with a
   note ("Read spec.md. When you are happy with it, change the status line
   to spec-approved."), so `spec-review` only ever means "checks passed,
   waiting for a person". Any check failing → one resend of design with the
   findings (marker `redesigned` in the run folder), then block. A checker
   that cannot run at all blocks at once.

(Gate timing rule, 2026-09-28 hardening: automated checks always run in the
step that produced the artifact; a review status is a wait for a person and
stepping it never advances.)

### Stage 3: plan and build

7. `spec-approved` → `planning`. **plan** with `--permission-mode plan`.
   Runtime writes `plan.md`. Commit on main.
8. Plan gate, in the same step: code check of headings and that listed
   files exist or are marked new; **plan-challenge** if enabled. Failing
   checks → one resend of plan with the concerns (marker `replanned`), then
   block. Pass → `plan-approved`, or `plan-review` when a person is on the
   gate, as for spec.
9. `plan-approved` → `building`. Runtime creates branch `intent/<slug>` from
   `main_branch` and a worktree under `.loopstra/worktrees/<slug>`. If both
   already exist (retry), reuse them.
10. `before` commands for build. **build** in the worktree. The runtime
    commits anything left uncommitted with the envelope's `commit_message`.
11. Plan drift check: `git diff --name-only main_branch...HEAD` versus the
    plan's files. Extra files → **reconcile** rewrites `plan.md`; runtime
    commits it on the branch.

### Stage 4: test

12. Test loop, up to `max_fix_loops`: run `commands.test`, then `lint`, then
    `build` if configured. First failure's output goes to **fix** with
    `LOOPSTRA_PHASE=fix` in the environment so the protect-tests hook denies
    edits to test files. Green → continue. Exhausted → block.
13. **verify**: the verifier subagent runs `commands.run` if configured,
    exercises the change, and reports. `passed: false` → one more fix loop
    with the observations, then block.

### Stage 5: review and merge

14. Status `reviewing`. Review rounds, up to `max_rounds`: **review** writes
    `review.md`. Findings with severity `important` → **revise**, then the
    test loop again, then review again. Exhausted with open important
    findings → block.
15. `after` commands for build. If a remote exists: push, open PR titled
    `<slug>: <intent title>` with a body linking the artifacts and the review
    summary, and post the findings as a comment. Status `merge-review`.
16. Merge gate, in the same step as the approving review (gate timing
    rule): branch contains `main_branch` tip (otherwise rebase), the test
    loop passes, and the newest review had no important findings. If the
    test loop committed fixes, the change is reviewed again (the round
    count continues; exhausted → block), so nothing reaches main that a
    review did not see. Pass with no person → merge now; with a person →
    `merge-review` with a plain note, and the person sets `merge-approved`,
    whose step re-checks and merges. Merging requires the root checkout on
    `main_branch` with no staged or unstaged changes to tracked files;
    otherwise block. A `merging` marker in the run folder makes a merge
    interrupted after it landed finish as merged instead of merging twice.
    Merge with `gates.merge.method`. Status `merged`. Remove the worktree and
    delete the branch (best effort; the scheduler retries). The PR path
    (`gates.merge.human: pr`, PR checks, approvals) is wired in Plan 3;
    until then `pr` blocks plainly.

### Stage 6: verify and maintain

17. Signal `main_health` runs on the tick after a merge (a
    `.loopstra/health-pending` file written at merge) and whenever the
    newest check is older than the interval: `commands.test` (after
    `commands.install`) on `main_branch` in a throwaway detached worktree at
    `.loopstra/health/main`. The baseline is the newest result that was not
    an error. Red after green → open `intent/<generated-slug>/intent.md` in
    draft, in plain language (what merged, a proposed outcome); the test
    output goes to the trace. No baseline yet → record only. Install or
    setup problems record `error` and open nothing. The generated slug is
    `fix-tests-after-<slug>`, or `fix-tests-on-main-<local date>`.
18. While the status is `merged` (so a restart resumes it): **done-check**
    judges each "Done when" criterion as met, unmet, or needs-person, in a
    throwaway detached worktree of main. The runtime always writes
    `outcome.md`, adding "For a person to confirm" for needs-person items
    (they never block). A judge that cannot finish blocks plainly; it is
    never read as criteria unmet.
19. **lessons**: appended to `outcome.md` under "Lessons" and "Proposed
    CLAUDE.md additions". The skill's `apply-lessons` command copies the
    additions into `CLAUDE.md` for review. Then the verify `after`
    commands. Unmet criteria → block, pointing at outcome.md. No person on
    the done gate → `done`; a person → `verifying` with a plain note (it
    only ever means "waiting for a person"), and the person sets `done`.
20. Commit `outcome.md` on main.

Signals also run on their interval regardless of intents.

## 9. The Claude adapter

`src/claude.ts` exposes one function:

```ts
runPhase({ cwd, prompt, schema, model, permissionMode, allowedTools,
           resume?, timeoutMs, maxBudgetUsd, env, onEvent }) →
  { sessionId, structuredOutput, costUsd, usage, exitCode, durationMs }
```

Behavior:

- Resolves the executable with `Bun.which("claude")`; on Windows this finds
  `claude.cmd`. Spawns with `Bun.spawn`, the prompt piped on stdin, args:
  `-p --output-format stream-json --verbose --json-schema <json>
  --model <m> --permission-mode <mode> --allowedTools <list>
  --max-budget-usd <n> [--resume <id>]`.
- Never sets `ANTHROPIC_API_KEY` and never passes `--bare`, so subscription
  auth and the repo's CLAUDE.md, skills, agents, and hooks all apply.
- Parses each stdout line as JSON. Captures `session_id` from the init
  event. Forwards every event to `onEvent` for tracing. Reads
  `structured_output`, `total_cost_usd`, `usage`, and `subtype` from the
  result event.
- Kills the process after `timeoutMs` and returns a failure. A result subtype
  other than `success` is a failure with the subtype as the reason.
- The read-only tool set is `Read, Glob, Grep, LS` and for verify and
  done-check additionally `Bash(<each configured command>)`.

The adapter is the only module that knows the CLI exists. Tests use a fake
`claude` script that replays fixture JSONL.

## 10. Git and GitHub

`src/git.ts` wraps `git` with `Bun.spawn`: branch, worktree add and remove,
commit paths, diff names, merge-base, contains, rebase, merge, log.
`src/github.ts` wraps `gh`: remote detection, PR create, PR view (state,
reviews, checks), PR comment, PR merge. All calls are logged to the trace.
The runtime never pushes to `main_branch` directly; it merges through the
merge gate only.

### Artifact commits

Artifacts under `intent/` (`intent.md` status changes, `spec.md`, `plan.md`,
`outcome.md`, `queue.md`) are markdown, not code. The runtime commits them
on `main_branch` directly and pushes when a remote exists, with the message
`loopstra(<slug>): <what changed>`. This is the course's model: the file
pair is committed alongside the intent, and git history is the audit trail.
Consequence: the runtime's git identity must be allowed to push markdown
under `intent/` to `main_branch`. Teams with strict branch protection grant
that bypass to the runtime's account or set the spec and plan gates to
`human: pr`, which delivers those artifacts as PRs instead. Code never takes
this path; it always goes through the merge gate.

## 11. Trace and observability

`src/trace.ts` writes every event twice: appended to
`.loopstra/runs/<slug>/events.jsonl` and inserted into `.loopstra/trace.db`
(Bun's built-in SQLite, WAL). Tables: `intents` (slug, status, priority,
updated), `phases` (slug, seq, name, kind, status, started, ended, cost,
session_id, error), `events` (rowid, slug, phase_seq, type, ts, payload
JSON), `gates` (slug, gate, check, result, evidence, ts), `signals` (name,
ts, result, output).

Event types: `tick`, `phase_start`, `claude_event`, `command`, `gate_check`,
`status_change`, `phase_end`, `error`, `signal`.

CLI on top:

- `loopstra status`: table of intents with status, current phase, last
  activity, cost so far, and the note if blocked.
- `loopstra tail [slug]`: streams events as they are written.
- `loopstra ui`: serves a single HTML page from `Bun.serve` on
  `localhost:4646` with a JSON API over the trace db, polling every two
  seconds. Shows the queue, each intent's phase timeline, gate results with
  evidence, cost, and the last 200 events. No build step, no framework.

## 12. The operator skill

`.claude/skills/loopstra/SKILL.md` gives an interactive session these
behaviors, each a short section, not a cookbook tree:

- **Onboard**: run `loopstra init`, then confirm the detected commands,
  choose which gates get a person, and name any skills each stage should
  load. Writes the answers into `config.yaml`.
- **Draft an intent**: interview the owner in plain language, write
  `intent/<slug>/intent.md` from the template, and stop. The owner sets
  `accepted`.
- **Status**: run `loopstra status` and explain it in plain language.
- **Unblock**: read the note, explain the options, and on the person's say
  set the status back to the last approved state or to `closed`.
- **Tune**: edit prompts, gates, and stage settings in `config.yaml`.
- **Apply lessons**: copy proposed CLAUDE.md additions from an
  `outcome.md` into `CLAUDE.md` for review.

The skill never runs `loopstra start` and never performs a stage by hand.

## 13. `loopstra init`

Deterministic and idempotent. Never overwrites a file that exists unless
`--force`. Steps:

1. Detect commands: `package.json` scripts (test, lint, build, start),
   `Makefile` targets, `pyproject.toml`, `Cargo.toml`, `go.mod`. Write what
   it finds; leave `commands.test` empty with a comment if nothing is found,
   which makes `loopstra start` refuse to run until it is set.
2. Write `loopstra/config.yaml` and `loopstra/prompts/*.md` from templates.
3. Write `intent/README.md` and `intent/queue.md`.
4. Write `REVIEW.md`, `.claude/agents/verifier.md`,
   `.claude/agents/reviewer.md`, `.claude/skills/loopstra/SKILL.md`,
   `.claude/hooks/loopstra-protect-tests.ts`.
5. Merge a `PreToolUse` hook entry for `Edit|Write` into
   `.claude/settings.json`, preserving existing content.
6. Add a Commands block to `CLAUDE.md` if absent, and `.loopstra/` to
   `.gitignore`.
7. Print what was written and what the engineer should check next.

The protect-tests hook: reads the tool input from stdin, and if
`LOOPSTRA_PHASE=fix` and the path matches a test pattern (`*.test.*`,
`*.spec.*`, `/tests/`, `/__tests__/`), exits 2 with a message. Otherwise
exits 0.

## 14. Runtime process

`loopstra start [--once]`: validates config, checks `claude`, `git`, and (if
a remote exists) `gh` are available, then loops: tick, sleep
`poll_seconds`. `--once` runs one tick and exits, for tests and cron. A tick:

1. Load config. On validation failure, log and sleep; never crash on a bad
   edit.
2. Run due signals.
3. Scan intents, consistency-check, regenerate `queue.md`.
4. Poll waiting gates (human status changes are picked up by the scan; PR
   state via `gh`).
5. Pick the top runnable intent and run exactly one stage step for it.
6. Sleep.

One step per tick keeps the loop legible and interruptible. A step is
bounded by its phase timeouts. The loop never dies: a tick's own problem is
traced and the next tick comes; an unreadable intent.md is listed under
"Needs a person" and the rest carry on. Ctrl-C (SIGTERM, SIGBREAK) asks for
a stop: no new session or command starts, one in flight is killed, its
phase is marked `interrupted`, and the intent keeps its in-progress status
(it is never blocked for this), which the next start resumes; steps are
idempotent. The sleep between ticks ends at once. A second Ctrl-C exits
with 130.

Resumption: `sessions.json` maps phase names to session IDs. A build
continuation resumes session B if present. If `--resume` fails (session gone),
the runtime starts a fresh session and records it.

## 15. Errors and budgets

- Per-phase timeout and dollar budget from config. Both are failures that
  count against the phase's retry budget, then block.
- Command failures in `before`/`after` block immediately.
- Git or GitHub command failures block with the stderr's last line.
- The runtime's own exceptions inside a tick are caught at the tick
  boundary, logged, and the loop continues with the next tick.
- Cost per intent is summed from result events and shown in `status`.

## 16. Repository layout of Loopstra itself

```
package.json              bin: loopstra → src/cli.ts; bun test; zod, yaml
src/
  cli.ts                  init | start | status | tail | ui | apply-lessons
  config.ts               schema, defaults, load
  intents.ts              frontmatter parse/write, scan, consistency, queue
  scheduler.ts            tick
  stages/                 design.ts plan.ts build.ts test.ts review.ts merge.ts verify.ts
  phases.ts               phase runner, envelopes, retries
  gates.ts                gate evaluation
  checks.ts               deterministic checks
  claude.ts               CLI adapter
  git.ts  github.ts
  prompts.ts              template rendering
  envelopes.ts            Zod schemas
  trace.ts                JSONL + SQLite
  signals.ts              main_health
  init.ts                 stamping
  ui/index.html           dashboard
templates/                everything init stamps
tests/
  fake-claude/            fake claude executable and fixtures
  unit/  integration/
docs/
```

## 17. Testing strategy

- Unit: config validation, frontmatter round-trip, state consistency, queue
  order, prompt rendering, envelope schemas, gate evaluation with fake
  checks, stream-json parsing from fixtures, git helpers against a temp repo.
- Integration: `loopstra init` into a temp repo; a full tick sequence driving
  one intent from `accepted` to `done` in a temp git repo using the fake
  `claude` and a trivial `bun test` project, with no remote; the protect-tests
  hook denying a test edit; the `status` and `ui` API against a seeded trace.
- Every stage is written test-first.

## 18. Milestones

1. Skeleton: package, CLI, config, intents, trace, `status`.
2. Claude adapter with the fake `claude` and fixture replay.
3. Stages 1 to 3 through `plan-approved`, no git branching yet.
4. Build and test stages with worktrees and the hook.
5. Review and local merge.
6. Stage 6: done-check, lessons, `main_health`.
7. GitHub: PR open, checks, approval, merge.
8. `init` templates, skill, prompts, `tail`, `ui`.
9. End-to-end integration test and README.
