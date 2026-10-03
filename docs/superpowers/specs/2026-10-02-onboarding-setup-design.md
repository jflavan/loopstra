# Onboarding: `loopstra setup`

Date: 2026-10-02. Status: built (this text matches what was built).

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
loopstra setup --check         # no questions, no edits: run the checks; exit 1 if any fails
loopstra setup --help          # the usage line and the sections, each with its title; exit 0
```

The arguments are at most one section and at most one of the two flags. `--help` or `-h` wins over
anything else and works in any folder. Anything else prints
"Usage: loopstra setup [section] [--defaults | --check]" and exits 1; an unknown section lists the
sections. In a folder without `loopstra/config.yaml` it says to run `loopstra init` first.

Run without `--defaults` or `--check` and without a terminal (stdin not a TTY), setup refuses and
writes nothing: "loopstra setup asks questions: run it in a terminal, or use --defaults (take every
suggestion) or --check (only check)."

`--check` first prints "loopstra/config.yaml loads." (or why it does not, and exits 1), then the
checks of the sections named (all of them by default).

`loopstra init` is unchanged in what it writes. The first steps have one order everywhere: setup,
commit, start. Its "Next:" list says so, `loopstra setup` first. Then, in a terminal, `offerSetup`
asks "Walk through the settings now? [Y/n]" and runs setup. One prompt reads the answer to the offer
and every question after it (a second reader on the same input would lose lines). After the
walkthrough, when setup saved (or had no changes), it prints "Next: commit what init wrote (loopstra/,
.claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore) on <main_branch>, then run `loopstra start`."
When setup stopped or saved nothing: "Next: run `loopstra setup` again when you are ready (or edit
loopstra/config.yaml), commit what init wrote (...) on <main_branch>, then run `loopstra start`."
Init exits 0 whatever setup did; setup says why when it saves nothing.

## Sections

Sections run in the order below. Each shows the current value, explains it in one sentence, and
suggests a value. Enter takes the suggestion, which is the current value when there is one. On a
question that may be left empty, `-` leaves it empty. Under `--defaults` nobody types, so hints about
typing ("Type - to leave out an optional one.", "press Enter to keep it") are left out.

| Section | Asks | Checks |
|---|---|---|
| `budgets` | The four limits as they are now, then "Do you want spending limits?". If yes: the rate, then each limit, in minutes or dollars (below). | Warnings, at the rate entered in this run ($0.20 a minute otherwise): `claude.max_budget_usd` below `timeout_minutes` (a long step stops on the budget first); a session limit above its day limit, for the loop or for chat; `chat.max_budget_usd_per_day` without `chat.max_budget_usd_per_session`. |
| `commands` | `test`, `install`, `lint`, `build`, `run` in turn, suggesting the current value or what `init` detects. Only `test` needs an answer. `-` leaves one out and sticks: the key becomes its `# install:` placeholder, and the detected command is suggested only when there is neither a key nor a placeholder. | `claude` is found (on PATH, or `LOOPSTRA_CLAUDE_EXECUTABLE`); missing fails. `commands.install` (when set) then `commands.test` run once in a throwaway detached checkout of `main_branch` at `.loopstra/setup-main`, sharing one `timeout_minutes`; the checkout is removed afterwards. A failure or timeout is a warning, since main may be red today; a program the shell could not find fails, naming it ("`bun` is not installed or not on PATH (commands.test)."). |
| `gates` | For spec, plan and done: should a person approve (`status`) or not (`none`), and does an independent agent review. (The merge gate belongs to `github`.) | — |
| `github` | Says whether the repository has a remote (with one, every change goes up as a pull request). Who approves a merge: `none`, `status` or `pr`; then the method (`squash` or `merge`). Without a remote, `pr` is asked again, and a config already set to `pr` suggests `status`. | With a remote: `git ls-remote --heads <remote>` answers and `gh` is signed in (20 seconds each), whatever the merge gate, since every change goes through a pull request. Without one: `pr` fails, anything else is fine. |
| `chat` | Where people talk to the orchestrator: any mix of terminal, dashboard, Slack, Discord. Only the chosen bots are asked about: the names of the token environment variables (a token pasted there is refused, naming that question's variable as the example), the channel, `allow`, `acceptors` and `announce_to` (for a new bot, the channel just entered is suggested). Discord ids must be numbers, kept as quoted strings; Slack ids must be ids, not `#names`. The token variable names are always written, so the file says which to set; id lists are written on one line (`allow: [ U1, U2 ]`). A bot that isn't chosen is removed. | Each chosen bot's token variables are set, and the platform accepts the bot token: Slack `auth.test`, Discord `GET /users/@me` (10 seconds each). A refused token, or a platform that cannot be reached, fails; any other answer (a rate limit, an outage) is a warning, and so is a Slack app-level token that does not start with `xapp-`. |
| `models` | The `claude.models` names (default, cheap, strong; no spaces), the model each stage uses, and `chat.model`. | — |

The terminal and the dashboard need no settings. Choosing them only says they'll be used, and
setup reminds the person to run `loopstra chat` and `loopstra ui`. Adding Slack or Discord later is
`loopstra setup chat` again.

## Budgets

### Defaults: no limit

Every budget becomes optional, and when it is missing there is no limit:

| Setting | Meaning | Default |
|---|---|---|
| `claude.max_budget_usd` | What one loop session may spend (and one chat session) | no limit |
| `claude.max_budget_usd_per_day` (new) | What the loop's sessions may spend together since local midnight | no limit |
| `chat.max_budget_usd_per_session` | What one chat turn or writer run may hold | no limit |
| `chat.max_budget_usd_per_day` | What chat turns and writer runs may spend together since local midnight | no limit |

With no limit:

- `claude.max_budget_usd`: `--max-budget-usd` is not passed to `claude`, and `timeout_minutes` is the
  only stop. (The fixed $0.05 cap on the probe session is not a user budget and stays.)
- Chat: no hold is reserved and no turn is refused for budget. Chat phases still record their cost in
  the trace, so the dashboard totals are unchanged.
- `claude.max_budget_usd_per_day`: phases start without a check.

In the schema each is `z.number().positive().optional()`.

`init`'s template mentions them in comments, with no values. The template is laid out so that the
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

Each tick checks before picking a change: while spent plus held leaves less than $0.01, nothing
starts, and the probe session that tells an outage from a phase's own failure is skipped too. A phase
that cannot start partway through a step ends the step like an unavailable assistant: the change
keeps its status, with no failure and no retry, and resumes when there is budget again. So does a
session cut short by the day: when its cap was what was left of the day (less than
`claude.max_budget_usd`, or that is unset) and it ends on its budget, the phase ends interrupted
with its real cost and the loop pauses. A session stopped by `claude.max_budget_usd` itself still
blocks. Both trace a `pause` event (under `_loop` once per new reason a day, or under the change).

A step that cannot fit in a day would start over and run out every day. So a day-budget pause
records the change's status, and when the change's previous such pause was on an earlier day at the
same status, the change is blocked instead: "This step needs more than the loop's daily budget
(claude.max_budget_usd_per_day, $X.XX): it ran out partway again at the same point as on an earlier
day. Raise or remove the limit with `loopstra setup budgets`.", plus the status to set to resume.

Every session's cost counts: a phase that ends interrupted (the assistant unavailable, the day's
budget) or crashes after its session ended keeps what the session cost, in chat turns too.

