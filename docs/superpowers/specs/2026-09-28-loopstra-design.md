# Loopstra design spec

Date: 2026-09-28. Status: approved for planning. Source of decisions:
`docs/decisions.md`. When this spec and that file disagree, fix this spec.

## 1. What Loopstra is

Loopstra is an unattended, continuously running software development loop
built on Claude Code. It takes a change from a plain-language intent through
design, planning, building, testing, review, merge, and verification, using
the six stages of Anthropic's AI-Native SDLC Playbook, and then keeps watching
the main branch so failures become new intents.

Four parts:

1. **The runtime**, a Bun process (`loopstra start`) that owns the loop. It
   decides what runs next, retries, gates, and records everything. Code owns
   sequencing, retries, and acceptance.
2. **Claude Code sessions**, spawned headlessly by the runtime one per phase.
   An agent owns only the work inside one bounded phase.
3. **The operator skill**, a Claude Code skill installed into the target repo
   so an interactive session can onboard, inspect, unblock, and tune. It never
   runs the loop.
4. **The orchestrator chat** (`loopstra chat`, and a panel in `loopstra ui`),
   added 2026-10-01: a read-only agent people talk to for updates and to work
   out new changes, which a writer turns into draft intents through a pull
   request. It never runs the loop or writes the main checkout (§17).

Non-goals for v1: parallel intents, custom stages, continuous production
metrics, a hosted service, any UI beyond a local dashboard and the chat
surfaces of §17 (terminal, dashboard panel, Slack and Discord bots).

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
    outcome.md                    Stage 6 evidence, for the owner
    lessons.md                    Stage 6 lessons and proposed CLAUDE.md additions, for engineers
loopstra/
  config.yaml                     all machinery configuration
  prompts/<phase>.md              editable prompt per agent phase, plus
                                  orchestrator.md and write-intent.md for chat
REVIEW.md                         review policy read by the reviewer
CLAUDE.md                         maintained per the course; init adds a Commands block
.claude/
  skills/loopstra/SKILL.md        operator skill
  hooks/loopstra-protect-tests.ts hook: blocks test edits during fix phases
  settings.json                   hook wiring (merged, not overwritten)
.loopstra/                        gitignored
  trace.db                        SQLite trace
  runs/<slug>/                    per-intent runtime state
    sessions.json                 phase → claude session id
    events.jsonl                  append-only event log
    phases/<n>-<phase>/           prompt.md, raw.jsonl, envelope.json
  worktrees/<slug>/               git worktree for the intent branch
  chat/                           chat state (§17): threads/, requests/, results/,
                                  announcements.jsonl, announcer.lock, worktrees/
```

Slugs are lowercase words joined by hyphens, chosen by the owner, and are the
folder name, the branch name (`intent/<slug>`), and the PR title prefix. A
folder whose name does not match `^[a-z0-9][a-z0-9-]*$` is listed under
"Needs a person" with "Rename the folder to lowercase words joined by
dashes, like add-numbers." A frontmatter key Loopstra does not know is
listed the same way: "intent.md has a line Loopstra does not recognise:
'<key>'. Remove it or fix the spelling."

## 3. The intent file

```markdown
---
status: draft
priority: normal          # low | normal | high | urgent; optional, intake fills it in
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
| merge-review | runtime | Reviewed and its merge checks passed; waiting for a person, or with a remote for its pull request (checks, approval). |
| merge-approved | runtime or human | Merge gate passed; the next step re-checks and merges. |
| merged | runtime | On main. Done-when checks, outcome, and lessons run from here. |
| verifying | runtime | Outcome written; waiting for a person to confirm. |
| done | runtime | Terminal. |
| blocked | runtime | Needs a person. `note` says what and why. |
| closed | human | Terminal. Dismissed. |

A person's edits are never overwritten. The runtime re-reads intent.md
right before every write and changes only the frontmatter lines it owns
(status, note, resume_from, priority), textually, so the body, other keys,
comments, key order and line endings stay as the person left them. If the
status on disk is no longer the one the step started with, a person
changed it while the step ran: the runtime writes nothing, records
`person-changed-status` in the trace, and ends the step without blocking;
the next tick picks up the person's status.

