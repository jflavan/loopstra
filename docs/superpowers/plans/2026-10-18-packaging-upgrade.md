# Packaging and Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Loopstra as the npm package `loopstra` and add `loopstra upgrade`, which installs the latest release and brings a project repository up to it in one commit.

**Architecture:** Prompts and the test hook move into the package (a repository keeps only overrides); the few files a repository must hold are tracked in a committed `loopstra/stamp.json` and updated by hash comparison or a 3-way `git merge-file`. A release workflow publishes every green merge to main with a `shipped.json` index of every template text ever shipped, which upgrade uses to recognise unedited files and find merge bases.

**Tech Stack:** Bun 1.4.2 (runtime, tests, `bun add -g`), TypeScript, git (`merge-file`, `show`, `log`), `yaml` (comment-preserving config edits), GitHub Actions, npm trusted publishing.

Spec: `docs/superpowers/specs/2026-10-18-packaging-upgrade-design.md`. Read it first.

## Conventions for every task

- Work in the worktree `C:\Source\Repos\loopstra-packaging` (branch `feat/packaging`). Never touch `C:\Source\Repos\loopstra` (other sessions use it).
- Never run `python`/`python3` (a Windows Store stub that hangs). Use `bun`.
- Run one test file: `bun test tests/unit/<file>.test.ts --timeout 30000`. Full suite: `bun run test` (4 shards, ~1-2 min). Types: `bun run typecheck`.
- Match the surrounding code: doc comments in plain sentences on every export, no abbreviations in user-facing text, double quotes, 2-space indent, `node:` imports.
- Commit after every task with a `feat(upgrade):`/`refactor(prompts):`-style subject and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test helpers live in `tests/helpers.ts`: `tempDir()`, `tempGitRepo()`, `run(cmd, cwd)`. Read it before writing tests.

## File structure

| File | Responsibility |
|---|---|
| `src/package.ts` (new) | Where the installed package is, its version, dev or not, template paths, the hook `--settings` JSON |
| `src/prompts.ts` (modify) | `promptPath(root, name)`: the override, else the shipped prompt, else null |
| `src/stamp.ts` (new) | The managed files list, `textSha`, reading and writing `loopstra/stamp.json` |
| `src/shipped.ts` (new) | The shipped-texts index: build from git history, load, closest base, fetch a base text |
| `src/upgrade/files.ts` (new) | The rules for one managed file (replace, merge, keep, conflict) |
| `src/upgrade/legacy.ts` (new) | Adopting a repository with no stamp: drop unedited prompt copies, remove the old hook |
| `src/upgrade/migrations.ts` (new) | Config migration runner and the (empty) list |
| `src/upgrade/repo.ts` (new) | `upgradeRepo`: checks, files, config, stamp, commit, report; `--check` |
| `src/upgrade/tool.ts` (new) | Registry check, semver compare, install, hand-off, release notes, the cached update notice |
| `src/commands/upgrade.ts` (new) | CLI wiring for `upgrade` |
| `src/commands/customize.ts` (new) | `customize [prompt]` |
| `src/cli.ts` (modify) | `upgrade`, `customize`, `--version`, notice on `start`/`status` |
| `src/init.ts` (modify) | No prompts, hook or settings; writes the stamp; `uncommittedSetup` asks for config, stamp, overrides |
| `src/claude.ts`, `src/phases.ts` (modify) | `--settings` with the hook on every agent-phase session |
| `src/judges.ts`, `src/chat/agents.ts`, `src/chat/writer.ts` (modify) | Read prompts through `promptPath`; drop the old-copy patching |
| `scripts/shipped.ts`, `scripts/release.ts` (new) | Build `shipped.json`; next version and skip check |
| `.github/workflows/release.yml` (new) | Publish after green CI on main |
| `package.json` (modify) | `0.0.0-dev`, `files`, `repository`, `publishConfig` |
| `README.md`, `docs/decisions.md` (modify) | Install, upgrade, customize, release docs |

---

### Task 1: `src/package.ts`

**Files:**
- Create: `src/package.ts`
- Test: `tests/unit/package.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hookSettings, isDev, PACKAGE_ROOT, packageVersion, stampVersion, templatePath } from "../../src/package";

describe("package", () => {
  test("the package root holds package.json and the templates", () => {
    expect(existsSync(join(PACKAGE_ROOT, "package.json"))).toBe(true);
    expect(existsSync(templatePath("prompts", "build.md"))).toBe(true);
  });

  test("a checkout is the development version; its stamp version names the commit", async () => {
    expect(packageVersion()).toBe("0.0.0-dev");
    expect(isDev()).toBe(true);
    expect(await stampVersion()).toMatch(/^0\.0\.0-dev\+[0-9a-f]{7,}$/);
  });

  test("the hook settings run the shipped hook by absolute path, with forward slashes", () => {
    const s = JSON.parse(hookSettings()) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> } };
    const entry = s.hooks.PreToolUse[0]!;
    expect(entry.matcher).toBe("Edit|Write|MultiEdit");
    expect(entry.hooks[0]!.command).toBe(`bun "${templatePath("hooks", "loopstra-protect-tests.ts").replace(/\\/g, "/")}"`);
    expect(entry.hooks[0]!.command).not.toContain("\\");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/package.test.ts --timeout 30000`
Expected: FAIL, cannot find module `../../src/package`. (`packageVersion()` would also fail until Task 14 sets `0.0.0-dev`; do Step 3b now.)

- [ ] **Step 3: Implement**

`src/package.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git";

/** The installed package's folder (the checkout, in development): the one holding package.json, src/ and templates/. */
export const PACKAGE_ROOT = join(import.meta.dir, "..");

/** The version every development checkout has in package.json; a release sets the real one in CI only. */
export const DEV_VERSION = "0.0.0-dev";

/** A shipped template's path, e.g. templatePath("prompts", "build.md"). */
export function templatePath(...parts: string[]): string {
  return join(PACKAGE_ROOT, "templates", ...parts);
}

/** The version in the package's package.json. */
export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
}

/** True for a development checkout (run through `bun link` or `bun src/cli.ts`), which is never upgraded from npm. */
export function isDev(): boolean {
  return packageVersion() === DEV_VERSION;
}

/** The version a repository's stamp records: the release, or `0.0.0-dev+<short commit>` for a checkout. */
export async function stampVersion(): Promise<string> {
  if (!isDev()) return packageVersion();
  const r = await new Git(PACKAGE_ROOT).run(["rev-parse", "--short", "HEAD"], true);
  return r.code === 0 && r.out.trim() ? `${DEV_VERSION}+${r.out.trim()}` : DEV_VERSION;
}

/**
 * The `claude --settings` JSON that adds the test-protection hook to a session Loopstra starts. The
 * hook runs from the installed package by absolute path (forward slashes, for the Git Bash Claude
 * Code runs hooks through on Windows); it does nothing outside a fix phase.
 */
export function hookSettings(): string {
  const hook = templatePath("hooks", "loopstra-protect-tests.ts").replace(/\\/g, "/");
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `bun "${hook}"` }] }] } });
}
```

- [ ] **Step 3b: Set the development version**

In `package.json`, change `"version": "0.1.0"` to `"version": "0.0.0-dev"`.

- [ ] **Step 4: Run the test**

Run: `bun test tests/unit/package.test.ts --timeout 30000` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/package.ts tests/unit/package.test.ts package.json
git commit -m "feat(upgrade): where the installed package is, its version, and the hook settings"
```

---

### Task 2: Prompts come from the package unless the repository overrides them

**Files:**
- Modify: `src/prompts.ts`, `src/phases.ts:166-199` and `:235`, `src/judges.ts:272-276`, `src/chat/agents.ts:19-60`, `src/chat/writer.ts:111`
- Test: `tests/unit/prompts.test.ts`, `tests/unit/phases.test.ts:56-66`, `tests/unit/judges-run.test.ts:78-85`, any chat test of the orchestrator patching

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/prompts.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptPath } from "../../src/prompts";
import { templatePath } from "../../src/package";
import { tempDir } from "../helpers";

describe("promptPath", () => {
  test("the repository's override first, else the shipped prompt, else null", () => {
    const t = tempDir();
    try {
      expect(promptPath(t.path, "review")).toBe(templatePath("prompts", "review.md"));
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(t.path, "loopstra", "prompts", "review.md"), "mine");
      expect(promptPath(t.path, "review")).toBe(join(t.path, "loopstra", "prompts", "review.md"));
      expect(promptPath(t.path, "no-such-phase")).toBeNull();
    } finally { t.cleanup(); }
  });
});
```

