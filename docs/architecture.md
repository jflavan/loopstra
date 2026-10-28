# How Loopstra is built

Loopstra is an unattended development loop on top of the Claude Code CLI. Code owns the loop; agents own bounded phases. This page is for an engineer reading or changing the code: how the source is layered, the rules every part keeps, and the TypeScript practices the codebase holds itself to. What each change decided, and why, is in [decisions.md](decisions.md). How to use Loopstra is in the [README](../README.md).

## Layers

About 190 modules under `src/`, in eight layers. A module imports only from its own layer or the ones below it. There is no runtime import cycle, and every exported name is imported somewhere: `bun run deadcode` fails otherwise.

1. **Foundations**, which import no other Loopstra module.
   - `text.ts`, `ids.ts`, `paths.ts` and `fsutil.ts` hold small helpers: `writeFileAtomic`, and `readJsonAs`, which reads a file through a zod schema.
   - `stop.ts` holds the stop request and the errors that end a step without being its fault (`notTheStepsFault`).
   - `lanes.ts` holds the in-process locks, which are keyed, re-entrant and checked for order, and the claims on changes.
   - `envelopes.ts` holds the zod schemas of what each agent phase answers.
   - `standard-examples.ts` holds the two example standards that `loopstra setup standards` and the console's New standard start from, as plain strings, so the page can import them.
2. **Processes and git.**
   - `shell.ts`: `spawnBounded` gives every child a deadline, kills its whole tree, and cleans its environment of a git hook's repository variables. `programsIn` and `missingProgram` name the programs a command line runs and the one the shell could not find.
   - `git.ts`: `Git`, with every call bounded and taking the checkout or remote lock its subcommand needs, plus the plumbing records use (`commitFiles`, `moveRef`).
   - `github.ts`: the `gh` CLI.
3. **State on disk**, each read through a schema.
   - `config.ts` reads `loopstra/config.yaml`.
   - `intents.ts` reads and patches a change's `intent.md` frontmatter and orders the queue.
   - `trace.ts` is the SQLite trace, with its own schema version and migrations.
   - `heartbeat.ts` holds the loop's lock and pause.
   - `requests.ts`, `inbox.ts`, `conversation.ts` and `questions.ts` are what people leave for the loop.
   - `stamp.ts` holds what an upgrade knows.
   - `risk.ts` scores a change's diff against `gates.merge.risky` (`scoreRisk`), for the merge gate.
   - `agents.ts` resolves a step's agent setup from the config (`resolveSetup`) and holds its rules: which steps are read-only, which git a step may never get, and which steps run as the build's agent.
   - `standards.ts` reads the standard files in `loopstra/standards/` from a commit of main (`readStandards`, every problem with its file and line), works out which apply to a change's files (`applying`), renders them for the prompts (`renderStandards`), reads and checks a spec's or plan's Standards section (`readStandardsSection`, `checkStandardsSection`), and reads an outcome's back (`readOutcomeStandards`).
   - `standards-record.ts` reads and writes a change's `intent/<slug>/standards.md` (standards added and removed, exceptions approved), and finds the exceptions a spec or plan asks for that nobody has allowed yet (`exceptionsToApprove`).
   - `standards-check.ts` runs a command once in a throwaway checkout of main's last commit (`runOnMain`, which setup's `commands.test` check uses too), and a standard's tool check that way with `LOOPSTRA_BASE` set (`checkOnMain`).
4. **Records.**
   - `record-draft.ts` holds `RecordDraft`.
   - `context.ts` holds `StepContext` and `commitRecord`, the one way anything is written to main, with `settleRecord` and `landed` (see Records). A step reads the standards once, at its commit of main (`StepContext.standards`), and throws `StandardsUnreadable` when one cannot be read.
5. **Sessions.**
   - `claude.ts` runs one CLI session: `runSession`, and `classify`, which reads how it ended.
   - `prompts.ts` renders the prompts.
   - `standards-prompt.ts` holds what each phase is told to do with the standards (`STANDARDS_INSTRUCTIONS`), which `phasePrompt` adds only when the change has standards to show.
   - `sessions.ts` traces each session.
   - `phases.ts` holds `agentPhase` and `codePhase`, plus `alongside`, for work that runs beside another phase.
   - `judges.ts` holds the cheaper first-pass judges.
   - `agent-files.ts` finds the agents and skills a setup names, reading the repository's agents from main's last commit so a change cannot rewrite the agent that judges it, and turns a setup into session options (`setupSession`) and a check of the session's start.
   - `agent-library.ts` lists, copies and fetches agents and skills, for `loopstra setup agents` and the console.
   - `main-project.ts` reads Claude Code's project setup (settings, CLAUDE.md, rules, skills, MCP servers) from the step's commit of main into a folder of the session's own, and gives it to sessions that run in a change's branch in place of the branch's own.
6. **Stages**: `stages/*`. Design, plan, build, review, merge and verify, one step per tick, each a short sequence of phases and gates.
7. **The loop.**
   - `scheduler.ts` runs `tick`, with up to `speed.max_parallel_changes` lanes, a thinker for design and plan, and a pull-request watcher beside them.
   - `apply.ts` applies people's requests between and beside steps.
   - `steering.ts` delivers messages to running sessions.
   - `signals.ts` checks main's health.
   - `remote.ts` syncs main and moves it in one step.
