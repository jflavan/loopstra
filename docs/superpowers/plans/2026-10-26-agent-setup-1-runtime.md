# Agent Setup, Part 1: Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each loop and chat step can run as a named agent, with its own subagents, teams, skills, tools and MCP tools, as set in a new `agents` block of `loopstra/config.yaml`; with nothing set, sessions start exactly as today.

**Architecture:** A pure layer (`src/agents.ts`) turns the config into one `AgentSetup` per step and into prompt lines. A disk layer (`src/agent-files.ts`) finds agent and skill definitions (main's committed tree, the user's `~/.claude`, installed plugins), parses agent files, builds the inline `--agents` JSON, and checks that every named definition exists. `runPhase` gains the flags and an init-event check that ends a session which did not load what it was told to, with the new failure reason `setup`. `agentPhase` and `runChatAgent` wire it in.

**Tech Stack:** Bun, TypeScript, Zod 4, `yaml`, bun:test with the fake CLI (`tests/fake-claude/claude.ts`, `LOOPSTRA_FAKE_ARGS`).

**Spec:** `docs/superpowers/specs/2026-10-26-agent-setup-design.md` (read its "Settled after review" first). Parts 2-4 (setup section, console screen, operator skill and docs) get their own plans.

## Global Constraints

- With no `agents` block, or an empty one, every session's argv and prompt are byte-identical to today's (pinned by a test).
- The runtime alone commits, branches and merges; read-only steps never get `Edit`, `Write`, `NotebookEdit`, bare `Bash` or `Bash(*)`; no step's `tools` may hold history- or remote-changing git (`commit`, `push`, `merge`, `rebase`, `reset`, `checkout`, `switch`, `branch`, `tag`, `stash`, bare `git`).
- `mcp_tools` entries match `/^mcp__[\w*-]+$/` (no commas: the allow list reaches the CLI comma-joined).
- Inline agents are named `loopstra-<name>` with `:` replaced by `-` (`superpowers:code-reviewer` → `loopstra-superpowers-code-reviewer`).
- A main agent's inline `tools`, when its file lists any, always include `StructuredOutput` (checked on CLI 2.1.311: without it `structured_output` is null).
- `agents.all` and today's `claude.mcp_tools` never reach chat steps; chat steps keep `CHAT_DENIED` and `dropEnv`.
- `agent` is a config error on `fix`, `reconcile`, `revise` (they resume the build's session and run as the build's agent).
- Stage skills (`stages.<stage>.skills`) keep reaching exactly the steps they reach today (callers pass them as `spec.skills`, unchanged).
- Windows, macOS, Linux: paths via `node:path`, home via `os.homedir()` (tests pass their own), CRLF agent files parse.
- Comments and naming follow the codebase: plain sentences, `/** */` on exports.

## CLI facts this plan relies on (checked on Claude Code 2.1.311, `-p`, stream-json)

- `--agents '<json>'` + `--agent <name>` run the main session as an inline agent; `--model` wins over the agent's `model`.
- `--disallowedTools` also binds subagents and `--agent`.
- `--add-dir <dir>` loads that dir's `.claude/skills`; when the working dir has a skill of the same name, the working dir's wins (the other shows as `<dirname>:<name>`).
- `--setting-sources project` drops user skills, agents, plugins and user MCP servers; project ones load.
- `total_cost_usd` includes subagents (verified: haiku main + sonnet subagent, total = sum of `modelUsage`).
- The `system`/`init` event carries `agents: string[]` and `skills: string[]`; the fake CLI's fixtures carry neither (treat absent as "cannot tell").

## Review Focus

1. A config with only `sources: all` or `agents: {}` → argv and prompt unchanged for every step. (Task 6.)
2. An agent file with CRLF line endings, no frontmatter, or frontmatter without `tools` → parsed; no `tools` key in the inline copy, so the agent gets the session's tools. (Task 3.)
3. A named skill that exists only as a Claude Code built-in or claude.ai-synced skill (not on disk) → the file check warns, does not refuse; the init check decides. (Task 4.)
4. A plugin agent named `plugin:name` whose plugin is installed but disabled in `enabledPlugins` → "missing", with the fix in words. (Task 3.)
5. A worktree step naming a skill only main has → `--add-dir <snapshot of main>` supplies it; the session's init list has it under its plain name. (Task 6.)

---

## File structure

- Create `src/agents.ts`: config types and checks for the `agents` block helpers, `resolveSetup`, `setupLines`, `isEmptySetup`, `inlineName`. Pure.
- Create `src/agent-files.ts`: `parseAgentFile`, `findAgent`, `findSkill`, `inlineAgents`, `checkAgentSetup`, `BUILTIN_AGENTS`, `userSettingsPassthrough`. Reads disk.
- Modify `src/config.ts`: the `agents` block; drop `claude.mcp_tools` (moved to `agents.all.mcp_tools`; never released).
- Modify `src/models.ts`: `withModels` also carries `agents`; `ModelSettings` gains `agents`.
- Modify `src/claude.ts`: `RunPhaseInput` flags, `checkInit`, `FailureReason` `"setup"`.
- Modify `src/sessions.ts`: nothing unless `"setup"` needs a branch (it does not: it is a plain failure).
- Modify `src/phases.ts`: `toolsFor` drops `claude.mcp_tools`; `phasePrompt` uses `setupLines`; `attempt` passes the setup; `ownerNote("setup")`.
- Modify `src/chat/agents.ts`, `src/chat/orchestrator.ts`: chat wiring and the reply for `setup`.
- Modify `src/scheduler.ts`: `start` refuses on missing agents.
- Modify `templates/config.yaml`, `templates/skill/SKILL.md` (step 5 writes `agents.all.mcp_tools`), `README.md`, `docs/decisions.md`.
- Tests: `tests/unit/agents.test.ts`, `tests/unit/agent-files.test.ts` (new); `tests/unit/config.test.ts`, `tests/unit/phases.test.ts`, `tests/unit/claude-run.test.ts`, `tests/unit/chat-*.test.ts` (whichever covers `runChatAgent`), `tests/unit/scheduler*.test.ts` (whichever covers `start`).

