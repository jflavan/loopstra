# Agent Setup, Part 2: Setup Section and the Agent Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `loopstra setup agents` lets an engineer choose where sessions get their setup from, set each step's agent, subagents, teams, skills, tools and MCP tools, and add skills and agents the repo lacks (copied from this machine or a plugin, fetched from a git repository or folder, or a new agent from a short form); `loopstra setup --check` reports missing names.

**Architecture:** A new library module (`src/agent-library.ts`) lists what is available (repo, personal, plugins), copies a skill folder or agent file into the repo, scans a fetched folder, clones a git source shallowly into a temporary folder, and writes a new agent file. It returns files to write; it never writes the repo itself, so the console (Part 3) can reuse it through its request files. The setup runner gains pending file writes, written only when the config saves. The new `agents` section asks the questions with the existing `Prompt` and `ConfigDocument`.

**Tech Stack:** Bun, TypeScript, Zod 4, `yaml`, bun:test; setup test helpers in `tests/setup-helpers.ts` (`scripted`, `configRepo`, `askSection`, `checkSection`).

**Spec:** `docs/superpowers/specs/2026-10-26-agent-setup-design.md` ("Getting skills and agents", "Setup (`loopstra setup agents`)", "Checks"). Part 1 (`docs/superpowers/plans/2026-10-26-agent-setup-1-runtime.md`) is built on this branch.

## Global Constraints

- The `agents` section runs in a full `loopstra setup` only after a yes to `Set up agents for the loop's steps now?` (suggestion: no). Run alone (`loopstra setup agents`) it skips that question. Under `--defaults` it changes nothing.
- Setup never commits. Nothing (config or files) is written when setup stops or fails; files are written only after the config saved (or was unchanged and files were added), then it says to commit `loopstra/config.yaml` and `.claude/` on main.
- Files written only under `<root>/.claude/agents/` and `<root>/.claude/skills/`; every path is checked to stay inside them (no `..`, no absolute paths, no symlinks followed out of a source).
- Downloaded and copied content is data: nothing in it runs; a git source is cloned with `git clone --depth 1 -- <url> <tmp>` into a new temporary folder that is removed afterwards; a URL starting with `-` is refused; before anything is written, the person sees the list of files to be written.
- A copied skill or agent records where it came from: a skill folder gets `SOURCE.md` (one line: `Copied from <url or path>[ (<path inside>)] on <YYYY-MM-DD>.`); an agent file gets a `source:` frontmatter key. `source` is added to `parseAgentFile`'s known keys (not dropped, not passed inline).
- Limits on a copy: at most 200 files and 5 MB per skill folder; larger is refused in words.
- Names: an agent or skill name is lowercase letters, digits and dashes (`/^[a-z0-9][a-z0-9-]*$/`); a plugin item keeps its `plugin:name` when used from the plugin, and gets its plain `name` when copied into the repo.
- Answers: `-` empties an optional answer (as in the other sections); lists are typed comma-separated or picked with `pickMany`.
- Copy follows the codebase: plain sentences; the other sections' question style ("Model for the design stage").

## Review Focus

1. A git source with a skill whose folder holds a symlink pointing outside the clone → the link is not followed; the copy is refused naming the file. (Task 1.)
2. A config with `agents.steps.review.agent: lead` where `.claude/agents/lead.md` is only in the working tree, not committed → `--check` reads the working tree at `<root>` (setup edits that tree, and its save message says to commit), so it passes; `loopstra start` (Part 1) checks main and refuses until it is committed. Pinned: `--check` reads `<root>`. (Task 4.)
3. The person adds a skill, then stops setup (Ctrl-C, `SetupStopped`) → no file is written. (Task 2.)
4. Picking "none" for a step that had an agent removes `agents.steps.<step>.agent`, and a step left with no settings is removed from `agents.steps` entirely (no empty `{}` left in the file). (Task 3.)
5. A plugin skill copied into the repo whose name collides with an existing repo skill → refused unless the person confirms overwriting; the existing folder is replaced whole, not merged. (Task 1 for the function, Task 3 for the question.)

---

## File structure