(Merge the imports with the file's existing ones; add `describe, expect, test` only if missing.)

Replace the test at `tests/unit/phases.test.ts:56` ("a missing prompt file is a plain failure") with:

```ts
  test("a phase with no prompt of the repository's own uses the shipped one", async () => {
    const { repo, ctx, trace } = await setup();
    rmSync(join(repo.path, "loopstra", "prompts", "intake.md"), { force: true });
    const r = await agentPhase(ctx, { name: "intake", model: "strong", permissionMode: "default", tools: "read", vars: {} });
    expect(r.reason).not.toBe("missing-prompt");
    trace.close(); repo.cleanup();
  });
```

(Use the same `setup()`/fixture the neighbouring intake test uses so the fake session succeeds; add `rmSync` to the `node:fs` import.)

Replace the judges test at `tests/unit/judges-run.test.ts:78` ("a missing prompt file gives today's failure...") with:

```ts
  test("with no repository prompt, the judge uses the shipped one and its sha", async () => {
    await withRepo(SHADOW, {}, async ({ repo, ctx }) => {
      rmSync(join(repo.path, "loopstra", "prompts", "spec-check.md"));
      expect(templateSha(repo.path, "spec-check")).toBe(sha256(readFileSync(templatePath("prompts", "spec-check.md"), "utf8")));
      expect((await runJudge(ctx, SPEC_CHECK)).reason).not.toBe("missing-prompt");
    });
  });
```

(Import `templateSha` from `../../src/judges`, `templatePath` from `../../src/package`, and `sha256` from wherever `src/judges.ts` imports it — check its imports; add `readFileSync`.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/prompts.test.ts tests/unit/phases.test.ts tests/unit/judges-run.test.ts --timeout 30000`
Expected: FAIL (`promptPath` not exported; the phase and judge report `missing-prompt`).

- [ ] **Step 3: Implement**

In `src/prompts.ts` add:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "./package";

/**
 * The prompt template a phase uses: the repository's override in loopstra/prompts/<name>.md when
 * there is one, else the one shipped in the package, else null (a broken install).
 */
export function promptPath(root: string, name: string): string | null {
  const own = join(root, "loopstra", "prompts", `${name}.md`);
  if (existsSync(own)) return own;
  const shipped = templatePath("prompts", `${name}.md`);
  return existsSync(shipped) ? shipped : null;
}
```

In `src/phases.ts`:
- Delete `promptFile` (lines 184-187).
- In `phasePrompt`: `const promptPath = promptFile(ctx, spec.name); if (!existsSync(promptPath)) return null;` becomes `const path = promptPath(ctx.root, spec.name); if (path === null) return null;` and `Bun.file(promptPath)` becomes `Bun.file(path)`. Import `promptPath` from `./prompts`. Update the doc comment: "or null when neither the repository nor the package has its prompt".
- In `withNote`: `Bun.file(promptFile(ctx, spec.name))` becomes `const path = promptPath(ctx.root, spec.name); try { template = path ? await Bun.file(path).text() : ""; } catch {...}`. Update its comment: "an override may leave the variable out".
- Line 235 detail: `` `loopstra/prompts/${spec.name}.md is missing; \`loopstra init\` restores it` `` becomes `` `the prompt ${spec.name}.md is missing from the repository and the package; reinstall Loopstra` ``.
- Remove `existsSync` from imports if now unused.

In `src/judges.ts` `templateSha`:

```ts
/** The sha256 of the prompt template a judge uses (the repository's override, else the shipped one), or null when there is none. Changing it starts the record over. */
export function templateSha(root: string, judge: JudgeName): string | null {
  const path = promptPath(root, judge);
  return path ? sha256(readFileSync(path, "utf8")) : null;
}
```

In `src/chat/agents.ts`:
- Delete `BUNDLED`, `ACTING`, `NO_ACTIONS`, `TRUSTED`, `QUOTES_ARE_DATA`, `sectionAt`, `sectionOf`.
- Replace `chatTemplate` with:

```ts
/** The prompt template for a chat phase: the repository's override, else the one shipped with Loopstra. */
export async function chatTemplate(root: string, name: ChatPhase): Promise<string> {
  const path = promptPath(root, name);
  if (!path) throw new Error(`the prompt ${name}.md is missing from the repository and the package; reinstall Loopstra`);
  return Bun.file(path).text();
}
```

- Remove now-unused imports (`existsSync`, `join` if unused).

In `src/chat/writer.ts:111` replace `join(import.meta.dir, "..", "..", "templates", "intent-README.md")` with `templatePath("intent-README.md")` (import from `../package`).

- [ ] **Step 4: Update the chat tests of the old patching**

Run: `bun test tests/unit/chat-orchestrator.test.ts tests/unit/chat-writer.test.ts tests/unit/chat-config.test.ts --timeout 30000`
Any test asserting that an old orchestrator copy gets the "Acting on a change" section or the `answer` sentence added, or the trusted sentence replaced, tests removed behaviour: delete those tests (and only those). A test that writes an override and expects it used stays.

- [ ] **Step 5: Run the touched tests and typecheck**

Run: `bun test tests/unit/prompts.test.ts tests/unit/phases.test.ts tests/unit/judges-run.test.ts tests/unit/judges-command.test.ts tests/unit/chat-orchestrator.test.ts tests/unit/chat-writer.test.ts --timeout 30000 && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "refactor(prompts): a phase uses the repository's override, else the prompt shipped in the package"
```

---

### Task 3: The test hook comes with every session, not with the repository

**Files:**
- Modify: `src/claude.ts` (RunPhaseInput and args at ~line 339), `src/phases.ts:~455-462`
- Test: `tests/unit/claude-run.test.ts`, `tests/unit/hook.test.ts` (unchanged; still runs `templates/hooks/...`)

- [ ] **Step 1: Write the failing test**

In `tests/unit/claude-run.test.ts`, find how existing tests call `runPhase` with `LOOPSTRA_FAKE_ARGS` (search `LOOPSTRA_FAKE_ARGS`) and add, following that pattern:

```ts
  test("settings are passed to claude as --settings", async () => {
    const t = tempDir();
    try {
      const argsFile = join(t.path, "args.json");
      await runPhase({ ...BASE_INPUT, settings: '{"hooks":{}}', env: { ...BASE_INPUT.env, LOOPSTRA_FAKE_ARGS: argsFile } });
      const { args } = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] };
      expect(args[args.indexOf("--settings") + 1]).toBe('{"hooks":{}}');
    } finally { t.cleanup(); }
  });
```

`BASE_INPUT` stands for whatever input object the file's other tests build; reuse it exactly (rename in the snippet to match).

In `tests/unit/phases.test.ts` add, following the file's intake test (which uses the fake claude):

```ts
  test("every agent phase session gets the test hook through --settings", async () => {
    const { repo, ctx, trace } = await setup();
    const argsFile = join(repo.path, "args.json");
    process.env.LOOPSTRA_FAKE_ARGS = argsFile;
    try {
      await agentPhase(ctx, { name: "intake", model: "strong", permissionMode: "default", tools: "read", vars: {} });
      const { args } = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] };
      expect(args[args.indexOf("--settings") + 1]).toBe(hookSettings());
    } finally { delete process.env.LOOPSTRA_FAKE_ARGS; trace.close(); repo.cleanup(); }
  });
```

(If the file passes fake env differently — e.g. through `ctx` or a helper — use that instead of `process.env`.)

- [ ] **Step 2: Run to see it fail**

Run: `bun test tests/unit/claude-run.test.ts tests/unit/phases.test.ts --timeout 30000` — Expected: FAIL (`settings` not a known field / no `--settings`).

- [ ] **Step 3: Implement**

In `src/claude.ts`, add to `RunPhaseInput`:

```ts
  /** Extra Claude Code settings for this session, as JSON (`claude --settings`): the test hook. */
  settings?: string;
```

After `if (input.disallowedTools?.length) ...` add:

```ts
  if (input.settings) args.push("--settings", input.settings);
```

In `src/phases.ts`, where `agentPhase` builds the `runPhase` input with `env: { LOOPSTRA_PHASE: spec.name, ... }` (~line 460), add `settings: hookSettings(),` (import from `./package`). Do the same where the cheaper judge session is started in `src/judges.ts` if it builds its own `runPhase` input (search `runPhase(` in `src/judges.ts`; it says "Same phase (so the same prompt file, LOOPSTRA_PHASE and tools)").

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/claude-run.test.ts tests/unit/phases.test.ts tests/unit/judges-run.test.ts tests/unit/hook.test.ts --timeout 30000` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "feat(upgrade): the test hook comes with every agent session through claude --settings"
```

---

### Task 4: `src/stamp.ts`

**Files:**
- Create: `src/stamp.ts`
- Test: `tests/unit/stamp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedFiles, readStamp, STAMP_FILE, textSha, writeStamp } from "../../src/stamp";
import { templatePath } from "../../src/package";
import { tempDir } from "../helpers";

describe("stamp", () => {
  test("textSha ignores line endings", () => {
    expect(textSha("a\r\nb\r\n")).toBe(textSha("a\nb\n"));
    expect(textSha("a\nb\n")).not.toBe(textSha("a\nc\n"));
  });

  test("the managed files: the skill, the owner guide, REVIEW.md, and each prompt override", () => {
    const t = tempDir();
    try {
      expect(managedFiles(t.path)).toEqual([
        { path: ".claude/skills/loopstra/SKILL.md", template: "templates/skill/SKILL.md", shipped: templatePath("skill", "SKILL.md") },
        { path: "intent/README.md", template: "templates/intent-README.md", shipped: templatePath("intent-README.md") },
        { path: "REVIEW.md", template: "templates/REVIEW.md", shipped: templatePath("REVIEW.md") },
      ]);
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(t.path, "loopstra", "prompts", "review.md"), "x");
      writeFileSync(join(t.path, "loopstra", "prompts", "notes.txt"), "x");
      expect(managedFiles(t.path).at(-1)).toEqual({ path: "loopstra/prompts/review.md", template: "templates/prompts/review.md", shipped: templatePath("prompts", "review.md") });
      expect(managedFiles(t.path)).toHaveLength(4);
    } finally { t.cleanup(); }
  });

  test("a prompt the stamp records stays managed after it is deleted", () => {
    const t = tempDir();
    try {
      const stamp = { loopstra: "0.1.0", files: { "loopstra/prompts/plan.md": { base: "abc", deleted: true } } };
      expect(managedFiles(t.path, stamp).map((f) => f.path)).toContain("loopstra/prompts/plan.md");
    } finally { t.cleanup(); }
  });

  test("reads back what it writes; a missing or unreadable stamp is null", () => {
    const t = tempDir();
    try {
      expect(readStamp(t.path)).toBeNull();
      writeStamp(t.path, { loopstra: "0.2.0", files: { "REVIEW.md": { base: "abc" } } });
      expect(readStamp(t.path)).toEqual({ loopstra: "0.2.0", files: { "REVIEW.md": { base: "abc" } } });
      writeFileSync(join(t.path, STAMP_FILE), "{nope");
      expect(readStamp(t.path)).toBeNull();
    } finally { t.cleanup(); }
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/stamp.test.ts --timeout 30000`, Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/stamp.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./fsutil";
import { templatePath } from "./package";

/** The committed record of the Loopstra version a repository is on and where each managed file came from. */
export const STAMP_FILE = "loopstra/stamp.json";

export interface StampEntry {
  /** textSha of the shipped text the file was last written from or merged to. */
  base: string;
  /** The repository removed the file on purpose; upgrade does not bring it back. */
  deleted?: true;
}

export interface Stamp {
  /** The Loopstra version that last wrote the repository's files. */
  loopstra: string;
  /** Keyed by the file's path in the repository, with forward slashes. */
  files: Record<string, StampEntry>;
}

/** A file Loopstra keeps up to date in the repository. */
export interface ManagedFile {
  /** Its path in the repository. */
  path: string;
  /** Its template's path in the Loopstra repository (the key in shipped.json). */
  template: string;
  /** The shipped text's path in the installed package. */
  shipped: string;
}

/** The files that must live in the repository; prompt overrides are added to these. */
const FIXED: ReadonlyArray<{ path: string; template: string[] }> = [
  { path: ".claude/skills/loopstra/SKILL.md", template: ["skill", "SKILL.md"] },
  { path: "intent/README.md", template: ["intent-README.md"] },
  { path: "REVIEW.md", template: ["REVIEW.md"] },
];

/** sha256 of a text with its line endings made `\n`, so a checkout with core.autocrlf hashes the same. */
export function textSha(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function managed(path: string, template: string[]): ManagedFile {
  return { path, template: ["templates", ...template].join("/"), shipped: templatePath(...template) };
}

/**
 * The repository's managed files: the fixed three, then every prompt override (a .md in
 * loopstra/prompts/ named like a shipped prompt), and any prompt the stamp still records (one deleted
 * on purpose stays managed, so it is not brought back).
 */
export function managedFiles(root: string, stamp: Stamp | null = null): ManagedFile[] {
  const files = FIXED.map((f) => managed(f.path, f.template));
  const dir = join(root, "loopstra", "prompts");
  const names = new Set(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : []);
  for (const p of Object.keys(stamp?.files ?? {})) if (p.startsWith("loopstra/prompts/")) names.add(p.slice("loopstra/prompts/".length));
  for (const name of [...names].sort()) {
    if (existsSync(templatePath("prompts", name))) files.push(managed(`loopstra/prompts/${name}`, ["prompts", name]));
  }
  return files;
}

/** The repository's stamp, or null when it has none or it cannot be read. */
export function readStamp(root: string): Stamp | null {
  try {
    const s = JSON.parse(readFileSync(join(root, STAMP_FILE), "utf8")) as Stamp;
    return typeof s?.loopstra === "string" && s.files && typeof s.files === "object" ? s : null;
  } catch {
    return null;
  }
}

/** Writes the stamp, its files in path order. */
export function writeStamp(root: string, stamp: Stamp): void {
  const files = Object.fromEntries(Object.entries(stamp.files).sort(([a], [b]) => a.localeCompare(b)));
  const path = join(root, STAMP_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ loopstra: stamp.loopstra, files }, null, 2)}\n`);
}
```

- [ ] **Step 4: Run** — `bun test tests/unit/stamp.test.ts --timeout 30000`, Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/stamp.ts tests/unit/stamp.test.ts && git commit -m "feat(upgrade): the stamp, a repository's record of its managed files"`

---

### Task 5: `src/shipped.ts`, the index of every text ever shipped

**Files:**
- Create: `src/shipped.ts`, `scripts/shipped.ts`
- Test: `tests/unit/shipped.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseText, buildShippedIndex, closestBase, type ShippedIndex } from "../../src/shipped";
import { textSha } from "../../src/stamp";
import { run, tempGitRepo } from "../helpers";

async function commitFile(dir: string, rel: string, text: string): Promise<string> {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
  await run(["git", "add", "-A"], dir);
  await run(["git", "commit", "-q", "-m", `edit ${rel}`], dir);
  return (await run(["git", "rev-parse", "HEAD"], dir)).out.trim();
}

describe("shipped index", () => {
  test("lists each template text once, with the commit that first had it", async () => {
    const repo = await tempGitRepo();
    try {
      const c1 = await commitFile(repo.path, "templates/REVIEW.md", "one\n");
      await commitFile(repo.path, "src/x.ts", "unrelated\n");
      const c3 = await commitFile(repo.path, "templates/REVIEW.md", "two\n");
      await commitFile(repo.path, "templates/REVIEW.md", "one\n");
      const index = await buildShippedIndex(repo.path);
      expect(index["templates/REVIEW.md"]).toEqual([
        { sha: textSha("one\n"), commit: c1 },
        { sha: textSha("two\n"), commit: c3 },
      ]);
      expect(index["src/x.ts"]).toBeUndefined();
    } finally { repo.cleanup(); }
  });

  test("closestBase picks the version with the fewest differing lines", async () => {
    const texts: Record<string, string> = { a: "l1\nl2\nl3\n", b: "l1\nl2\nl3\nl4\nl5\n" };
    const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: textSha(texts.a!), commit: "a" }, { sha: textSha(texts.b!), commit: "b" }] };
    const fetch = async (_t: string, commit: string) => texts[commit] ?? null;
    const best = await closestBase(index, "templates/REVIEW.md", "l1\nl2\nl3\nl4\nmine\n", fetch);
    expect(best).toEqual({ sha: textSha(texts.b!), commit: "b", text: texts.b! });
  });

  test("baseText finds the text for a sha through the index", async () => {
    const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: "s1", commit: "c1" }] };
    const fetch = async (t: string, commit: string) => `${t}@${commit}`;
    expect(await baseText(index, "templates/REVIEW.md", "s1", fetch)).toBe("templates/REVIEW.md@c1");
    expect(await baseText(index, "templates/REVIEW.md", "nope", fetch)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/shipped.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement** `src/shipped.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git";
import { isDev, PACKAGE_ROOT } from "./package";
import { textSha } from "./stamp";

/** Every text each template has had: its textSha and the first commit that had it, oldest first. Keyed by `templates/...` path. */
export type ShippedIndex = Record<string, Array<{ sha: string; commit: string }>>;

/** Gets a template's text at a commit, or null when it cannot. */
export type FetchText = (template: string, commit: string) => Promise<string | null>;

/** Where a release's base texts are read from. LOOPSTRA_RAW_URL is for tests only. */
const RAW_URL = process.env.LOOPSTRA_RAW_URL ?? "https://raw.githubusercontent.com/jflavan/loopstra";

/** Builds the index from a Loopstra checkout's git history (a release does this; so does a development checkout, which has no shipped.json). */
export async function buildShippedIndex(repo: string): Promise<ShippedIndex> {
  const git = new Git(repo);
  const log = await git.run(["log", "--reverse", "--format=%H", "--", "templates"]);
  const index: ShippedIndex = {};
  for (const commit of log.out.split(/\r?\n/).filter(Boolean)) {
    const files = await git.run(["ls-tree", "-r", "--name-only", commit, "--", "templates"]);
    for (const path of files.out.split(/\r?\n/).filter(Boolean)) {
      const shown = await git.run(["show", `${commit}:${path}`], true);
      if (shown.code !== 0) continue;
      const sha = textSha(shown.out);
      const seen = (index[path] ??= []);
      if (!seen.some((e) => e.sha === sha)) seen.push({ sha, commit });
    }
  }
  return index;
}

/** The installed package's index: its shipped.json, or, in a development checkout, built from the checkout's history. */
export async function loadShippedIndex(): Promise<ShippedIndex> {
  const file = join(PACKAGE_ROOT, "shipped.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as ShippedIndex;
  return isDev() ? buildShippedIndex(PACKAGE_ROOT) : {};
}

/** Fetches a template's text at a commit: `git show` in a development checkout, else from GitHub. */
export const fetchShipped: FetchText = async (template, commit) => {
  if (isDev() && !process.env.LOOPSTRA_RAW_URL) {
    const r = await new Git(PACKAGE_ROOT).run(["show", `${commit}:${template}`], true);
    return r.code === 0 ? r.out : null;
  }
  try {
    const res = await fetch(`${RAW_URL}/${commit}/${template}`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

/** Whether a text is one the template has shipped with. */
export function wasShipped(index: ShippedIndex, template: string, text: string): boolean {
  const sha = textSha(text);
  return (index[template] ?? []).some((e) => e.sha === sha);
}

/** The text of the shipped version with this sha, or null when it is not in the index or cannot be fetched. */
export async function baseText(index: ShippedIndex, template: string, sha: string, fetchText: FetchText = fetchShipped): Promise<string | null> {
  const entry = (index[template] ?? []).find((e) => e.sha === sha);
  return entry ? fetchText(template, entry.commit) : null;
}

/** Lines in one text and not the other, counted both ways (a multiset difference). */
function differingLines(a: string, b: string): number {
  const count = new Map<string, number>();
  for (const l of a.replace(/\r\n/g, "\n").split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  let extra = 0;
  for (const l of b.replace(/\r\n/g, "\n").split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1); else extra++;
  }
  return extra + [...count.values()].reduce((s, n) => s + n, 0);
}

/** The shipped version closest to `text` (fewest differing lines), with its text; null when none can be fetched. Ties go to the newer version. */
export async function closestBase(index: ShippedIndex, template: string, text: string, fetchText: FetchText = fetchShipped): Promise<{ sha: string; commit: string; text: string } | null> {
  let best: { sha: string; commit: string; text: string; d: number } | null = null;
  for (const e of index[template] ?? []) {
    const t = await fetchText(template, e.commit);
    if (t === null) continue;
    const d = differingLines(text, t);
    if (!best || d <= best.d) best = { ...e, text: t, d };
  }
  return best ? { sha: best.sha, commit: best.commit, text: best.text } : null;
}
```

`scripts/shipped.ts`:

```ts
#!/usr/bin/env bun
// Writes shipped.json (every text each template has had, and the commit that first had it) for a release.
import { buildShippedIndex } from "../src/shipped";

const out = process.argv[2] ?? "shipped.json";
await Bun.write(out, `${JSON.stringify(await buildShippedIndex(process.cwd()), null, 1)}\n`);
console.log(`wrote ${out}`);
```

- [ ] **Step 4: Run** — `bun test tests/unit/shipped.test.ts --timeout 30000`, Expected: PASS. Also run `bun scripts/shipped.ts C:/Users/flava/AppData/Local/Temp/shipped-check.json` once and check it finishes in under a minute and lists `templates/prompts/review.md`.
- [ ] **Step 5: Commit** — `git add src/shipped.ts scripts/shipped.ts tests/unit/shipped.test.ts && git commit -m "feat(upgrade): the index of every template text Loopstra has shipped"`

---

### Task 6: `src/upgrade/files.ts`, the rules for one managed file

**Files:**
- Create: `src/upgrade/files.ts`
- Test: `tests/unit/upgrade-files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeText, upgradeFile } from "../../src/upgrade/files";
import { textSha, type ManagedFile } from "../../src/stamp";
import { tempDir } from "../helpers";

const BASE = "# Title\n\nline a\nline b\nline c\n";
const NEW = "# Title\n\nline a\nline b changed\nline c\n";

function setup(theirs: string | null) {
  const t = tempDir();
  mkdirSync(join(t.path, "pkg"), { recursive: true });
  writeFileSync(join(t.path, "pkg", "REVIEW.md"), NEW);
  if (theirs !== null) writeFileSync(join(t.path, "REVIEW.md"), theirs);
  const file: ManagedFile = { path: "REVIEW.md", template: "templates/REVIEW.md", shipped: join(t.path, "pkg", "REVIEW.md") };
  return { t, file };
}

describe("upgradeFile", () => {
  test("an unedited file is replaced", async () => {
    const { t, file } = setup(BASE);
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(r).toEqual({ path: "REVIEW.md", outcome: "replaced", entry: { base: textSha(NEW) } });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe(NEW);
    } finally { t.cleanup(); }
  });

  test("a file already at the new text is unchanged", async () => {
    const { t, file } = setup(NEW);
    try {
      expect((await upgradeFile(t.path, file, { base: textSha(NEW) }, async () => null, { write: true })).outcome).toBe("unchanged");
    } finally { t.cleanup(); }
  });

  test("an edited file is merged", async () => {
    const { t, file } = setup("# Title\n\nline a\nline b\nline c\nmy own line\n");
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(r.outcome).toBe("merged");
      expect(r.entry).toEqual({ base: textSha(NEW) });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe("# Title\n\nline a\nline b changed\nline c\nmy own line\n");
    } finally { t.cleanup(); }
  });

  test("a conflict leaves markers and keeps the old base", async () => {
    const { t, file } = setup("# Title\n\nline a\nline b mine\nline c\n");
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(r.outcome).toBe("conflict");
      expect(r.entry).toEqual({ base: textSha(BASE) });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toContain("<<<<<<<");
    } finally { t.cleanup(); }
  });

  test("an edited file whose base cannot be fetched is left alone", async () => {
    const { t, file } = setup("mine\n");
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => null, { write: true });
      expect(r.outcome).toBe("no-base");
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe("mine\n");
    } finally { t.cleanup(); }
  });

  test("deleted on purpose stays deleted; a new managed file is written; a just-deleted one is recorded", async () => {
    const { t, file } = setup(null);
    try {
      expect((await upgradeFile(t.path, file, { base: "x", deleted: true }, async () => null, { write: true })).outcome).toBe("deleted");
      expect(existsSync(join(t.path, "REVIEW.md"))).toBe(false);
      const fresh = await upgradeFile(t.path, file, undefined, async () => null, { write: true });
      expect(fresh).toEqual({ path: "REVIEW.md", outcome: "added", entry: { base: textSha(NEW) } });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe(NEW);
    } finally { t.cleanup(); }
    const again = setup(null);
    try {
      const r = await upgradeFile(again.t.path, again.file, { base: textSha(BASE) }, async () => null, { write: true });
      expect(r).toEqual({ path: "REVIEW.md", outcome: "deleted", entry: { base: textSha(BASE), deleted: true } });
    } finally { again.t.cleanup(); }
  });

  test("with write false nothing is written", async () => {
    const { t, file } = setup(BASE);
    try {
      expect((await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: false })).outcome).toBe("replaced");
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe(BASE);
    } finally { t.cleanup(); }
  });

  test("a CRLF file stays CRLF after a merge", async () => {
    const { t, file } = setup("# Title\r\n\r\nline a\r\nline b\r\nline c\r\nmine\r\n");
    try {
      await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe("# Title\r\n\r\nline a\r\nline b changed\r\nline c\r\nmine\r\n");
    } finally { t.cleanup(); }
  });
});

describe("mergeText", () => {
  test("clean and conflicting merges", async () => {
    expect(await mergeText("a\nb\nmine\n", "a\nb\n", "a\nB\n")).toEqual({ text: "a\nB\nmine\n", conflict: false });
    expect((await mergeText("a\nX\n", "a\nb\n", "a\nY\n")).conflict).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/upgrade-files.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement** `src/upgrade/files.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { textSha, type ManagedFile, type StampEntry } from "../stamp";

/** What upgrade did, or would do, to one managed file. */
export type FileOutcome = "unchanged" | "replaced" | "merged" | "conflict" | "no-base" | "added" | "deleted";

export interface FileResult {
  path: string;
  outcome: FileOutcome;
  /** The file's stamp entry afterwards. */
  entry: StampEntry;
}

/** Gets the shipped text whose textSha is `sha`, or null. */
export type BaseFor = (sha: string) => Promise<string | null>;

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const isCrlf = (s: string) => (s.match(/\r\n/g)?.length ?? 0) * 2 > (s.match(/\n/g)?.length ?? 0);

/** A 3-way merge with `git merge-file`, all three as `\n` text: the merged text, and whether it has conflict markers. */
export async function mergeText(theirs: string, base: string, next: string): Promise<{ text: string; conflict: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "loopstra-merge-"));
  try {
    const [a, o, b] = [join(dir, "theirs"), join(dir, "base"), join(dir, "new")];
    writeFileSync(a, lf(theirs)); writeFileSync(o, lf(base)); writeFileSync(b, lf(next));
    const proc = Bun.spawn({ cmd: ["git", "merge-file", "-p", "-L", "yours", "-L", "base", "-L", "loopstra", a, o, b], stdout: "pipe", stderr: "pipe" });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code < 0) throw new Error(`git merge-file failed (${code})`);
    return { text, conflict: code > 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Applies the managed-file rules (spec: "Rules for a managed file") to one file. `entry` is its
 * stamp entry (undefined: Loopstra never wrote it). With `write` false it only says what it would do.
 */
export async function upgradeFile(root: string, file: ManagedFile, entry: StampEntry | undefined, baseFor: BaseFor, opts: { write: boolean }): Promise<FileResult> {
  const target = join(root, file.path);
  const next = readFileSync(file.shipped, "utf8");
  const nextSha = textSha(next);
  const done = (outcome: FileOutcome, e: StampEntry): FileResult => ({ path: file.path, outcome, entry: e });
  const put = (text: string) => {
    if (!opts.write) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };

  if (!existsSync(target)) {
    if (entry) return done("deleted", { base: entry.base, deleted: true });
    put(next);
    return done("added", { base: nextSha });
  }
  const theirs = readFileSync(target, "utf8");
  const theirSha = textSha(theirs);
  if (theirSha === nextSha) return done("unchanged", { base: nextSha });
  if (entry && theirSha === entry.base) {
    put(isCrlf(theirs) ? lf(next).replace(/\n/g, "\r\n") : next);
    return done("replaced", { base: nextSha });
  }
  if (entry && entry.base === nextSha) return done("unchanged", { base: nextSha });
  // No entry: the caller found no base for the file (see upgradeRepo); it is treated as written from today's text, so nothing is merged into it now.
  const base = entry ? await baseFor(entry.base) : null;
  if (base === null) return done("no-base", entry ?? { base: nextSha });
  const merged = await mergeText(theirs, base, next);
  const text = isCrlf(theirs) ? merged.text.replace(/\n/g, "\r\n") : merged.text;
  put(text);
  return merged.conflict ? done("conflict", entry!) : done("merged", { base: nextSha });
}
```

- [ ] **Step 4: Run** — `bun test tests/unit/upgrade-files.test.ts --timeout 30000`, Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/upgrade/files.ts tests/unit/upgrade-files.test.ts && git commit -m "feat(upgrade): the rules for one managed file: replace, merge, keep, conflict"`

---

### Task 7: `src/upgrade/legacy.ts`, adopting a repository set up before the stamp

**Files:**
- Create: `src/upgrade/legacy.ts`
- Modify: `src/init.ts` (export `HOOK_FILE`, `HOOK_MARK` stay exported; they move here in Task 9)
- Test: `tests/unit/upgrade-legacy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptLegacy } from "../../src/upgrade/legacy";
import { textSha } from "../../src/stamp";
import type { ShippedIndex } from "../../src/shipped";
import { tempDir } from "../helpers";

const OLD_REVIEW = "old review prompt\n";
const OLD_PLAN = "old plan prompt\nline 2\n";

function legacyRepo() {
  const t = tempDir();
  const p = join(t.path, "loopstra", "prompts");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "review.md"), OLD_REVIEW);
  writeFileSync(join(p, "plan.md"), "old plan prompt\nline 2\nmy rule\n");
  mkdirSync(join(t.path, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(t.path, ".claude", "hooks", "loopstra-protect-tests.ts"), "// hook");
  writeFileSync(join(t.path, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/loopstra-protect-tests.ts"' }] }] } }, null, 2));
  writeFileSync(join(t.path, "REVIEW.md"), "a review guide\n");
  return t;
}

const INDEX: ShippedIndex = {
  "templates/prompts/review.md": [{ sha: textSha(OLD_REVIEW), commit: "c1" }],
  "templates/prompts/plan.md": [{ sha: textSha(OLD_PLAN), commit: "c1" }],
  "templates/REVIEW.md": [{ sha: textSha("a review guide\n"), commit: "c1" }],
};
const fetchText = async (template: string) => (template.endsWith("plan.md") ? OLD_PLAN : null);

describe("adoptLegacy", () => {
  test("drops unedited prompt copies, keeps overrides with their closest base, removes the old hook", async () => {
    const t = legacyRepo();
    try {
      const r = await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(existsSync(join(t.path, "loopstra", "prompts", "plan.md"))).toBe(true);
      expect(r.removed).toEqual(["loopstra/prompts/review.md", ".claude/hooks/loopstra-protect-tests.ts"]);
      expect(r.stamp.files["loopstra/prompts/plan.md"]).toEqual({ base: textSha(OLD_PLAN) });
      expect(r.notes).toEqual(["loopstra/prompts/plan.md is your own; it is merged from the shipped version of commit c1."]);
      expect(r.stamp.files["REVIEW.md"]).toEqual({ base: textSha("a review guide\n") });
      expect(JSON.parse(readFileSync(join(t.path, ".claude", "settings.json"), "utf8"))).toEqual({ model: "x" });
      expect(r.changed).toContain(".claude/settings.json");
    } finally { t.cleanup(); }
  });

  test("a settings file left empty is deleted; with write false nothing changes", async () => {
    const t = legacyRepo();
    try {
      writeFileSync(join(t.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "bun loopstra-protect-tests.ts" }] }] } }));
      const dry = await adoptLegacy(t.path, INDEX, fetchText, { write: false });
      expect(dry.removed).toContain("loopstra/prompts/review.md");
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(true);
      await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(existsSync(join(t.path, ".claude", "settings.json"))).toBe(false);
    } finally { t.cleanup(); }
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/upgrade-legacy.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement** `src/upgrade/legacy.ts`:

```ts
import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closestBase, wasShipped, type FetchText, type ShippedIndex } from "../shipped";
import { managedFiles, textSha, type Stamp } from "../stamp";