The note tells the two cases apart:

- Spent (what has ended alone reaches the cap): "The loop has used today's budget
  (claude.max_budget_usd_per_day, $X.XX). It resumes after midnight, or an engineer can change it
  with `loopstra setup budgets`." The attention list (`status`, the dashboard, chat's announcements)
  shows it as "Paused". The next tick after midnight starts the phase.
- Held (the rest is held by running phases): "The rest of the loop's budget for today (...) is held by
  a phase still running, or by one that stopped without ending. The loop goes on once it ends, or
  within N minutes at the latest." Only in the tick's result and the trace: it clears by itself, so it
  is not on the attention list.

The tick also records its wait in the heartbeat, so the loop line reads "Paused — <note>" in
`status`, `tail` and the dashboard: until local midnight when the day is spent, for two polls while
it is only held, and cleared when a tick goes on. An unavailable assistant's pause (kept in
`.loopstra/paused.json`) comes first; a stopped loop drops the day's.

### In setup

The section first lists the four limits as they are. "Do you want spending limits?" "No" removes all
four keys. Enter takes "yes" when a limit someone chose is set (any limit unless they are the old
template's, below), else "no", so `--defaults` never removes a limit someone chose but does remove the
old template's.

"Yes" asks the rate first: "Minutes are turned into dollars at $0.20 a minute (about $2 per 10
minutes); press Enter to keep it or type another rate". The rate is used for this run (the questions
and the budgets check) and is not saved; `--check` uses $0.20. Then each limit in turn, with its suggestion as a hint in the question, while Enter keeps the
current limit (none when unset or the old template's), so `--defaults` never adds a limit:

```
What may one loop session spend? Suggested: 45m ($9.00). Enter keeps: no limit. (minutes like 30m, dollars like $6, or none) [no limit]:
```

An answer can be minutes (`30m`, `2h`), dollars (`$6`, `6`) or `none`, which removes the key. Amounts
are kept to the cent and shown with two decimals. One that comes to $0 is asked again: "Answer more
than $0, or none for no limit."

| Setting | Suggested |
|---|---|
| `claude.max_budget_usd` | `timeout_minutes` × 1.5 at the rate (30 min → 45m, $9) |
| `claude.max_budget_usd_per_day` | none |
| `chat.max_budget_usd_per_session` | 20 minutes ($4) |
| `chat.max_budget_usd_per_day` | 3 hours ($36) |

An existing repository's config keeps whatever values it has until setup runs. The limits count as
the old template's only when every one present has that template's value (`claude.max_budget_usd: 5`,
`chat.max_budget_usd_per_day: 5`, `chat.max_budget_usd_per_session: 2`) and there is no
`claude.max_budget_usd_per_day`, which it never wrote. Then setup shows each as "$5.00 (the old
default; the default is now no limit)" and treats it as unset; otherwise every limit there is a choice.