- Create `src/agent-library.ts`: `LibraryItem`, `FileWrite`, `listLibrary`, `copyItem`, `scanFolder`, `cloneSource`, `newAgentFile`, `repoPath`.
- Modify `src/agent-files.ts`: `source` is a known frontmatter key.
- Modify `src/setup/types.ts`: `SetupContext.files` (pending writes) and `SetupContext.only`.
- Modify `src/setup/index.ts`: create `files`, set `only`, write files after save, say so.
- Create `src/setup/sections/agents.ts`; modify `src/setup/sections/index.ts` (last in `SECTIONS`).
- Modify `tests/setup-helpers.ts` (`askSection` writes pending files, accepts `only`).
- Tests: `tests/unit/agent-library.test.ts` (new), `tests/unit/setup-agents.test.ts` (new), `tests/unit/setup.test.ts` or the file covering `setup()` (find with `grep -l "await setup(" tests`).
- Docs: `README.md` (setup paragraph), `docs/decisions.md` (Part 2 bullets).

---

### Task 1: The agent library

**Files:**
- Create: `src/agent-library.ts`
- Modify: `src/agent-files.ts` (known keys)
- Test: `tests/unit/agent-library.test.ts`

**Interfaces:**
- Consumes: `findAgent`, `findSkill`, `parseAgentFile`, `Where`, `userHome` (src/agent-files.ts); plugin listing reads the same `installed_plugins.json` and `enabledPlugins` as `findAgent` (reuse its private helpers by exporting one function `enabledPlugins(home): Array<{ plugin: string; installPath: string }>` from src/agent-files.ts).
- Produces:
  - `export interface LibraryItem { kind: "agent" | "skill"; name: string; description: string; from: "repo" | "personal" | "plugin" | "source"; path: string }` (`path`: the agent file, or the skill folder; `name` is `plugin:name` for plugin items)
  - `export interface FileWrite { path: string; content: string | null }` (`path` relative to the repo root, `/`-separated; `null` removes)
  - `export function listLibrary(root: string, home: string, sources: "all" | "repo"): LibraryItem[]`: repo items, then (with `all`) personal, then enabled plugins' items; sorted by kind then name within each group.
  - `export function scanFolder(dir: string): LibraryItem[]` (`from: "source"`): every `SKILL.md` (its folder is the skill; name from frontmatter `name`, else the folder name) and every `*.md` directly in a folder named `agents` (name from frontmatter, else the file name); hidden folders other than `.claude` and `node_modules` are skipped.
  - `export function copyItem(item: LibraryItem, o: { root: string; source?: string; today: string }): FileWrite[] | { refused: string }`: an agent → one write `.claude/agents/<plain name>.md` (frontmatter gains `source: <source ?? item.path>`); a skill → every file of the folder under `.claude/skills/<plain name>/`, plus `SOURCE.md`. Refusals: a symlink inside the folder; over 200 files or 5 MB; a name failing the name rule. Text files are read as UTF-8; a binary file (contains a NUL byte in its first 8000 bytes) is refused for now (`content` is a string).
  - `export async function cloneSource(url: string): Promise<{ dir: string; cleanup: () => void } | { refused: string }>`: `url` starting with `-`, or not `https://`, `ssh://`, `git@`, `file://` or an existing local folder path → refused. A local folder is returned as is with a no-op cleanup.
  - `export function newAgentFile(o: { name: string; description: string; prompt: string; tools: string[]; model: string | null }): FileWrite`
  - `export function repoPath(p: string): string | null`: the normalized repo-relative path when it lies inside `.claude/agents/` or `.claude/skills/`, else null.

- [ ] **Step 1: Write the failing tests**