/** The hook file init used to write, and the text that marks its entry in .claude/settings.json. */
export const OLD_HOOK_FILE = ".claude/hooks/loopstra-protect-tests.ts";
export const OLD_HOOK_MARK = "loopstra-protect-tests";

export interface Adopted {
  /** The stamp to start from: a base for every managed file that exists. Its version is filled in by the caller. */
  stamp: Stamp;
  /** Files deleted: unedited prompt copies and the old hook. */
  removed: string[];
  /** Files edited: .claude/settings.json when the hook entry was taken out. */
  changed: string[];
  /** One sentence per override whose base was guessed. */
  notes: string[];
}

/**
 * Brings a repository set up before the stamp to the new layout: an unedited prompt copy is deleted
 * (the package has it); an edited one is an override, based on the closest shipped version; the
 * other managed files get a base the same way; the old hook file and its settings entry go.
 */
export async function adoptLegacy(root: string, index: ShippedIndex, fetchText: FetchText, opts: { write: boolean }): Promise<Adopted> {
  const out: Adopted = { stamp: { loopstra: "", files: {} }, removed: [], changed: [], notes: [] };
  for (const file of managedFiles(root)) {
    const path = join(root, file.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const isPrompt = file.path.startsWith("loopstra/prompts/");
    if (wasShipped(index, file.template, text)) {
      if (isPrompt) {
        if (opts.write) rmSync(path);
        out.removed.push(file.path);
      } else {
        out.stamp.files[file.path] = { base: textSha(text) };
      }
      continue;
    }
    const best = await closestBase(index, file.template, text, fetchText);
    // No shipped version to go by: the file is treated as written from today's text, so nothing is merged into it.
    out.stamp.files[file.path] = { base: best ? best.sha : textSha(readFileSync(file.shipped, "utf8")) };
    if (isPrompt) out.notes.push(best ? `${file.path} is your own; it is merged from the shipped version of commit ${best.commit.slice(0, 7)}.` : `${file.path} is your own; no shipped version could be read, so it is left as it is.`);
  }

  const hook = join(root, OLD_HOOK_FILE);
  if (existsSync(hook)) {
    if (opts.write) {
      rmSync(hook);
      const dir = join(root, ".claude", "hooks");
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    }
    out.removed.push(OLD_HOOK_FILE);
  }
  const settingsRel = ".claude/settings.json";
  const settingsPath = join(root, settingsRel);
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown> | null = null;
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { /* not JSON: left alone */ }
    const hooks = settings?.hooks as Record<string, unknown[]> | undefined;
    const pre = hooks?.PreToolUse;
    if (settings && hooks && Array.isArray(pre) && pre.some((h) => JSON.stringify(h).includes(OLD_HOOK_MARK))) {
      const kept = pre.filter((h) => !JSON.stringify(h).includes(OLD_HOOK_MARK));
      if (kept.length) hooks.PreToolUse = kept; else delete hooks.PreToolUse;
      if (!Object.keys(hooks).length) delete settings.hooks;
      if (Object.keys(settings).length) {
        if (opts.write) writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        out.changed.push(settingsRel);
      } else {
        if (opts.write) rmSync(settingsPath);
        out.removed.push(settingsRel);
      }
    }
  }
  return out;
}
```

Note: in the first test `fetchText` returns OLD_PLAN for plan.md, so `closestBase` returns the c1 entry. The `.claude/settings.json` change is listed in `changed`. In the empty-settings test the file goes to `removed`; the assertion only checks it no longer exists.

- [ ] **Step 4: Run** — `bun test tests/unit/upgrade-legacy.test.ts --timeout 30000`, Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/upgrade/legacy.ts tests/unit/upgrade-legacy.test.ts && git commit -m "feat(upgrade): adopt a repository set up before the stamp"`