Runnable means: not draft, not blocked, not done, not closed, and not a
review status whose gate is waiting on a person. With a remote,
`merge-review` is always runnable: its step watches the pull request.

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

`queue.md` also lists, under "Needs a person", every change waiting for
one (blocked, drafts, and reviews with a person on the gate) with its note,
and done or closed intents in a section of their own. It is regenerated,
never edited, and committed only along with another runtime commit (§10).

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
  run: bun run start            # optional; used by the verify session

claude:
  models:
    default: sonnet             # any alias or id the CLI accepts
    cheap: haiku
    strong: opus
  timeout_minutes: 30           # per phase; the process is killed past this
  max_budget_usd: 5             # per phase, passed to --max-budget-usd
  allowed_tools:                # for the build session, plus Bash(<cmd> *) for each
                                # configured command; judges get read-only
    - Read
    - Edit
    - Write
    - Glob
    - Grep
    - Bash(bun *)
    - Bash(git diff *)          # git that only reads; the runtime makes every
    - Bash(git log *)           # commit, branch, and merge itself
    - Bash(git show *)
    - Bash(git status *)

gates:
  # No intent gate: a person always accepts an intent (draft → accepted).
  spec:   { human: none, agent: true }          # human: status | none
  plan:   { human: none, agent: true }
  merge:  { human: none, method: squash }   # human: status | pr | none; method: squash | merge
  done:   { human: none, agent: true }          # human: status | none

stages:
  design:  { model: strong,  skills: [], before: [], after: [] }
  plan:    { model: strong,  skills: [], before: [], after: [] }
  build:   { model: default, skills: [], before: [], after: [], max_fix_loops: 3 }
  review:  { model: strong,  skills: [], before: [], after: [], max_rounds: 2 }
  verify:  { model: cheap,   skills: [], before: [], after: [] }

signals:
  main_health:
    every_minutes: 30           # also runs after every merge

chat:                           # optional; see §17
  model: default                # the orchestrator; the writer uses stages.design.model
  max_budget_usd_per_day: 5     # chat turns and writer runs together, since local midnight
  transports:                   # each optional
    slack:
      token_env: LOOPSTRA_SLACK_APP_TOKEN    # environment variable names, never tokens
      bot_token_env: LOOPSTRA_SLACK_BOT_TOKEN
      channel: C0123ABCD
      allow: []                 # who may chat; empty: anyone in the channel
      acceptors: []             # who may also start drafts; empty: nobody from here
      announce_to: C0123ABCD    # optional
    discord:
      token_env: LOOPSTRA_DISCORD_TOKEN
      channel: "1234567890"
      allow: []
      acceptors: []
      announce_to: "1234567890"