```ts
test("listLibrary: repo, then personal, then enabled plugins", () => {
  // repo: .claude/agents/lead.md, .claude/skills/house/SKILL.md; home: .claude/agents/mine.md, .claude/skills/tone/SKILL.md;
  // plugin sp@m (enabled): agents/cr.md, skills/tdd/SKILL.md
  expect(listLibrary(repo, home, "all").map((i) => `${i.from}:${i.kind}:${i.name}`)).toEqual([
    "repo:agent:lead", "repo:skill:house", "personal:agent:mine", "personal:skill:tone", "plugin:agent:sp:cr", "plugin:skill:sp:tdd",
  ]);
  expect(listLibrary(repo, home, "repo").map((i) => i.name)).toEqual(["lead", "house"]);
});

test("copyItem copies a skill folder whole, records its source, and refuses links and size", () => {
  // personal skill tone/ with SKILL.md, scripts/run.sh, references/a.md
  const w = copyItem(tone, { root: repo, source: "https://example.com/skills.git (tone)", today: "2026-10-27" }) as FileWrite[];
  expect(w.map((f) => f.path).sort()).toEqual([".claude/skills/tone/SKILL.md", ".claude/skills/tone/SOURCE.md", ".claude/skills/tone/references/a.md", ".claude/skills/tone/scripts/run.sh"]);
  expect(w.find((f) => f.path.endsWith("SOURCE.md"))!.content).toBe("Copied from https://example.com/skills.git (tone) on 2026-10-27.\n");
  // symlinkSync(join(t, "outside.txt"), join(toneDir, "leak")) → { refused } naming "leak"
  // 201 files → { refused } saying "at most 200 files"
});

test("copyItem gives a plugin agent its plain name and a source key", () => {
  const w = copyItem(pluginCr, { root: repo, today: "2026-10-27" }) as FileWrite[];
  expect(w[0]!.path).toBe(".claude/agents/cr.md");
  expect(parseAgentFile("cr", w[0]!.content!, "repo", "p")).toMatchObject({ dropped: [] });
  expect(w[0]!.content).toContain("source: ");
});

test("scanFolder finds skills and agents in a fetched source", () => {
  // dir: skills/a/SKILL.md, nested/b/SKILL.md (name: bee), agents/x.md, .git/agents/y.md (skipped), docs/agents.md (not in an agents folder)
  expect(scanFolder(dir).map((i) => `${i.kind}:${i.name}`).sort()).toEqual(["agent:x", "skill:a", "skill:bee"]);
});

test("cloneSource refuses option-like and unknown URLs, and clones a file:// repo shallowly", async () => {
  expect(await cloneSource("--upload-pack=x")).toEqual({ refused: expect.stringContaining("") });
  expect(await cloneSource("ftp://x")).toHaveProperty("refused");
  // a temp git repo with one commit: cloneSource(`file://${repo}`) → dir has its files; cleanup removes dir
});

test("repoPath keeps writes inside .claude/agents and .claude/skills", () => {
  expect(repoPath(".claude/skills/a/SKILL.md")).toBe(".claude/skills/a/SKILL.md");
  expect(repoPath(".claude/agents/../settings.json")).toBeNull();
  expect(repoPath("/etc/passwd")).toBeNull();
  expect(repoPath(".claude\\agents\\x.md")).toBe(".claude/agents/x.md");
});

test("newAgentFile writes frontmatter that parses back", () => {
  const f = newAgentFile({ name: "lead", description: "Leads reviews", prompt: "You lead.", tools: ["Read", "Grep"], model: null });
  expect(f.path).toBe(".claude/agents/lead.md");
  expect(parseAgentFile("lead", f.content!, "repo", "p")).toMatchObject({ description: "Leads reviews", prompt: "You lead.", tools: ["Read", "Grep"], model: null, dropped: [] });
});
```

- [ ] **Step 2: Run to see them fail.** `bun test tests/unit/agent-library.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.** `cloneSource` runs `git clone --depth 1 --quiet -- <url> <dir>` with `Bun.spawn` (no shell), a 2-minute timeout, `GIT_TERMINAL_PROMPT=0` in its env so it never waits for a password. Use `lstatSync` to detect symlinks. Frontmatter is written with `yaml`'s `stringify` so descriptions with `:` stay valid.
- [ ] **Step 4: Run tests.** → PASS; `bun run check` → PASS.
- [ ] **Step 5: Commit** `feat(agents): a library to list, copy, fetch and write skills and agents`.

---

### Task 2: Pending file writes in setup

**Files:**
- Modify: `src/setup/types.ts`, `src/setup/index.ts`, `tests/setup-helpers.ts`
- Test: the test file covering `setup()`