---

### Task 1: The `agents` config block

**Files:**
- Modify: `src/config.ts` (the `claude` object, around `mcp_tools`; add `agents` to `ConfigSchema`)
- Create: `src/agents.ts` (types and the step-key list only, so config can import them)
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces in `src/agents.ts`:
  - `export const TEAM_WAYS = ["parallel", "pick"] as const; export type TeamWay = (typeof TEAM_WAYS)[number];`
  - `export const READ_ONLY_STEPS: ReadonlySet<StepKey>`: every step except `build`, `reconcile`, `fix`, `revise`.
  - `export const CONTINUES_BUILD: ReadonlySet<StepKey> = new Set(["fix", "reconcile", "revise"]);`
  - `export const CHAT_STEPS: ReadonlySet<StepKey> = new Set(["orchestrator", "write-intent"]);`
  - `export function toolProblem(rule: string, readOnly: boolean): string | null`: the reason a `tools` rule is refused, or null.
- Produces in `src/config.ts`: `Config["agents"]` shaped
  `{ sources: "all" | "repo"; teams: Record<string, { members: string[]; way: TeamWay }>; all: StepAgents; steps: Partial<Record<StepKey, StepAgents>> }` where
  `StepAgents = { agent?: string; subagents: string[]; teams: string[]; skills: string[]; tools: string[]; mcp_tools: string[] }` (lists default `[]`). Export `type StepAgents`.
- `claude.mcp_tools` is removed.

- [ ] **Step 1: Write the failing tests** in `tests/unit/config.test.ts`

```ts
test("the agents block defaults to nothing set", async () => {
  const cfg = validateConfig({ version: 1, commands: { test: "bun test" } });
  expect(cfg.agents).toEqual({ sources: "all", teams: {}, all: { subagents: [], teams: [], skills: [], tools: [], mcp_tools: [] }, steps: {} });
  expect("mcp_tools" in cfg.claude).toBe(false);
});

test("agents settings are refused in plain words", () => {
  const ok = { version: 1, commands: { test: "bun test" } };
  const problems = (agents: unknown) => { try { validateConfig({ ...ok, agents }); return []; } catch (e) { return (e as ConfigError).problems.map((p) => p.text); } };
  expect(problems({ steps: { reviews: {} } })[0]).toStartWith("agents.steps: unknown step reviews; the steps are intake, design,");
  expect(problems({ steps: { fix: { agent: "x" } } })).toEqual(["agents.steps.fix.agent: fix continues the build session and runs as the build's agent; set the agent on build"]);
  expect(problems({ steps: { review: { tools: ["Edit"] } } })).toEqual(["agents.steps.review.tools.0: review is read-only; Edit would let it change files"]);
  expect(problems({ steps: { review: { tools: ["Bash"] } } })).toEqual(["agents.steps.review.tools.0: review is read-only; a bare Bash rule would let it run anything"]);
  expect(problems({ steps: { build: { tools: ["Bash(git push *)"] } } })).toEqual(["agents.steps.build.tools.0: only Loopstra commits, branches, merges and pushes; git push is not allowed"]);
  expect(problems({ all: { tools: ["Write"] } })).toEqual(["agents.all.tools.0: these reach read-only steps too; Write would let them change files"]);
  expect(problems({ all: { mcp_tools: ["mcp__x,Bash"] } })).toEqual(["agents.all.mcp_tools.0: must be an MCP rule, like mcp__github or mcp__github__get_issue"]);
  expect(problems({ teams: { Reviewers: { members: ["a"] } } })).toEqual(["agents.teams.Reviewers: a team name is lowercase words joined by dashes"]);
  expect(problems({ teams: { r: { members: [] } } })).toEqual(["agents.teams.r.members: a team needs at least one member"]);
  expect(problems({ steps: { review: { teams: ["nope"] } } })).toEqual(["agents.steps.review.teams.0: there is no team nope under agents.teams"]);
  expect(problems({ sources: "mine" })).toEqual(["agents.sources: must be all or repo"]);
  // Narrow commands and read-only git are fine anywhere; Bash(git diff *) is not history-changing.
  expect(problems({ steps: { review: { tools: ["Bash(npm run e2e *)", "Bash(git diff *)", "WebFetch"] } } })).toEqual([]);
});
```