```

`before` and `after` are lists of commands. A non-zero exit from a `before`
command blocks the intent with the command's last output line as the note. A
non-zero `after` command is recorded and blocks likewise.

`skills` are names under `.claude/skills/`. The runtime mentions them by name
at the top of the phase prompt ("Use the `brand-guidelines` skill.") so the
session loads them.

## 7. Prompts and envelopes

Each agent phase has a prompt file in `loopstra/prompts/` rendered with a
small set of `{{variables}}` (the list is `PROMPT_VARS` in `src/prompts.ts`):
`{{slug}}`, `{{main_branch}}` and `{{commands}}` are always set; the others
are `{{intent}}`, `{{priority}}`, `{{spec}}`, `{{plan}}`, `{{review}}`,
`{{previous}}` (the failed phases so far, for lessons), `{{failure_output}}`,
`{{findings}}`, `{{concerns}}`, `{{done_when}}`, `{{test_result}}` (what the
runtime's own test run says about the code a judge sees),
`{{test_command}}`, and `{{run_command}}`. `{{commands}}` is the plain list
of shell commands the session's tool set allows (for example `` `bun test`,
`git diff` ``, or `none`), so a prompt can say exactly what may be run.
Missing variables render as `(none)`. Skills are not a variable: they are
named in one line at the top of the prompt. Every prompt ends with the same
two contract lines ("Set `status` to fail only if …" and "Respond only
through the structured output."); the runtime appends them after the
rendered template, so templates leave them out (a copy an older init stamped
at the end of a prompt is dropped first, never doubled). Prompts are stamped
by init and edited like code.

Phases and their envelopes (all include `status: "success" | "fail"` and
`summary`):

| Phase | Session | Tools | Envelope adds |
|---|---|---|---|
| intake | fresh, cheap | read-only | `priority`, `question` |
| design | fresh, strong, plan mode | read-only | `spec_markdown` (concerns are its "Areas of concern" heading; the owner sections are plain language) |
| spec-check | fresh, strong | read-only | `approved`, `findings[{requirement, met, evidence}]` |
| plan | fresh, strong, plan mode | read-only | `plan_markdown` (its "Files that change" list is the file list) |
| plan-challenge | fresh, strong | read-only | `approved`, `concerns[{concern, blocking}]` |
| build | B, default | build tools (`claude.allowed_tools` plus the configured commands, install included) | `commit_message` (the changed files come from git) |
| fix | resume B | build tools, test edits blocked | same as build |
| reconcile | resume B | build tools | `plan_markdown` |
| verify | fresh, cheap | read-only plus Bash of configured commands and read-only git | `passed`, `observations[]` |
| review | fresh, strong | read-only plus read-only git | `approved`, `findings[{severity, file, line, finding}]`, `review_markdown` |
| revise | resume B | build tools | same as build |
| done-check | fresh, strong | read-only plus Bash of configured commands and read-only git | `evidence[{criterion, result (met, unmet, or needs-person), evidence}]` (plain words for the owner), `outcome_markdown` (`# Outcome`, `## Outcome`, `## Evidence`) |
| lessons | fresh, cheap | read-only | `lessons[]`, `claude_md_additions` |

Envelopes are Zod schemas in `src/envelopes.ts`. The JSON Schema passed to
`--json-schema` is generated from the Zod schema, so there is one definition.

The two chat phases (§17) are not stage phases: they have their own schemas
in `src/chat/schemas.ts`, their own variables (`CHAT_PROMPT_VARS` in
`src/chat/agents.ts`: `{{main_branch}}`, `{{brief}}`, `{{existing}}`,
`{{template}}`, `{{updates}}`, `{{problems}}`), are traced under the `_chat`
slug, and fall back to the shipped template when the repository has none.

| Phase | Session | Tools | Output |
|---|---|---|---|
| orchestrator | one per chat thread, resumed each message; `chat.model` | read-only plus `loopstra status` and read-only git | `reply`, `handoff` (title, brief, updates) or null, `accept` (slug) or null |
| write-intent | fresh per hand-off, `stages.design.model` | the same | `status`, `summary`, `intents[{slug, title, priority, depends_on, problem, proposed_outcome, done_when, affected_users_and_systems, constraints, open_questions}]` |

## 8. Stage flows

Every step below is a phase: named, traced, fails by default. Any uncaught
error in a phase blocks the intent with the error's first line as the note and
the full error in the trace.

### Stage 1 and 2: intent to spec

