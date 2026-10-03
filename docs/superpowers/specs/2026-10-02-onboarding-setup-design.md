# Onboarding: `loopstra setup`

Date: 2026-10-02. Status: proposed.

## Problem

`loopstra init` writes a config without asking anything, and some of its defaults stop the loop
without saying why it matters. The budgets are the worst: `claude.max_budget_usd: 5` is about 25
minutes of Claude at roughly $0.20 a minute, shorter than the 30-minute `timeout_minutes`, so a long
build ends as "hit its spending limit" and blocks the change. Chat's $5 a day is about 25 minutes of
chat for everyone together. Other settings (the test command, gates, GitHub, chat bots, models) are
correct only if someone opens `config.yaml` and reads it.

## Goals

- A walkthrough of every setting, which can be run again at any time, as a whole or one section at a time.
- Budgets are off unless someone wants them: no default limits.
- Checks that what is configured actually works (the test command, `gh`, the chat tokens).
- When the loop stops on a limit, the person is told which setting it was and which command changes it.
- It works unattended (`--defaults`, `--check`), and it never calls Claude.

## Non-goals

- A Claude-driven setup conversation. The `loopstra` skill explains choices and points to
  `loopstra setup`; it never edits the config itself.
- New settings other than `claude.max_budget_usd_per_day`.
- Testing real Slack or Discord tokens or a real `claude` sign-in automatically.

## Commands

```
loopstra setup                 # every section, in order
loopstra setup <section>       # one section: budgets, commands, gates, github, chat, models
loopstra setup --defaults      # no questions: every question takes its suggestion
loopstra setup --check         # no questions, no edits: run every section's checks; exit 1 if any fails
```

Run without `--defaults` or `--check` and without a terminal (stdin not a TTY), setup refuses and
writes nothing: "setup asks questions; run it in a terminal, or use --defaults / --check".

`loopstra init` is unchanged in what it writes. At the end, in a terminal, it asks "Walk through
the settings now? [Y/n]" and runs `loopstra setup`. Without a terminal it prints
"Next: loopstra setup walks you through the settings."

## Sections

Sections run in the order below. Each shows the current value, explains it in one sentence, and
suggests a value. Pressing Enter takes the suggestion, which is the current value when there is one.

| Section | Asks | Checks |
|---|---|---|
| `budgets` | "Do you want spending limits? [no]". If yes: each limit, in minutes or dollars. | A limit shorter than `timeout_minutes`, in minutes, is a warning. |
| `commands` | Confirms or edits test, lint, build, run and install, showing what `init` detected. | `commands.test` runs once in a temporary detached worktree of `main_branch`, within `timeout_minutes`, and exits 0. If it fails, that's a warning, since main may be red today. `claude` is found (on PATH, or `LOOPSTRA_CLAUDE_EXECUTABLE`). |
| `gates` | For spec, plan and done: whether a person approves (`status`) or not (`none`), and whether an agent reviewer runs. (The merge gate belongs to `github`.) | — |
| `github` | How a change is merged: through a GitHub pull request that someone approves (`gates.merge.human: pr`), locally after a person sets the status (`status`), or locally on its own (`none`). Then the method (`squash` or `merge`). | With pull requests: `gh auth status` succeeds and `git ls-remote <remote>` answers. |
| `chat` | Where people talk to the orchestrator: any of terminal, dashboard, Slack, Discord. Only the chosen bots are asked about: the token environment variable names, channel, `allow`, `acceptors` and `announce_to`. A bot that isn't chosen is removed. | Each chosen bot's token variable is set, and the platform accepts it: Slack `auth.test`, Discord `GET /users/@me`. |
| `models` | The `claude.models` names (default, cheap, strong), the model each stage uses, and `chat.model`. | — |

The terminal and the dashboard need no settings. Choosing them only says they'll be used, and
setup reminds the person to run `loopstra chat` and `loopstra ui`. Adding Slack or Discord later is
`loopstra setup chat` again.

## Budgets

### Defaults: no limit

Every budget becomes optional, and when it is missing there is no limit:

| Setting | Meaning | Default |
|---|---|---|
| `claude.max_budget_usd` | What one loop session may spend | no limit |
| `claude.max_budget_usd_per_day` (new) | What the loop's sessions may spend together since local midnight | no limit |
| `chat.max_budget_usd_per_session` | What one chat turn or writer run may hold | no limit |
| `chat.max_budget_usd_per_day` | What chat turns and writer runs may spend together since local midnight | no limit |

With no limit:

- `claude.max_budget_usd`: `--max-budget-usd` is not passed to `claude`, and `timeout_minutes` is the
  only stop. (The fixed $0.05 cap on preflight's probe session is not a user budget and stays.)
- Chat: no hold is reserved and no turn is refused for budget. Chat phases still record their cost in
  the trace, so the dashboard totals are unchanged.
- `claude.max_budget_usd_per_day`: phases start without a check.

In the schema each is `z.number().positive().optional()`.

`init`'s template mentions them in a comment, with no values. The template is laid out so that the
`yaml` library writes it back unchanged (no map ends in comment lines, no padding for alignment, and
`commands.test` comes last in its block), so the first edit by setup changes only the lines it edits:

```yaml
  # Spending limits, in US dollars, are off unless set (`loopstra setup budgets` sets them in minutes or dollars):
  #   max_budget_usd: what one session may spend
  #   max_budget_usd_per_day: what the loop's sessions may spend together in a day
```

### The loop's daily cap

When `claude.max_budget_usd_per_day` is set, every loop phase that runs an agent reserves what it may
spend through the same hold that chat uses (`Trace.phaseStartWithin`). Phases count across every
slug except `_chat`, since local midnight. What it holds is the smaller of `claude.max_budget_usd`
(when set) and what is left of the day.

A running phase's hold counts against the day until the phase ends, or until it is older than
`timeout_minutes` plus 10 minutes: a process killed mid-phase leaves its row running, and its hold must
not lock the rest of the day. (Chat's holds go stale the same way.) A hold is not spending: a
change's cost, the dashboard and `status` leave running phases out.

If nothing is left, the phase doesn't start. The change waits in its current state with no failure
and no retry, and the attention list shows "Paused: the loop has used today's budget
(`claude.max_budget_usd_per_day`, $X). It resumes after midnight, or change it with
`loopstra setup budgets`." The next tick after midnight starts the phase.

### In setup

"Do you want spending limits?" "No" removes all four keys. Enter takes "yes" when a limit someone
chose is set (a value other than the old template's), else "no", so `--defaults` never removes a limit
someone chose but does remove the old template's. "Yes" asks each one in turn; Enter keeps the
current limit (none when unset or the old template's), and the table's suggestion is shown as a hint
in the question. An answer can be minutes (`30m`, `2h`), dollars (`$6`, `6`) or `none`. Minutes are converted at a rate
shown at the start: "$0.20 a minute (about $2 per 10 minutes); press Enter to keep it or type
another rate." The rate is only used during setup and is not saved. Each question shows a suggestion:

| Setting | Suggested |
|---|---|
| `claude.max_budget_usd` | `timeout_minutes` × 1.5 at the rate (30 min → $9) |
| `claude.max_budget_usd_per_day` | none |
| `chat.max_budget_usd_per_session` | 20 minutes ($4) |
| `chat.max_budget_usd_per_day` | 3 hours ($36) |

An existing repository's config keeps whatever values it has. Where a value equals the old template's
(`claude.max_budget_usd: 5`, `chat.max_budget_usd_per_day: 5`, `chat.max_budget_usd_per_session: 2`),
setup shows it as "5 (the old default; the default is now no limit)".

### When a limit is hit

The notes for a phase stopped by a limit name the setting and the command:

- budget: "This step hit its spending limit (`claude.max_budget_usd`). An engineer can raise or
  remove it with `loopstra setup budgets`."
- timeout: the existing note, plus "An engineer can allow longer with claude.timeout_minutes in
  loopstra/config.yaml."

## How it's built

```
src/setup/index.ts          loopstra setup: parse args, load the document, run sections, validate, save
src/setup/prompt.ts         questions over streams: yes/no, pick one or several, text, amount (30m, $6, none)
src/setup/document.ts       the YAML document: get, set and clear by path, keeping comments
src/setup/sections/*.ts     budgets, commands, gates, github, chat, models
```

```ts
interface SetupContext {
  root: string;
  doc: ConfigDocument;    // edits go here; nothing is written until the end
  ask: Prompt;            // with --defaults, every question returns its suggestion
  out: (line: string) => void;
}

interface Section {
  name: string;
  title: string;
  ask(ctx: SetupContext): Promise<void>;
  check(ctx: SetupContext): Promise<Check[]>;
}

interface Check { level: "ok" | "warn" | "fail"; text: string }
```

- Sections are independent. Each reads current values from `ctx.doc` and writes only what the person
  changed. A key that is not in the file is added only when the answer differs from its default; a key
  that is there (the template writes many, as documentation) is updated in place. Budgets are the
  exception: no limit is the absence of the key, so choosing none removes it.
- `document.ts` uses `yaml`'s `parseDocument`, `getIn`, `setIn` and `deleteIn`, and `String(doc)` to
  save. Comments and key order survive.
- At the end, the edited document is validated with `ConfigSchema`. If it is invalid, the errors are
  printed and nothing is saved. If it is valid, it is written in one atomic write. Quitting (Ctrl+C
  or end of input) saves nothing.
- Checks run after saving (or alone with `--check`), each with a time limit, and only read. The test
  command runs in a temporary detached worktree that is removed afterwards. A failed check never
  undoes the save; it is printed under "To fix".

## The skill

`templates/skill/SKILL.md`'s Onboard steps point to `loopstra setup`, and its Status section explains
the budget pause and a step stopped by its limit: when someone asks how to configure Loopstra or why
the loop stopped on a limit, the skill explains the choice in their context and tells them which
`loopstra setup <section>` to run. It does not edit `config.yaml` for anything setup asks.

## Testing

Unit:

- prompt: each question type over fake streams. Amounts (`30m`, `2h`, `$6`, `6`, `none`); re-asking
  after an invalid answer; `--defaults` returns suggestions without reading input.
- document: set and clear keep comments and order; clearing removes the key; an unchanged document
  saves byte for byte.
- each section's `ask`: scripted answers give the expected YAML; untouched keys stay.
- budgets: with no limit, `--max-budget-usd` is not passed (fake `claude` args) and chat reserves
  nothing; a set limit still stops a phase, with the new note; the old-default note appears for 5.
- daily cap: a phase past it does not start and the attention item appears; after midnight (an
  injected clock) it starts.

Integration:

- `loopstra init` then `loopstra setup --defaults`: the config loads, keeps its comments, and has no
  budget keys.
- `--check` with a failing `commands.test`, a signed-out fake `gh` and an unset Slack token variable
  reports all three and exits 1.
- Without a TTY and without flags, setup refuses and writes nothing.
- The chat token checks against the fake Slack and Discord APIs (`LOOPSTRA_SLACK_API` and the Discord
  equivalent).

Manual, once before release: real Slack and Discord tokens, and a real `claude` sign-in.

## Documentation

- README: "Set up a repo" points to `loopstra setup`; Configuration lists the budget settings as
  optional, unlimited by default.
- `docs/decisions.md`: budgets are opt-in; setup never calls Claude; the skill explains, setup edits.
- `templates/config.yaml`: the budget comments above.