Also update the existing `claude.mcp_tools` assertions in this file to `agents.all.mcp_tools` (same three refused entries, same message).

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/config.test.ts`
Expected: FAIL (`cfg.agents` undefined).

- [ ] **Step 3: Implement**

In `src/agents.ts`, `toolProblem(rule, readOnly)`:
- `Bash(git <sub>...)` or `Bash(git)`/`Bash(git *)` where `<sub>` is in `commit push merge rebase reset checkout switch branch tag stash` or absent → `only Loopstra commits, branches, merges and pushes; git <sub> is not allowed` (`<sub>` is `*` text as written for a bare git rule: use "git" alone → `git is not allowed`).
- When `readOnly`: `Edit`/`Write`/`NotebookEdit` (with or without a `(...)` specifier) → `<Tool> would let it change files`; `Bash` or `Bash(*)` → `a bare Bash rule would let it run anything`.
- Otherwise null. The config layer prefixes `"<step> is read-only; "` for a step and `"these reach read-only steps too; "` for `all` (with `readOnly: true`). For build steps only the git check applies.

In `src/config.ts`: a `stepAgents` Zod object (`.strict()`, lists `.default([])`, `agent` optional trimmed non-empty), `agents` object (`sources` enum with error `must be all or repo`, `teams` record with name check via `superRefine`, `all`, `steps` as a record checked against `STEP_KEYS` with the "unknown step" message listing `STEP_KEYS` joined by `, `), and a `superRefine` on `agents` for: `agent` on `CONTINUES_BUILD`, `toolProblem` per `tools` entry, team references. Reuse the existing `mcp_tools` regex and message for both `all.mcp_tools` and `steps.*.mcp_tools`. `prefault({})` the whole block.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/config.test.ts && bun run typecheck`
Expected: PASS. Typecheck then fails where `cfg.claude.mcp_tools` is read (`toolsFor` in `src/phases.ts`): make `toolsFor` return the set's own tools only (Task 6 adds the setup's), and delete the mcp test in `tests/unit/phases.test.ts` (Task 6 brings it back on `agents.all.mcp_tools`).

- [ ] **Step 5: Commit**

```bash
git add src/agents.ts src/config.ts src/phases.ts tests/unit/config.test.ts tests/unit/phases.test.ts
git commit -m "feat(config): agents block for per-step agent setup"
```

---

### Task 2: Layering and prompt lines

**Files:**
- Modify: `src/agents.ts`
- Test: `tests/unit/agents.test.ts` (new)

**Interfaces:**
- Consumes: `Config["agents"]`, `StepAgents`, `CHAT_STEPS`, `CONTINUES_BUILD` (Task 1).
- Produces:
  - `export interface Team { name: string; members: string[]; way: TeamWay }`
  - `export interface AgentSetup { sources: "all" | "repo"; agent: string | null; subagents: string[]; teams: Team[]; skills: string[]; tools: string[]; mcpTools: string[] }`
  - `export function resolveSetup(agents: Config["agents"], step: StepKey, stageSkills: readonly string[]): AgentSetup`
  - `export function isEmptySetup(s: AgentSetup): boolean`: no agent, subagents, teams, skills, tools, mcpTools, and `sources: "all"`.
  - `export function inlineName(name: string): string`: `loopstra-` + name with `:` → `-`.
  - `export function setupLines(s: AgentSetup, describe: (name: string) => string | null): string`: the text put before the prompt template; `""` when there are no skills, subagents or teams.

- [ ] **Step 1: Write the failing tests**

```ts
const agents = (over: object = {}) => validateConfig({ version: 1, commands: { test: "t" }, agents: over }).agents;

test("all, then stage skills, then the step's own; each name once", () => {
  const a = agents({ all: { skills: ["house"], mcp_tools: ["mcp__docs"] }, steps: { review: { skills: ["threat", "house"], subagents: ["Explore"], agent: "lead" } } });
  expect(resolveSetup(a, "review", ["stage-skill"])).toEqual({ sources: "all", agent: "lead", subagents: ["Explore"], teams: [], skills: ["house", "stage-skill", "threat"], tools: [], mcpTools: ["mcp__docs"] });
});

test("fix, reconcile and revise run as the build's agent; chat steps never get all", () => {
  const a = agents({ all: { skills: ["house"], tools: ["WebFetch"] }, steps: { build: { agent: "senior" }, orchestrator: { skills: ["chat-tone"] } } });
  expect(resolveSetup(a, "fix", []).agent).toBe("senior");
  expect(resolveSetup(a, "revise", []).skills).toEqual(["house"]);
  expect(resolveSetup(a, "orchestrator", [])).toMatchObject({ agent: null, skills: ["chat-tone"], tools: [] });
});

test("teams resolve to their members; an empty setup is empty", () => {
  const a = agents({ teams: { reviewers: { members: ["sec", "perf"], way: "parallel" } }, steps: { review: { teams: ["reviewers"] } } });
  expect(resolveSetup(a, "review", []).teams).toEqual([{ name: "reviewers", members: ["sec", "perf"], way: "parallel" }]);
  expect(isEmptySetup(resolveSetup(agents(), "build", []))).toBe(true);
  expect(isEmptySetup(resolveSetup(agents({ sources: "repo" }), "build", []))).toBe(false);
});

test("prompt lines: skills as today, then subagents and teams by their inline names", () => {
  const s = { sources: "all", agent: null, subagents: ["Explore", "test-writer"], teams: [{ name: "reviewers", members: ["sec", "perf"], way: "parallel" }], skills: ["a", "b"], tools: [], mcpTools: [] } as AgentSetup;
  const lines = setupLines(s, (n) => (n === "test-writer" ? "Writes tests" : null));
  expect(lines).toStartWith("Use these skills: `a`, `b`.\n\n");
  expect(lines).toContain("`Explore`");                 // built-ins keep their own name
  expect(lines).toContain("`loopstra-test-writer` (Writes tests)");
  expect(lines).toContain("`loopstra-sec`, `loopstra-perf`");
  expect(lines).toContain("same task");                  // parallel wording
  expect(lines).toContain("structured output");          // the session still reports itself
  expect(lines).toEndWith("\n\n");
  expect(setupLines({ ...s, subagents: [], teams: [] }, () => null)).toBe("Use these skills: `a`, `b`.\n\n");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test tests/unit/agents.test.ts`