### When a limit is hit

The notes for a phase stopped by a limit name the setting and the command:

- budget: "This step hit its spending limit (claude.max_budget_usd). An engineer can raise or
  remove it with `loopstra setup budgets`."
- the loop's day, twice at the same status: the note above ("This step needs more than the loop's
  daily budget ...").
- timeout: the existing note, plus "An engineer can allow longer with claude.timeout_minutes in
  loopstra/config.yaml."
- chat, when its day is spent: "I have used today's chat budget ($X.XX), so I cannot answer until
  tomorrow. An engineer can raise or remove the limit with `loopstra setup budgets`." When the rest
  is only held by other conversations, it asks to try again in a few minutes.

## How it's built

```
src/setup/index.ts          loopstra setup: parse args, load the document, run sections, validate, save, check
src/setup/offer.ts          offerSetup: init's "Walk through the settings now?"
src/setup/prompt.ts         questions over streams: text, yes/no, pick one or several, amount (30m, $6, none)
src/setup/document.ts       the YAML document: get, set, put and clear by path, keeping comments
src/setup/sections/*.ts     budgets, commands, gates, github, chat, models
```

```ts
interface SetupContext {
  root: string;
  doc: ConfigDocument;    // edits go here; nothing is written until the end
  ask: Prompt;            // with --defaults, every question returns its suggestion; ask.interactive is false
  env: Record<string, string | undefined>;  // where token variables are read
  ratePerMinute?: number; // the rate entered in this run (budgets sets it; its check uses it)
}

interface Section {
  name: string;
  title: string;
  covers: string[];       // the paths its questions edit, like "gates.merge" or "stages.*.model": what it can fix
  ask(ctx: SetupContext): Promise<void>;
  check(ctx: SetupContext, cfg: Config): Promise<Check[]>;
}

interface Check { level: "ok" | "warn" | "fail"; text: string; section?: string }
```

