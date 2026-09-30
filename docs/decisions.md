# Loopstra design decisions

Running log of settled design decisions. One line per decision. Newer entries
at the bottom. The design spec is derived from this file, not from memory.

Sources of truth, in order of precedence when they conflict:
1. Anthropic, *The AI-Native SDLC Playbook* (academy.claude.com)
2. disler, *super-simple-software-factory*

## Settled (2026-09-11)

- **Purpose.** Unattended, continuously running, Claude Code based SDLC loop
  that iterates a change through the six course stages (Plan, Design, Build,
  Test, Deploy, Maintain) with injection points at every stage.
- **Three pillars.** A Claude Code skill (operator console), a TypeScript
  runtime on Bun (owns the loop), and Claude Code CLI sessions (do the work
  inside bounded phases). "Code owns sequencing, retries, and acceptance; the
  agent owns only the work inside one bounded phase."
- **Skill role.** Operator console only: install, onboard, write config, help
  draft intents, inspect traces, unblock gates, tune config. It never runs the
  loop. The runtime is a standalone `bun` process.
- **Invocation.** Runtime spawns `claude -p --output-format stream-json`
  (plus `--resume`, `--json-schema`, `--allowedTools`, `--permission-mode`,
  `--max-budget-usd`, `--worktree`) behind a small adapter interface. Not the
  Agent SDK, because the SDK requires an API key and the CLI uses the user's
  Claude subscription. Subscription auth is a hard requirement for adoption.
- **Work source.** The target repo is the queue. Each change is a folder
  `intent/<slug>/` where `<slug>` is a plain human-readable name chosen by the
  product owner. Artifacts: `intent.md`, `spec.md`, `plan.md`, `review.md`,
  `outcome.md`. Runtime noise (transcripts, envelopes, trace db) lives in a
  gitignored `.loopstra/` folder, never in `intent/`.
- **Queue ordering.** Computed by the runtime from a simple priority the
  owner states in `intent.md`, with an agent filling gaps. `queue.md` is a
  generated view, never a file the owner maintains.
- **State.** Status lives in `intent.md` frontmatter, written only by the
  runtime except at human gates. States: draft, accepted, specified, planned,
  building, reviewed, merged, done, closed; any state may also be blocked
  with a reason. Before advancing, the runtime verifies the artifacts on disk
  match the claimed status.
- **Definition of done.** Every intent states its done-when criteria in the
  owner's terms. Proving them may combine deterministic checks, agent review,
  and human confirmation, per gate config.
- **Gates.** Every stage boundary is a gate: a list of checks that must all
  pass. Check kinds: `code` (deterministic, runs in the runtime), `agent`
  (fresh-context adversarial reviewer returning a structured verdict with
  evidence), `human` (runtime waits for a person). Defaults lean
  deterministic; human only where configured. Stages 2 through 5 must be
  runnable with no human in the path when configured that way.
- **Human gate surfaces.** Per gate, `status` (owner edits the status line in
  `intent.md` and commits) or `pr` (GitHub PR approval read via API).
  Defaults: status for intent, spec, and plan gates; pr for the merge gate.
  (Pending explicit confirmation.)
- **Git model.** Every change is built on its own branch `intent/<slug>`.
  Agents commit freely on that branch. Merge is a gate and is never done by
  the agent that wrote the code. Nothing lands on main without passing the
  merge gate. With a GitHub remote the merge gate is a PR; without one the
  runtime merges locally under the same checks.
- **Artifacts.** Markdown files in git are the durable record, readable by
  humans and agents alike. JSON envelopes from structured output are the
  machine-readable per-phase report the runtime uses to decide.
- **Injection points.** (A) gate checks, (B) per-stage prompt files and named
  skills, (C) deterministic before/after commands per stage. All set during
  onboarding, all editable later. No custom stages or stage graphs; the six
  stages are fixed. Teams needing more fork the runtime.
- **Config.** A file in the target repo, re-read every loop iteration so edits
  take effect without a restart.
- **Concurrency.** One intent in flight at a time. Each intent still gets its
  own branch and worktree so parallel intents later are a config change.
  Within an intent, stages 3 through 5 lean on fresh-context subagents
  (verifier, reviewer, researcher) and on code phases for known commands.
- **Toolchain verified locally.** Bun 1.4.2, Claude Code 2.1.269, gh 2.93.0,
  git 2.54, node 22.20. Agent SDK 0.3.269 usable as a dev-only dependency for
  its message types.