Expected: FAIL (`resolveSetup` not exported).

- [ ] **Step 3: Implement** in `src/agents.ts`.

`setupLines` needs to know built-ins: define `export const BUILTIN_AGENTS: ReadonlySet<string> = new Set(["general-purpose", "Explore", "Plan", "claude", "statusline-setup"]);` here in `src/agents.ts` (`src/agent-files.ts` imports from this file, never the other way). The skills line is exactly today's (`Use these skills: \`a\`, \`b\`.\n\n`). Wording for subagents and teams is yours; it must name each agent by its inline name (built-ins by their own), give the description when `describe` returns one, say for `parallel` that every member gets the same task at the same time and the session weighs their answers, for `pick` that each piece of work goes to the member that fits it, and end with one sentence that the session still returns its own structured output.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents.ts tests/unit/agents.test.ts
git commit -m "feat(agents): layer each step's agent setup and its prompt lines"
```

---

### Task 3: Finding and parsing definitions, inline agents

**Files:**
- Modify: `src/agent-files.ts`
- Test: `tests/unit/agent-files.test.ts` (new)

**Interfaces:**
- Consumes: `AgentSetup`, `inlineName` (Task 2).
- Consumes also: `BUILTIN_AGENTS` (Task 2, `src/agents.ts`).
- Produces:
  - `export interface AgentDefinition { name: string; description: string; prompt: string; tools: string[] | null; model: string | null; skills: string[] | null; dropped: string[]; from: "repo" | "personal" | "plugin"; path: string }`
  - `export function parseAgentFile(name: string, text: string, from: AgentDefinition["from"], path: string): AgentDefinition` (frontmatter via `yaml`; `tools` accepts a comma-separated string or a list; keys other than `name description tools model skills color` go to `dropped`, in file order)
  - `export interface Where { repo: string; home: string; sources: "all" | "repo" }` (`repo`: a checkout of main: the step's snapshot, or the root)
  - `export async function findAgent(name: string, where: Where): Promise<AgentDefinition | null>`: `BUILTIN_AGENTS` → null is not used for them (callers skip built-ins); order: `<repo>/.claude/agents/<name>.md`; with `sources: "all"`: `<home>/.claude/agents/<name>.md`, then for `plugin:agent` the plugin's `agents/<agent>.md` (see Step 3).
  - `export async function findSkill(name: string, where: Where): Promise<"repo" | "personal" | "plugin" | null>`: same order, `skills/<name>/SKILL.md`.
  - `export function inlineAgents(main: AgentDefinition | null, others: AgentDefinition[]): Record<string, { description: string; prompt: string; tools?: string[]; model?: string; skills?: string[] }>`: keys by `inlineName`; `main`'s `tools`, when not null, gain `StructuredOutput` if missing; `model` only for `others` (a main agent runs on the step's model); `skills` copied when set.

- [ ] **Step 1: Write the failing tests**

```ts
test("an agent file parses with CRLF, a tools string, and unknown keys dropped", () => {
  const d = parseAgentFile("lead", "---\r\nname: lead\r\ndescription: Leads\r\ntools: Read, Grep\r\nmodel: opus\r\npermissionMode: bypassPermissions\r\nhooks: {}\r\n---\r\nYou lead.\r\n", "repo", "/r/.claude/agents/lead.md");
  expect(d).toMatchObject({ description: "Leads", prompt: "You lead.", tools: ["Read", "Grep"], model: "opus", dropped: ["permissionMode", "hooks"] });
  expect(parseAgentFile("x", "Just a prompt.\n", "repo", "p")).toMatchObject({ description: "", prompt: "Just a prompt.", tools: null, model: null, dropped: [] });
});