1. `accepted` → runtime sets `designing`.
2. `before` commands for design.
3. **intake**: fills missing `priority`; if `question` is set, block with that
   question as the note. (Missing required sections never reach intake: the
   scan's consistency check blocks first, "This request is missing a Proposed
   outcome and a Done when section. Add them to intent.md, then set status to
   accepted.")
4. **design**: runtime writes `spec.md` from `spec_markdown`. Concerns are
   the spec's own "Areas of concern" heading. Summary, Requirements, Out
   of scope, Open questions, and Areas of concern are written for the owner
   in plain language (no code, regular expressions, file paths, or function
   names); Design and Affected code are for engineers. spec-check treats a
   technical owner section as a finding that is not met.
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
    files of main's `plan.md`. Extra files → **reconcile** returns the plan
    as it now stands; the runtime keeps it in the run folder
    (`plan.reconciled.md`), never on the branch or main. Verify and review
    use the reconciled plan when there is one, else main's `plan.md`; the
    plan is never read from the branch. A new build (every build step)
    clears it, so a retry is compared with main's plan again.

### Stage 4: test

12. Test loop, up to `max_fix_loops`: run `commands.test`, then `lint`, then
    `build` if configured. The first failing command and the end of its
    output go to **fix** with
    `LOOPSTRA_PHASE=fix` in the environment so the protect-tests hook denies
    edits to test files. Green → continue. Exhausted → block.
13. **verify**: a fresh read-only session runs `commands.run` if configured,
    exercises the change, and reports. It is told the tests passed and not
    to run them again. `passed: false` → one more fix, told "The checks
    pass; the verifier found the change does not do what the spec says:"
    and the observations, then the test loop and verify again, then block.

### Stage 5: review and merge

14. Status `reviewing`. Review rounds, up to `max_rounds`: **review** writes
    `review.md`. The reviewer is told the runtime's test result on the
    code it reviews (`{{test_result}}`), not to run tests, and never to
    report unverified tests as a finding. Findings with severity `important` → **revise**, then the
    test loop again, then review again. Exhausted with open important
    findings → block.
15. `after` commands for review.
16. Merge gate, in the same step as the approving review (gate timing
    rule): branch contains `main_branch` tip (otherwise rebase), the test
    loop passes (skipped when the tests already passed on the same code:
    the same commit, or one that differs only under `intent/`, with the
    same test, lint and build commands; the `tested` run-folder marker),
    and the newest review had no important findings. If the
    test loop committed fixes, the change is reviewed again (the round
    count continues; exhausted → block), so nothing reaches main that a
    review did not see.
    - **No remote.** Pass with no person → merge now; with a person →
      `merge-review` with a plain note, and the person sets
      `merge-approved`, whose step re-checks and merges. `human: pr` blocks
      plainly (there is nowhere to open a pull request; `merge-approved`
      merges locally instead). The merge step first commits the change's
      own `intent/<slug>/` folder, so a person's uncommitted
      `merge-approved` counts. Merging then requires the root checkout on
      `main_branch` with nothing staged and no unsaved changes to tracked
      files outside `intent/` (a person's unsaved edits to other intents
      never block it); otherwise block. A `merging` marker in the run
      folder makes a merge interrupted after it landed finish as merged
      instead of merging twice. Merge with `gates.merge.method`: `squash`
      is a commit with the branch's tree on top of main
      (`commit-tree`) and a fast-forward to it, so it lands whole or not
      at all; `merge` is `merge --no-ff`.
    - **With a remote (the PR gate).** Share main (Main sync), then push the branch
      (`--force-with-lease`, since the checks may have rebased it), open a
      PR titled `<slug>: <intent title>` if none is open (body: the artifact
      paths and the review summary; `review.md` as a comment), and trace its
      number and link. Status `merge-review` with a note per
      `gates.merge.human`: `none` "Waiting for the automatic checks on
      GitHub."; `pr` "A pull request is open. Approve it on GitHub to
      merge, or close it to stop."; `status` the usual status-line note.
      `merge-review` stays runnable in every mode and each tick's merge
      step looks at the PR: merged on GitHub → recorded; closed → block;
      with `status`, anything else waits for a person to set
      `merge-approved`; otherwise checks pending (or `gh` not answering) or,
      for `pr`, not approved yet → wait, changing nothing; checks failed →
      block; PR closed → block ("Set status to closed, or to plan-approved
      to rebuild."); otherwise merge with `gh pr merge` and
      `gates.merge.method`. With `status`, the person sets `merge-approved`
      and the step requires the PR checks to pass, then merges. For `pr`, a
      person setting `merge-approved` counts as the approval. A PR already
      merged (on GitHub, or by a step that stopped before recording it) is
      recorded, never merged again.
    After either merge: sync main (with a remote), status `merged`, write
    `.loopstra/health-pending`, remove the worktree and delete the branch
    (best effort; the scheduler retries). Cleanup happens only when main
    already has the branch's changes; otherwise (for example `merged` set by
    hand) the branch and worktree stay, and the reason is traced once.
    A `closed` change's worktree is removed by the scheduler once it
    holds nothing uncommitted; its branch is kept.

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
19. **lessons**: written to `lessons.md` (for engineers) under "Lessons"
    and "Proposed CLAUDE.md additions"; `outcome.md` keeps only Outcome,
    Evidence, Not met, and For a person to confirm. `loopstra
    apply-lessons <slug>` copies the additions into `CLAUDE.md` for review.
    Then the verify `after` commands. Unmet criteria → block, pointing at outcome.md. No person on
    the done gate → `done`; a person → `verifying` with a plain note (it
    only ever means "waiting for a person"), and the person sets `done`.
20. Commit `outcome.md` and `lessons.md` on main.

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
  other than `success` is a failure with the subtype as the reason. A
  `--resume` whose session is gone ("No conversation found" on stderr) is
  `no-session`, checked before the result, since the CLI also sends an
  `error_during_execution` result then.
- A build session (build, fix, reconcile, revise) may use
  `claude.allowed_tools` plus `Bash(<cmd> *)` for each configured command
  (test, lint, build, run, install), so it can run the tests it must pass.
- The read-only tool set is `Read, Glob, Grep` (the write tools are removed
  with `--disallowedTools`) and for verify and done-check additionally
  `Bash(<each configured command>)` and read-only git. Every session also
  loses the `PowerShell` tool, so on Windows shell commands go through Bash,
  which the allow rules cover.
- Reads `permission_denials` from the result event: the commands the session
  tried and was not allowed to run are kept on the phase in the trace (as
  allow-rule text, e.g. `Bash(git tag v1)`) and shown by the dashboard and
  `tail` ("N commands were not allowed"), so an engineer can add allow
  rules. The owner note stays plain.

The adapter is the only module that knows the CLI exists. Tests use a fake
`claude` script that replays fixture JSONL.

## 10. Git and GitHub

`src/git.ts` wraps `git` with `Bun.spawn`: branch, worktree add and remove,
commit paths, diff names, merge-base, contains, rebase, merge, log.
`src/github.ts` wraps `gh`: remote detection, PR create, PR view (state,
reviews, checks), PR comment, PR merge. All calls are logged to the trace.
Every `gh` call and every git call is bounded by a timeout (git: 5 minutes;
past it the call and everything it started are killed) and never prompts
for credentials or keys. A stop request lets a running git call finish for
a moment, then kills it; aborts that put a checkout back always run. A git
call that times out inside a step blocks the intent with "A
version-control command did not finish in time; an engineer should look."
Every commit the runtime makes is authored `Loopstra <loopstra@localhost>`
with `--no-verify` and `-c commit.gpgsign=false` (one constant in
`src/git.ts`): the gates run the configured checks, not the owner's commit
hooks. On POSIX every child process gets its own process group so a kill
reaches everything it started. Code never reaches `main_branch` except
through the merge gate.

### Main sync

With a remote, at the start of each tick and after a PR merge, if the root
checkout is on `main_branch` with no staged or unstaged changes to tracked
files (an unsaved `intent/queue.md` aside: it is generated, so it is put
back and written again later in the tick): fetch, then rebase local main
onto the remote's main (`pull --rebase`), so a PR merged on GitHub and an
owner's status edit made on GitHub or pushed from another clone reach this
checkout, and that tick's scan sees them. Then Loopstra's own records are
shared: main is pushed when every commit the remote's main lacks is
authored by Loopstra. Artifact commits are not pushed one by one: main is
shared once at the end of each tick (when that tick's sync went through),
and before an intent branch is pushed for its PR. A person's unpushed commits are
theirs to share, so then nothing is pushed and the `main_sync` signal waits
("Main has your own unpushed commits; Loopstra will share its records
after you push yours."). A refused push (a protected branch) is a
`main_sync` failure and the loop carries on. Intent branches are pushed
for their PRs, right after main is shared, and the merge checks have
rebased the branch onto main, so its PR shows only the change. A
rebase conflict only inside `intent/` takes the remote's version (an
owner's edit on GitHub wins over the local record; a merged PR also
carries the artifacts committed before its branch was last rebased). Any
other conflict aborts the rebase, and the loop carries on unsynced until
an engineer resolves it. Nothing here ever stops the tick. Every outcome
(pass, waiting, fail, in plain words) is the `main_sync` signal, written
only when it changes, with the technical detail in the trace; the
dashboard's attention list shows it while it is waiting or failing.

### Artifact commits

Artifacts under `intent/` (`intent.md` status changes, `spec.md`, `plan.md`,
`review.md`, `outcome.md`, `lessons.md`) are markdown, not code. The runtime
commits them on `main_branch` directly (shared as described in Main sync),
with the message `loopstra(<slug>): <what changed> [skip ci]`: bookkeeping
does not start CI; the change's own merge commit (`<slug>: <title>`) does.
`queue.md` is written every tick and committed only along with another
runtime commit (it rides in the next one), so a tick with nothing else to
record adds no commit; its unsaved copy never blocks a merge or a sync.
This is the course's model: the file
pair is committed alongside the intent, and git history is the audit trail.
The loop's checkout is the source of truth for status; with a remote,
the records reach GitHub's main when only Loopstra's commits are ahead.
Code never takes this path; it always goes through the merge gate.

## 11. Trace and observability

`src/trace.ts` writes every event twice: appended to
`.loopstra/runs/<slug>/events.jsonl` and inserted into `.loopstra/trace.db`
(Bun's built-in SQLite, WAL). Tables: `intents` (slug, status, priority,
updated), `phases` (slug, seq, name, kind, status, started, ended, cost,
session_id, error), `events` (rowid, slug, phase_seq, type, ts, payload
JSON), `gates` (slug, gate, check, result, evidence, ts), `signals` (name,
ts, result, output).

A `trace.db` that cannot be read as a database is moved aside to
`trace.db.corrupt-<time>` and a fresh one is started, with a plain console
line and an event in the new one; the loop and the dashboard keep working.

Event types: `tick`, `phase_start`, `claude_event`, `command`, `gate_check`,
`status_change`, `phase_end`, `error`, `signal`, `stop`,
`person-changed-status`, `pause`, `stale-lock-removed`, and for chat
`chat-message`, `chat-request`, `chat-pr`.

CLI on top:

- `loopstra status`: the loop line (running, paused, stopping, stopped,
  "Stopped — it did not shut down cleanly" when the heartbeat's process is
  gone, not responding when it is there but silent; a stopped loop with a
  pause pending adds "The assistant was unavailable; the next start waits
  until 14:32."), then the "Needs attention" block (the same list as the
  dashboard's, from `src/attention.ts`; "Nothing needs you right now." when
  empty), then a table of changes: name, priority, where it is in plain
  words, last phase and its result, cost so far, and the note. The last
  column is never padded; notes wrap to the terminal width.
- `loopstra tail [slug]`: streams events as they are written (the first
  screen is the newest 50, read with a bounded query).
- `loopstra chat [--no-terminal]`: the orchestrator in the terminal and on
  the configured bots (§17). `--no-terminal` runs only the bots.
- `status`, `tail`, `ui` and `chat` in a folder without `loopstra/config.yaml` say
  "This folder is not set up for Loopstra. Run loopstra init first." and
  create nothing.
- `loopstra ui`: serves a single HTML page from `Bun.serve` on
  `127.0.0.1:4646` (local only) with a JSON API over the trace db, polling every two
  seconds. Shows the queue, each intent's phase timeline, gate results with
  evidence, cost, links to the change's own documents (served read-only as
  text/plain from `/docs/<slug>/<name>`, slug and name checked, the real path
  kept inside the change's folder), and the last 200 events, and a "needs
  attention" list (a pause, a red main, `main_sync` waiting or failing, a
  config problem, "Blocked" changes, unreadable intents, and changes
  "Waiting for you"). No build step, no framework. Unless started with
  `--no-chat` it also has the chat panel (§17): the only writes it takes are
  `POST /api/chat` from its own origin on a local host name, and the cost
  totals include what chat spent.

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
- **Apply lessons**: copy proposed CLAUDE.md additions from a change's
  `lessons.md` into `CLAUDE.md` for review.
- **Chat**: explain `loopstra chat`, the dashboard panel and the bots, and
  point to the README for setting a bot up.

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
4. Write `REVIEW.md`, `.claude/skills/loopstra/SKILL.md`,
   `.claude/hooks/loopstra-protect-tests.ts`. (No subagent files: the
   runtime runs its judges as fresh sessions itself.)
5. Merge a `PreToolUse` hook entry for `Edit|Write` into
   `.claude/settings.json`, preserving existing content.
6. Add a Commands block to `CLAUDE.md` if absent, and `.loopstra/` to
   `.gitignore`.
7. Print what was written and what the engineer should do next, first of
   all commit the stamped files on main: the loop works in worktrees,
   which only see what is committed.

The protect-tests hook: reads the tool input from stdin, and if
`LOOPSTRA_PHASE=fix` and the path matches a test pattern (`*.test.*`,
`*.spec.*`, `/tests/`, `/__tests__/`), exits 2 with a message. Otherwise
exits 0.

## 14. Runtime process

`loopstra start [--once]`: checks the folder is set up (it has
`loopstra/config.yaml`; otherwise "This folder is not set up for Loopstra.
Run loopstra init first."), `claude` and `git` are installed, the
root checkout is on `main_branch` ("Run loopstra from a checkout of
<main_branch>; you are on <branch>."), that Loopstra's own files are
committed there (`loopstra/config.yaml`, `loopstra/prompts/`, and, when
init wired the hook, `.claude/settings.json` and the hook; otherwise "These
Loopstra files are not committed on main yet, so the loop's own checkouts
would not see them: <files>. Commit them, then start again."), and, if a
remote exists, that `gh` is
available ("This repo has a remote but gh was not found. Install GitHub CLI
or remove the remote.") and signed in ("GitHub CLI is installed but not
signed in. Run gh auth login, then start again."), then loops: tick, sleep `poll_seconds`. `--once`
runs one tick and exits, for tests and cron. A tick:

1. Load config. On validation failure, log and sleep; never crash on a bad
   edit. Remove any git `index.lock` (repository or worktree) older than 10
   minutes, left by a git process that died; traced as `stale-lock-removed`.
2. With a remote, sync main (§10).
3. Apply the requests chat left (§17): start a draft someone accepted in
   chat, or, without a remote, add the intents chat wrote.
4. Run due signals.
5. Scan intents, consistency-check, regenerate `queue.md`.
6. Pick the top runnable intent and run exactly one stage step for it
   (human status changes are picked up by the scan). A step that only
   looked at a pull request and found it still waiting changes nothing and
   lets the next runnable intent run in the same tick, so a pull request
   waiting on GitHub never holds up other changes.
7. Sleep.

One step per tick keeps the loop legible and interruptible. A step is
bounded by its phase timeouts. The loop never dies: a tick's own problem is
traced and the next tick comes; an unreadable intent.md is listed under
"Needs a person" and the rest carry on. Ctrl-C (SIGTERM, SIGBREAK) asks for
a stop: no new session or command starts, one in flight is killed, its
phase is marked `interrupted`, and the intent keeps its in-progress status
(it is never blocked for this), which the next start resumes; steps are
idempotent. The sleep between ticks ends at once. A second Ctrl-C exits
with 130.

An unavailable assistant (the CLI could not start, or a session failed
with text that means signed out, a usage or rate limit, an overloaded
service, or the network; the one pattern list is `ENVIRONMENT_PATTERNS` in
`src/claude.ts`) is not the change's fault either: the phase is marked
`interrupted`, the intent keeps its status and is never blocked, and the
loop pauses. No step runs until the pause runs out (1, 2, 4, 8, 16, then
30 minutes for each outage in a row; the next successful phase resets it).
The pause is kept in `.loopstra/paused.json`, so a restart keeps backing
off. It is shown with its plain reason ("The assistant is unavailable
(sign-in, usage limit, or network). Retrying at 14:32.") in the heartbeat
(`pausedUntil`, `pauseReason`), the dashboard's header and attention list,
`loopstra status`, and `tail`. `start --once` just returns. The pause also
records the change, phase, and matched line; stderr counts only when the
session never answered (no `assistant` event), the error result's text
always. On the third pause in a row for the same change, phase, and line,
one probe session runs (cheap model, $0.05, no tools, a trivial prompt,
schema `{ok: boolean}`, traced as a `probe` phase): if it gets through, the
failure is the phase's own, so the pause ends and the change is blocked as
a crash; if not, the loop keeps backing off.

Resumption: `sessions.json` maps phase names to session IDs. A build
continuation resumes session B if present. If `--resume` fails (session gone),
the runtime starts a fresh session and records it.

## 15. Errors and budgets

- Per-phase timeout and dollar budget from config. Both are failures that
  count against the phase's retry budget, then block.
- An unavailable assistant (sign-in, limits, outage, network, not
  installed) never blocks: the loop pauses and backs off (§14). Failures the
  agent causes keep blocking.
- Command failures in `before`/`after` block immediately.
- Git or GitHub command failures inside a step block with a plain note
  ("... An engineer needs to look at it."); the command and its stderr go
  to the trace, never into the note. A hung git command says "A
  version-control command did not finish in time; an engineer should
  look."
- The runtime's own exceptions inside a tick are caught at the tick
  boundary, logged, and the loop continues with the next tick.
- Cost per intent is summed from result events and shown in `status`.
- Every block note ends with what a person does next. `block()` adds
  "When that is sorted out, set status to <x> to try again." (x: the
  approved status the change resumes from, or for a merge retried
  without a rebuild, `merge-approved` / `merge-review`) unless the note
  already says which status to set. A passing hiccup (the assistant
  crashed or took too long) needs nothing sorted out: "To try again, set
  status to <x>." A spending-limit block says an engineer may need to
  raise the limit.

## 16. Repository layout of Loopstra itself

```
package.json              bin: loopstra → src/cli.ts; bun test; zod, yaml
src/
  cli.ts                  init | start | status | tail | ui | chat | apply-lessons
  commands/               status.ts tail.ts ui.ts chat.ts apply-lessons.ts
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
  ui/index.html           dashboard, with the chat panel
  chat/                   orchestrator.ts writer.ts publish.ts requests.ts announcer.ts
                          service.ts threads.ts agents.ts schemas.ts
    transports/           terminal.ts dashboard.ts slack.ts discord.ts
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

## 17. Orchestrator chat

Added 2026-10-01; the full design is
`docs/superpowers/specs/2026-10-01-orchestrator-chat-design.md`, and the
decisions are in `docs/decisions.md` ("Orchestrator chat").

- `loopstra chat` and the `loopstra ui` panel run the orchestrator, one
  resumed session per thread. It answers from the intents, `loopstra status`
  and git, and works out new changes with people. It cannot write files.
- When it proposes a hand-off or a start, code asks a fixed question and
  acts only on a plain yes. A hand-off goes to a fresh writer that sees only
  the brief; its intents are rendered by code, checked (slugs, clashes,
  drafts-only updates, `depends_on`, the consistency check as if accepted),
  rewritten once with the problems, and then, with a remote, opened as a
  pull request of drafts on `intent-proposal/<slug>` from a throwaway
  checkout of the remote's main.
- Chat never writes the main checkout. Starting a draft, and without a
  remote adding written intents, are request files the loop applies at step 3
  of a tick (§14), a person's edit winning; the loop leaves a plain result
  for the chat process to post in the thread.
- Announcements are code: the process holding `announcer.lock` diffs the
  needs-attention list (§11) and intent statuses each poll and appends new
  items, merges and finished changes to `announcements.jsonl`; each process
  passes them to its own surfaces. Pull requests opened from chat are checked
  on GitHub every minute and their merge or close is told to the thread.
- Surfaces: the terminal and the dashboard panel (local; their user may
  start drafts), and Slack (Socket Mode) and Discord (gateway) bots, both
  outbound connections, with `allow` and `acceptors` lists. Tokens come from
  environment variables named in the config.
- Chat turns and writer runs are `_chat` phases in the trace, capped by
  `chat.max_budget_usd_per_day`.