**Interfaces:**
- Consumes: `FileWrite`, `repoPath` (Task 1).
- Produces:
  - `SetupContext.files: FileWrite[]` (pending; a later write to the same path replaces an earlier one) and `SetupContext.only: boolean` (true when one section was named).
  - `export function writeFiles(root: string, files: FileWrite[]): string[]` in `src/setup/index.ts` or a small `src/setup/files.ts`: writes each (via `writeFileAtomic`, making folders; `null` removes the file; a skill folder replaced whole is expressed by the section as removals plus writes), refuses (throws) any path `repoPath` rejects, returns the paths written.
  - `runSetup`: after `doc.validate()` and `doc.save()`, when `files.length`, `writeFiles` and print `Wrote <n> file(s) under .claude/: <paths, comma-separated>. Commit them with loopstra/config.yaml on the main branch.` When the config was unchanged and files were written, print that line instead of "No changes.". A section that throws, or `SetupStopped`, writes nothing.
  - `askSection(section, root, answers, env, o?: { only?: boolean })` in tests/setup-helpers.ts writes pending files after `doc.save()` and returns them as `files: string[]` too.

- [ ] **Step 1: Write the failing tests**

```ts
test("files a section adds are written after the config saves, and not at all when setup stops", async () => {
  // a fake Section whose ask() pushes { path: ".claude/skills/a/SKILL.md", content: "x" } and sets one config value
  // setup(root, { sections: [fake], prompt: scripted(...).prompt, interactive: true }) → 0; the file exists; output contains "Wrote 1 file under .claude/: .claude/skills/a/SKILL.md"
  // a fake Section that pushes a file then throws SetupStopped → 1; the file does not exist
  // a fake Section that pushes ".claude/../x" → not saved, output names the path
});
```

- [ ] **Step 2: Run to see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** → PASS; `bun run check`.
- [ ] **Step 5: Commit** `feat(setup): sections can add files, written only when the config saves`.

---

### Task 3: The `agents` section