test("findAgent looks in the repo, then the user's folder, then installed and enabled plugins", async () => {
  const t = tempDir(); const repo = join(t.path, "repo"); const home = join(t.path, "home");
  write(join(repo, ".claude/agents/lead.md"), "---\ndescription: repo lead\n---\nR");
  write(join(home, ".claude/agents/lead.md"), "---\ndescription: home lead\n---\nH");
  write(join(home, ".claude/agents/mine.md"), "---\ndescription: mine\n---\nM");
  const plug = join(home, "plugins-cache/sp");
  write(join(plug, "agents/code-reviewer.md"), "---\ndescription: cr\n---\nC");
  write(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sp@market": [{ scope: "user", installPath: plug }] } }));
  write(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sp@market": true } }));
  const all = { repo, home, sources: "all" as const };
  expect((await findAgent("lead", all))?.description).toBe("repo lead");
  expect((await findAgent("mine", all))?.from).toBe("personal");
  expect((await findAgent("sp:code-reviewer", all))?.from).toBe("plugin");
  expect(await findAgent("mine", { ...all, sources: "repo" })).toBeNull();
  write(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sp@market": false } }));
  expect(await findAgent("sp:code-reviewer", all)).toBeNull();
  t.cleanup();
});

test("inline agents: loopstra names, StructuredOutput for the main agent, its model left to the step", () => {
  const lead = parseAgentFile("lead", "---\ndescription: L\ntools: [Read]\nmodel: opus\n---\nP", "repo", "p");
  const sec = parseAgentFile("sec", "---\ndescription: S\nmodel: haiku\n---\nQ", "repo", "p");
  expect(inlineAgents(lead, [sec])).toEqual({
    "loopstra-lead": { description: "L", prompt: "P", tools: ["Read", "StructuredOutput"] },
    "loopstra-sec": { description: "S", prompt: "Q", model: "haiku" },
  });
});
```

(`write` and `tempDir` come from `tests/helpers.ts`; add a two-line `write(path, text)` that makes the folder there if it has none.)

- [ ] **Step 2: Run to see them fail**

Run: `bun test tests/unit/agent-files.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Plugins: read `<home>/.claude/plugins/installed_plugins.json` (`plugins: Record<"<plugin>@<marketplace>", Array<{ installPath: string }>>`) and `<home>/.claude/settings.json` `enabledPlugins` (`Record<string, boolean>`); a plugin counts when its key's value is `true`. For `plugin:agent` take the entry whose key starts with `<plugin>@`, its first `installPath`. A file that does not exist or does not parse is "not there", never a throw.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/agent-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-files.ts tests/unit/agent-files.test.ts tests/helpers.ts
git commit -m "feat(agents): find and parse agent and skill definitions, build inline agents"
```

---

### Task 4: Checking a whole config's names

**Files:**
- Modify: `src/agent-files.ts`
- Test: `tests/unit/agent-files.test.ts`

**Interfaces:**
- Consumes: `resolveSetup` (Task 2), `findAgent`, `findSkill` (Task 3), `STEPS`/`STEP_KEYS` (`src/models.ts`).
- Produces:
  - `export interface SetupProblem { level: "fail" | "warn"; step: StepKey | "all"; name: string; text: string }`
  - `export async function checkAgentSetup(cfg: Config, where: Where): Promise<SetupProblem[]>`: for every step, the resolved setup's agent, subagents and team members (skipping `BUILTIN_AGENTS`) and skills.

Rules (one problem per name per step, steps in `STEP_KEYS` order):
- agent not found → `fail`: `` `<name>`, the agent <step> runs as, is not in .claude/agents/ on <main_branch>[ or on this machine]. Add it with `loopstra setup agents`, or commit it. ``
- subagent or team member not found → `fail`, same wording with "a subagent of <step>" / "in the team <team> of <step>".
- found only `personal` or `plugin` → `warn`: `` `<name>` (<step>) is only on this machine, so a loop running elsewhere will not have it. ``
- a definition with `dropped` keys → `warn`: `` <path>: Loopstra leaves out <keys> when it runs this agent. ``
- skill not found → `warn`: `` The skill `<name>` (<step>) is not in .claude/skills/[ or on this machine]; it may be built in to Claude Code. If a session does not load it, the step stops and says so. ``
- `[ or on this machine]` appears only with `sources: all`.

- [ ] **Step 1: Write the failing test**

```ts
test("checkAgentSetup: missing agents fail, machine-only ones and unknown skills warn", async () => {
  const t = tempDir(); const repo = join(t.path, "repo"); const home = join(t.path, "home");
  write(join(repo, ".claude/agents/lead.md"), "---\ndescription: L\nhooks: {}\n---\nP");
  write(join(home, ".claude/agents/mine.md"), "M");
  const cfg = validateConfig({ version: 1, commands: { test: "t" }, agents: { steps: { review: { agent: "lead", subagents: ["mine", "Explore", "gone"], skills: ["pdf"] } } } });
  const p = await checkAgentSetup(cfg, { repo, home, sources: "all" });
  expect(p.map((x) => [x.level, x.step, x.name])).toEqual([
    ["warn", "review", "lead"], ["warn", "review", "mine"], ["fail", "review", "gone"], ["warn", "review", "pdf"],
  ]);
  expect(p[2]!.text).toContain("Add it with `loopstra setup agents`");
  t.cleanup();
});
```

- [ ] **Step 2: Run to see it fail.** `bun test tests/unit/agent-files.test.ts` → FAIL.
- [ ] **Step 3: Implement `checkAgentSetup`.**
- [ ] **Step 4: Run tests.** → PASS.
- [ ] **Step 5: Commit** `feat(agents): check that every named agent and skill exists`.

---

### Task 5: Session flags and the init check

**Files:**
- Modify: `src/claude.ts` (`FailureReason`, `RunPhaseInput`, `claudeCommand`, `runSession`'s `onLine` and return)
- Modify: `src/phases.ts` (`ownerNote`, `BlockingReason` stays `Exclude<FailureReason, "environment" | "not-started">` so it gains `"setup"`; `"setup"` is not in `RETRIED`)
- Test: `tests/unit/claude-run.test.ts`

**Interfaces:**
- Produces on `RunPhaseInput`:
  - `agents?: Record<string, object>` → `--agents <JSON>` when it has keys
  - `agent?: string` → `--agent <name>`
  - `settingSources?: string` → `--setting-sources <value>`
  - `addDirs?: string[]` → `--add-dir <dir>` per dir
  - `forwardSubagentText?: boolean` → `--forward-subagent-text`
  - `checkInit?: (init: { agents?: string[]; skills?: string[] }) => string | null`: called with the first `system`/`init` event; a string ends the session: reading stops (`onLine` returns true), and the result is a failure with reason `"setup"` and that string as detail.
- `FailureReason` gains `"setup"`. `ownerNote("setup")`: `"This step's agent setup is not complete on this machine."` (callers append the detail).
- Flags go after `--permission-mode` and the tool lists, before `--settings`, in the order listed above; none appear when unset.

- [ ] **Step 1: Write the failing tests** (fake CLI; follow the file's existing `LOOPSTRA_FAKE_ARGS` pattern)

```ts
test("agent flags reach the CLI only when set", async () => {
  // run once without them: none of the five flags in args
  // run with { agents: { "loopstra-x": { description: "d", prompt: "p" } }, agent: "loopstra-x", settingSources: "project", addDirs: ["/snap"], forwardSubagentText: true }
  expect(args).toEqual(expect.arrayContaining(["--agents", JSON.stringify({ "loopstra-x": { description: "d", prompt: "p" } }), "--agent", "loopstra-x", "--setting-sources", "project", "--add-dir", "/snap", "--forward-subagent-text"]));
});

test("an init event that lacks a named skill ends the session as a setup failure", async () => {
  // fixture: init with skills: ["a"], agents: ["loopstra-x"], then a long tail of events (use an existing slow fixture, or LOOPSTRA_FAKE_DELAY_MS)
  const r = await runPhase({ ...base, checkInit: (i) => (i.skills?.includes("b") ? null : "this session did not load the skill `b`") });
  expect(r).toMatchObject({ ok: false, reason: "setup", detail: "this session did not load the skill `b`" });
});

test("an init event without lists is not judged", async () => {
  // the default fixture's init has no agents or skills
  const r = await runPhase({ ...base, checkInit: () => "would fail" });
  // checkInit is not called when both lists are absent
  expect(r.ok).toBe(true);
});
```

Add the fixture `tests/fake-claude/fixtures/init-lists.jsonl`: an init event with `"skills":["a"],"agents":["loopstra-x"]`, then the lines of `simple-success.jsonl`.

- [ ] **Step 2: Run to see them fail.** `bun test tests/unit/claude-run.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `runSession`, keep a `setupProblem: string | null`; in `onLine`, for the first `system`/`init` event that has `agents` or `skills`, call `checkInit`; a string sets `setupProblem` and returns `true`. After the loop, `setupProblem` wins over every other outcome except a stop or cancel: `return failure(collector.finish(), { started, nudged }, "setup", setupProblem)`. `checkInit` is not called on resent processes (`--resume` sends) after the first passed.
- [ ] **Step 4: Run tests.** `bun test tests/unit/claude-run.test.ts && bun run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(claude): agent flags and the init check, with failure reason setup`.

---

### Task 6: Wire the setup into loop sessions

**Files:**
- Modify: `src/models.ts` (`withModels` carries `agents`; `ModelSettings` = `Pick<Config, "claude" | "stages" | "chat" | "agents">`; its doc says model and agent settings)
- Modify: `src/context.ts` (`models()` doc: model and agent settings)
- Modify: `src/agent-files.ts` (`userSettingsPassthrough`)
- Modify: `src/phases.ts` (`toolsFor`, `phasePrompt`, `attempt`)
- Test: `tests/unit/phases.test.ts`

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces:
  - `export function userSettingsPassthrough(home: string): { apiKeyHelper?: string; env?: Record<string, string> }`: those two keys from `<home>/.claude/settings.json`, when present (with `sources: repo`, `--setting-sources project` would drop them, and a machine that signs in with them could not start sessions).
  - `export async function stepSetup(ctx: StepContext, spec: AgentPhaseSpec): Promise<AgentSetup>` in `src/phases.ts`: `resolveSetup((await ctx.models()).agents, spec.name as StepKey, spec.skills ?? [])`. (Every `PhaseName` used with `agentPhase` is a `StepKey`; assert with a type guard, not a cast, and fall back to an empty setup for any that is not.)
  - `toolsFor(ctx, set, setup?: AgentSetup)`: the set's own tools, then `setup.tools`, then `setup.mcpTools`, each once.

`attempt` gets the setup once per attempt and, when `isEmptySetup(setup)`, passes nothing new (today's argv). Otherwise:
1. `allowedTools: toolsFor(ctx, spec.tools, setup)`.
2. `where = { repo: await ctx.snapshot(), home: os.homedir(), sources: setup.sources }`. Definitions: main agent via `findAgent(setup.agent)`; subagents and team members via `findAgent` (built-ins skipped). Any non-built-in not found → return `{ ok: false, reason: "setup", note: "<ownerNote> <checkAgentSetup-style text for that name>", sessionId: null }` before starting a session (trace an `error` event `{ where: traceName, reason: "setup", detail }` as `missing-prompt` does).
3. `agents: inlineAgents(main, others)` when any definition; `agent: inlineName(setup.agent)` when there is a main agent.
4. `settingSources: "project"` and settings `JSON.stringify({ ...JSON.parse(hookSettings()), ...userSettingsPassthrough(home) })` when `sources === "repo"`.
5. `addDirs: [snapshot]` when `cwd !== snapshot` and `setup.skills.length`.
6. `forwardSubagentText: true` when subagents or teams.
7. `checkInit`: every expected inline agent name (and built-in) must be in `init.agents` when that list is present; every skill in `init.skills` when present (a skill counts if listed as `name` or `<x>:name`); the problem names what is missing and says `` Add it with `loopstra setup agents`, then retry. ``
8. After `startPhase`, `ctx.trace.event(ctx.slug, "agent_setup", { agent, subagents, teams: teams.map((t) => t.name), skills, tools, mcp_tools: mcpTools, sources, models: { <inlineName>: model } }, seq)`, only when not empty.
9. `phasePrompt` uses `setupLines(setup, describe)` in place of today's `skillsLine`. `describe` is synchronous: `phasePrompt` first looks up the subagents' and team members' definitions with `findAgent` (same `where` as above) and passes `(n) => found.get(n)?.description || null`. With an empty setup `setupLines` returns today's skills line, so prompts do not change.
10. A failed `"setup"` attempt's note is `` `${ownerNote("setup")} ${detail}` ``.

- [ ] **Step 1: Write the failing tests** in `tests/unit/phases.test.ts` (use the file's `setup()` and `LOOPSTRA_FAKE_ARGS`)

```ts
test("with nothing set, a session's args and prompt are what they were", async () => {
  // run intake and build once with cfg.agents as validated from {} and once from { sources: "all", all: {}, steps: {} }:
  // identical args arrays and identical prompt.md text; neither has --agents, --agent, --setting-sources, --add-dir, --forward-subagent-text
});

test("a step's agent, subagents, team and tools reach its session", async () => {
  // repo: commit .claude/agents/lead.md (tools: Read), sec.md, perf.md on main
  // cfg.agents = { teams: { reviewers: { members: ["sec", "perf"], way: "parallel" } }, steps: { review: { agent: "lead", teams: ["reviewers"], tools: ["WebFetch"], mcp_tools: ["mcp__gh"] } } }
  // run the review phase (tools "read+git", cwd: the worktree)
  expect(args[args.indexOf("--agent") + 1]).toBe("loopstra-lead");
  expect(Object.keys(JSON.parse(args[args.indexOf("--agents") + 1]))).toEqual(["loopstra-lead", "loopstra-sec", "loopstra-perf"]);
  expect(JSON.parse(args[args.indexOf("--agents") + 1])["loopstra-lead"].tools).toEqual(["Read", "StructuredOutput"]);
  expect(allowed).toEqual(expect.arrayContaining(["WebFetch", "mcp__gh"]));
  expect(args).toContain("--forward-subagent-text");
  expect(prompt).toContain("`loopstra-sec`, `loopstra-perf`");
});

test("agent files come from main, not from the change's branch", async () => {
  // main: .claude/agents/lead.md prompt "MAIN"; the worktree branch commits lead.md with prompt "BRANCH"
  // build-stage step in the worktree: the inline lead prompt is "MAIN"
});

test("a named agent nobody has stops the step before a session starts", async () => {
  // steps: { design: { agent: "ghost" } } → result { ok: false, reason: "setup" }, note mentions `ghost` and `loopstra setup agents`; no fake call recorded
});

test("repo-only sessions load project settings and keep the user's sign-in", async () => {
  // a temp home with .claude/settings.json { apiKeyHelper: "/bin/key", env: { A: "1" }, theme: "x" }; the code reads os.homedir(),
  // so set process.env.HOME and process.env.USERPROFILE to it for this test and restore them after
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
  expect(JSON.parse(args[args.indexOf("--settings") + 1])).toMatchObject({ apiKeyHelper: "/bin/key", env: { A: "1" }, hooks: expect.any(Object) });
  expect(JSON.parse(args[args.indexOf("--settings") + 1]).theme).toBeUndefined();
});

test("a worktree step that names skills also gets main's snapshot as an added dir", async () => {
  // all: { skills: ["house"] } → build session args contain --add-dir <snapshot path>; a snapshot-run step (design) does not
});

test("mcp rules from agents.all reach every tool set, once each", async () => {
  // the former claude.mcp_tools test, moved: ctx.cfg.agents.all.mcp_tools = ["mcp__github", "mcp__docs__guide", "mcp__github"]
});
```

Fill each with the setup and run calls the neighbouring tests in this file use; the assertions above are the required ones.

- [ ] **Step 2: Run to see them fail.** `bun test tests/unit/phases.test.ts` → FAIL.
- [ ] **Step 3: Implement** as listed above.
- [ ] **Step 4: Run tests.** `bun test tests/unit/phases.test.ts && bun run check` → PASS (the whole suite: stage tests must be untouched by an empty setup).
- [ ] **Step 5: Commit** `feat(phases): run each step with its agent setup`.

---

### Task 7: Chat steps

**Files:**
- Modify: `src/chat/agents.ts` (`runChatAgent`)
- Modify: `src/chat/orchestrator.ts` (the failure reply around line 277)
- Test: the test file that covers `runChatAgent` (find it with `grep -l runChatAgent tests/unit`)

**Interfaces:**
- Consumes: `resolveSetup` (it already leaves `all` out of chat steps), `findAgent`, `inlineAgents`, `inlineName`, `setupLines`, `userSettingsPassthrough`.
- Behaviour:
  - Setup for `o.name`; definitions with `where = { repo: o.root, home: os.homedir(), sources }` (chat runs in the main checkout).
  - `allowedTools: [...CHAT_TOOLS, ...setup.tools, ...setup.mcpTools]` (only the chat step's own entries, by `resolveSetup`); `disallowedTools: CHAT_DENIED` unchanged; `dropEnv` unchanged.
  - Same flags and `checkInit` as Task 6; prompt lines prepended to `o.prompt` when not empty.
  - A missing definition or a `setup` failure: `{ ok: false, reason: "setup", detail }` with no session (or the init check's detail). The orchestrator replies: `` My setup is not complete: <detail> ``. Write-intent's failure path shows the same detail (follow how it shows other failures).

- [ ] **Step 1: Write the failing tests**

```ts
test("a chat step gets only its own tools; agents.all never reaches it", async () => {
  // cfg.agents = { all: { tools: ["WebFetch"], mcp_tools: ["mcp__x"] }, steps: { orchestrator: { skills: ["tone"], mcp_tools: ["mcp__docs"] } } }
  // allowed = CHAT_TOOLS + mcp__docs; no WebFetch, no mcp__x; disallowed is CHAT_DENIED; prompt starts with "Use these skills: `tone`."
});

test("a chat agent that cannot be found is answered in words", async () => {
  // steps: { orchestrator: { agent: "ghost" } } → the orchestrator's reply starts with "My setup is not complete:" and names `ghost`
});
```

- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** `bun test tests/unit/chat-*.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(chat): agent setup for the orchestrator and the intent writer`.

---

### Task 8: `start` refuses while a named agent is missing

**Files:**
- Modify: `src/scheduler.ts` (`start`, before `takeLoopLock`)
- Test: the test file covering `start` refusals (`grep -l "await start(" tests`)

**Interfaces:**
- Consumes: `checkAgentSetup` (Task 4).
- Behaviour: load the config; when `agents` is not empty, make a detached worktree of `main_branch` in `.loopstra/snapshots/_start` (reuse `addDetachedWorktree`/`removeWorktree` from `src/git.ts`, removed in a `finally`), run `checkAgentSetup` with it as `repo`. Any `fail` → return `"Some steps name agents that are not set up:\n" + fails.map((p) => `- ${p.text}`).join("\n")`. `warn`s are printed with `log` and do not refuse. A config that does not load is left to the existing handling (no new refusal).

- [ ] **Step 1: Write the failing test**

```ts
test("start refuses while a step names an agent that main does not have", async () => {
  // config with agents.steps.design.agent: "ghost", committed on main
  const refused = await start(repo.path, { once: true, installSignals: false });
  expect(refused).toStartWith("Some steps name agents that are not set up:\n- `ghost`, the agent design runs as");
});
```

- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** → PASS.
- [ ] **Step 5: Commit** `feat(start): refuse while a step names a missing agent`.

---

### Task 9: Templates, docs, and a live check

**Files:**
- Modify: `templates/config.yaml` (replace the commented `mcp_tools` lines under `claude:` with a commented `agents:` block: `sources`, a `teams` example, `all.mcp_tools`, one `steps.review` example; every line commented out)
- Modify: `templates/skill/SKILL.md` (Onboard step 5 writes `agents.all.mcp_tools` under `agents:`; step 2's mention of `claude.mcp_tools` becomes `agents.all.mcp_tools`)
- Modify: `README.md` (config section: replace the `mcp_tools` sentence under `claude` with an `agents` bullet: sources, teams, all, steps; the safety rules; chat's rule; fix/reconcile/revise; the `setup` failure)
- Modify: `docs/decisions.md` (new section "Agent setup for every step (2026-10-26)": the CLI facts above, `claude.mcp_tools` moved before release, definitions from main, inline names, `StructuredOutput`, skills by `--add-dir`, the sign-in passthrough, file check warns for skills)
- Test: `tests/unit/templates*.test.ts` stay green.

- [ ] **Step 1: Edit the four files.**
- [ ] **Step 2: Run** `bun run check` → all green.
- [ ] **Step 3: Live check with the real CLI** in a scratch repo (`loopstra init`, a committed `.claude/agents/lead.md` with `tools: Read`, `agents.steps.intake.agent: lead`, `agents.steps.build.agent: lead` and `subagents: [Explore]`, one accepted intent, `loopstra start --once` until build has run and a fix has resumed if one happens). Record in `docs/decisions.md`: the intake envelope parsed (StructuredOutput through an inline agent), the build's `agent_setup` trace event, whether `--resume` with the same `--agent` kept the session id. If resume with `--agent` fails, stop and report it before changing anything.
- [ ] **Step 4: Commit** `docs: agent setup in the config template, skill, README and decisions`.