---

### Task 8: `src/upgrade/migrations.ts`, the config migration runner

**Files:**
- Create: `src/upgrade/migrations.ts`
- Test: `tests/unit/upgrade-migrations.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { CONFIG_VERSION, migrateConfig, type Migration } from "../../src/upgrade/migrations";

const V1 = "# my config\nversion: 1\nold_key: 5 # keep this comment\nother: x\n";

describe("migrateConfig", () => {
  test("no migrations: the text is unchanged", () => {
    expect(migrateConfig(V1, [], () => {})).toEqual({ text: V1, from: 1, to: 1 });
    expect(CONFIG_VERSION).toBe(1);
  });

  test("runs each step from the file's version, keeping comments, and sets the version", () => {
    const steps: Migration[] = [{ from: 1, run: (doc) => { doc.set("new_key", doc.get("old_key")); doc.delete("old_key"); } }];
    const r = migrateConfig(V1, steps, () => {});
    expect(r.from).toBe(1);
    expect(r.to).toBe(2);
    expect(r.text).toContain("# my config");
    expect(r.text).toContain("version: 2");
    expect(r.text).toContain("new_key: 5");
    expect(r.text).not.toContain("old_key");
  });

  test("a step that throws, or a result that does not load, names the problem and gives nothing", () => {
    const bad: Migration[] = [{ from: 1, run: () => { throw new Error("boom"); } }];
    expect(() => migrateConfig(V1, bad, () => {})).toThrow("config migration from version 1 failed: boom");
    const ok: Migration[] = [{ from: 1, run: () => {} }];
    expect(() => migrateConfig(V1, ok, () => { throw new Error("commands.test is required"); })).toThrow("commands.test is required");
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/upgrade-migrations.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement** `src/upgrade/migrations.ts`:

```ts
import { parseDocument, type Document } from "yaml";
import { ConfigError } from "../config";

/** One step: edits a config document of version `from` into version `from + 1`, keeping its comments. */
export interface Migration {
  from: number;
  run: (doc: Document) => void;
}

/**
 * Every config migration, in order. Empty until a release renames or removes a setting (a new key
 * with a default needs none: the schema fills it in). Add one per version step and bump the
 * `version` literal in src/config.ts's schema and templates/config.yaml with it.
 */
export const MIGRATIONS: readonly Migration[] = [];

/** The config version this Loopstra reads. */
export const CONFIG_VERSION = 1 + MIGRATIONS.length;

/**
 * Applies every migration from the file's version on, then checks the result with `validate` (which
 * throws a ConfigError naming the setting). Throws without returning anything when a step or the
 * check fails, so nothing half-migrated is ever written.
 */
export function migrateConfig(text: string, migrations: readonly Migration[] = MIGRATIONS, validate: (text: string) => void): { text: string; from: number; to: number } {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(`loopstra/config.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  const from = Number(doc.get("version") ?? 1);
  let version = from;
  for (const m of migrations.filter((m) => m.from >= from).sort((a, b) => a.from - b.from)) {
    if (m.from !== version) continue;
    try { m.run(doc); } catch (e) { throw new ConfigError(`config migration from version ${m.from} failed: ${(e as Error).message}`); }
    version = m.from + 1;
    doc.set("version", version);
  }
  const out = version === from ? text : doc.toString();
  validate(out);
  return { text: out, from, to: version };
}
```

Check that `ConfigError` is exported from `src/config.ts` (it is imported by `src/setup/document.ts`, so it is). `validate` in production is a function that parses and runs `validateConfig` (see Task 10).

- [ ] **Step 4: Run** — `bun test tests/unit/upgrade-migrations.test.ts --timeout 30000`, Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/upgrade/migrations.ts tests/unit/upgrade-migrations.test.ts && git commit -m "feat(upgrade): the config migration runner"`

---

### Task 9: `init` writes the new layout

**Files:**
- Modify: `src/init.ts`
- Modify: `src/setup/offer.ts:19` (the list of files to commit)
- Test: `tests/unit/init.test.ts`, `tests/integration/scheduler.test.ts` (preflight refusal text)

- [ ] **Step 1: Update the tests first**

In `tests/unit/init.test.ts`:
- The first test ("stamps a bun repo ... and merges settings.json"): it should now expect **no** `loopstra/prompts/` folder, **no** `.claude/hooks/` folder, **no** `.claude/settings.json` written by init, and a `loopstra/stamp.json` whose `files` has exactly `.claude/skills/loopstra/SKILL.md`, `intent/README.md`, `REVIEW.md`, each `{ base: textSha(<shipped text>) }`, and whose `loopstra` matches `/^0\.0\.0-dev/`. Rename it "stamps a bun repo with detected commands, the managed files and their stamp".
- Add:

```ts
  test("a kept managed file gets the base of the shipped version it matches", async () => {
    const repo = await tempGitRepo();
    try {
      writeFileSync(join(repo.path, "REVIEW.md"), "our own review rules\n");
      await init(repo.path);
      const stamp = readStamp(repo.path)!;
      // Not a shipped text: recorded against today's shipped text, so later upgrades merge nothing into it.
      expect(stamp.files["REVIEW.md"]).toEqual({ base: textSha(readFileSync(templatePath("REVIEW.md"), "utf8")) });
    } finally { repo.cleanup(); }
  });

  test("an existing stamp is kept", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      writeStamp(repo.path, { loopstra: "0.3.0", files: {} });
      const r = await init(repo.path);
      expect(readStamp(repo.path)).toEqual({ loopstra: "0.3.0", files: {} });
      expect(r.kept).toContain("loopstra/stamp.json");
    } finally { repo.cleanup(); }
  });

  test("uncommittedSetup asks for the config, the stamp and overrides only", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      expect(await uncommittedSetup(repo.path, "main")).toEqual(["loopstra/config.yaml", "loopstra/stamp.json"]);
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "mine");
      expect(await uncommittedSetup(repo.path, "main")).toContain("loopstra/prompts/");
    } finally { repo.cleanup(); }
  });
```

(Check `tempGitRepo` makes branch `main`; imports: `readStamp`, `writeStamp`, `textSha` from `../../src/stamp`, `templatePath` from `../../src/package`, `uncommittedSetup` from `../../src/init`.)

- The idempotence test: drop any assertion about prompts or settings.json.

- [ ] **Step 2: Run to see failures** — `bun test tests/unit/init.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement in `src/init.ts`**

- Delete the prompts loop, the `HOOK_FILE` stamp line, `mergeSettings` and its call, `HOOK_FILE`, `HOOK_MARK`, `HOOK_COMMAND`. Search the repo for other users of `HOOK_FILE`/`HOOK_MARK` (`grep -rn "HOOK_FILE\|HOOK_MARK" src tests`) and point them at `OLD_HOOK_FILE`/`OLD_HOOK_MARK` in `src/upgrade/legacy.ts` or remove them.
- Replace the template reads with `templatePath` from `./package` (delete the local `TEMPLATES` constant): `const template = (...parts: string[]) => Bun.file(templatePath(...parts)).text();`
- After the `REVIEW.md` and skill stamps, write the stamp:

```ts
  await writeInitialStamp(root, report);
```

