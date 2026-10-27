# Agent Setup, Part 3: Console Agents Screen and Operator Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The console's Settings page gets an Agents section where a person sets each step's agent, subagents, teams, skills, tools and MCP tools, manages teams, and adds, edits or removes the repo's agents and skills; the loopstra operator skill gets an onboarding step that sets agents up with the engineer.

**Architecture:** The console never writes the repository. Config changes reuse the `settings` request (extended to `agents.*` paths and list values). File changes are a new `agent-files` request: the console server turns an operation (copy from this machine, fetch from a git repository or folder, new agent, edit agent, remove) into file writes with `src/agent-library.ts` (Part 2), and the loop commits them through `commitRecord` under `_settings`, refusing if any file changed since the page read it. A read-only `/api/agents` view feeds the page. The page's logic lives in a pure `src/ui/agent-settings.ts` (tested like `src/ui/settings.ts`); the component is `src/ui/views/AgentSettings.tsx`, rendered inside the Settings view.

**Tech Stack:** Bun, TypeScript, Preact (`preact/hooks`), the console's server and request plumbing (`src/console/*`, `src/requests.ts`, `src/apply.ts`, `src/record-draft.ts`), bun:test, `tests/console-helpers.ts`.

**Spec:** `docs/superpowers/specs/2026-10-26-agent-setup-design.md` ("The console: an Agents settings screen", "The operator skill (onboarding)", "Observability"). Parts 1-2 are built on this branch.

## Global Constraints