8. **Surfaces.**
   - `cli.ts` and `commands/*` are the command line; `commands/standards.ts` is `loopstra standards`.
   - `console/*` is the local server, with JSON and SSE. `console/standards.ts` serves Settings › Standards, a draft's check, Try it on main, the exceptions granted, a change's Standards panel, and the `standards-scope` request.
   - `ui/*` is the Preact page. `ui/views/StandardSettings.tsx`, `ui/views/Exceptions.tsx` and `ui/parts/StandardsPanel.tsx` are the standards' views, and `ui/standards.ts` what they say and check as a person types.
   - `chat/*` is the orchestrator, its writer, and the terminal, console, Slack and Discord transports.
   - `setup/*` is `loopstra setup`; `setup/sections/standards.ts` is its standards section, and `setup/standards-checks.ts` the standards' checks, which `--check` runs with the rest.
   - `upgrade/*` is `loopstra upgrade`.

Good places to start reading are `scheduler.ts`'s `tick` for the loop, and `context.ts`'s `commitRecord` for how anything reaches main.

## Rules every part keeps

- **One loop per repository, and only the loop writes main.**
  - A second `start` is refused by `heartbeat.ts`'s lock.
  - People change what the loop owns through requests (`requests.ts`), never by writing alongside it. Chat and the console both leave requests.
- **Records go through `commitRecord`.**
  - A record's callback writes into a draft.
  - The commit is built from main, the change's folder on disk and the draft, in a temporary index.
  - Main moves by compare-and-swap, and only then does the checkout change.
  - A kill in between leaves `.loopstra/recording.json`, which the next tick or record finishes.
  - A request's or message's commit carries `Loopstra-Request: <id>`, so a retry asks git whether it landed.
  - Nothing is ever on disk uncommitted, so nothing needs putting back.
- **Every external process is bounded and stoppable.** It has a deadline. Its whole tree is killed. A stop request ends it gracefully, except for the few calls that must finish once begun (`cleanup`).
- **Locks are keyed by what they protect** (the checkout, the remote, a merge) and taken in one order, which `lanes.ts` checks at run time.
- **The trace is the record of what happened.** Every phase, gate, request and error is an event, and `status`, `tail` and the console read from it. A repeated problem is traced once while it stays the same (`eventOnChange`).
- **Text a person reads is plain.** Notes say what happened and what to do, in sentences, never a stack trace or a raw command. Lint enforces part of this: no `[object Object]` and no `undefined` in a template string.

## TypeScript practices

These came out of the hardening pass (#47 and the reviews after it). The reasons are in [decisions.md](decisions.md), under "Hardening pass (2026-10-18)".

- **Strict, and then some.** `strict` and `noUncheckedIndexedAccess` are on, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`. `exactOptionalPropertyTypes` was tried and left off: its errors were churn, not bugs.
- **Typechecking.** `bun run typecheck` runs TypeScript 7, the native compiler, aliased as `@typescript/native`. TypeScript 6 is kept beside it for typescript-eslint, which needs the JavaScript compiler API.
- **Type-aware lint.** `bun run lint` runs typescript-eslint's type-aware rules, each one guarding a way an unattended loop fails quietly:
  - a promise nobody awaits, or an async callback whose rejection is lost (`no-floating-promises`, `no-misused-promises`);
  - `any` leaking in from `JSON.parse` (`no-unsafe-*`);
  - text that would print `[object Object]` (`no-base-to-string`, `restrict-template-expressions`);
  - a switch that misses a union member.
- **No dead code.** `bun run deadcode` (knip) fails on any unused export, file or dependency, so a refactor cannot leave a helper behind.
- **Schemas at every boundary.** Every JSON file, request, frontmatter block, config, gh output and Slack or Discord frame is parsed with zod before use, and its type is inferred from the schema (`z.infer`), so the two cannot drift. An unreadable file is set aside or reported, never trusted.
- **Errors as classes.** `StopRequested`, `MainCheckoutMoved`, `PersonChangedStatus`, `RecordRaced`, `RecordUnsettled`, `AssistantUnavailable` and the rest are classes, and callers branch on `instanceof`, never on message text. `notTheStepsFault` names the ones that end a step without blocking its change.
- **Discriminated unions** for results and requests (`kind`, `ok`), handled with exhaustive switches.

## Tests

`bun run check` runs the typecheck, the lint, the dead-code gate and the suite, in that order. CI runs it on Ubuntu, macOS and three Windows jobs, and adds a coverage gate of at least 80% and the security scans.

- **About 130 test files.** Unit tests sit in `tests/unit/`; `tests/integration/` runs whole ticks in throwaway git repositories.
- **No real Claude or GitHub.**
  - A fake `claude` (`tests/fake-claude/`) answers each phase from fixtures, and can be slow, hang or fail on cue.
  - A fake `gh` (`tests/fake-gh/`) uses a bare repository as the remote.
  - Slack and Discord are local stub servers.
- **Property-based tests** (fast-check, `tests/unit/properties.test.ts`) cover the parsers: frontmatter, plan file lists and the like.
- **Each test file runs in its own process**, four at a time (`scripts/test.ts`), heaviest first, so tests that touch `process.env` or the stop state stay apart.
- **Windows needs care.** Windows hands out a freed pid again quickly, so a test that needs a process that is not running uses `NEVER_A_PID`, never an exited process's pid. A rename can be refused while another process holds the file, so `writeFileAtomic` retries before it writes in place.
