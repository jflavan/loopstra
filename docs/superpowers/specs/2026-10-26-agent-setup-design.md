# Agent setup for every step

## Why

Every step of the loop (intake, design, spec-check, plan, plan-challenge, build, reconcile, fix, review, revise, verify, done-check, lessons, and chat's orchestrator and write-intent) runs as one plain Claude Code session. Per stage a person can set a model, a "Use these skills" line, and before/after commands; per step, a model. That is a good baseline, but projects and teams differ: one wants its review done by three specialist reviewers, another wants its build session to play a house "senior engineer" role with the team's own skills, a third wants the loop to run the same agents on every machine regardless of who starts it.

The owner's words: "this tool should allow for a high degree of flexibility to accommodate different projects and teams. What's going on right now is a good baseline." The goal is flexibility, not one prescribed way of working.

## Goals

- For each step, an engineer can set:
  - **the agent** the session plays (a role: a system prompt, and optionally a narrower tool list);
  - **the subagents** it may hand work to, one by one or as named **teams**;
  - **the skills** it uses;
  - **extra tools** and **MCP tools** on top of the step's baseline.
- Settings layer: one block for every step, then each step's own. A step with nothing set behaves exactly as today.
- Engineers can choose whether loop sessions also load the personal setup (skills, agents, plugins, MCP servers, CLAUDE.md) of whoever runs `loopstra start`, or only what the repository declares.
- Agents, teams and skills can be set up in three places: `loopstra setup`, the loopstra operator skill during onboarding, and a new configuration screen in the console.
- A skill or agent the repository does not have yet can be added there: copied from the person's machine or a plugin, fetched from a git repository or folder, or (through the operator skill) written new.
- Everything stays human readable: agent and skill definitions are Claude Code's own files in the repository; `loopstra/config.yaml` only names which ones each step uses.

## Non-goals

- Claude Code's experimental agent teams (peers with their own sessions messaging each other). In CLI 2.1.311 the Agent tool's `team_name` is deprecated and ignored; no team tools exist. A loopstra team is a named group of subagents under the step's session. Revisit if Claude Code ships teams again.
- Changing what a step is for, its prompt contract, or its structured output. Prompts stay customizable as today (`loopstra customize`).
- A marketplace or registry of loopstra's own.
- Per-change agent setups (an intent choosing its own agents). Settings are per repository.

## Anti-goals (a failure even if it works)

- **Weakening the loop's safety.** The runtime alone commits, branches and merges. Read-only steps (intake, design, spec-check, plan, plan-challenge, review, verify, done-check, lessons, and the chat steps) never get write tools, whatever an agent, subagent, team or tools list says. Checked on the real CLI: tools in `--disallowedTools` are also refused to the session's subagents and to a session run with `--agent`.
- **Breaking the structured output.** Every step must still return its envelope.
- **Hidden behaviour.** What a step ran as (agent, subagents, skills, tools) must be visible in the trace and the console, like its model is today.
- **Making the simple case harder.** A repository that sets nothing sees no new questions it must answer, no new required files, and no change in behaviour.

## What the CLI does (checked on Claude Code 2.1.311, `-p`, stream-json)

| Fact | Consequence |
|---|---|
| The repo's `.claude/agents/*.md` and `.claude/skills/*/SKILL.md` load in `-p` sessions; the `init` event lists `agents` and `skills`. | Definitions can live in the repo; the init event tells what a session actually saw. |
| Subagents run through the Task/Agent tool without any allow rule. | Delegation needs no new permission plumbing. |
| `--agents '<json>'` adds inline agent definitions for one session. | Loopstra can hand a session agents built from config or adjusted files. |
| `--agent <name>` runs the main session as that agent; the session's `--model` wins over the agent's `model:`. | Model choice stays loopstra's (one source of truth, already shown in the console). |
| An agent whose `tools:` list is narrow (e.g. `Read`) loses the structured-output tool: the session ends with `structured_output: null`. | Loopstra must not use `--agent` with a definition's own tool list as-is. See "Running a step as an agent". |
| `--disallowedTools` applies to subagents and to `--agent`: a judge's subagent with `Write` in its definition could not write. | The safety guard holds without extra work. |
| `--setting-sources project` drops user skills, agents and plugins (106 skills down to 20, user agents gone); project skills and agents still load. | "Repo only" is one flag. |
| Project `.mcp.json` servers load in `-p` without approval. | Committing `.mcp.json` is enough for repo-declared MCP servers. |
| `--forward-subagent-text` forwards subagents' text and thinking into the stream. | The console can show what subagents do. |

## The settings

A new top-level `agents` block in `loopstra/config.yaml`. Everything in it is optional.

```yaml
agents:
  # all: the personal setup of whoever runs `loopstra start` plus the repo's (today's behaviour).
  # repo: only what the repository declares (its .claude/, .mcp.json, CLAUDE.md), the same on every machine.
  sources: all

  # Named groups of subagents. `parallel`: each member gets the same task and the session weighs
  # their answers. `pick`: the session hands each piece of work to the member that fits it.
  teams:
    reviewers:
      members: [security-reviewer, performance-reviewer, correctness-reviewer]
      way: parallel

  # Applies to every step, then each step's own settings are added on top.
  all:
    skills: [house-style]

  steps:
    review:
      agent: lead-reviewer            # .claude/agents/lead-reviewer.md
      teams: [reviewers]
      subagents: [Explore]            # single subagents, by name
      skills: [threat-modeling]
      tools: ["WebFetch"]
      mcp_tools: [mcp__github__get_pull_request]
    build:
      agent: senior-engineer
      subagents: [test-writer]
```

Rules:

- **Keys under `steps`** are the step keys of `STEPS` in `src/models.ts` (all fifteen, including `orchestrator` and `write-intent`). An unknown key is a config error naming the known ones. The chat steps follow their own rules (see "Chat steps").
- **Layering:** `all`, then the existing `stages.<stage>.skills` exactly where they reach today (design and plan writing, build, both reviews, verify, done-check, lessons; not intake, spec-check, plan-challenge, reconcile, fix or revise), then `steps.<step>`. Lists (`skills`, `subagents`, `teams`, `tools`, `mcp_tools`) add up, each name once, in that order. `agent` is a single value: the step's own wins over `all`.
- **`claude.mcp_tools`** (added on branch `feat/mcp-tools`) stays and means the same thing as `agents.all.mcp_tools`. *Builder's call:* keep both as aliases, or move `claude.mcp_tools` into `agents.all.mcp_tools` with an upgrade migration before that branch is released. Prefer the migration if the branch has not shipped in a release.
- **`tools`** are Claude Code allow rules, as in `claude.allowed_tools`. On a read-only step, `Edit`, `Write`, `NotebookEdit` and a bare `Bash` (or `Bash(*)`) are config errors that name the step and say why; narrower `Bash(<cmd> *)` rules are allowed, as judges already run the configured commands. Write tools stay removed from read-only steps by `--disallowedTools` regardless.
- **`mcp_tools`** entries follow the existing rule (`mcp__` plus letters, digits, `_`, `-`, `*`; no commas).
- **Names** of agents, subagents and skills are what Claude Code shows: `lead-reviewer`, a plugin's `plugin:name`, built-ins like `Explore`. Team names are loopstra's own: lowercase words joined by dashes. A team name that is also an agent name is an error.
- **Defaults:** with no `agents` block, or an empty one, every session is started exactly as today (same flags, same prompt). This must be pinned by a test.

## What a step's session gets

For a step with settings, `agentPhase` (src/phases.ts) adds:

1. **Allow list:** the step's tool set as today (`toolsFor`), plus the layered `tools` and `mcp_tools`, each once. `disallowedFor` is unchanged.
2. **Setting sources:** with `sources: repo`, `--setting-sources project` (not `local`: `.claude/settings.local.json` is personal). Loopstra's own `--settings` (the test-protection hook) still applies, since `--settings` is not a setting source. *Builder verifies* with the real CLI whether user MCP servers also drop out under `--setting-sources project`; if not, add `--strict-mcp-config --mcp-config .mcp.json` (when the file exists) for `repo`.
3. **The agent (role):** see the next section.
4. **Prompt lines,** before the prompt template, replacing today's single skills line:
   - `Use these skills: \`a\`, \`b\`.` (as today);
   - `Hand work to these subagents when it helps: \`x\` (its description), ...`;
   - per team: `For <what the team is for>, use the team \`reviewers\`: give each of \`a\`, \`b\`, \`c\` the same task at the same time, then weigh their answers yourself.` (or, for `pick`, `hand each piece of work to whichever of ... fits it`). The wording is the builder's; it must say which agents, how to use them, and that the session still returns its own structured output.
5. **Subagent visibility:** `--forward-subagent-text` when the step has subagents or teams, so the console and trace show their work.

A step without agent settings gets none of these, and today's skills line is produced exactly as now.

## Running a step as an agent

`--agent <name>` cannot be passed as is: a definition with its own `tools:` list removes the structured-output tool (checked), and its `model:` would be shown nowhere. Instead loopstra reads the definition and starts the session with an inline copy:

- Find the definition on main, never on the change's branch (see "Settled after review", 2): the step's snapshot of main first, then, with `sources: all`, `~/.claude/agents/<name>.md`. A plugin's agent (`plugin:name`) is found through the init event of an earlier session or by the builder's lookup of installed plugins; *builder's call* how, but a plugin agent must work with `sources: all`.
- Build `--agents '{"<name>": {...}}'` from it: its description and prompt as written; its `tools`, when it lists any, with the structured-output tool added and intersected with the step's allow list (a definition can narrow a step's tools, never widen them); no `model` (the step's model applies). Then pass `--agent <name>`.
- If the definition cannot be found, the step does not start: it fails with reason `setup` (a new failure reason: not an outage, not retried), and the owner note names the step, the missing agent, and where to add it. The same for a missing skill or subagent (see Checks).
- *Builder verifies* on the real CLI that an inline agent's `prompt` and the session's `--json-schema` together still produce `structured_output`, and that an inline definition with the same name as a file definition takes precedence. If inline-over-file precedence does not hold, give the inline copy a loopstra-specific name (`loopstra-<name>`).

## Checks

- **When the config loads:** shape only (names, step keys, tools rules, team members not empty, no team named like an agent).
- **`loopstra setup --check`, `loopstra start`, and the console's agent screen** check that every named agent, subagent, team member and skill exists: in the repo's `.claude/` (committed, since the loop works from commits), or, with `sources: all`, in the user's `~/.claude/` or an installed plugin. Missing ones are listed with the step that names them. `start` refuses to start while a name used by any step is missing, with the list and the fix (`loopstra setup agents`, or commit the file). A name found only on this machine (personal) gets a warning, not a refusal: it will not exist on another machine.
- **At session start:** the `init` event lists the agents and skills the session actually loaded. If a named one is missing there, loopstra ends the session at once (before it spends anything meaningful) and fails the step with reason `setup`, as above. This catches what the file check cannot (a plugin that failed to load).

## Getting skills and agents

Two kinds of things: **definitions in the repo** (`.claude/agents/<name>.md`, `.claude/skills/<name>/`), and **the step settings** that name them. Adding a skill or agent always ends with its files in the repo's `.claude/`, committed, so every machine and every loop checkout has it. Sources:

1. **This machine:** a personal skill or agent (`~/.claude/skills/<name>/`, `~/.claude/agents/<name>.md`) or one from an installed plugin, copied into the repo. The copy is the whole skill folder (scripts and references included).
2. **A git repository or a local folder:** the person gives a URL (and optionally a path inside it) or a folder; loopstra clones it shallowly into a temporary folder, lists the skills and agents it finds (any `SKILL.md`, any `agents/*.md`), and copies the ones picked. The source is recorded in the copied skill folder (a line in a `SOURCE.md`, or in the agent file's frontmatter as `source:`; *builder's call* which, as long as it is human readable) so a later update can find it.
3. **New:** a new agent from a short form (name, description, role text, tools, optional subagents of its own). A new skill only through the operator skill (step 4 of its Onboard, below), which can write one with the person; the CLI and console offer an empty skill (name, description, body) as a plain file at most.

Downloaded content is untrusted: copies go through a temporary folder, nothing in them runs, and the person sees the files' list before anything is written to the repo.

*Non-goal for now:* installing Claude Code plugins at project scope (`enabledPlugins` in `.claude/settings.json`). Copying is simpler, reviewable in the diff, and works with `sources: repo`. A plugin's skills and agents can still be used with `sources: all` on machines that have it.

## Setup (`loopstra setup agents`)

A new section, listed with the others and runnable alone (`loopstra setup agents`). It does not run in the first full walk-through unless the person says yes to "Set up agents for the loop's steps now? (y/N)", so the simple case gets one extra question at most.

1. **Sources:** all (default, today's behaviour) or repo only, with one line on what each means.
2. **What is available:** lists the agents and skills found (repo, personal, plugins), marking which are in the repo.
3. **Per step or for all steps:** the person picks a step (or "all steps") from the step table, then sets its agent, subagents, teams and skills by picking from the list (numbers or names; `-` clears), and tools and MCP tools as text. Teams are made or edited in the same flow (name, members, way).
4. **Adding:** at any pick, "add one" offers the sources above (copy from this machine, from a git repository or folder, or a new agent from the short form).
5. Saves the config keeping its comments (as setup does today), writes the copied or new files, then runs the checks and lists anything missing. It does not commit; like the rest of setup, it says to commit `loopstra/config.yaml` and `.claude/`.

The `setup` prompt style, `-` for empty, Enter for the suggestion, and per-section re-runs stay as they are.

## The operator skill (onboarding)

`templates/skill/SKILL.md` gets an Onboard step after the MCP step: "Set up the agents." The agent:

- lists the agents and skills its own session has (it sees them, and the repo's `.claude/`), and the steps with what each does;
- asks what the team wants from the loop in their words, and suggests a setup (for example a team of reviewers, or a role for the build), always saying what each choice costs (subagents and teams spend more per step);
- adds missing skills or agents: copies, fetches, or writes new ones with the person (it can author a skill; the CLI cannot);
- writes the `agents` block and the files, then has them run `loopstra setup --check` and commit.

The Tune section says the same flow is how to change agents later.

## The console: an Agents settings screen

The existing `/agents` page shows live sessions; this is configuration, so it sits in Settings as a second section next to the models, titled "Agents".

It shows:

- **Sources** (all / repo only), switchable.
- **The step table**, the same rows as the models: for each step, its agent, subagents, teams, skills, extra tools and MCP tools, each shown as set on the step, from `all`, or from the stage's skills, so the person sees where a value comes from (like the models page shows "follows design"). Editing a row changes `agents.steps.<step>`; an "All steps" row edits `agents.all`.
- **Teams:** list, create, edit (members, way), delete (refused while a step uses it, naming the steps).
- **Library:** the agents and skills available, grouped as In the repo / On this machine / From plugins, each with its description and the steps that use it. Actions: "Add to the repo" (copy), "Add from a git repository or folder", "New agent" (the short form), "Edit" for a repo agent (its frontmatter and role text), and "Remove from the repo" (refused while a step uses it).
- **Problems:** the check's result (missing names, personal-only names), at the top, with the fix.

Writing: the console never writes the repository itself. As with the models page, each change is a request in `.loopstra/requests/` that the loop applies and commits:

- config changes extend the existing `settings` request (path and value with the file's version) to the `agents.*` paths; list values are sent whole (the new list), not as edits;
- file changes are a new `agent-files` request: the files to write or remove under `.claude/agents/` and `.claude/skills/` (paths checked to stay inside those folders), with the version of each file read (or "absent"); refused if any changed since. Fetching from a git repository happens in the console server into a temporary folder and is shown before the request is sent.
- The loop commits them like other settings changes: `loopstra(_settings): agents.steps.review.teams → [reviewers] by <who> from the dashboard`, and `loopstra(_settings): add .claude/agents/lead-reviewer.md by <who> from the dashboard`.

Settings are read fresh per session (as models are since step models), so a change applies to sessions that start after it.

## Observability

- The trace's phase start records the step's effective agent setup (agent, subagents, teams, skills, tools, mcp_tools, sources), like the model.
- The session page in the console shows it in the session's facts, and shows subagents' work (from `--forward-subagent-text` and the Task tool events, which `src/tools.ts` already names "Handing off") nested under the call that started it.
- `loopstra status` and `tail` show nothing new unless a step failed with `setup`, whose note says what is missing.
- Cost: subagents' cost is part of a session's cost. *Builder verifies* that `total_cost_usd` includes subagents in `-p` (spike: run a step with a team and compare with the sum of usage). Budget caps apply to the whole session as today.

## Constraints

- Bun, TypeScript, Zod config, comment-preserving YAML edits, Preact console: as the codebase uses.
- Windows, macOS and Linux (paths to `~/.claude`, CRLF in agent files).
- `bun run check` green; new behaviour has tests with the fake CLI (`LOOPSTRA_FAKE_ARGS` records flags); the CLI facts above that the builder must verify get a short live check recorded in `docs/decisions.md`.
- `docs/decisions.md` gets a section for this feature; the README's config section and the setup section describe the new block and screen.

## Settled after review

A builder's read of this document raised these; each is decided here.

1. **Chat steps** (`orchestrator`, `write-intent`) run through `runChatAgent` (src/chat/agents.ts), in the main checkout, steered by people in Slack and Discord channels, with their own fixed allow and deny lists and secrets removed from the environment. So:
   - `agents.all` does not reach them, and neither does `claude.mcp_tools` (it does not today either).
   - On their own step entries they take `agent`, `skills`, `subagents` and `teams`. Their own `tools` and `mcp_tools` are allowed only on those entries, never inherited, and setup and the console say in plain words that anyone allowed to chat can steer those tools. `CHAT_DENIED` and the environment scrubbing always apply on top.
   - A missing name in a chat turn does not block anything: the turn answers that the chat agent's setup is broken, names what is missing, and is traced under `_chat`.
2. **Definitions come from main.** The loop's settings are main's, so are the definitions: loopstra reads every agent it names (the step's agent, its subagents, team members) from the step's snapshot of main (or the user's folder or plugins with `sources: all`) and passes them inline with `--agents`, under a loopstra name (`loopstra-<name>`) so a same-named file in a change's worktree never wins. A change's branch cannot rewrite the role that reviews it. Skills are loaded by Claude Code from the working directory, so for steps in a worktree the builder must make main's skills the ones used: *verify* whether `--add-dir <snapshot of main>` exposes its `.claude/skills`; if not, fail the step with `setup` when a named skill is missing from the worktree or differs from main's, with a note to reconcile. Either way a change editing `.claude/` already counts as drift unless its plan lists those files.
3. **Subagents' models and other frontmatter.** A subagent or team member keeps its own `model:` when its file sets one (a team mixing cheap and strong members is a feature); without one it runs on the step's model. Every subagent's model is recorded in the trace and shown in the console with the step's. Inline copies carry only `description`, `prompt`, `tools` (intersected with the step's allow list), `model` and `skills`; `permissionMode`, `hooks` and `mcpServers` are dropped, and the checks warn that they were dropped, naming the file.
4. **What the safety line covers.** On every step, `tools` may not hold git commands that change history or remotes (`git commit`, `push`, `merge`, `rebase`, `reset`, `checkout`, `switch`, `branch`, `tag`, `stash`, a bare `Bash(git *)`): the runtime owns those. On read-only steps, also no `Edit`, `Write`, `NotebookEdit`, bare `Bash` or `Bash(*)`. Narrower `Bash(<cmd> *)` rules and MCP tools stay the owner's call (as `claude.mcp_tools` already is), and setup, the console and the operator skill say which picks can change things.
5. **Fix, reconcile and revise resume the build's session**, so they run as the build's agent: `agent` is a config error on those three steps (the message says they continue the build session). Their other lists (skills, subagents, teams, tools, mcp_tools) layer as for any step, since each send passes its own flags; the inline agents are passed again on every resume.
6. **Stage skills** keep reaching exactly the steps they reach today (Layering, above), so a config with only `sources: repo` changes no prompt.
7. **Sign-in under `sources: repo`.** *Builder verifies* whether `--setting-sources project` drops a user's `apiKeyHelper` or `env` from `~/.claude/settings.json`. If it does, loopstra passes those two through its own `--settings`, so sessions still sign in.

## Left to the builder

- Module layout (a new `src/agents.ts` for layering, lookup and the inline definition is the obvious home), exact prompt wording, and the console layout within the Settings page's existing look.
- How plugin agents and skills are found on disk (or read from a recent init event).
- The `claude.mcp_tools` alias or migration (above).
- Whether `parallel`/`pick` need a third way; keep to these two unless a test shows one is missing.
- Splitting the work into PRs. A suggested order: (1) config, layering, session flags and prompt lines, checks, trace; (2) running a step as an agent; (3) setup section and adding skills/agents; (4) console screen and requests; (5) operator skill and docs.