- **Two audiences, two surfaces.** Engineers configure machinery once at
  onboarding: commands, gates, prompts, and any thresholds. Product owners
  only ever read and write plain-language markdown (intent, spec, plan,
  outcome) and a status line. No technical term, command, or number the
  owner must interpret may appear on the owner surface. Onboarding detects
  the test/build/lint commands from the repo and an engineer confirms them;
  they are written to the runtime config and to the Commands section of
  CLAUDE.md.
- **Stage 6 for v1.** No statistics. After every merge, and on a schedule,
  the runtime runs the test command on main. Green before and red after is
  a breach. A breach opens a new `intent/<slug>/intent.md` in plain
  language (what merged, what broke, proposed outcome) with status draft,
  which the owner handles like any other intent. After a merge the runtime
  also verifies the intent's done-when criteria via the configured checks,
  writes `outcome.md` with evidence, and marks the intent done. Repeated
  reviewer findings are proposed as edits to CLAUDE.md. Continuous metrics
  (error rates, bands, sigma tiers) are a documented extension point, added
  later as one-line commands in config by an engineer, never by the owner.

- **Distribution.** One global install (clone the repo, `bun install`, `bun link`; no package is published yet). In a
  repo, `loopstra init` runs onboarding and writes only config, stage
  prompts, the operator skill, and hooks into that repo. Runtime code
  stays in the global install; upgrades are one command.
- **Config format.** YAML, one file `loopstra/config.yaml` in a tracked `loopstra/` folder that also holds `prompts/<stage>.md`; `.loopstra/` is the gitignored runtime folder. Config is
  schema-validated on load with plain error messages.
- **Trigger cadence.** Polling, 60s default. Each pass scans `intent/`,
  git, and GitHub. No file watchers or webhooks in v1.
- **Observability.** Append-only JSONL event log per run plus a SQLite
  database in `.loopstra/`, written as events happen. The skill reads
  these. No web viewer in v1.

- **States (refined).** One field. Every gate has a waiting status and an
  approved status: draft → accepted → designing → spec-review →
  spec-approved → planning → plan-review → plan-approved → building →
  reviewing → merge-review → merged → verifying → done; any state →
  blocked (with plain-language note) or closed. Waiting statuses tell the
  reader what to do. Automated gates pass through review statuses.
- **Gate defaults.** Only intent acceptance is human by default. Spec,
  plan, merge, and done gates run deterministic checks plus a
  fresh-context agent reviewer. Onboarding asks which gates get a person.
- **Agents propose, the runtime writes artifacts.** Design and plan
  sessions are read-only and return content via structured output
  (`--json-schema`); the runtime writes spec.md, plan.md, review.md,
  outcome.md. Only the build session (and its fix/revise/reconcile
  continuations) edits code, inside the intent worktree.
- **Sessions.** Build, fix, revise, reconcile share one resumed session.
  Intake, design, plan, plan-challenge, verify, review, done-check, and
  lessons each get a fresh session. Judges never share context with the
  worker.
- **Bounded loops.** Test→fix max 3; review→revise max 2; plan challenge
  max 1 resend. Exhausted → blocked with a plain note. A person retries by
  setting status back to the last approved state, or closes.
- **Observability tooling.** `loopstra status` (table of intents and
  current step), `loopstra tail` (live events), and `loopstra ui` (a
  single-page local dashboard served by Bun over the SQLite trace,
  polling). No external services.
- **Testability.** A fake `claude` executable (Bun script emitting
  stream-json from fixtures) lets the whole loop run end-to-end in a
  temp git repo without calling Claude. Every stage has unit tests; the
  scheduler has an integration test.