and add:

```ts
/**
 * Records where each managed file came from, when the repository has no stamp yet: a file init
 * wrote, or one that is a shipped text, gets that text's sha; a file of the repository's own gets
 * today's shipped sha, so upgrade merges nothing into it until the shipped text changes again.
 */
async function writeInitialStamp(root: string, report: InitReport): Promise<void> {
  if (readStamp(root)) { report.kept.push(STAMP_FILE); return; }
  const files: Stamp["files"] = {};
  for (const f of managedFiles(root)) {
    const path = join(root, f.path);
    if (!existsSync(path)) continue;
    const shipped = textSha(await Bun.file(f.shipped).text());
    files[f.path] = { base: shipped };
  }
  writeStamp(root, { loopstra: await stampVersion(), files });
  report.written.push(STAMP_FILE);
}
```

(A kept file that matches an older shipped text gets today's sha too; `upgrade` adopts it properly with the index. Keeping init free of the shipped index keeps it fast and offline.)

- Change the next-step text: `Commit the files init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore)` stays as is (still true).
- Rewrite `uncommittedSetup`:

```ts
/**
 * Loopstra's own files that must be committed on `main` for the loop's checkouts (worktrees) to see
 * them: the config, the stamp, and any prompt override. Returns the ones missing from main, the
 * prompts folder as one entry.
 */
export async function uncommittedSetup(root: string, main: string): Promise<string[]> {
  const dir = join(root, "loopstra", "prompts");
  const overrides = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => `loopstra/prompts/${n}`) : [];
  const wanted = ["loopstra/config.yaml", STAMP_FILE, ...overrides];
  const r = await new Git(root).run(["ls-tree", "-r", "--name-only", main, "--", ...wanted], true);
  const onMain = new Set(r.code === 0 ? r.out.split(/\r?\n/).map((l) => l.trim()) : []);
  const missing = wanted.filter((p) => !onMain.has(p) && existsSync(join(root, p)));
  return [...new Set(missing.map((p) => (p.startsWith("loopstra/prompts/") ? "loopstra/prompts/" : p)))];
}
```

- Update `README`-facing strings only in Task 16.

- [ ] **Step 4: Fix the integration tests**

Run: `bun test tests/integration/scheduler.test.ts tests/integration/loop.test.ts tests/unit/setup-offer.test.ts --timeout 60000`
A test that commits init's output and expects the hook files, or asserts the old uncommitted list (`.claude/settings.json`, the hook), is updated to the new list (config, stamp, overrides). Tests that copy `TEMPLATES` into `loopstra/prompts` keep working (they are overrides). A test that `git add`s a fixed list including `loopstra/prompts` must not fail when the folder is missing: `commitPaths` skips missing paths, but a raw `git add` does not — guard with `existsSync`.

- [ ] **Step 5: Run** — `bun test tests/unit/init.test.ts tests/integration/scheduler.test.ts tests/unit/setup-offer.test.ts --timeout 60000 && bun run typecheck`, Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A src tests && git commit -m "feat(upgrade): init writes the stamp and no prompts, hook or settings"`

---

### Task 10: `src/upgrade/repo.ts`, the repository step

**Files:**
- Create: `src/upgrade/repo.ts`
- Test: `tests/unit/upgrade-repo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../src/init";
import { writeHeartbeat } from "../../src/heartbeat";
import { readStamp, textSha, writeStamp } from "../../src/stamp";
import { templatePath } from "../../src/package";
import { upgradeRepo } from "../../src/upgrade/repo";
import type { ShippedIndex } from "../../src/shipped";
import { run, tempGitRepo } from "../helpers";

const OLD_SKILL = "old skill text\n";

async function setUpRepo() {
  const repo = await tempGitRepo();
  await init(repo.path);
  writeFileSync(join(repo.path, "loopstra", "config.yaml"), readFileSync(join(repo.path, "loopstra", "config.yaml"), "utf8").replace('test: ""', 'test: "bun test"'));
  await run(["git", "add", "-A"], repo.path);
  await run(["git", "commit", "-q", "-m", "set up"], repo.path);
  return repo;
}

const deps = (index: ShippedIndex = {}, texts: Record<string, string> = {}, version = "0.9.0") => ({
  index: async () => index,
  fetchText: async (_t: string, commit: string) => texts[commit] ?? null,
  version: async () => version,
  notes: async () => "- feat: something new",
});

describe("upgradeRepo", () => {
  test("a repository already up to date: nothing to commit", async () => {
    const repo = await setUpRepo();
    try {
      const r = await upgradeRepo(repo.path, { check: false }, deps({}, {}, readStamp(repo.path)!.loopstra));
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(false);
      expect(readStamp(repo.path)!.loopstra).toMatch(/^0\.0\.0-dev/);
    } finally { repo.cleanup(); }
  });

  test("an unedited managed file is replaced and committed as Loopstra, with the versions and notes", async () => {
    const repo = await setUpRepo();
    try {
      const skill = join(repo.path, ".claude", "skills", "loopstra", "SKILL.md");
      writeFileSync(skill, OLD_SKILL);
      writeStamp(repo.path, { loopstra: "0.8.0", files: { ...readStamp(repo.path)!.files, ".claude/skills/loopstra/SKILL.md": { base: textSha(OLD_SKILL) } } });
      await run(["git", "commit", "-qam", "older"], repo.path);
      const r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(true);
      expect(r.committed).toBe(true);
      expect(readFileSync(skill, "utf8")).toBe(readFileSync(templatePath("skill", "SKILL.md"), "utf8"));
      const log = (await run(["git", "log", "-1", "--format=%an%n%B"], repo.path)).out;
      expect(log).toContain("Loopstra");
      expect(log).toContain("loopstra: upgrade to 0.9.0 (from 0.8.0)");
      expect(log).toContain("- feat: something new");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally { repo.cleanup(); }
  });

  test("--check reports and writes nothing", async () => {
    const repo = await setUpRepo();
    try {
      const skill = join(repo.path, ".claude", "skills", "loopstra", "SKILL.md");
      writeFileSync(skill, OLD_SKILL);
      writeStamp(repo.path, { loopstra: "0.8.0", files: { ".claude/skills/loopstra/SKILL.md": { base: textSha(OLD_SKILL) } } });
      await run(["git", "commit", "-qam", "older"], repo.path);
      const r = await upgradeRepo(repo.path, { check: true }, deps());
      expect(r.files.find((f) => f.path === ".claude/skills/loopstra/SKILL.md")!.outcome).toBe("replaced");
      expect(readFileSync(skill, "utf8")).toBe(OLD_SKILL);
      expect(r.committed).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a conflicted file is listed and left out of the commit", async () => {
    const repo = await setUpRepo();
    try {
      const review = join(repo.path, "REVIEW.md");
      const shipped = readFileSync(templatePath("REVIEW.md"), "utf8");
      const firstLine = shipped.split("\n")[0]!;
      const base = shipped.replace(firstLine, "# Base title");
      writeFileSync(review, shipped.replace(firstLine, "# Our title"));
      writeStamp(repo.path, { loopstra: "0.8.0", files: { "REVIEW.md": { base: textSha(base) } } });
      await run(["git", "commit", "-qam", "older"], repo.path);
      const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: textSha(base), commit: "b1" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index, { b1: base }));
      expect(r.files.find((f) => f.path === "REVIEW.md")!.outcome).toBe("conflict");
      expect(readFileSync(review, "utf8")).toContain("<<<<<<<");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out).toContain("REVIEW.md");
    } finally { repo.cleanup(); }
  });

  test("refuses off main, with uncommitted managed files, or with the loop running", async () => {
    const repo = await setUpRepo();
    try {
      writeFileSync(join(repo.path, "REVIEW.md"), "edited, not committed\n");
      let r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.ok).toBe(false);
      expect(r.refusal).toContain("REVIEW.md");
      await run(["git", "checkout", "-q", "REVIEW.md"], repo.path);

      writeHeartbeat(repo.path, { pid: process.pid, startedAt: new Date().toISOString(), lastTickAt: null, lastBeatAt: new Date().toISOString(), current: null, stopping: false, stopped: false });
      r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toBe("The loop is running. Stop it (Ctrl-C in its terminal), run loopstra upgrade, then start it again.");
      writeHeartbeat(repo.path, { pid: process.pid, startedAt: new Date().toISOString(), lastTickAt: null, lastBeatAt: new Date().toISOString(), current: null, stopping: false, stopped: true });

      await run(["git", "checkout", "-q", "-b", "other"], repo.path);
      r = await upgradeRepo(repo.path, { check: false }, deps());
      expect(r.refusal).toContain("main");
    } finally { repo.cleanup(); }
  });

  test("a repository with no stamp is adopted: unedited prompt copies go", async () => {
    const repo = await setUpRepo();
    try {
      const promptText = readFileSync(templatePath("prompts", "review.md"), "utf8");
      const { mkdirSync, rmSync } = await import("node:fs");
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), promptText);
      rmSync(join(repo.path, "loopstra", "stamp.json"));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "legacy"], repo.path);
      const index: ShippedIndex = { "templates/prompts/review.md": [{ sha: textSha(promptText), commit: "c" }] };
      const r = await upgradeRepo(repo.path, { check: false }, deps(index));
      expect(r.ok).toBe(true);
      expect(existsSync(join(repo.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(r.removed).toContain("loopstra/prompts/review.md");
      expect(readStamp(repo.path)).not.toBeNull();
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally { repo.cleanup(); }
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/upgrade-repo.test.ts --timeout 60000`, Expected: FAIL.

- [ ] **Step 3: Implement** `src/upgrade/repo.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { configPath, loadConfig, validateConfig } from "../config";
import { Git } from "../git";
import { heartbeatState, readHeartbeat } from "../heartbeat";
import { onCheckout } from "../lanes";
import { stampVersion } from "../package";
import { closestBase, fetchShipped, loadShippedIndex, type FetchText, type ShippedIndex } from "../shipped";
import { managedFiles, readStamp, STAMP_FILE, textSha, writeStamp, type Stamp } from "../stamp";
import { writeFileAtomic } from "../fsutil";
import { upgradeFile, type FileResult } from "./files";
import { adoptLegacy } from "./legacy";
import { migrateConfig } from "./migrations";

export const LOOP_RUNNING = "The loop is running. Stop it (Ctrl-C in its terminal), run loopstra upgrade, then start it again.";

/** What the repository step needs from outside, injectable for tests. */
export interface RepoDeps {
  index: () => Promise<ShippedIndex>;
  fetchText: FetchText;
  /** The version being upgraded to (the stamp's new `loopstra`). */
  version: () => Promise<string>;
  /** Release notes between two versions, as Markdown lines; "" when there are none or they cannot be read. */
  notes: (from: string, to: string) => Promise<string>;
}

export const REAL_DEPS: RepoDeps = { index: loadShippedIndex, fetchText: fetchShipped, version: stampVersion, notes: async () => "" };

export interface RepoResult {
  ok: boolean;
  /** Why nothing was done, in plain words. */
  refusal?: string;
  from: string | null;
  to: string;
  files: FileResult[];
  /** Files deleted (unedited prompt copies, the old hook). */
  removed: string[];
  /** Other files changed (the config, .claude/settings.json). */
  changed: string[];
  notes: string[];
  committed: boolean;
}

/**
 * Brings the repository at `root` up to the installed Loopstra (spec: "loopstra upgrade", steps 2-6).
 * `check`: say what would happen and write nothing.
 */
export async function upgradeRepo(root: string, opts: { check: boolean }, deps: RepoDeps = REAL_DEPS): Promise<RepoResult> {
  const to = await deps.version();
  const stamp = readStamp(root);
  const result: RepoResult = { ok: false, from: stamp?.loopstra ?? null, to, files: [], removed: [], changed: [], notes: [], committed: false };
  const refuse = (refusal: string): RepoResult => ({ ...result, refusal });

  if (!existsSync(configPath(root))) return refuse("This folder is not set up for Loopstra. Run loopstra init first.");
  const cfg = await loadConfig(root).catch(() => null);
  const main = cfg?.main_branch ?? "main";
  const git = new Git(root);
  const branch = await git.currentBranch();
  if (branch !== main) return refuse(`The checkout is on ${branch || "no branch"}, not ${main}. Switch to ${main}, then run loopstra upgrade again.`);
  const hb = heartbeatState(readHeartbeat(root), cfg?.poll_seconds ?? 60);
  if (hb.state === "running" || hb.state === "paused") return refuse(LOOP_RUNNING);
  const index = await deps.index();
  const files = managedFiles(root, stamp);
  const watched = [...new Set(["loopstra/config.yaml", STAMP_FILE, ".claude/settings.json", ...files.map((f) => f.path)])];
  const dirty = (await git.run(["status", "--porcelain", "--", ...watched])).out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) return refuse(`These files have changes that are not committed: ${dirty.join(", ")}. Commit or undo them, then run loopstra upgrade again.`);

  const write = !opts.check;
  let base: Stamp = stamp ?? { loopstra: "", files: {} };
  if (!stamp) {
    const adopted = await adoptLegacy(root, index, deps.fetchText, { write });
    base = adopted.stamp;
    result.removed.push(...adopted.removed);
    result.changed.push(...adopted.changed);
    result.notes.push(...adopted.notes);
  }
  // A managed file with no stamp entry (an override made by hand): its base is the closest shipped version, else today's text.
  for (const f of managedFiles(root, base)) {
    const path = join(root, f.path);
    if (base.files[f.path] || result.removed.includes(f.path) || !existsSync(path)) continue;
    const best = await closestBase(index, f.template, readFileSync(path, "utf8"), deps.fetchText);
    base.files[f.path] = { base: best ? best.sha : textSha(readFileSync(f.shipped, "utf8")) };
  }
  const baseFor = (template: string) => async (sha: string) => {
    const entry = (index[template] ?? []).find((e) => e.sha === sha);
    return entry ? deps.fetchText(template, entry.commit) : null;
  };
  const next: Stamp = { loopstra: to, files: {} };
  for (const f of managedFiles(root, base)) {
    if (result.removed.includes(f.path)) continue;
    const r = await upgradeFile(root, f, base.files[f.path], baseFor(f.template), { write });
    result.files.push(r);
    next.files[f.path] = r.entry;
  }

  const cfgText = readFileSync(configPath(root), "utf8");
  let migrated: { text: string; from: number; to: number };
  try {
    migrated = migrateConfig(cfgText, undefined, (t) => { validateConfig(parse(t)); });
  } catch (e) {
    return refuse(`The config could not be brought up to date, so nothing was changed: ${(e as Error).message}`);
  }
  if (migrated.text !== cfgText) {
    result.changed.push("loopstra/config.yaml");
    if (write) writeFileAtomic(configPath(root), migrated.text);
  }
  if (write) writeStamp(root, next);
  result.ok = true;
  if (!write) return result;

  const conflicted = new Set(result.files.filter((f) => f.outcome === "conflict").map((f) => f.path));
  const paths = [...new Set([STAMP_FILE, ...watched, ...result.removed, ...result.changed, ...result.files.map((f) => f.path)])].filter((p) => !conflicted.has(p));
  // Notes only between two releases: a first upgrade, or one from a development checkout, would list every release.
  const notes = result.from && !result.from.startsWith("0.0.0-dev") ? await deps.notes(result.from, to) : "";
  const message = [`loopstra: upgrade to ${to}${result.from ? ` (from ${result.from})` : ""}`, ...(notes ? ["", notes] : [])].join("\n");
  result.committed = await onCheckout(root, async () => {
    // git add -A on a deleted path stages its removal; commitPaths skips paths that never existed.
    await git.run(["add", "-A", "--", ...paths.filter((p) => existsSync(join(root, p)) || result.removed.includes(p))], true);
    const staged = (await git.run(["diff", "--cached", "--name-only"])).out.trim();
    if (!staged) return false;
    await git.runtime("commit", ["-q", "-m", message]);
    return true;
  });
  return result;
}
```

Check before relying on them: `validateConfig` signature in `src/config.ts` (it takes parsed data and throws `ConfigError`; adjust the call if it returns errors instead), and that `heartbeatState`'s "paused" includes the person's hold (it does only when `hold` is passed; a loop process that is paused by its own back-off still has `state: "paused"`). Use `git.run(["add", ...])` directly, not `commitPaths`, because removals of deleted files must be staged.

Note: `git add -A -- <path>` errors for a pathspec that matches nothing in the index or tree. Filter `paths` to those that exist on disk or in `HEAD` (`git ls-files --error-unmatch` per path is slow; instead pass `--ignore-missing`? It only works with `--dry-run`). Simplest robust choice: run `git add -A -- <each path>` one by one with `allowFail: true`. Replace the single add with:

```ts
    for (const p of paths) await git.run(["add", "-A", "--", p], true);
```

- [ ] **Step 4: Run** — `bun test tests/unit/upgrade-repo.test.ts --timeout 60000`, Expected: PASS. Fix the implementation, not the tests, unless a test contradicts the spec.
- [ ] **Step 5: Commit** — `git add src/upgrade/repo.ts tests/unit/upgrade-repo.test.ts && git commit -m "feat(upgrade): the repository step: files, config, stamp, one commit"`

---

### Task 11: `src/upgrade/tool.ts`, the registry, install and notice

**Files:**
- Create: `src/upgrade/tool.ts`
- Test: `tests/unit/upgrade-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compareVersions, latestVersion, releaseNotes, updateNotice } from "../../src/upgrade/tool";
import { tempDir } from "../helpers";

function serve(routes: Record<string, unknown>) {
  const server = Bun.serve({ port: 0, fetch: (req) => {
    const path = new URL(req.url).pathname;
    return path in routes ? Response.json(routes[path]) : new Response("no", { status: 404 });
  } });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

describe("versions", () => {
  test("compareVersions", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.0.0-dev+abc", "0.0.1")).toBeLessThan(0);
  });

  test("latestVersion reads the registry; null when it cannot", async () => {
    const s = serve({ "/loopstra/latest": { version: "0.4.2" } });
    try {
      expect(await latestVersion(s.url)).toBe("0.4.2");
      expect(await latestVersion(`${s.url}/nothing`)).toBeNull();
    } finally { s.stop(); }
  });

  test("releaseNotes collects the releases after `from` up to `to`, newest first", async () => {
    const s = serve({ "/repos/jflavan/loopstra/releases": [
      { tag_name: "v0.5.0", body: "- feat: c" }, { tag_name: "v0.4.1", body: "- fix: b" }, { tag_name: "v0.4.0", body: "- feat: a" },
    ] });
    try {
      expect(await releaseNotes("0.4.0", "0.5.0", s.url)).toBe("## 0.5.0\n- feat: c\n\n## 0.4.1\n- fix: b");
      expect(await releaseNotes("0.4.0", "0.5.0", "http://localhost:1")).toBe("");
    } finally { s.stop(); }
  });

  test("the notice is cached for a day and silent in a development checkout", async () => {
    const t = tempDir();
    const s = serve({ "/loopstra/latest": { version: "0.9.0" } });
    try {
      expect(await updateNotice(t.path, { installed: "0.0.0-dev", registry: s.url })).toBeNull();
      expect(await updateNotice(t.path, { installed: "0.4.0", registry: s.url })).toBe("Loopstra 0.9.0 is out (you have 0.4.0): run loopstra upgrade.");
      s.stop();
      // Cached: the stopped server is not asked again.
      expect(await updateNotice(t.path, { installed: "0.4.0", registry: s.url })).toBe("Loopstra 0.9.0 is out (you have 0.4.0): run loopstra upgrade.");
      expect(await updateNotice(t.path, { installed: "0.9.0", registry: s.url, stamp: "0.8.0" })).toBe("This repository is on Loopstra 0.8.0 and 0.9.0 is installed: run loopstra upgrade.");
    } finally { s.stop(); t.cleanup(); }
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/upgrade-tool.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement** `src/upgrade/tool.ts`:

```ts
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../fsutil";

/** Where versions and release notes are read. The environment overrides are for tests only. */
export const REGISTRY = process.env.LOOPSTRA_REGISTRY_URL ?? "https://registry.npmjs.org";
export const GITHUB_API = process.env.LOOPSTRA_GITHUB_API ?? "https://api.github.com";

/** Compares x.y.z versions (anything after - or + is ignored, and sorts before the plain version). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => { const [core, extra] = v.split(/[-+](.*)/s); return { n: core!.split(".").map((p) => Number(p) || 0), pre: extra !== undefined }; };
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

/** The newest published version of the package, or null when the registry cannot be reached. */
export async function latestVersion(registry = REGISTRY): Promise<string | null> {
  try {
    const res = await fetch(`${registry}/loopstra/latest`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The release notes of every release after `from` up to `to`, newest first, as Markdown; "" when they cannot be read. */
export async function releaseNotes(from: string, to: string, api = GITHUB_API): Promise<string> {
  try {
    const res = await fetch(`${api}/repos/jflavan/loopstra/releases?per_page=100`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return "";
    const releases = (await res.json()) as Array<{ tag_name: string; body?: string | null }>;
    return releases
      .map((r) => ({ v: r.tag_name.replace(/^v/, ""), body: (r.body ?? "").trim() }))
      .filter((r) => (!from || compareVersions(r.v, from) > 0) && compareVersions(r.v, to) <= 0)
      .sort((a, b) => compareVersions(b.v, a.v))
      .map((r) => `## ${r.v}\n${r.body}`.trimEnd())
      .join("\n\n");
  } catch {
    return "";
  }
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * One line for `start` and `status` when a newer release is out, or the repository's stamp names a
 * different version from the installed one; null otherwise. The registry is asked at most once a
 * day (cached in .loopstra/update-check.json) and never in a development checkout. Never throws.
 */
export async function updateNotice(root: string, o: { installed: string; registry?: string; stamp?: string | null; now?: number }): Promise<string | null> {
  if (o.installed.startsWith("0.0.0-dev")) return null;
  if (o.stamp && o.stamp !== o.installed) return `This repository is on Loopstra ${o.stamp} and ${o.installed} is installed: run loopstra upgrade.`;
  const now = o.now ?? Date.now();
  const cache = join(root, ".loopstra", "update-check.json");
  let latest: string | null = null;
  try {
    const c = JSON.parse(readFileSync(cache, "utf8")) as { checkedAt: number; latest: string | null };
    if (now - c.checkedAt < DAY_MS) latest = c.latest;
    else throw new Error("stale");
  } catch {
    latest = await latestVersion(o.registry);
    try {
      if (existsSync(join(root, ".loopstra")) || latest) { mkdirSync(join(root, ".loopstra"), { recursive: true }); writeFileAtomic(cache, JSON.stringify({ checkedAt: now, latest })); }
    } catch { /* the notice is a convenience */ }
  }
  return latest && compareVersions(latest, o.installed) > 0 ? `Loopstra ${latest} is out (you have ${o.installed}): run loopstra upgrade.` : null;
}

/** The command that installs a version globally. LOOPSTRA_INSTALL_COMMAND (tests only) replaces `bun add -g`; `{version}` in it is filled in. */
export function installCommand(version: string): string[] {
  const custom = process.env.LOOPSTRA_INSTALL_COMMAND;
  if (custom) return custom.replaceAll("{version}", version).split(" ");
  return ["bun", "add", "-g", `loopstra@${version}`];
}

/** The globally installed `loopstra` executable (`<bun pm bin -g>/loopstra`), or null. LOOPSTRA_INSTALLED_BIN overrides it for tests. */
export async function installedBin(): Promise<string | null> {
  if (process.env.LOOPSTRA_INSTALLED_BIN) return process.env.LOOPSTRA_INSTALLED_BIN;
  const proc = Bun.spawn({ cmd: ["bun", "pm", "bin", "-g"], stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !out.trim()) return null;
  const bin = join(out.trim(), process.platform === "win32" ? "loopstra.exe" : "loopstra");
  return existsSync(bin) ? bin : null;
}
```

- [ ] **Step 4: Run** — `bun test tests/unit/upgrade-tool.test.ts --timeout 30000`, Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/upgrade/tool.ts tests/unit/upgrade-tool.test.ts && git commit -m "feat(upgrade): versions from npm, release notes from GitHub, the update notice"`

---

### Task 12: `loopstra upgrade`, `customize`, `--version` and the notice in the CLI

**Files:**
- Create: `src/commands/upgrade.ts`, `src/commands/customize.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/upgrade-command.test.ts`, `tests/unit/customize.test.ts`, `tests/unit/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/unit/customize.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { customize } from "../../src/commands/customize";
import { init } from "../../src/init";
import { templatePath } from "../../src/package";
import { readStamp, textSha } from "../../src/stamp";
import { tempGitRepo } from "../helpers";

describe("customize", () => {
  test("copies a shipped prompt and records its base; lists prompts; refuses an unknown or existing one", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      const r = await customize(repo.path, "review");
      expect(r).toEqual({ ok: true, text: "Wrote loopstra/prompts/review.md. Edit it, commit it, and the loop uses it from then on." });
      const shipped = readFileSync(templatePath("prompts", "review.md"), "utf8");
      expect(readFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "utf8")).toBe(shipped);
      expect(readStamp(repo.path)!.files["loopstra/prompts/review.md"]).toEqual({ base: textSha(shipped) });
      expect((await customize(repo.path, "review")).ok).toBe(false);
      expect((await customize(repo.path, "nope")).text).toContain("No shipped prompt is called nope");
      const list = await customize(repo.path, undefined);
      expect(list.text).toContain("review (yours)");
      expect(list.text).toContain("plan");
    } finally { repo.cleanup(); }
  });
});
```

`tests/unit/upgrade-command.test.ts` (the tool step, with injected pieces):

```ts
import { describe, expect, test } from "bun:test";
import { upgradeCommand } from "../../src/commands/upgrade";

const quiet = { say: (_: string) => {} };

describe("upgradeCommand", () => {
  test("a development checkout skips the install and runs the repository step", async () => {
    const calls: string[] = [];
    const code = await upgradeCommand("/r", [], { ...quiet, installed: "0.0.0-dev", latest: async () => "0.5.0", install: async () => { calls.push("install"); return true; }, handOff: async () => { calls.push("handoff"); return 0; }, repoStep: async () => { calls.push("repo"); return 0; } });
    expect(code).toBe(0);
    expect(calls).toEqual(["repo"]);
  });

  test("a newer release is installed and the new version runs the repository step", async () => {
    const calls: string[] = [];
    await upgradeCommand("/r", [], { ...quiet, installed: "0.4.0", latest: async () => "0.5.0", install: async (v) => { calls.push(`install ${v}`); return true; }, handOff: async (v) => { calls.push(`handoff ${v}`); return 0; }, repoStep: async () => { calls.push("repo"); return 0; } });
    expect(calls).toEqual(["install 0.5.0", "handoff 0.5.0"]);
  });

  test("up to date, or the registry unreachable: the repository step runs with this version", async () => {
    for (const latest of ["0.4.0", null]) {
      const calls: string[] = [];
      await upgradeCommand("/r", [], { ...quiet, installed: "0.4.0", latest: async () => latest, install: async () => true, handOff: async () => 0, repoStep: async () => { calls.push("repo"); return 0; } });
      expect(calls).toEqual(["repo"]);
    }
  });

  test("--repo never installs; --check never installs", async () => {
    for (const flag of ["--repo", "--check"]) {
      const calls: string[] = [];
      await upgradeCommand("/r", [flag], { ...quiet, installed: "0.4.0", latest: async () => "0.5.0", install: async () => { calls.push("install"); return true; }, handOff: async () => 0, repoStep: async () => { calls.push("repo"); return 0; } });
      expect(calls).toEqual(["repo"]);
    }
  });
});
```

Add to `tests/unit/cli.test.ts`, following its existing pattern for running the CLI:

```ts
  test("--version prints the package version", async () => {
    const r = await run([process.execPath, CLI, "--version"], process.cwd());
    expect(r.out.trim()).toBe("0.0.0-dev");
  });
```

(`CLI` is whatever constant the file uses for `src/cli.ts`.)

- [ ] **Step 2: Run to see them fail** — `bun test tests/unit/customize.test.ts tests/unit/upgrade-command.test.ts tests/unit/cli.test.ts --timeout 30000`, Expected: FAIL.

- [ ] **Step 3: Implement**

`src/commands/customize.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "../package";
import { readStamp, textSha, writeStamp } from "../stamp";
import { stampVersion } from "../package";

/** `loopstra customize [prompt]`: copies a shipped prompt into the repository as an override, or lists the prompts. */
export async function customize(root: string, name: string | undefined): Promise<{ ok: boolean; text: string }> {
  const shippedDir = templatePath("prompts");
  const names = readdirSync(shippedDir).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).sort();
  if (!name) {
    const own = (n: string) => existsSync(join(root, "loopstra", "prompts", `${n}.md`));
    return { ok: true, text: ["Prompts (yours: the repository's override is used):", ...names.map((n) => `  ${n}${own(n) ? " (yours)" : ""}`), "", "loopstra customize <prompt> copies one into loopstra/prompts/ for you to edit."].join("\n") };
  }
  const n = name.replace(/\.md$/, "");
  if (!names.includes(n)) return { ok: false, text: `No shipped prompt is called ${n}. Run loopstra customize to list them.` };
  const rel = `loopstra/prompts/${n}.md`;
  const target = join(root, rel);
  if (existsSync(target)) return { ok: false, text: `${rel} is already yours.` };
  const text = readFileSync(join(shippedDir, `${n}.md`), "utf8");
  mkdirSync(join(root, "loopstra", "prompts"), { recursive: true });
  writeFileSync(target, text);
  const stamp = readStamp(root) ?? { loopstra: await stampVersion(), files: {} };
  stamp.files[rel] = { base: textSha(text) };
  writeStamp(root, stamp);
  return { ok: true, text: `Wrote ${rel}. Edit it, commit it, and the loop uses it from then on.` };
}
```

`src/commands/upgrade.ts`:

```ts
import { packageVersion } from "../package";
import { REAL_DEPS, upgradeRepo, type RepoResult } from "../upgrade/repo";
import { compareVersions, installCommand, installedBin, latestVersion, releaseNotes } from "../upgrade/tool";

/** The pieces of the tool step, injectable for tests. */
export interface UpgradeIo {
  say: (line: string) => void;
  installed: string;
  latest: () => Promise<string | null>;
  /** Installs a version globally; false when it failed. */
  install: (version: string) => Promise<boolean>;
  /** Runs the repository step with the newly installed version; its exit code. */
  handOff: (version: string, installed: boolean) => Promise<number>;
  /** Runs the repository step with this version; its exit code. */
  repoStep: (check: boolean) => Promise<number>;
}

async function spawnInherit(cmd: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn({ cmd, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** The real pieces. */
export function realIo(root: string): UpgradeIo {
  const say = (l: string) => console.log(l);
  return {
    say,
    installed: packageVersion(),
    latest: () => latestVersion(),
    install: async (v) => (await spawnInherit(installCommand(v), root)) === 0,
    handOff: async (v, installed) => {
      const bin = installed ? await installedBin() : null;
      if (bin) return spawnInherit([bin, "upgrade", "--repo"], root);
      say(`Running the new version without installing it. To install it: ${installCommand(v).join(" ")}`);
      return spawnInherit(["bunx", `loopstra@${v}`, "upgrade", "--repo"], root);
    },
    repoStep: (check) => runRepoStep(root, check, say),
  };
}

/** `loopstra upgrade [--repo] [--check]`. */
export async function upgradeCommand(root: string, args: string[], io: UpgradeIo): Promise<number> {
  const check = args.includes("--check");
  if (args.includes("--repo") || check) {
    if (check) {
      const latest = io.installed.startsWith("0.0.0-dev") ? null : await io.latest();
      io.say(`Installed: Loopstra ${io.installed}.${latest ? ` Latest: ${latest}.` : ""}`);
    }
    return io.repoStep(check);
  }
  if (io.installed.startsWith("0.0.0-dev")) {
    io.say("This is a development checkout of Loopstra; update it with git pull. Bringing this repository up to the checkout.");
    return io.repoStep(false);
  }
  const latest = await io.latest();
  if (latest === null) io.say("The npm registry could not be reached; bringing this repository up to the installed version.");
  if (latest === null || compareVersions(latest, io.installed) <= 0) return io.repoStep(false);
  io.say(`Installing Loopstra ${latest} (you have ${io.installed}).`);
  const installed = await io.install(latest);
  return io.handOff(latest, installed);
}

/** Runs upgradeRepo and prints its report. */
export async function runRepoStep(root: string, check: boolean, say: (l: string) => void): Promise<number> {
  const r = await upgradeRepo(root, { check }, { ...REAL_DEPS, notes: (from, to) => releaseNotes(from, to) });
  if (!r.ok) { console.error(r.refusal); return 1; }
  for (const line of report(r, check)) say(line);
  return 0;
}

const WORDS: Record<string, string> = {
  replaced: "updated", merged: "merged with your edits", conflict: "CONFLICT: has conflict markers; resolve them and commit",
  "no-base": "kept as it is (the version it came from could not be read)", added: "added", deleted: "stays deleted",
};

/** The report, one line per thing that changed. */
export function report(r: RepoResult, check: boolean): string[] {
  const would = check ? "Would " : "";
  const lines = [`${check ? "Checking" : "Upgraded"} this repository: Loopstra ${r.from ?? "(no stamp)"} → ${r.to}.`];
  for (const f of r.files) if (f.outcome !== "unchanged") lines.push(`  ${f.path}: ${WORDS[f.outcome]}`);
  for (const p of r.removed) lines.push(`  ${p}: ${would ? "would be " : ""}removed`);
  for (const p of r.changed) lines.push(`  ${p}: ${would ? "would be " : ""}updated`);
  lines.push(...r.notes.map((n) => `  ${n}`));
  if (lines.length === 1) lines.push("  Nothing to change.");
  if (!check) lines.push(r.committed ? "Committed on main; loopstra start shares it with the remote, or push it yourself." : "Nothing to commit.");
  return lines;
}
```

In `src/cli.ts`:
- Add to `HELP`:

```
  upgrade   install the latest Loopstra and bring this repo up to it, in one commit
            (--check shows what would change; --repo skips the install)
  customize [prompt]  copy a shipped prompt into loopstra/prompts/ to edit (no name: list them)
  --version print the installed version
```

- Add cases:

```ts
    case "--version": case "-v": case "version": {
      const { packageVersion } = await import("./package");
      console.log(packageVersion()); return 0;
    }
    case "upgrade": {
      if (!setUp()) return 1;
      const { realIo, upgradeCommand } = await import("./commands/upgrade");
      return upgradeCommand(root, rest, realIo(root));
    }
    case "customize": {
      if (!setUp()) return 1;
      const { customize } = await import("./commands/customize");
      const r = await customize(root, rest[0]);
      (r.ok ? console.log : console.error)(r.text);
      return r.ok ? 0 : 1;
    }
```

- Add the notice to `start` (before `start(root, ...)`) and `status` (after its output):

```ts
async function notice(): Promise<void> {
  try {
    const { packageVersion } = await import("./package");
    const { readStamp } = await import("./stamp");
    const { updateNotice } = await import("./upgrade/tool");
    const line = await updateNotice(root, { installed: packageVersion(), stamp: readStamp(root)?.loopstra ?? null });
    if (line) console.log(line);
  } catch { /* never in the way */ }
}
```

`updateNotice`'s stamp comparison must ignore a dev stamp (`0.0.0-dev+...`) on the repository side too: a repo stamped by a checkout and now run by a release should say to upgrade (it does: the versions differ). Fine as written.

- [ ] **Step 4: Run** — `bun test tests/unit/customize.test.ts tests/unit/upgrade-command.test.ts tests/unit/cli.test.ts --timeout 30000 && bun run typecheck`, Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A src tests && git commit -m "feat(upgrade): loopstra upgrade, customize and --version"`

---

### Task 13: The release scripts and workflow

**Files:**
- Create: `scripts/release.ts`, `.github/workflows/release.yml`
- Test: `tests/unit/release.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { nextVersion, shipsChanges } from "../../scripts/release";

describe("release", () => {
  test("next version: patch by default, minor for a breaking change, 0.1.0 first", () => {
    expect(nextVersion(null, [])).toBe("0.1.0");
    expect(nextVersion("0.4.2", [{ subject: "fix(x): y", body: "" }])).toBe("0.4.3");
    expect(nextVersion("0.4.2", [{ subject: "feat(x)!: y", body: "" }])).toBe("0.5.0");
    expect(nextVersion("0.4.2", [{ subject: "feat: y", body: "BREAKING CHANGE: z" }])).toBe("0.5.0");
    expect(nextVersion("0.4.2", [], "minor")).toBe("0.5.0");
    expect(nextVersion("0.4.2", [{ subject: "feat!: y", body: "" }], "patch")).toBe("0.4.3");
  });

  test("ships only when src/, templates/ or package.json changed", () => {
    expect(shipsChanges(["docs/a.md", "README.md"])).toBe(false);
    expect(shipsChanges(["src/cli.ts"])).toBe(true);
    expect(shipsChanges(["templates/REVIEW.md"])).toBe(true);
    expect(shipsChanges(["package.json"])).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `bun test tests/unit/release.test.ts --timeout 30000`.

- [ ] **Step 3: Implement** `scripts/release.ts`:

```ts
#!/usr/bin/env bun
// The release workflow's decisions: whether to release, and the next version.
// `bun scripts/release.ts plan [patch|minor]` prints `version=<v>` and `ship=<true|false>` lines for $GITHUB_OUTPUT.

export interface Commit { subject: string; body: string }

/** The next version after `last` (null: no release yet): minor for a breaking change (we are on 0.x), else patch. `bump` forces one. */
export function nextVersion(last: string | null, commits: Commit[], bump?: "patch" | "minor"): string {
  if (!last) return "0.1.0";
  const [major, minor, patch] = last.split(".").map(Number) as [number, number, number];
  const breaking = commits.some((c) => /^[a-z]+(\([^)]*\))?!:/.test(c.subject) || /BREAKING CHANGE/.test(c.body));
  const kind = bump ?? (breaking ? "minor" : "patch");
  return kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** Whether a set of changed paths changes what the package ships. */
export function shipsChanges(paths: string[]): boolean {
  return paths.some((p) => p.startsWith("src/") || p.startsWith("templates/") || p === "package.json");
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out;
}

if (import.meta.main && process.argv[2] === "plan") {
  const bump = process.argv[3] as "patch" | "minor" | undefined;
  const tags = (await git(["tag", "--list", "v*", "--sort=-v:refname"])).split("\n").filter(Boolean);
  const last = tags[0]?.slice(1) ?? null;
  const range = last ? [`v${last}..HEAD`] : ["HEAD"];
  const log = await git(["log", "--format=%s%x1f%b%x1e", ...range]);
  const commits = log.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => { const [subject, body = ""] = c.split("\x1f"); return { subject: subject!, body }; });
  const changed = last ? (await git(["diff", "--name-only", `v${last}..HEAD`])).split("\n").filter(Boolean) : ["src/"];
  const ship = Boolean(bump) || shipsChanges(changed);
  console.log(`version=${nextVersion(last, commits, bump)}`);
  console.log(`ship=${ship}`);
  console.log(`previous=${last ?? ""}`);
}
```

`.github/workflows/release.yml`:

```yaml
name: release

on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      bump:
        description: "Force a patch or minor release"
        required: false
        type: choice
        options: ["", patch, minor]

permissions:
  contents: write
  id-token: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    if: github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm install -g npm@latest
      - run: bun install --frozen-lockfile
      - id: plan
        run: bun scripts/release.ts plan ${{ inputs.bump }} >> "$GITHUB_OUTPUT"
      - if: steps.plan.outputs.ship == 'true'
        run: npm version ${{ steps.plan.outputs.version }} --no-git-tag-version
      - if: steps.plan.outputs.ship == 'true'
        run: bun scripts/shipped.ts shipped.json
      - if: steps.plan.outputs.ship == 'true'
        run: npm publish --provenance --access public
      - if: steps.plan.outputs.ship == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          PREVIOUS: ${{ steps.plan.outputs.previous }}
          VERSION: ${{ steps.plan.outputs.version }}
        run: |
          git tag "v$VERSION"
          git push origin "v$VERSION"
          if [ -n "$PREVIOUS" ]; then range="v$PREVIOUS..v$VERSION"; else range="v$VERSION"; fi
          git log --format='- %s' "$range" --no-merges > notes.md
          gh release create "v$VERSION" --title "v$VERSION" --notes-file notes.md
```

- [ ] **Step 4: Run** — `bun test tests/unit/release.test.ts --timeout 30000`, Expected: PASS. Also run `bun scripts/release.ts plan` in the worktree and check it prints `version=0.1.0`, `ship=true`.
- [ ] **Step 5: Commit** — `git add scripts/release.ts .github/workflows/release.yml tests/unit/release.test.ts && git commit -m "feat(release): publish every green merge to main to npm"`

---

### Task 14: `package.json` for publishing

**Files:**
- Modify: `package.json`, `.gitignore`

- [ ] **Step 1: Edit `package.json`** to:

```json
{
  "name": "loopstra",
  "version": "0.0.0-dev",
  "description": "Unattended, Claude Code based SDLC loop. Code owns the loop; agents own bounded phases.",
  "type": "module",
  "license": "UNLICENSED",
  "repository": { "type": "git", "url": "git+https://github.com/jflavan/loopstra.git" },
  "homepage": "https://github.com/jflavan/loopstra#readme",
  "bin": { "loopstra": "./src/cli.ts" },
  "files": ["src/", "templates/", "shipped.json", "README.md"],
  "engines": { "bun": ">=1.4.2" },
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": { ...unchanged... },
  "dependencies": { ...unchanged... },
  "devDependencies": { ...unchanged... }
}
```

Check whether the repository has a LICENSE file (`ls LICENSE*`). If it has one, set `license` to its SPDX id; if not, keep `"UNLICENSED"` and record in `docs/decisions.md` (Task 16) that the user should choose a license before the first publish.

- [ ] **Step 2: Ignore the generated index**: add `shipped.json` to `.gitignore`.
- [ ] **Step 3: Check the packed contents**: `bun pm pack --dry-run` (or `npm pack --dry-run`) lists only `src/`, `templates/`, `README.md`, `package.json`. No `tests/`, `docs/`, `node_modules/`.
- [ ] **Step 4: Commit** — `git add package.json .gitignore && git commit -m "feat(release): the package's files and publishing settings"`

---

### Task 15: End-to-end test of the packed package

**Files:**
- Create: `tests/integration/upgrade-e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, tempDir, tempGitRepo } from "../helpers";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Packs the checkout as version `v` (in a copy, so package.json is untouched) with a shipped.json; returns the tarball. */
async function pack(dir: string, v: string): Promise<string> {
  const copy = join(dir, `pkg-${v}`);
  for (const p of ["src", "templates", "README.md", "package.json", "bun.lock"]) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  pkg.version = v;
  writeFileSync(join(copy, "package.json"), JSON.stringify(pkg, null, 2));
  expect((await run([process.execPath, join(ROOT, "scripts", "shipped.ts"), join(copy, "shipped.json")], ROOT)).code).toBe(0);
  const r = await run([process.execPath, "pm", "pack", "--destination", dir], copy);
  expect(r.code).toBe(0);
  return join(dir, `loopstra-${v}.tgz`);
}

describe("upgrade end to end", () => {
  test("a repository set up the old way is upgraded by the packed package in one commit", async () => {
    const work = tempDir("loopstra-e2e-");
    const repo = await tempGitRepo();
    try {
      const tgz = await pack(work.path, "0.9.0");
      const bunHome = join(work.path, "bun");
      const env = { ...process.env, BUN_INSTALL: bunHome };
      const add = Bun.spawnSync({ cmd: [process.execPath, "add", "-g", tgz], env, stdout: "pipe", stderr: "pipe" });
      expect(add.exitCode).toBe(0);
      const bin = join(bunHome, "bin", process.platform === "win32" ? "loopstra.exe" : "loopstra");
      expect(existsSync(bin)).toBe(true);

      // The old layout: every prompt copied, the hook and its settings entry.
      mkdirSync(join(repo.path, "loopstra"), { recursive: true });
      cpSync(join(ROOT, "templates", "prompts"), join(repo.path, "loopstra", "prompts"), { recursive: true });
      cpSync(join(ROOT, "templates", "config.yaml"), join(repo.path, "loopstra", "config.yaml"));
      writeFileSync(join(repo.path, "loopstra", "config.yaml"), readFileSync(join(repo.path, "loopstra", "config.yaml"), "utf8").replace("__MAIN_BRANCH__", "main").replace("__COMMANDS__", '  test: "bun test"'));
      mkdirSync(join(repo.path, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(repo.path, ".claude", "hooks", "loopstra-protect-tests.ts"), "// old hook\n");
      writeFileSync(join(repo.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/loopstra-protect-tests.ts"' }] }] } }));
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-qm", "old layout"], repo.path);

      const up = Bun.spawnSync({ cmd: [bin, "upgrade", "--repo"], cwd: repo.path, env, stdout: "pipe", stderr: "pipe" });
      expect(up.stderr.toString()).toBe("");
      expect(up.exitCode).toBe(0);
      expect(existsSync(join(repo.path, "loopstra", "prompts"))).toBe(false);
      expect(existsSync(join(repo.path, ".claude", "hooks", "loopstra-protect-tests.ts"))).toBe(false);
      expect(existsSync(join(repo.path, ".claude", "settings.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(repo.path, "loopstra", "stamp.json"), "utf8")).loopstra).toBe("0.9.0");
      expect((await run(["git", "log", "-1", "--format=%s"], repo.path)).out.trim()).toBe("loopstra: upgrade to 0.9.0");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");

      // The packed version reports itself, and the tool step installs a newer one from a fake registry.
      const v = Bun.spawnSync({ cmd: [bin, "--version"], env, stdout: "pipe" });
      expect(v.stdout.toString().trim()).toBe("0.9.0");
      const newer = await pack(work.path, "0.9.1");
      const server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/loopstra/latest" ? Response.json({ version: "0.9.1" }) : new Response("[]")) });
      try {
        const env2 = { ...env, LOOPSTRA_REGISTRY_URL: `http://localhost:${server.port}`, LOOPSTRA_GITHUB_API: `http://localhost:${server.port}`, LOOPSTRA_INSTALL_COMMAND: `${process.execPath} add -g ${newer.replace(/\\/g, "/")}` };
        const up2 = Bun.spawnSync({ cmd: [bin, "upgrade"], cwd: repo.path, env: env2, stdout: "pipe", stderr: "pipe" });
        expect(up2.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(join(repo.path, "loopstra", "stamp.json"), "utf8")).loopstra).toBe("0.9.1");
      } finally { server.stop(true); }
    } finally { repo.cleanup(); work.cleanup(); }
  }, 240_000);
});
```

Notes for the implementer:
- `LOOPSTRA_INSTALL_COMMAND` is split on spaces; temp paths on Windows CI have no spaces (`C:\Users\RUNNER~1\...`), and the user's `flava` path has none. If a space ever appears, change `installCommand` to JSON (an array) and update this test.
- `installedBin()` runs `bun pm bin -g`, which honours `BUN_INSTALL`, so the hand-off finds `bunHome/bin/loopstra`.
- The fake GitHub API answers `[]` for releases, so the notes are empty and the commit message has no body.
- The upgraded repository's stamp `loopstra` is `0.9.0` for a release (no `+commit`).
- `templates/config.yaml`'s placeholders are `__MAIN_BRANCH__` and `__COMMANDS__` (see `src/init.ts`); if the replaced config does not load, look at `init()` for the exact replacement.

- [ ] **Step 2: Run** — `bun test tests/integration/upgrade-e2e.test.ts --timeout 240000`. Expected: PASS. Debug failures with the spawned process's stdout/stderr.
- [ ] **Step 3: Commit** — `git add tests/integration/upgrade-e2e.test.ts && git commit -m "test(upgrade): the packed package upgrades an old repository and itself"`

---

### Task 16: Documentation

**Files:**
- Modify: `README.md`, `docs/decisions.md`, `templates/skill/SKILL.md` (if it mentions `loopstra init` restoring prompts or the hook files), the spec's Status line

- [ ] **Step 1: README**
  - **Install**: `bun add -g loopstra` (Bun 1.4.2+ on PATH; `npm i -g loopstra` works with `bun` on PATH). Check with `loopstra --version`.
  - New **Upgrade** section: `loopstra upgrade` in a project repository: what it does (install the latest from npm, then bring the repository up to it: managed files updated or merged, unedited prompt copies dropped on the first upgrade, the old hook removed, config migrated, one commit `loopstra: upgrade to X (from Y)` made as Loopstra and shared by the next `loopstra start`), the refusals (not on main, uncommitted managed files, loop running), conflicts (markers left in the file, not committed), `--check`, `--repo`, the notice on `start`/`status`, and that loops in other repositories keep the code they loaded until restarted.
  - **Set up a repo**: init writes no prompts, hook or settings; writes `loopstra/stamp.json`; commit list is config, stamp, skill, intent, REVIEW.md, CLAUDE.md, .gitignore.
  - **Prompts**: they ship in the package; `loopstra customize [prompt]`; an override is merged on upgrade.
  - The test-protection hook paragraph: it now comes with every session Loopstra starts (`claude --settings`), runs from the package, needs `bun` on Claude Code's PATH as before.
  - Remove "If you set the repo up before chat existed, run `loopstra init` again to stamp the two chat prompts" (prompts ship now).
  - New **Develop Loopstra** section: clone, `bun install`, `bun src/cli.ts <command>` (or `bun link` to use the checkout globally: version `0.0.0-dev`, upgrade then only does the repository step); how releases happen (every green merge to main that touches `src/`, `templates/` or `package.json`; `feat!:`/`BREAKING CHANGE` bumps the minor; manual run of the release workflow with `bump`); the one-time setup: first publish by hand, then configure the npm trusted publisher (repository `jflavan/loopstra`, workflow `release.yml`).
  - Update the command list in README to include `upgrade`, `customize`, `--version`.
- [ ] **Step 2: `docs/decisions.md`**: add a "Packaging and upgrade (2026-10-18)" section listing: npm with trusted publishing; version only in CI (`0.0.0-dev` in git); prompts and hook in the package; stamp with bases; shipped.json with raw GitHub fetches; `git merge-file`, conflict files left out of the commit; a running loop refuses (no cross-process graceful stop on Windows); commit as the runtime so `shareMain` pushes it; init's stamp uses today's shipped sha for kept files; `withNote` kept; the license note from Task 14 if `UNLICENSED`.
- [ ] **Step 3: Skill**: `grep -n "init\|prompts\|hook" templates/skill/SKILL.md` and update any sentence that says init stamps prompts or that `loopstra init` restores a prompt; mention `loopstra upgrade` and `loopstra customize`.
- [ ] **Step 4: Spec status**: change `Status: designed.` to `Status: built (plan: docs/superpowers/plans/2026-10-18-packaging-upgrade.md).`
- [ ] **Step 5: Run the template tests** (the skill is a template): `bun test tests/unit/templates.test.ts --timeout 30000`.
- [ ] **Step 6: Commit** — `git add -A README.md docs templates && git commit -m "docs: install from npm, loopstra upgrade, customize, and releases"`

---

### Task 17: Full verification

- [ ] Run `bun run typecheck` — Expected: no errors.
- [ ] Run `bun run test` — Expected: all shards pass. Fix any failure at its cause.
- [ ] Run `bun src/cli.ts --version`, `bun src/cli.ts help` (shows upgrade, customize), and in a throwaway repo: `bun src/cli.ts init`, `bun src/cli.ts customize`, `bun src/cli.ts upgrade --check`.
- [ ] Commit any fixes.