**Files:**
- Create: `src/setup/sections/agents.ts`
- Modify: `src/setup/sections/index.ts` (`SECTIONS` ends with `agents`)
- Test: `tests/unit/setup-agents.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2; `STEPS`, `STEP_KEYS` (src/models.ts); `TEAM_WAYS`, `CONTINUES_BUILD`, `CHAT_STEPS`, `BUILTIN_AGENTS` (src/agents.ts); `userHome`.
- Produces: `export const agents: Section` with `name: "agents"`, `title: "Agents"`, `covers: ["agents"]` (and `"agents.*"` paths: whatever `coveredBy` needs so a bad `agents` value can be fixed by this section).

The questions, in order (wording is the implementer's except where quoted):
1. Unless `ctx.only`: `Set up agents for the loop's steps now?` (suggestion no). No → return.
2. `ctx.ask.say` one paragraph: what an agent, subagents, teams and skills are for a step, that picks reach the loop's sessions, that fix, reconcile and revise run as the build's agent, and that chat's two steps are steered by channel members.
3. `Where sessions get skills, agents, plugins and MCP servers` pick `["all", "repo"]` with one line each said first (`all`: the setup of whoever runs `loopstra start` plus the repo's; `repo`: only what the repository declares, the same on every machine). `doc.put(["agents","sources"], v, "all")`.
4. Say the library (`listLibrary(root, userHome(), sources)`): one line per item `<kind> <name> (<from>): <description>`, or "No agents or skills found yet."
5. Loop: `Which step to set up` pick from `["done", "all steps", "teams", ...STEP_KEYS]` (suggestion `done`). For a step (or all steps → path `agents.all`):
   - agent (not for `fix`/`reconcile`/`revise`, and not offered built-ins): pick from `["none", "add one", ...agent names usable as a main agent]`, suggestion the current or `none`.
   - subagents: `pickMany` over agent names including built-ins, plus a separate yes/no `Add an agent first?` that runs the add flow.
   - teams: `pickMany` over team names (skip the question when there are none).
   - skills: `pickMany` over skill names, with the same `Add a skill first?`.
   - tools: `text` comma-separated, `-` empty, `check` = each rule through `toolProblem(rule, READ_ONLY_STEPS.has(step))` (for all steps: read-only true).
   - MCP tools: `text` comma-separated, `-` empty, `check` = the mcp rule regex message.
   - For chat steps, `say` first that anyone allowed to chat can steer these tools.
   - Writes with `doc.put`/`doc.unset`; a step left with no settings is unset whole (`agents.steps.<step>`); an empty `agents.steps`/`agents.all`/`agents` is not left behind as `{}` (unset it).
6. "teams": pick `["done", "new team", ...team names]`; a team: members `pickMany` (at least one), way pick `TEAM_WAYS`, or `delete` (refused while a step uses it: say which steps).
7. "add one" flow: pick `["from this machine", "from a git repository or folder", "a new agent"]` (skills: the first two only):
   - this machine: pick from `listLibrary` items of that kind not from the repo → `copyItem`.
   - git/folder: `text` URL or path → `cloneSource` → `scanFolder` → `pickMany` of items of that kind → `copyItem` each with `source: url`.
   - new agent: name (`check`: the name rule and not taken), description, role text (one line), tools (comma-separated, `-` for the session's), model (`-` for the step's).
   - Before adding, `say` the files that will be written; if a target already exists in the repo, `yesNo("Replace the existing <kind> <name>?", false)`; replacing a skill removes the old folder's files first (`content: null` writes for each existing file).
   - Push to `ctx.files`; the new item is then listed in this run's picks (keep a run-local list of added names).
   - `cleanup()` the clone in a `finally`.

`check(ctx, cfg)`: `checkAgentSetup(cfg, { repo: ctx.root, home: userHome(), sources: cfg.agents.sources })` mapped to `Check { level: p.level, text: p.text }`; when there are no problems and agents are set, one `ok` line `Every agent the steps name is in place.`; when agents are not set, `[]`.

- [ ] **Step 1: Write the failing tests** (with `askSection` and `scripted` answers; pickers take a number or the choice text, as the other section tests do)

```ts
test("in a full setup the section asks first and changes nothing on no", async () => {
  // configRepo(minimal); askSection(agents, root, ["n"]) → config text unchanged
  // askSection(agents, root, "defaults") → unchanged
});

test("a step's agent, subagents and skills are written; none removes them; an emptied step is removed", async () => {
  // repo .claude/agents/lead.md, .claude/skills/house/SKILL.md
  // answers (only: true): sources all; step review; agent lead; subagents Explore; skills house; tools -; mcp -; step done
  // → agents.steps.review = { agent: lead, subagents: [Explore], skills: [house] }; sources not written (default)
  // second run: step review; agent none; subagents (none); skills (none); tools -; mcp -; done → no agents.steps.review in the file, no "steps: {}"
});

test("tools are refused in words on a read-only step", async () => {
  // step review; ...; tools "Edit" → shown contains "review is read-only" and asks again; then "-"
});

test("adding a skill from this machine copies it into the repo after the config saves", async () => {
  // home .claude/skills/tone/SKILL.md; answers: sources all; step build; agent none; subagents: (none) / add first? n; skills: add first? y → from this machine → tone → (shown lists .claude/skills/tone/SKILL.md, SOURCE.md); then pick tone; ...; done
  // → files written: .claude/skills/tone/SKILL.md and SOURCE.md; agents.steps.build.skills = [tone]
});

test("a team is made and used, and cannot be deleted while used", async () => {});

test("check: missing agents fail, machine-only names warn, nothing set is silent", async () => {});
```

- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** → PASS; `bun run check` (the full-setup tests in the setup test file still pass: their scripted answers now need one more `n` at the end for the agents question, or the setup under test passes `sections` explicitly; update those tests).
- [ ] **Step 5: Commit** `feat(setup): an agents section for each step's agent, subagents, teams, skills and tools`.

---

### Task 4: `--check`, docs

**Files:**
- Modify: `README.md` (the setup paragraph lists `agents`; one sentence on adding skills and agents from this machine, a git repository or folder, or a new agent; that setup never commits), `docs/decisions.md` (Part 2 bullets: files written only after save; copies are data, clone shallow into a temporary folder, `SOURCE.md` / `source:`; binary files refused for now; the section is last and asked for)
- Modify: `templates/skill/SKILL.md` Onboard step 2's section list includes `agents`
- Test: the setup `--check` test file

- [ ] **Step 1: Write the failing test**

```ts
test("setup --check lists a step's missing agent under the agents section and fails", async () => {
  // config agents.steps.design.agent: ghost; setup(root, { check: true, output }) → 1; output has "FAIL  `ghost`, the agent design runs as" and "To fix: ... loopstra setup agents"
});
```

- [ ] **Step 2: Run to see it fail** (if Task 3's `check` already makes it pass, record that and keep the test).
- [ ] **Step 3: Edit the docs.**
- [ ] **Step 4:** `bun run check` → PASS.
- [ ] **Step 5: Commit** `docs: setup agents section`.