- The console never writes the repo or `loopstra/config.yaml` itself: every change is a request the loop applies and commits (`loopstra(_settings): …`), as the models page does.
- Config writes: `agents.sources`, `agents.all.<field>`, `agents.steps.<step>.<field>`, `agents.teams.<name>.members`, `agents.teams.<name>.way`, and `agents.teams.<name>` / `agents.steps.<step>` set to null (remove). `<field>` is one of `agent`, `subagents`, `teams`, `skills`, `tools`, `mcp_tools`. List fields take a list of strings (sent whole); `agent` and `way` and `sources` take a string; any field may be null (removed). After a write, empty `agents.steps.<step>`, `agents.steps`, `agents.all`, `agents.teams` and `agents` maps are removed, not left as `{}`.
- Every write is checked twice, by the console before submitting and by the loop before committing: the config must still load (`validateConfig`), and the file's version must be the one the page read.
- File writes only under `.claude/agents/` and `.claude/skills/` (`repoPath`), text only, at most 200 files and 5 MB per request; each file's base version is the sha256 of its text (`configVersion`-style) or `"absent"`; any mismatch refuses the whole request with the stale wording.
- Removing an agent or skill a step or team uses is refused, naming the users (`agents.steps.review`, `team reviewers`).
- Commit messages: `loopstra(_settings): agents.steps.review.teams → [reviewers] by <who> from the dashboard`; files: `loopstra(_settings): add .claude/agents/lead.md by <who> from the dashboard` (`add`, `edit`, `remove`; several files: `add skill tone (3 files) by …`).
- Writes come only from the page (`jsonWrite`: POST, same Origin, JSON). Fetching a git source happens on the server, into a temporary folder removed after the answer; only `https://`, `ssh://`, `git@`, `file://` URLs or an existing folder (Part 2's `cloneSource`).
- The page keeps the Settings page's look (the tokens in `src/ui/theme.css`, `set-row`/`set-group` classes) and works at phone width.
- Chat steps show the warning that anyone allowed to chat can steer their tools, next to their tools and MCP fields.

## Review Focus

1. Two tabs: tab A adds a skill while tab B, holding the old version, edits a step's skills → B's write still lands (config version unchanged by a file-only write), and A's file write lands; a second file write from a tab that read the old file is refused as stale. (Tasks 1-2.)
2. A config edited by hand while the page is open (uncommitted) → every agents write is refused with the existing "commit loopstra/config.yaml first" wording, as model writes are. (Task 1.)
3. A git source URL that needs a password → the clone fails within its timeout (GIT_TERMINAL_PROMPT=0) and the page shows the reason; no temporary folder is left. (Task 3.)
4. Removing a step's last setting from the page leaves no `steps: {}` or `review: {}` in the file. (Task 1.)
5. A list value sent as a string, or with a non-string member, is refused with a 400 in words, before any request file is written. (Task 1.)

---

## File structure

- Modify `src/settings.ts` (paths, problems, list values, pruning), `src/requests.ts` (settings `value` union; new `agent-files` kind), `src/console/writes.ts` (parse both), `src/apply.ts` (apply `agent-files`; settings trace text for lists).
- Create `src/console/agents.ts` (the view and the operations → writes); modify `src/console/server.ts` (routes), `src/console/types.ts` (`AgentsView`, `AgentFilesOp`).
- Create `src/ui/agent-settings.ts` (pure helpers), `src/ui/views/AgentSettings.tsx`; modify `src/ui/views/Settings.tsx` (render it), `src/ui/requests.ts` (`sendAgentFiles`), `src/ui/theme.css` (only if a new class is needed).
- Modify `templates/skill/SKILL.md`, `README.md`, `docs/decisions.md`.
- Tests: `tests/unit/settings.test.ts` (or the file covering `src/settings.ts`), `tests/unit/apply*.test.ts` (whichever covers settings requests), `tests/unit/console-*.test.ts` (routes), `tests/unit/ui-logic.test.ts`.

---

### Task 1: Agents settings through the `settings` request

**Files:** `src/settings.ts`, `src/requests.ts`, `src/console/writes.ts`, `src/apply.ts`; tests for each.

**Interfaces:**
- Produces:
  - `type SettingValue = string | string[] | null` (export from `src/settings.ts`); the settings request's `value` is `z.union([z.string(), z.array(z.string()).max(64), z.null()])`.
  - `settingPath(dotted)` accepts the agents paths in Global Constraints (step keys from `STEP_KEYS`; team names by the team-name rule from Part 1).
  - `settingProblem(path, value: SettingValue)`: list fields need a list, scalar fields a string; `null` allowed for every agents path; model paths unchanged.
  - `applySetting(file, text, path, value)`: lists written in flow style (`[a, b]`); after a set or unset, prune empty maps (Global Constraints); `doc.validate()` so config problems (a read-only step's `Edit`, a built-in main agent, an unknown team) come back as `problem` in words.
  - The `settings` apply trace and toast text show a list as `[a, b]`.

- [ ] **Step 1: Write the failing tests**

```ts
test("agents paths are writable settings; others are not", () => {
  expect(settingPath("agents.steps.review.teams")).toEqual(["agents", "steps", "review", "teams"]);
  expect(settingPath("agents.all.mcp_tools")).toEqual(["agents", "all", "mcp_tools"]);
  expect(settingPath("agents.teams.reviewers.way")).toEqual(["agents", "teams", "reviewers", "way"]);
  expect(settingPath("agents.steps.review")).toEqual(["agents", "steps", "review"]);
  expect(settingPath("agents.steps.nope.agent")).toBeNull();
  expect(settingPath("agents.steps.review.model")).toBeNull();
  expect(settingPath("agents.teams.Bad.way")).toBeNull();
});

test("list fields take lists, scalars take strings", () => {
  expect(settingProblem(["agents", "steps", "review", "skills"], "house")).toBe("agents.steps.review.skills takes a list of names.");
  expect(settingProblem(["agents", "steps", "review", "agent"], ["a"])).toBe("agents.steps.review.agent takes one name.");
  expect(settingProblem(["agents", "steps", "review"], null)).toBeNull();
});

test("applySetting writes flow lists and prunes empty maps", () => {
  const base = "version: 1\ncommands:\n  test: bun test\n";
  const a = applySetting("c.yaml", base, ["agents", "steps", "review", "skills"], ["a", "b"]);
  expect(a.ok).toBe(true);
  expect(parse((a as { text: string }).text).agents.steps.review.skills).toEqual(["a", "b"]); // `parse` from "yaml"
  expect((a as { text: string }).text).toMatch(/skills: \[.*a.*b.*\]/); // flow style, one line
  const b = applySetting("c.yaml", (a as { text: string }).text, ["agents", "steps", "review", "skills"], null);
  expect(b.ok && b.text).toBe(base);
  const c = applySetting("c.yaml", base, ["agents", "steps", "review", "tools"], ["Edit"]);
  expect(c).toEqual({ ok: false, problem: expect.stringContaining("review is read-only") });
});

test("the console refuses a malformed agents value before writing a request", async () => {
  // POST /api/requests { kind: "settings", path: "agents.steps.review.skills", value: "house", version } → 400 "agents.steps.review.skills takes a list of names."
  // value: ["a", 1] → 400; no file under .loopstra/requests
});

test("the loop commits an agents setting under _settings", async () => {
  // submit { kind: settings, path: agents.steps.review.teams, value: ["reviewers"] } with agents.teams.reviewers defined → commit subject "loopstra(_settings): agents.steps.review.teams → [reviewers] by …"
  // with an uncommitted config edit → refused with UNCOMMITTED_CONFIG
});
```

- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.** Pruning lives in `applySetting` (walk from the written path up while the map is empty and is under `agents`).
- [ ] **Step 4: Run tests**; `bun run check`.
- [ ] **Step 5: Commit** `feat(console): agents settings through settings requests`.

---

### Task 2: The `agent-files` request

**Files:** `src/requests.ts`, `src/console/writes.ts` (submit path from Task 3's route, not from `/api/requests`), `src/apply.ts`, `src/record-draft.ts` only if a records' `paths` need anything new; tests.

**Interfaces:**
- Consumes: `FileWrite`, `repoPath` (Part 2).
- Produces:
  - Request kind `agent-files`: `{ kind: "agent-files", what: string (≤ 200 chars, the commit's words: "add .claude/agents/lead.md"), writes: Array<{ path: string; content: string | null }> (1..200), base: Record<string, string> (path → sha256 hex of the text the page/server read, or "absent") }`.
  - `export function fileVersion(text: string | null): string` in `src/settings.ts`: `"absent"` for null, else the same hash as `configVersion`.
  - `applyAgentFiles(root, cfg, trace, req)`: every path through `repoPath` (else refused); total content ≤ 5 MB; `commitRecord(root, main, SETTINGS_SLUG, \`${req.what} by ${byWhom(req)}\`, draft => { for each path: fileVersion(draft.read(path)) must equal base[path] (else stale); draft.write(path, content) }, { paths: writes.map(w => w.path), … })`. Outcome texts: `Saved: <what>.` / `That change was not saved: <problem>` / `STALE_SETTINGS`.
  - A config-file write is never part of `agent-files` (refused if `loopstra/config.yaml` appears).

- [ ] **Step 1: Write the failing tests**

```ts
test("agent-files writes and removes files under .claude and commits them", async () => {
  // repo on main with .claude/skills/old/SKILL.md; request writes .claude/agents/lead.md (base absent) and removes old/SKILL.md (base = its hash)
  // → one commit "loopstra(_settings): add .claude/agents/lead.md by …" with both changes; the working tree matches
});

test("agent-files refuses paths outside .claude/agents and .claude/skills, and stale bases", async () => {
  // writes ".claude/settings.json" → refused, nothing committed
  // base for lead.md says absent but lead.md exists on main → STALE_SETTINGS, nothing committed
});
```

- [ ] **Step 2-5:** fail → implement → pass (+ `bun run check`) → commit `feat(console): agent-files requests the loop commits`.

---

### Task 3: The agents view and operations on the server

**Files:** create `src/console/agents.ts`; modify `src/console/server.ts`, `src/console/types.ts`; test `tests/unit/console-agents.test.ts`.

**Interfaces:**
- Consumes: `resolveSetup`, `READ_ONLY_STEPS`, `CHAT_STEPS`, `CONTINUES_BUILD`, `BUILTIN_AGENTS`, `TEAM_WAYS` (src/agents.ts); `checkAgentSetup`, `parseAgentFile`, `userHome` (src/agent-files.ts); `listLibrary`, `scanFolder`, `cloneSource`, `copyItem`, `newAgentFile` (src/agent-library.ts); `configVersion`, `fileVersion` (src/settings.ts); `STEPS` (src/models.ts).
- Produces (in `src/console/types.ts`; the page imports only types):
  - `AgentsView { version: string | null; problem: string | null; sources: "all" | "repo"; steps: AgentStepRow[]; teams: Array<{ name: string; members: string[]; way: string; usedBy: string[] }>; library: Array<LibraryItemView>; problems: Array<{ level: "fail" | "warn"; step: string; name: string; text: string }>; builtins: string[]; ways: string[] }`
  - `AgentStepRow { key: string; what: string; readOnly: boolean; chat: boolean; continuesBuild: boolean; own: Partial<Record<Field, string | string[]>>; fromAll: Partial<Record<Field, string | string[]>>; fromStage: string[] /* stage skills */ }` plus one row with `key: "all"`.
  - `LibraryItemView { kind: "agent" | "skill"; name: string; description: string; from: "repo" | "personal" | "plugin"; usedBy: string[]; base: string /* fileVersion of the agent file, or of SKILL.md */; editable: boolean /* repo agents */ ; text?: string /* a repo agent's file, for the edit form */ }`
  - `AgentFilesOp = { op: "copy"; kind; name; from } | { op: "fetch"; url: string; names: string[]; kind } | { op: "new"; name; description; prompt; tools: string[]; model: string | null } | { op: "edit"; name; text: string; base: string } | { op: "remove"; kind; name }`
  - Routes: `GET /api/agents` → `AgentsView`; `GET /api/agents/source?url=…` → `{ items: Array<{ kind; name; description }> }` or `{ error }` (clone, scan, cleanup); `POST /api/agents/files` (via `jsonWrite`) with an `AgentFilesOp` → builds `writes` and `base` from the working tree at `root` (the files' current text) and submits an `agent-files` request (202 `{ id, loop }`), or refuses (409/400) in words: a name in use (remove), a copy refused by `copyItem`, a target that exists for `new`/`copy`/`fetch` unless the op says `replace: true`.

- [ ] **Step 1: Write the failing tests** (server-level, like the existing console route tests: start the console app on a temp repo, `fetch` with the page's Origin)

```ts
test("GET /api/agents shows each step's own, inherited and stage values, the library and problems", async () => {});
test("POST /api/agents/files copy submits an agent-files request with the skill's files and absent bases", async () => {});
test("POST /api/agents/files remove is refused while a step uses the agent", async () => {});
test("GET /api/agents/source lists what a file:// repository holds and leaves no temp folder", async () => {});
test("a write without the page's Origin is refused (403)", async () => {});
```

Fill each with the assertions their names state; the existing console route tests show the server setup.

- [ ] **Step 2-5:** fail → implement → pass (+ `bun run check`) → commit `feat(console): agents view and file operations`.

---

### Task 4: The Agents section on the Settings page

**Files:** create `src/ui/agent-settings.ts`, `src/ui/views/AgentSettings.tsx`; modify `src/ui/views/Settings.tsx`, `src/ui/requests.ts`; test `tests/unit/ui-logic.test.ts`.

**Interfaces:**
- Consumes: `AgentsView`, `AgentFilesOp` (Task 3); `sendSetting`/`cancelSetting` (src/ui/requests.ts), extended so `value` may be a list.
- Produces:
  - `src/ui/agent-settings.ts` (pure): `effective(row: AgentStepRow, field: Field): { value: string | string[] | null; from: "own" | "all" | "stage" | "build" | null }` (fix/reconcile/revise agent shows `from: "build"`); `choicesFor(view, field, step): string[]` (agents for `agent` exclude built-ins; subagents include them; teams by name; skills from the library); `listText(v: string[]): string` (`"a, b"`, `"none"`); `parseList(text: string): string[]` (split on commas, trim, drop empties, keep order, each once).
  - `sendAgentFiles(op: AgentFilesOp, onDone)` in `src/ui/requests.ts`, same shape as `sendSetting`.
  - `AgentSettings` component: under the models, an "Agents" heading; a problems callout (fails first) when `problems` is not empty; a Sources picker; a table of rows (All steps first, then the steps in `STEPS` order): each field shows its effective value with a muted "from all steps" / "stage skill" / "as build" note, and an edit control (a `<select>` for `agent`; a checkbox list in a small popover or `<details>` for list fields; a text input for tools and MCP tools, parsed with `parseList`); the chat warning next to chat steps' tools; Teams (list with members and way, New team, Delete disabled with a tooltip listing users while used); Library grouped In the repo / On this machine / From plugins, each item with description, "used by", and actions (Add to the repo, Edit for repo agents, Remove disabled while used); "Add from a git repository or folder" (URL field → list from `/api/agents/source` → checkboxes → Add); "New agent" (name, description, role text `<textarea>`, tools, model). All writes lock the section while one is pending, like the models (one pending write at a time, with Cancel).
  - `Settings.tsx` renders `<AgentSettings />` after the stages, sharing its pending/locked state or with its own (the implementer's call; one pending write at a time across the page).

- [ ] **Step 1: Write the failing tests** for the pure helpers in `tests/unit/ui-logic.test.ts`

```ts
test("effective agent setup: own, then all steps, then stage skills; fix shows the build's agent", () => {});
test("parseList splits, trims, dedupes and keeps order", () => {
  expect(parseList(" a, b,,a , c ")).toEqual(["a", "b", "c"]);
});
test("choicesFor leaves built-ins out of a step's own agent", () => {});
```

- [ ] **Step 2-4:** fail → implement → pass; then a browser check: seed a demo repo (the `tests/console-helpers.ts` helpers; a committed `.claude/agents/lead.md`, a personal skill in a temp HOME), run `HOME=<temp home> bun src/cli.ts ui --port 4747 --no-chat` from it, open it (headless Firefox screenshot as in the console's earlier checks, or Claude in Chrome if available), and check: the section renders in light and dark, at 390 px wide without horizontal scroll, a step's skill pick sends a request (the loop not running, the pending note shows with Cancel). Record the check (screenshots in the scratchpad; one line in the report).
- [ ] **Step 5: Commit** `feat(ui): agents section on the settings page`.

---

### Task 5: Operator skill, README, decisions

**Files:** `templates/skill/SKILL.md`, `README.md`, `docs/decisions.md`; templates tests stay green.

- `templates/skill/SKILL.md` Onboard: a new step after the MCP step, "Set up the agents" (the spec's "The operator skill (onboarding)" section): list the agents and skills its session has and the repo's `.claude/`; list the steps with what each does (`loopstra setup agents` shows them, or the README's step table); ask what the team wants from the loop in their words; suggest a setup and say what it costs (subagents and teams spend more per step); add what is missing (copy, fetch, or write a new skill or agent with them; a skill it writes goes in `.claude/skills/<name>/SKILL.md` with frontmatter `name` and `description`); write the `agents` block (and only that block; nothing `loopstra setup` asks about); then `loopstra setup --check` and commit `loopstra/config.yaml` and `.claude/`. Renumber the later steps; Tune says the same flow, `loopstra setup agents`, or the console's Settings page changes agents later.
- `README.md`: the console section mentions the Agents part of Settings; the setup paragraph already lists `agents` (Part 2).
- `docs/decisions.md`: Part 3 bullets (no repo writes from the console; `agent-files` request with per-file bases; list values in settings requests; pruning empty maps; server-side clone; one pending write at a time).

- [ ] **Step 1:** Edit. **Step 2:** `bun run check`. **Step 3:** A dry run of the new skill step in a scratch repo with the real CLI on `haiku` (as done for the MCP step: `claude -p` reading templates/skill/SKILL.md, "carry out only the agents step up to the first question; write nothing"); one line in the report on what it listed and asked. **Step 4: Commit** `docs: agents in the console and the operator skill`.