- **Onboarding.** `loopstra init` is deterministic: detects test/lint/build
  commands, writes loopstra/config.yaml, loopstra/prompts/*.md,
  .claude/skills/loopstra/, .claude/agents/{verifier,reviewer}.md, a
  Bun-based test-protection hook wired into .claude/settings.json,
  REVIEW.md, intent/README.md (owner guide), and a .gitignore entry.
  The skill then walks an engineer through confirming commands and gates.
- **Decision authority (2026-09-28).** User directed: make all remaining
  decisions autonomously, optimizing for simple, unattended, human
  readable, with observability tooling on top, and build the full
  factory.

- **Gate timing (2026-09-28 hardening).** Supersedes "automated gates pass
  through review statuses". A gate's automated checks run in the step that
  produced the artifact. Pass with no person on the gate → the approved
  status; pass with a person → the review status with a plain note, so a
  review status only ever means "checks passed, waiting for a person" and
  stepping it never advances. Fail → one automatic rewrite with the
  findings, then block. A checker that cannot run blocks at once.
- **Owner notes (2026-09-28 hardening).** Notes on the owner surface are
  plain sentences with retry advice; check ids, commands, branch names,
  counts, and raw output go to the trace. Nothing is written on the root
  checkout unless it is on `main_branch`; otherwise the loop pauses.
- **Merge gate (2026-09-28 hardening).** New status `merge-approved`,
  symmetric with spec-approved and plan-approved. The merge checks (up to
  date, tests, review findings) run in the step of the approving review;
  fixes they commit go back for one more review round. Merging requires a
  clean root checkout on `main_branch`; an interrupted merge that landed is
  finished, never repeated. Worktree and branch cleanup is best effort and
  retried by the scheduler.
- **PR gate (2026-09-28, Plan 3).** With a remote, the approving review
  pushes the branch and opens a PR instead of merging locally; the status
  is merge-review with a note per `gates.merge.human`. With `none` or `pr`
  the merge step watches the PR each tick (pending or `gh` silent → wait,
  changing nothing; failed checks or a closed PR → block; `pr` also needs
  an approval, or a person setting merge-approved); with `status` a person
  sets merge-approved and the PR's checks must pass. Merges go through
  `gh pr merge`; a PR already merged is recorded, never merged twice. A
  step that only looked at a waiting PR lets the next change run in the
  same tick.
- **Main sync (2026-09-28, Plan 3).** With a remote, each tick (and after
  a PR merge) fetches and rebases local main onto the remote's main when
  the checkout is on main with no tracked changes. Main is never pushed,
  since that would push a person's own commits; only intent branches are
  pushed (`--force-with-lease`). Conflicts only in `intent/` take the
  remote's version (an owner's edit wins); any other conflict aborts and
  is traced. `start` refuses a checkout off main, or a remote without gh.

## Batch 4 hardening (2026-09-28)

- **Git runner (H3).** Every git call goes through one runner: bounded (5 min default), killed with its whole tree past the limit (`GitTimeout`), never prompting (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, empty `GIT_ASKPASS`, no `SSH_ASKPASS`, `ssh -o BatchMode=yes` unless the repo or environment sets its own ssh command), stop-aware (no git starts after a stop; a running one gets 2 s, then is killed; aborts that put a checkout back always run). A git timeout inside a step blocks with "A version-control command did not finish in time; an engineer should look."
- **Runtime commits (H3, H24).** Every commit the runtime makes (bookkeeping on main, worktree saves, merges, rebases) is authored `Loopstra <loopstra@localhost>`, uses `--no-verify` where the command has it and `-c commit.gpgsign=false`; one constant in `src/git.ts`. The gates run the configured checks instead of the owner's hooks.
- **commitPaths (H11).** Checks staged changes only for its own paths; other staged files stay staged and out of the commit. Git error messages skip git's `warning:` lines.
- **Process groups (H15).** On POSIX every child (claude, git, gh, project commands) starts in its own process group, so a timeout or stop kills everything it started; Windows keeps `taskkill /T`.
- **A person's edits win (H2).** Every intent.md write re-reads the file right before writing and changes only its own frontmatter lines (textual patch: other keys, their order, comments, blank lines, the body, CRLF/LF and a BOM stay; a shape the patcher cannot handle is rewritten whole). If the status on disk is not the one the step started with, a person changed it: nothing is written, the trace gets `person-changed-status`, and the step ends without blocking or advancing; the next tick picks up the person's status. The priority is written only when the file still has none, and only on main.
- **Merge precondition (H1).** The merge step first commits the change's own `intent/<slug>/` folder (a person's uncommitted `merge-approved` counts). Then the root must be on main, have nothing staged anywhere, and no unsaved changes to tracked files outside `intent/`. Unsaved edits to other intents never block a merge. The owner guide says status edits are picked up whether or not they are committed.
- **Atomic squash (H6).** A squash merge is `commit-tree <branch>^{tree} -p <main>` then `merge --ff-only`: it lands whole or not at all, and a failure before the fast-forward leaves main, the index, and the files untouched. The branch must contain main (the merge checks rebase it; if bookkeeping moved main since, the branch is rebased once more). `method: merge` stays `merge --no-ff`.
- **Retry wording (H10).** `block()` owns it: a note that does not already say which status to set gets "When that is sorted out, set status to <x> to try again.", where x is the approved status the change resumes from (or, for a merge retried without a rebuild, merge-approved / merge-review). Stages no longer word their own retries; notes with a specific instruction (for example the two ways on after a spec or plan fails its check twice) stay as they are. The budget note says an engineer may need to raise the limit.
- **Sharing main (H24).** Supersedes "main is never pushed". With a remote, after artifact commits and in each tick's sync, main is pushed when every commit in `<remote>/<main>..<main>` is authored by Loopstra. A person's unpushed commits are theirs to share: then nothing is pushed and `main_sync` waits ("Main has your own unpushed commits; Loopstra will share its records after you push yours."). A refused push (a protected branch) is a `main_sync` failure; the loop carries on. A push beaten by a newer remote main is left to the next sync. Intent branches are created after the artifact commits are pushed, so a pull request shows only the change. The sync keeps "the remote wins inside intent/".
- **Pull requests in every mode (H25).** With a remote, `merge-review` is runnable for every `gates.merge.human` mode: merged on GitHub → recorded as merged; closed → blocked; with `status`, anything else waits until a person sets `merge-approved`.
- **main_sync signal (H26).** Sync outcomes (pass, waiting, fail, in plain words; detail in the trace) are the `main_sync` signal, written only when the outcome changes; a lasting condition (unsaved changes, GitHub out of reach, the remote has no main) is one trace line. The dashboard's attention list shows `main_sync` waiting or failing.
- **gh signed in (H27).** With a remote, `start` also refuses when `gh auth status` fails: "GitHub CLI is installed but not signed in. Run gh auth login, then start again."
- **Closed changes (H16).** The scheduler's cleanup removes a closed change's worktree once it has nothing uncommitted (untracked files count); the branch is kept. A worktree with uncommitted work is left, traced once.
- **Damaged trace (H17).** A `trace.db` that is not a database (or is malformed) is renamed to `trace.db.corrupt-<time>` and a fresh one started, with a plain console line and an event in the new db. A lock or other error is not treated as damage.
- **Reconciled plan (H5).** A plan reconciled with what a build changed lives in `.loopstra/runs/<slug>/plan.reconciled.md`, cleared whenever a build step starts. Drift compares with main's `plan.md`; verify and review use the reconciled plan when there is one, else main's. The plan is never read from, or written to, the branch.
- **Lessons apart (H7).** Lessons and proposed CLAUDE.md additions go to `intent/<slug>/lessons.md` (for engineers, committed); `outcome.md` keeps Outcome, Evidence, Not met, and For a person to confirm. `apply-lessons` reads `lessons.md`.
- **Setup committed (H8).** `init`'s first next step is to commit what it stamped. `start` refuses, listing them, when `loopstra/config.yaml`, `loopstra/prompts/`, or (when init wired the hook) `.claude/settings.json` and `.claude/hooks/loopstra-protect-tests.ts` are not committed on main: the worktrees only see what is committed. The hook file is included because the settings point at it inside the worktree.
- **Read-only git for builds (H9).** The default `claude.allowed_tools` has `Bash(git diff|log|show|status *)` instead of `Bash(git *)`; the runtime makes every commit, branch, and merge. The build prompt says not to commit.
- **Folder names (H12).** A change folder must match `^[a-z0-9][a-z0-9-]*$`; any other is listed under "Needs a person" with "Rename the folder to lowercase words joined by dashes, like add-numbers."
- **Unknown intent.md lines (H13).** "intent.md has a line Loopstra does not recognise: '<key>'. Remove it or fix the spelling."
- **Gate surfaces (H14).** `pr` is accepted only for `gates.merge.human`; spec, plan, and done take `status` or `none` ("must be status or none; a pull request cannot be used for this gate"). `gates.intent` is removed: a person always accepts an intent; an old config naming it gets "gates.intent: remove this line; ...".
- **No subagent files (H20).** `init` no longer stamps `.claude/agents/{verifier,reviewer}.md`: the runtime runs its judges as fresh sessions itself.
- **Less to carry (H18).** Removed what nothing read: `scanIntents` (use `scanRepo`), the envelope field `notes_for_next_phase` and its prompt sentence, the plan envelope's `files` (the plan's "Files that change" list is the one source), design's `concerns` (the spec's "Areas of concern" heading), and the stream collector's tool-use list. `codePhase` failures carry `detail` (for the trace), not `note`.
- **One merge gate (H19).** `runMergeStep` is the one entry for reviewing, merge-review, and merge-approved: a merge that landed before a stop is recorded there once; review rounds (`runReviewRounds` in review.ts, which imports nothing from merge.ts) are followed by the one `mergeGate`, which the merge step also uses; the "reviewed as many times as allowed" block and the round marker's advance live once, in `anotherRound`. No import cycles among the stages.
- **Stale git locks (H28).** At the start of each tick an `index.lock` older than 10 minutes, in the repository or any worktree, is removed and traced (`stale-lock-removed`): the loop is the only automated git user and its own git calls end within 5 minutes, so an old lock was left by a git process that died; a person's git command does not hold one that long.
- **Missing session (H21).** A `--resume` whose session is gone is recognised from stderr ("No conversation found") before any result check, since the CLI also sends an `error_during_execution` result; the continuation then runs once in a fresh session.
- **No PowerShell (H22).** Every session gets `--disallowedTools PowerShell` (read-only sessions also lose Edit, Write, NotebookEdit), so on Windows shell commands go through Bash, which the allow rules cover.
- **Outage pause (H4).** A new failure class, the environment's: the CLI could not start, or a failed session's stderr or error result matches `ENVIRONMENT_PATTERNS` in `src/claude.ts` (signed out, usage or rate limit, overloaded, network). It never blocks: `agentPhase` marks the phase `interrupted` and throws `AssistantUnavailable`; the tick records a `pause` event and backs off 1, 2, 4, 8, 16, 30 minutes (cap), reset by the next successful phase. The pause lives in `.loopstra/paused.json` (it survives a restart); while it runs no step starts. Heartbeat (`pausedUntil`, `pauseReason`), dashboard pill and attention list, `status`, and `tail` show "The assistant is unavailable (sign-in, usage limit, or network). Retrying at 14:32." Agent-caused failures keep blocking.
- **Refused commands (H23).** The result event's `permission_denials` are collected and kept on the phase (the `phase_end` event's `denied`, as allow-rule text like `Bash(git tag v1)`); a failed phase's traced error names them. The dashboard's phase drill-down and event log, and `tail`, say "N commands were not allowed: ...". The owner note stays plain.

## Open

- None. Remaining details are settled in the design spec.


## Verified live (2026-09-29)

- **End-to-end smoke run with the real Claude Code CLI.** A throwaway Bun repo, `loopstra init`, one owner intent ("say goodbye") set to accepted, `loopstra start`. The loop went accepted → designing → spec-approved → planning → plan-approved → building → reviewing → merged → done in about 2.5 minutes for $1.35 (sonnet for strong/default, haiku for cheap), with no person in the path. 15 phases, all successful; one squash commit of the change on main; branch and worktree cleaned up; plain outcome.md and a separate lessons.md; `loopstra status` and `loopstra ui` showed it live.
- **CLI behaviour confirmed by probes:** missing session gives an `error_during_execution` result plus "No conversation found" on stderr; budget exhaustion gives `error_max_budget_usd`; `--allowedTools` takes one comma-joined argument with spaces inside rules; `--disallowedTools` removes tools; read-only shell commands are auto-approved and mutating ones denied and listed in `permission_denials`; plan mode with `--json-schema` returns `structured_output` normally.

## Batch 5: behaviour and operator experience (2026-09-29)

- **Build sessions run the project's commands.** A build session's allow list is `claude.allowed_tools` plus `Bash(<cmd> *)` for each configured command (test, lint, build, run, install), so the agent can run the tests it is asked to make pass; judges keep their own lists (no install).
- **Bounded outage pause.** `paused.json` records the change, phase, and matched line of the pause. Stderr is matched against `ENVIRONMENT_PATTERNS` only when the session never answered (no `assistant` event); the error result's text always is. On the third pause in a row for the same change, phase, and line, one probe session runs (cheap model, $0.05, no tools, a trivial prompt, schema `{ok: boolean}`, traced as a `probe` phase): it gets through → the pause ends and the change is blocked like a crash (detail and the probe in the trace); it does not → the loop keeps backing off.
- **Push once per tick (supersedes "after artifact commits" in H24).** Artifact commits are not pushed one by one: main is shared once at the end of each tick (only when that tick's sync went through, so a sync that waits or fails is not followed by a push that says otherwise) and once in `openPullRequest` before the branch is pushed. Bookkeeping commits on main (`loopstra(<slug>): ...`, a person's recorded edits, the failing-tests intent) end with ` [skip ci]`; the change's squash or merge commit does not.
- **Queue commits (L3).** `queue.md` is written each tick (and again at the end of a tick that ran a step) but never committed on its own: the next artifact commit takes it along. An unsaved `queue.md` never blocks a merge (the merge precondition ignores unsaved changes under `intent/`) and never holds up the sync (it is put back before the rebase and written again later in the tick). `status` and the dashboard read `intent.md` files, not the queue.
- **No redundant merge test run.** The test loop records the commit its commands last passed on (run-folder `tested`, with the commands). The merge checks skip `merge-test` when the branch is that commit, or differs from it only under `intent/` (the usual rebase onto main's bookkeeping); any code change, or a changed command, runs the tests again. Judgment call: "HEAD moved" alone would re-run the tests after every rebase, since main always gains records during a change.
- **One "needs attention" list.** `src/attention.ts` builds it (pause, red main, main out of step with GitHub, a config problem, blocked changes, unreadable intents, then changes waiting for a person), from the root, the config (or the problem loading it), and the trace; it uses `REVIEW_GATE` and `waitsForPerson` from `intents.ts`. `loopstra status` prints it as a "Needs attention" block under the Loop line ("Nothing needs you right now." when empty); the dashboard shows the same items with their labels ("Blocked", "Waiting for you", never "Stopped"). `queue.md`'s "Needs a person" holds every change waiting for one (blocked, drafts, reviews with a person on the gate); the separate Drafts section is gone. A config the tick cannot load is traced (`where: config`, once while it stays the same).
- **Loop state (L4).** A stale heartbeat whose process is gone (`process.kill(pid, 0)`) reads "Stopped — it did not shut down cleanly (last check 8 h ago)"; "Not responding" is kept for a live process with a stale beat. A stopped loop with a pause still running adds "The assistant was unavailable; the next start waits until 14:32."
- **Change documents on the dashboard (L6).** The drill-down links intent.md, spec.md, plan.md, review.md, outcome.md, lessons.md when present, served read-only as text/plain from `/docs/<slug>/<name>`: the slug must pass the change-name rule, the name must be one of those documents, and the real path must stay inside the change's folder.
- **Wording (L7, L8).** Missing sections: "This request is missing a Proposed outcome and a Done when section. Add them to intent.md, then set status to accepted." A crash or timeout block says "To try again, set status to X." (other blocks keep "When that is sorted out, ..."). `loopstra status` never pads the last column and wraps notes and attention lines to the terminal width (100 when unknown; a note column is never narrower than 24).
- **Outside a set-up repo.** `status`, `tail`, and `ui` without `loopstra/config.yaml` say "This folder is not set up for Loopstra. Run loopstra init first." and create nothing; `start` refuses the same way in its preflight; `init` outside a git repository warns "This folder is not a git repository; run git init first." and writes nothing. `tail <slug>` and the dashboard's time in status read only the newest events they need.
- **Intake envelope without `missing_sections`.** The scan's consistency check blocks an accepted request that lacks a required section before intake runs, so intake returns only `priority` and `question` (schema, prompt, fixtures, stage code).
- **Owner and operator docs.** The owner guide says `merged` means "the change is in the main code" (not "live"), words `merge-review` for all three merge modes, and its template leaves `priority:` out with a comment that Loopstra fills it in. The skill's Unblock says to follow the status the note names, with `resume_from` as the fallback. The spec's §15 no longer says git failures block with stderr text (the note is plain; stderr goes to the trace), and §11 describes what `status` prints.

## Batch 6: prompts (2026-09-29)

- **One contract, in code.** `agentPhase` appends the two lines every prompt shares ("Set `status` to fail only if ..." and "Respond only through the structured output.") after the rendered template (`withContract` in `src/phases.ts`); the 13 templates no longer carry them. A prompt in `loopstra/prompts/` stamped by an older init that still ends with them loses that trailing copy first, so they never appear twice.
- **`{{commands}}`.** Always set: the shell commands the session's tool set allows, as a plain list (`` `bun test`, `git diff` ``; `none`; `any command` for a bare `Bash` rule), derived from `toolsFor`. verify, done-check, and review say "You may run only these ..."; build, fix, and revise name them too, so sessions stop trying commands that will be refused. `{{skills}}` is gone from the variables (no template used it; skills stay the one line at the top of the prompt).
- **Judges are told the test result (L2).** New variable `{{test_result}}` for review and verify: "The test command passed after the latest change." when the test loop's `tested` marker covers the worktree's commit (the same check the merge gate uses, now `alreadyTested` in `stages/shared.ts`), else "The tests have not run on the latest change yet; the runtime runs them before merging." (unfinished edits kept on the branch at review start). A failing run never reaches a judge (the test loop fixes or blocks first), so there is no failing-output form. Both prompts say not to run the tests and never to report unverified tests as a finding.
- **No `changed_files`.** build, fix, and revise return only `commit_message`: nothing read the list (drift and the merge use git).
- **Fix says what it is fixing.** After a test failure `{{failure_output}}` is "The command `<cmd>` failed. The end of its output:" plus the last 8000 characters; after a verify failure it is "The checks pass; the verifier found the change does not do what the spec says:" plus the observations. `{{observations}}` is gone, and fix.md no longer opens with "The checks failed".
- **A spec the owner can read (L1).** design.md splits the spec by reader: Summary, Requirements, Out of scope, Open questions, and Areas of concern are for the product owner (plain language, behaviour in words and small examples, no code, regular expressions, file paths, or function names); Design and Affected code are for engineers. spec-check.md checks this and records technical owner sections as a finding that is not met, so the spec is written again with that finding. The owner guide says which parts of `spec.md` are theirs and that `plan.md` is for engineers.
- **Plain-words outcome.** done-check.md asks for `# Outcome`, `## Outcome`, and `## Evidence` exactly (the headings of the runtime's own no-check outcome), with the met criteria under Evidence and the unmet and needs-person ones left to the runtime's own headings. Every `evidence` text says what was checked and what happened, without test names, commands, file paths, or line numbers.
- **Design runs in plan mode.** design and plan are both read-only sessions, so both use `--permission-mode plan` (design used `default`). The live probe showed plan mode with `--json-schema` returns `structured_output` normally, and the read tool set is unchanged; no test or live run argued for `default`.
- **Second and third live runs (2026-09-29).** A harder run (human spec gate approved by an uncommitted status edit, a subjective done-when criterion, a vague intent) surfaced the improvements in batches 5-7: technical owner sections in spec.md, a reviewer that tried to run tests it was not allowed to, queue-only commits on main, a killed loop shown as "not responding", and dashboard wording. The third run, on a fresh `init`, confirmed the fixes: plain owner sections in the spec, a clean review, a plain outcome.md routing the subjective criterion to a person, no queue-only commits, `[skip ci]` on bookkeeping commits; accepted → done for $1.90 with one human approval.

## Cross-platform behaviour (2026-09-29)

- **SIGHUP and orphans.** On POSIX, SIGHUP stops like SIGTERM (first asks for a stop, second exits). `spawnBounded` keeps the pids of its live children and, in the process's `exit` handler, kills each one's tree (POSIX `kill(-pid, SIGKILL)`, Windows `taskkill /T /F`), so a second Ctrl-C or an exit during a stop grace leaves nothing running.
- **POSIX tree kill.** `killTree` sends SIGTERM to the child's process group, waits up to 1.5 s for it to go, then SIGKILLs the group and every descendant found by walking `ps -A -o pid=,ppid=` from the child (collected before the first signal, since orphans are adopted by init), which catches grandchildren that started their own group or session. Windows keeps `taskkill /T /F`.
- **main_branch from the repository.** `init` writes the branch checked out now (`git symbolic-ref --short HEAD`, which also names an unborn branch), else git's `init.defaultBranch`, else `main`. Judgment call: init run on a feature branch records that branch; the README says where the value comes from, and it is one line to change.
- **Git in the C locale.** Every git call gets `LC_ALL=C` and `LANG=C` (and no `LANGUAGE`), so the messages the runtime reads are English on every machine.
- **Bun first on children's PATH.** Agent sessions and project commands get the running Bun's folder prepended to PATH (keeping the key's spelling, `Path` on Windows), so a short PATH (cron) still finds `bun`. The README's cron example sets an explicit PATH with bun, git, claude and gh.
- **Hook paths are judged inside the project.** The protect-tests hook strips `CLAUDE_PROJECT_DIR` (or, when that is unset, the working folder) from the edited path before matching, so a project that itself lives under a `tests/` folder is not all tests. The settings.json command is unchanged; it runs through Claude Code's shell.
- **Exact names.** The plan's files check compares against `git ls-files` exactly, so a wrong-case path fails on every system (with the right spelling named); `(new)` files are not checked; a listed folder passes when it holds a tracked file. `init` finds `CLAUDE.md`, `.gitignore` and the makefile (`GNUmakefile`, `makefile`, `Makefile`) by exact directory entry; a `claude.md` or other-case `.gitignore` is left alone with a warning rather than overwritten on a case-insensitive disk.
- **No long command lines.** `gh pr create` and `gh pr comment` take their bodies with `--body-file -` on stdin; `containsChanges` runs `git diff --quiet` over at most 200 paths at a time (Windows limits a command line to 32K characters).
- **WAL fallback.** When SQLite cannot put the trace in WAL mode (some network drives), it uses `journal_mode=DELETE` and traces one `_loop` error event (`where: trace`) per process. A lock is still thrown.
- **Claude override checked.** `start`'s preflight refuses a `LOOPSTRA_CLAUDE_EXECUTABLE` that is not found (as a path, or on PATH for a bare name) or, on POSIX, not executable; a `.ts` override only has to exist.
- **Test pid.** The heartbeat test's "dead process" is a process that was spawned and has exited, not a made-up pid that may be in use.
- **Chained commands allowed part by part.** Claude Code checks each part of `a && b` against the allow rules on its own, so `toolsFor` adds `Bash(<part> *)` for each part of a configured command (split on `&&`, `||` and `;` outside quotes and escapes) next to the whole-chain rule. Without it judges, which never see `claude.allowed_tools`, were refused a chained test or build command outright. Pipes are not split: each part is allowed with any arguments, and a `| tee out.log` part would let read-only judges write files; a piped command belongs in a script.

## Background tasks (2026-09-30)

- **Sessions run without background tasks (#1).** A build session that left a `run_in_background` task pending made the next resumed phase (fix, reconcile, revise) answer the task's notification with an empty turn and end without reading the prompt, which blocked the change as an unreadable report. `runPhase` sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for every session (this also stops auto-backgrounding), so long commands run in the foreground under the Bash timeout. A result event whose `origin.kind` is `task-notification` is not the prompt's result: reading goes on past it, and a process that ends having answered only notifications (a session started before this change) gets the prompt again with `--resume` on the same session, at most twice, within the phase's deadline. Past that it is a crash, which `agentPhase` retries once.

## Missing structured output (2026-09-30)

- **Asked once for a missing report (#7).** A session whose result is a success but carries no structured output (it wrote its report as text, or stopped after a refused command) is resumed once on the same session with a short prompt asking it to call the structured-output tool without redoing the work (`ENVELOPE_NUDGE` in `src/claude.ts`), within the phase's deadline; both sends' cost and refused commands count. Still missing after that, or if the nudge itself times out or breaks, it is `invalid-envelope` as before (never a timeout or crash, which `agentPhase` would rerun from scratch). This saves a rerun of the whole phase, and for verify, a rebuild.
- **Verify on the default model (#7; supersedes "verify: cheap" in the design spec).** `stages.verify.model` defaults to `default`: the cheap model often ended verify sessions without calling the structured-output tool, and each such block cost a whole build session to recover.

## Dependencies between intents (2026-09-30)

- **`depends_on` (#3).** An optional `depends_on` frontmatter line (one name or a list; blank reads as absent) names changes that must be in main first. The scheduler skips a change while the code of any of them is not in main (its status is not `merged`, `verifying` or `done`, and it is not blocked or closed with `resume_from` one of those, as after a verify block), so a blocked dependency holds its dependents instead of letting them be designed and built on a main without it. A change whose own code is in main waits for nothing (holding its verify step would prevent nothing). Ordering itself is unchanged. A bare number is a name, and `a, b` without brackets is two names. `status`, `queue.md` and the dashboard put "Waits for <slug> to be merged (now: <where it is>)." before the change's note; a name that matches no readable change, a closed change, or a cycle only a person can end, so it also goes on the "needs attention" list. The runtime never writes `depends_on`. The owner guide, README and the skill's "Draft an intent" say one intent is one build session and to split large work into ordered intents.