- Sections are independent. Each reads current values from `ctx.doc` and writes only what the person
  changed. `put` adds a key that is not in the file only when the answer differs from its default; a
  key that is there (the template writes many, as documentation) is updated in place. The exceptions:
  budgets (no limit is the absence of the key, so choosing none removes it), a chosen bot's token
  variable names (always written), and a parent that is not a map (`gates: none`), which `put`
  replaces with one so the config loads.
- `document.ts` uses `yaml`'s `parseDocument`, `getIn`, `setIn` and `deleteIn`, and `String(doc)` to
  save. Comments, key order and line endings survive (CRLF when most lines have it). A scalar is
  changed in place, so its line comment stays. A new key takes the place of its commented-out
  placeholder line (`# lint:`) when its map has one. Clearing a key removes any map it leaves empty,
  and moves its comments to the next key.
- A config that does not load now gets a note before the questions ("Note: loopstra/config.yaml has
  problems now; the questions below can fix them:", then one line per problem) when every problem is
  in a setting the sections being run ask about: its path is under one of their `covers`, or holds
  one (`gates: none` holds `gates.spec`). An unknown key, or a problem elsewhere (like
  `claude.timeout_minutes`, which no question asks), prints
  "Fix these in loopstra/config.yaml first:" with the problems, asks nothing and exits 1. A
  validation message that already starts with its path is not prefixed with it again. At the end,
  the edited document is validated with `ConfigSchema`. If it is invalid, the
  errors are printed and nothing is saved. If it is valid and changed, it is written in one atomic
  write. Quitting (end of input: Ctrl-D, or Ctrl-Z then Enter on Windows), a section that throws, or
  `--defaults` reaching a question with no suggestion saves nothing and exits 1.
- Checks run after saving (or alone with `--check`), only for the sections that ran, all sections at
  the same time, each section's within `timeout_minutes` plus a minute, and only read. They are
  listed in section order. A failed check never undoes the save; what is not ok is counted under "To
  fix", which names the `loopstra setup <section>` commands to run again. Setup exits 0 once saved;
  `--check` exits 1 when any check fails.

## The skill

`templates/skill/SKILL.md`'s Onboard steps point to `loopstra setup`, and its Status section explains
the day pause and a step stopped by its limit (and that a "held" pause clears by itself): when someone
asks how to configure Loopstra or why the loop stopped on a limit, the skill explains the choice in
their context and tells them which `loopstra setup <section>` to run. It does not edit `config.yaml`
for anything setup asks.

## Testing

Unit:

- prompt: each question type over fake streams. Amounts (`30m`, `2h`, `$6`, `6`, `none`); re-asking
  after an invalid answer; `-`; `--defaults` returns suggestions without reading input.
- document: set and clear keep comments and order; clearing removes the key and emptied maps;
  placeholders; CRLF; an unchanged document saves byte for byte.
- each section's `ask`: scripted answers give the expected YAML; untouched keys stay.
- budgets: with no limit, `--max-budget-usd` is not passed (fake `claude` args) and chat reserves
  nothing; a set limit still stops a phase, with the new note; the old-default note appears for 5.
- daily cap: a phase past it does not start and the attention item appears only when spent; a stale
  hold stops counting; after midnight (an injected clock) it starts.
- the offer: one prompt for the offer and the questions; the final "Next:" line.

Integration:

- `loopstra init` then `loopstra setup --defaults`: the config loads, keeps its comments, and has no
  budget keys.
- `--check` with a failing `commands.test`, a signed-out fake `gh` and an unset Slack token variable
  reports all three and exits 1.
- Without a TTY and without flags, setup refuses and writes nothing.
- The chat token checks against the fake Slack and Discord APIs (`LOOPSTRA_SLACK_API`,
  `LOOPSTRA_DISCORD_API`).

Manual, once before release: real Slack and Discord tokens, and a real `claude` sign-in.

## Documentation

- README: "Set up a repo" points to `loopstra setup`; Configuration lists the budget settings as
  optional, unlimited by default, with a Budgets paragraph.
- `docs/decisions.md`: the Onboarding section (budgets are opt-in; the daily cap pauses; setup never
  calls Claude; the skill explains, setup edits).
- `templates/config.yaml`: the budget comments above. `templates/skill/SKILL.md`: as above.
