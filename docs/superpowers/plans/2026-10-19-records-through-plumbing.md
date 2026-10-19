# Records Through Git Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A record is committed before its files reach the checkout, so nothing is ever left written but uncommitted, and the put-back machinery in `src/context.ts`, `src/apply.ts` and `src/questions.ts` goes.

**Architecture:** Write callbacks write into an in-memory `RecordDraft`. `commitRecord` builds the commit from HEAD plus the paths on disk plus the draft in a temporary index (`Git.commitFiles`), moves HEAD with a compare-and-swap (`Git.moveHead`), then writes the drafted files to the checkout. A marker file covers a kill between moving HEAD and the disk write (`settleRecord`). The applier tags each record with its request id and, on a retry, asks git whether it landed.

**Tech Stack:** TypeScript on Bun 1.4.2, `bun:test`, git plumbing (`read-tree`, `hash-object`, `update-index`, `write-tree`, `commit-tree`, `update-ref`). Spec: `docs/superpowers/specs/2026-10-19-records-through-plumbing-design.md`.

**Working rules for every task:** worktree `C:\Source\Repos\loopstra-records`, branch `feat/records-through-plumbing`. No Python on this machine (use bun). Comments in plain prose, saying what and why (no "we", no emoji). Before each commit: `bun run typecheck`, `./node_modules/.bin/eslint <files touched>`, `bun run deadcode` all clean, and the task's test files pass. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit as `git -c user.name="John Flavan" -c user.email="johnflavan@gmail.com" commit`.

---

## File structure

- Create `src/record-draft.ts`: `RecordDraft` (the files one record changes, in memory). One responsibility; knows nothing of git.
- Modify `src/git.ts`: `GitRunOptions` gains `env` and `stdin`; `stagePaths` split out of `commitPaths`; new `commitFiles`, `moveHead`.
- Modify `src/context.ts`: `commitRecord` on the draft; the marker; `settleRecord`; `putBackRecord` and `nothingLanded` go; the step writers (`writeForStep`, `setStatus`, `writeArtifact`, `writeIntentPriority`) draft.
- Modify `src/intents.ts`: `writeChangeFile` and `writeIntent` take an optional draft.
- Modify `src/conversation.ts`, `src/signals.ts`, `src/questions.ts`, `src/apply.ts`: their record writes go through the draft; the put-back families go.
- Modify `src/scheduler.ts`: `settleRecord` at tick start.
- Modify `src/requests.ts`: the `Request` schema drops `written`, `writtenHash`, `recordHash` (old files still read: zod objects are `.loose()` or the fields are optional and ignored).
- Tests: create `tests/unit/record-draft.test.ts`, `tests/unit/git-commit-files.test.ts`, `tests/unit/records.test.ts`; modify `tests/unit/context.test.ts`, `tests/unit/apply.test.ts`, `tests/unit/questions.test.ts`, `tests/integration/chat.test.ts` where they set up "written but not committed" by hand.
- Docs: `docs/decisions.md` (a section), README only if it describes the old behaviour.

---

### Task 1: RecordDraft

**Files:**
- Create: `src/record-draft.ts`
- Test: `tests/unit/record-draft.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecordDraft } from "../../src/record-draft";
import { tempDir } from "../helpers";

describe("RecordDraft", () => {
  test("reads fall through to disk until written; writes and removals are the changes, in order", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "a"), { recursive: true });
      writeFileSync(join(t.path, "intent", "a", "intent.md"), "on disk\n");
      const d = new RecordDraft(t.path, "a");
      expect(d.read("intent/a/intent.md")).toBe("on disk\n");
      expect(d.read("intent/a/spec.md")).toBeNull();
      d.write("intent/a/intent.md", "drafted\n");
      d.write("intent/a/spec.md", "# Spec\n");
      d.remove("intent/a/old.md");
      expect(d.read("intent/a/intent.md")).toBe("drafted\n");
      expect(d.read("intent/a/old.md")).toBeNull();
      expect(d.changes()).toEqual([
        { rel: "intent/a/intent.md", text: "drafted\n" },
        { rel: "intent/a/spec.md", text: "# Spec\n" },
        { rel: "intent/a/old.md", text: null },
      ]);
    } finally { t.cleanup(); }
  });

  test("a path outside the change's folder (and queue.md) is refused", () => {
    const d = new RecordDraft("/r", "a");
    expect(() => d.write("intent/b/intent.md", "x")).toThrow("a record of a cannot write intent/b/intent.md");
    expect(() => d.write("intent/a/../b/intent.md", "x")).toThrow();
    expect(() => d.write("intent/a\\x.md", "x")).toThrow();
    expect(() => d.read("src/index.ts")).toThrow();
    expect(() => d.write("intent/queue.md", "q")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/record-draft.test.ts`
Expected: FAIL, `Cannot find module '../../src/record-draft'`.

- [ ] **Step 3: Write `src/record-draft.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One file a record changes: its new text, or null when the record removes it. Paths are relative to the repository, with forward slashes. */
export interface DraftChange { rel: string; text: string | null }

/**
 * The files one record changes, held in memory until commitRecord has committed them (see
 * src/context.ts): a record's write callback writes here, never into the checkout. A read gives the
 * draft's version, else the file on disk. Only the change's own folder (`intent/<slug>/`) and the
 * generated `intent/queue.md` may be written: a record never writes elsewhere.
 */
export class RecordDraft {
  private readonly drafted = new Map<string, string | null>();

  constructor(readonly root: string, readonly slug: string) {}

  private check(rel: string): void {
    const inFolder = rel.startsWith(`intent/${this.slug}/`) && !rel.split("/").includes("..") && !rel.includes("\\");
    if (!inFolder && rel !== "intent/queue.md") throw new Error(`a record of ${this.slug} cannot write ${rel}`);
  }

  /** The draft's version of the file, else what is on disk; null when neither has it. */
  read(rel: string): string | null {
    this.check(rel);
    if (this.drafted.has(rel)) return this.drafted.get(rel) ?? null;
    try {
      return readFileSync(join(this.root, rel), "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
  }

  write(rel: string, text: string): void {
    this.check(rel);
    this.drafted.set(rel, text);
  }

  remove(rel: string): void {
    this.check(rel);
    this.drafted.set(rel, null);
  }

  /** Every file written or removed, in the order first touched. */
  changes(): DraftChange[] {
    return [...this.drafted].map(([rel, text]) => ({ rel, text }));
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/unit/record-draft.test.ts`
Expected: PASS (2 tests). The dead-code gate will flag `RecordDraft` until Task 3 uses it from `src/`; run `bun run deadcode` only from Task 3 on, or accept its report here.

- [ ] **Step 5: Commit**

```bash
git add src/record-draft.ts tests/unit/record-draft.test.ts
git commit -m "feat(records): RecordDraft, the files one record changes, in memory"
```

---

### Task 2: Git.commitFiles and Git.moveHead

**Files:**
- Modify: `src/git.ts` (`GitRunOptions` around line 74; `Git.run` around line 183; `commitPaths` around line 346)
- Test: `tests/unit/git-commit-files.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { run, tempGitRepo } from "../helpers";

async function repo() {
  const r = await tempGitRepo();
  mkdirSync(join(r.path, "intent", "a"), { recursive: true });
  writeFileSync(join(r.path, "intent", "a", "intent.md"), "---\nstatus: draft\n---\n");
  writeFileSync(join(r.path, "intent", "a", "old.md"), "old\n");
  writeFileSync(join(r.path, "other.txt"), "other\n");
  await run(["git", "add", "-A"], r.path);
  await run(["git", "commit", "-q", "-m", "base"], r.path);
  return r;
}

describe("Git.commitFiles", () => {
  test("a commit of the paths on disk with the changes over them; the checkout, its index and HEAD are untouched", async () => {
    const r = await repo();
    try {
      const git = new Git(r.path);
      const parent = (await git.headSha())!;
      // A person's uncommitted edit in the folder is taken along; one outside it is not.
      writeFileSync(join(r.path, "intent", "a", "notes.md"), "a person's notes\n");
      writeFileSync(join(r.path, "other.txt"), "edited elsewhere\n");
      const commit = await git.commitFiles(parent, ["intent/a", "intent/queue.md"], [
        { rel: "intent/a/intent.md", text: "---\nstatus: accepted\n---\n" },
        { rel: "intent/a/old.md", text: null },
        { rel: "intent/queue.md", text: "# Queue\n" },
      ], "loopstra(a): accepted [skip ci]");
      expect(commit).not.toBeNull();
      expect((await run(["git", "show", `${commit}:intent/a/intent.md`], r.path)).out).toBe("---\nstatus: accepted\n---\n");
      expect((await run(["git", "show", `${commit}:intent/a/notes.md`], r.path)).out).toBe("a person's notes\n");
      expect((await run(["git", "cat-file", "-e", `${commit}:intent/a/old.md`], r.path)).code).not.toBe(0);
      expect((await run(["git", "show", `${commit}:other.txt`], r.path)).out).toBe("other\n");
      expect((await run(["git", "log", "-1", "--format=%P%n%s", commit!], r.path)).out.trim()).toBe(`${parent}\nloopstra(a): accepted [skip ci]`);
      // Untouched: HEAD, the index, the files.
      expect(await git.headSha()).toBe(parent);
      expect((await run(["git", "diff", "--cached", "--name-only"], r.path)).out.trim()).toBe("");
      expect(readFileSync(join(r.path, "intent", "a", "intent.md"), "utf8")).toBe("---\nstatus: draft\n---\n");
    } finally { r.cleanup(); }
  });

  test("nothing to commit gives null; no hook runs", async () => {
    const r = await repo();
    try {
      const git = new Git(r.path);
      writeFileSync(join(r.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const parent = (await git.headSha())!;
      expect(await git.commitFiles(parent, ["intent/a"], [], "nothing")).toBeNull();
      expect(await git.commitFiles(parent, ["intent/a"], [{ rel: "intent/a/x.md", text: "x\n" }], "with a hook")).not.toBeNull();
    } finally { r.cleanup(); }
  });
});

describe("Git.moveHead", () => {
  test("moves HEAD only from the commit it expects", async () => {
    const r = await repo();
    try {
      const git = new Git(r.path);
      const parent = (await git.headSha())!;
      const commit = (await git.commitFiles(parent, ["intent/a"], [{ rel: "intent/a/x.md", text: "x\n" }], "x"))!;
      expect(await git.moveHead("0".repeat(40), commit)).toBe(false);
      expect(await git.headSha()).toBe(parent);
      expect(await git.moveHead(parent, commit)).toBe(true);
      expect(await git.headSha()).toBe(commit);
      expect(await git.currentBranch()).toBe("main");
    } finally { r.cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/git-commit-files.test.ts`
Expected: FAIL, `git.commitFiles is not a function`.

- [ ] **Step 3: Add `env` and `stdin` to `GitRunOptions` and pass them in `Git.run`**

In `GitRunOptions` add:

```ts
  /** Variables added to the command's environment (a temporary index's GIT_INDEX_FILE, say). */
  env?: Record<string, string>;
  /** Text written to the command's stdin, which is then closed. */
  stdin?: string;
```

In `Git.run`, the spawn becomes:

```ts
    const spawn = () => spawnBounded({
      cmd: ["git", ...args], cwd: this.cwd, env: { ...gitEnv(this.cwd), ...o.env }, timeoutMs,
      onStop: o.cleanup ? "ignore" : "grace", graceMs: this.stopGraceMs,
      ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    });
```

- [ ] **Step 4: Split `stagePaths` out of `commitPaths`**

Move the body of `commitPaths` up to and including `if (!staged) return false;` into a new method that takes `GitRunOptions` (so it can stage into a temporary index) and returns the paths to commit, or null when nothing differs:

```ts
  /**
   * Stages `paths` as they are on disk into the index `o.env` names (the checkout's by default), by the
   * rules commitPaths has always used: an ignored, untracked file is left out, a removal is taken
   * along, and a path that matches nothing is not named. The paths to commit, or null when none
   * differs from what the index's HEAD side has.
   */
  async stagePaths(paths: string[], o: GitRunOptions = {}): Promise<string[] | null> {
    // (the existing body of commitPaths, from `const names = ...` to the `staged` check, with every
    //  `this.run(..., o)` keeping `o` so the env reaches each call; it ends:)
    if (!toCommit.length) return null;
    const staged = (await this.run(["diff", "--cached", "--name-only", "--", ...toCommit], o)).out.trim();
    return staged ? toCommit : null;
  }

  async commitPaths(paths: string[], message: string, opts: { finish?: boolean } = {}): Promise<boolean> {
    const o = { cleanup: opts.finish === true };
    const toCommit = await this.stagePaths(paths, o);
    if (!toCommit) return false;
    await this.runtime("commit", ["-q", "-m", message, "--", ...toCommit], o);
    return true;
  }
```

`diff --cached` in a temporary index read from `parent` compares it with HEAD, not with `parent`; `commitFiles` does not use that answer (it compares trees), so `stagePaths`'s null there only means "nothing staged differs from HEAD". Keep it as it is for `commitPaths`.

- [ ] **Step 5: Add `commitFiles` and `moveHead` to `Git`**

```ts
  /**
   * A commit made from `parent` without touching the checkout's index or files: `paths` as they are
   * on disk (see stagePaths), with `changes` over them, in a temporary index. Each content is hashed
   * with `--path`, so the repository's line-ending and attribute rules apply as `git add` applies
   * them. Made as the runtime (no hooks, the records' identity). Null when the tree is `parent`'s.
   */
  async commitFiles(parent: string, paths: string[], changes: ReadonlyArray<{ rel: string; text: string | null }>, message: string): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "loopstra-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    const o: GitRunOptions = { env, cleanup: true };
    try {
      await this.run(["read-tree", parent], o);
      await this.stagePaths(paths, o);
      for (const c of changes) {
        if (c.text === null) {
          await this.run(["update-index", "--force-remove", "--", c.rel], o);
          continue;
        }
        const blob = (await this.run(["hash-object", "-w", `--path=${c.rel}`, "--stdin"], { ...o, stdin: c.text })).out.trim();
        const mode = (await this.run(["ls-tree", parent, "--", c.rel], o)).out.split(/\s/)[0] || "100644";
        await this.run(["update-index", "--add", "--cacheinfo", `${mode},${blob},${c.rel}`], o);
      }
      const tree = (await this.run(["write-tree"], o)).out.trim();
      const parentTree = (await this.run(["rev-parse", `${parent}^{tree}`], o)).out.trim();
      if (tree === parentTree) return null;
      return (await this.runtime("commit-tree", [tree, "-p", parent, "-m", message], o)).out.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Moves HEAD (its branch) from `from` to `to`, as a compare-and-swap: false when HEAD is no longer `from`. */
  async moveHead(from: string, to: string): Promise<boolean> {
    const r = await this.run(["update-ref", "-m", "loopstra: record", "HEAD", to, from], { allowFail: true, cleanup: true });
    return r.code === 0;
  }
```

Add `mkdtempSync` to the `node:fs` import and `import { tmpdir } from "node:os";`.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/unit/git-commit-files.test.ts tests/unit/git.test.ts`
Expected: PASS (the existing git tests guard `commitPaths`).

- [ ] **Step 7: Commit**

```bash
git add src/git.ts tests/unit/git-commit-files.test.ts
git commit -m "feat(git): commitFiles and moveHead, a commit made without the checkout, and a compare-and-swap of HEAD"
```

---

### Task 3: commitRecord on the draft, the marker and settleRecord

**Files:**
- Modify: `src/context.ts` (`commitRecord` around line 143; remove `putBackRecord`, `nothingLanded`; add `settleRecord`, `RecordRaced`)
- Modify: `src/intents.ts` (`writeChangeFile`, `writeIntent`, around lines 351-372)
- Test: `tests/unit/records.test.ts` (new); `tests/unit/context.test.ts` (the put-back tests change meaning)

- [ ] **Step 1: Write the failing tests** in `tests/unit/records.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitRecord, RecordRaced, settleRecord } from "../../src/context";
import { Git } from "../../src/git";
import { Trace } from "../../src/trace";
import { run, setupRepo } from "../helpers";

const SLUG = "add-numbers";
const md = (root: string) => join(root, "intent", SLUG, "intent.md");

describe("commitRecord through plumbing", () => {
  test("the commit lands before the file changes, and the checkout matches it after", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const before = readFileSync(md(repo.path), "utf8");
      const head = await new Git(repo.path).headSha();
      expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
        // Nothing is on disk yet while the callback runs.
        expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      })).toBe(true);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect(await new Git(repo.path).headSha()).not.toBe(head);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a callback that throws leaves HEAD, the index and the files as they were", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const before = readFileSync(md(repo.path), "utf8");
      const head = await new Git(repo.path).headSha();
      await expect(commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, "x");
        throw new Error("SQLITE_BUSY");
      })).rejects.toThrow("SQLITE_BUSY");
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect(await new Git(repo.path).headSha()).toBe(head);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a person's save of a drafted file during the record stays on disk, uncommitted; the commit has the record's", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const moveHead = Git.prototype.moveHead;
    try {
      const before = readFileSync(md(repo.path), "utf8");
      // The person saves after the commit was built and before HEAD moves.
      Git.prototype.moveHead = async function (this: Git, from: string, to: string) {
        writeFileSync(md(repo.path), "a person's version\n");
        return moveHead.call(this, from, to);
      };
      await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
      });
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toBe("a person's version\n");
    } finally { Git.prototype.moveHead = moveHead; trace.close(); repo.cleanup(); }
  });

  test("HEAD moved by a person's commit during the record is tried again from the new HEAD; moved every time, RecordRaced", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      let calls = 0;
      await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        if (calls++ === 0) {
          writeFileSync(join(repo.path, "person.txt"), "p\n");
          await run(["git", "add", "person.txt"], repo.path);
          await run(["git", "commit", "-q", "-m", "a person's commit"], repo.path);
        }
        d.write(`intent/${SLUG}/note.md`, "n\n");
      });
      expect(calls).toBe(2);
      expect((await run(["git", "log", "-2", "--format=%s"], repo.path)).out).toContain("a person's commit");
      let n = 0;
      await expect(commitRecord(repo.path, "main", SLUG, "racing", async (d) => {
        writeFileSync(join(repo.path, `p${n}.txt`), "p\n");
        await run(["git", "add", `p${n}.txt`], repo.path);
        await run(["git", "commit", "-q", "-m", `person ${n++}`], repo.path);
        d.write(`intent/${SLUG}/other.md`, "o\n");
      })).rejects.toBeInstanceOf(RecordRaced);
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("settleRecord", () => {
  async function killedAfterHeadMoved(root: string): Promise<{ parent: string; commit: string }> {
    const git = new Git(root);
    const parent = (await git.headSha())!;
    const text = readFileSync(md(root), "utf8").replace("status: accepted", "status: designing");
    const commit = (await git.commitFiles(parent, [`intent/${SLUG}`], [{ rel: `intent/${SLUG}/intent.md`, text }], "loopstra(add-numbers): killed [skip ci]"))!;
    writeFileSync(join(root, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
    expect(await git.moveHead(parent, commit)).toBe(true);
    return { parent, commit };
  }

  test("HEAD moved, the file not yet written: it is brought up to the commit, and the index with it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await killedAfterHeadMoved(repo.path);
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a file a person edited since is left as they left it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await killedAfterHeadMoved(repo.path);
      writeFileSync(md(repo.path), "a person's version\n");
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toBe("a person's version\n");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("HEAD never moved: the marker goes and nothing else changes", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const git = new Git(repo.path);
      const parent = (await git.headSha())!;
      writeFileSync(join(repo.path, ".loopstra", "recording.json"), JSON.stringify({ parent, commit: "1".repeat(40), slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
      const before = readFileSync(md(repo.path), "utf8");
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect(await git.headSha()).toBe(parent);
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });
});
```

(`setupRepo` and `run` are in `tests/helpers.ts`; `setupRepo(status)` makes a repository with one change `add-numbers` at that status and returns `{ repo, trace }`. Check its exact return shape in `tests/helpers.ts` before running, and adjust the destructuring if it differs.)

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/unit/records.test.ts`
Expected: FAIL, `settleRecord` and `RecordRaced` are not exported.

- [ ] **Step 3: Give `writeChangeFile` and `writeIntent` an optional draft** (`src/intents.ts`)

```ts
export function writeChangeFile(intent: Intent, name: string, text: string, draft?: RecordDraft): void {
  if (draft) { draft.write(`intent/${intent.slug}/${name}`, text); return; }
  writeFileAtomic(join(intent.dir, name), text, join(intent.dir, "..", "..", ".loopstra"));
}
```

In `writeIntent`, add `draft?: RecordDraft` as a fourth parameter; read through it and write through it:

```ts
export async function writeIntent(intent: Intent, patch: Partial<Frontmatter>, opts: { expectStatus?: Status; remove?: Array<keyof Frontmatter> } = {}, draft?: RecordDraft): Promise<boolean> {
  const rel = `intent/${intent.slug}/intent.md`;
  const onDisk = draft ? draft.read(rel) : existsSync(join(intent.dir, "intent.md")) ? await Bun.file(join(intent.dir, "intent.md")).text() : null;
  if (onDisk === null) return false;
  if (opts.expectStatus !== undefined && parseIntentFile(onDisk).frontmatter.status !== opts.expectStatus) return false;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) values[k] = String(v);
  const text = patchFrontmatter(onDisk, values, opts.remove ?? []);
  writeChangeFile(intent, "intent.md", text, draft);
  intent.file = parseIntentFile(text);
  return true;
}
```

Update both doc comments: with a draft, the file is written to the draft and reaches disk once the record's commit has landed (see commitRecord). Add `import type { RecordDraft } from "./record-draft";`.

- [ ] **Step 4: Rewrite `commitRecord`; add the marker, `settleRecord` and `RecordRaced`** (`src/context.ts`)

Replace `commitRecord`, `nothingLanded` and `putBackRecord` (keep `filesUnder`, `readIfThere`, `codeOf` if anything else still uses them; `filesUnder` is used below):

```ts
/** Main moved twice while a record was being committed; it is tried again on the next tick. */
export class RecordRaced extends Error {
  constructor(slug: string) {
    super(`main moved twice while a record of ${slug} was being committed; it is tried again on the next tick`);
    this.name = "RecordRaced";
  }
}

/** The record being brought into the checkout (see commitRecord), so a kill in between is finished (see settleRecord). */
interface RecordMarker { parent: string; commit: string; slug: string; paths: string[] }
const RecordMarkerSchema = z.object({ parent: z.string(), commit: z.string(), slug: z.string(), paths: z.array(z.string()) });
const markerPath = (root: string) => join(loopstraDir(root), "recording.json");

/**
 * Writes a change's record on main and commits it: every record (statuses, artifacts, a person's
 * edits, chat's drafts, the main-health draft) is written this one way, under the checkout lock and
 * only on main (MainCheckoutMoved otherwise). `write` writes into a draft, never the checkout (it may
 * give false: nothing to commit after all). The commit is made first, from main's HEAD, the change's
 * folder and queue.md as they are on disk, and the draft over them (see Git.commitFiles); HEAD moves to
 * it with a compare-and-swap (tried once more from the new HEAD when someone committed meanwhile,
 * then RecordRaced); only then are the drafted files written to the checkout, each unless a person
 * saved it since it was noted (theirs then stays, uncommitted, as any edit of theirs), and the index
 * brought up for the paths. A marker (`.loopstra/recording.json`) covers a kill between HEAD moving
 * and the checkout matching (see settleRecord). A throw before HEAD moved changed nothing anywhere.
 * Once it commits a stop request does not stop it. `opts.request` tags the commit with the request
 * it applies (`Loopstra-Request: <id>`), so a later pass can ask git whether it landed. False when
 * nothing was committed.
 */
export function commitRecord(root: string, main: string, slug: string, what: string, write: (draft: RecordDraft) => Promise<boolean | void> = async () => {}, opts: { request?: string } = {}): Promise<boolean> {
  return onCheckout(root, async () => {
    const git = new Git(root);
    await assertOnMain(git, main);
    await settleRecord(root);
    throwIfStopping();
    const paths = [`intent/${slug}`, "intent/queue.md"];
    const message = bookkeeping(`loopstra(${slug}): ${what}`) + (opts.request ? `\n\nLoopstra-Request: ${opts.request}` : "");
    for (let attempt = 0; attempt < 2; attempt++) {
      const parent = await git.headSha();
      if (!parent) throw new Error("main has no commit yet");
      const draft = new RecordDraft(root, slug);
      if ((await write(draft)) === false) return false;
      const changes = draft.changes();
      const seen = new Map(changes.map((c) => [c.rel, readIfThere(join(root, c.rel))] as const));
      const commit = await git.commitFiles(parent, paths, changes, message);
      if (!commit) return false;
      const marker: RecordMarker = { parent, commit, slug, paths: changes.map((c) => c.rel) };
      writeFileAtomic(markerPath(root), JSON.stringify(marker));
      if (!(await git.moveHead(parent, commit))) {
        rmSync(markerPath(root), { force: true });
        continue;
      }
      for (const c of changes) {
        const abs = join(root, c.rel);
        const now = readIfThere(abs);
        const was = seen.get(c.rel) ?? null;
        // A person saved it since it was noted: theirs stays, uncommitted.
        if (!(now === null ? was === null : was !== null && now.equals(was))) continue;
        if (c.text === null) rmSync(abs, { force: true });
        else writeFileAtomic(abs, c.text, loopstraDir(root));
      }
      // The whole folder: the commit also took a person's unstaged edits in it, whose index entries are now behind HEAD.
      // Check that a path matching nothing (queue.md not made yet) does not stop the others being reset; if it does, name only those that exist on disk or in HEAD.
      await git.run(["reset", "-q", "--", ...paths], { allowFail: true, cleanup: true });
      rmSync(markerPath(root), { force: true });
      return true;
    }
    throw new RecordRaced(slug);
  });
}

/**
 * Finishes a record a kill left between moving HEAD and writing the checkout (see commitRecord), at
 * the start of each tick and of each record. HEAD at the marker's parent: it never moved, and the
 * marker goes. HEAD at the marker's commit or past it: each file the marker names that still holds
 * what the parent had (as git compares it) is brought up to the commit; one holding anything else is
 * left (a person's edit since); the index is brought up for those paths. Anything else (main reset
 * by a person): the marker goes. Traced when there is a trace. Never throws.
 */
export async function settleRecord(root: string, trace?: Trace): Promise<void> {
  const m = readJsonAs(markerPath(root), RecordMarkerSchema);
  if (!m) { rmSync(markerPath(root), { force: true }); return; }
  try {
    const git = new Git(root);
    const head = await git.headSha();
    const landed = head === m.commit || (head !== null && (await git.run(["merge-base", "--is-ancestor", m.commit, head], { allowFail: true, cleanup: true })).code === 0);
    if (head !== m.parent && landed) {
      for (const rel of m.paths) {
        const untouched = (await git.run(["diff", "--quiet", m.parent, "--", rel], { allowFail: true, cleanup: true })).code === 0;
        if (!untouched) continue;
        const inCommit = (await git.run(["cat-file", "-e", `${m.commit}:${rel}`], { allowFail: true, cleanup: true })).code === 0;
        if (inCommit) await git.run(["checkout", m.commit, "--", rel], { cleanup: true });
        else rmSync(join(root, rel), { force: true });
      }
      await git.run(["reset", "-q", "--", `intent/${m.slug}`, "intent/queue.md"], { allowFail: true, cleanup: true });
      trace?.event(m.slug, "command", { command: "finish a record a kill cut short", commit: m.commit });
    }
    rmSync(markerPath(root), { force: true });
  } catch (e) {
    trace?.event(m.slug, "error", { where: "record", error: `a record a kill cut short could not be finished; it is tried again: ${errorText(e)}` });
  }
}
```

Imports to add in `src/context.ts`: `RecordDraft` from `./record-draft`, `writeFileAtomic`, `readJsonAs` from `./fsutil`, `loopstraDir` from `./paths`, `z` from `zod`. `diff --quiet <parent> -- <rel>` compares the working file with the parent's (exit 0 equal; a file the parent did not have and the disk does not have is equal too).

- [ ] **Step 5: The step writers draft** (`src/context.ts`)

`writeForStep(ctx, patch)` gains a `draft: RecordDraft` parameter and passes it to `writeIntent(ctx.intent, patch, { expectStatus: expected }, draft)`; its deletion check (`throwIfDeleted`) reads `draft.read(\`intent/${ctx.slug}/intent.md\`) === null` instead of `existsSync`. Every `commitForStep(ctx, what, async () => { ... })` callback becomes `async (draft) => { ... }` and passes `draft` on: `setStatus` (`writeForStep(ctx, patch, draft)`), `writeArtifact` (`writeChangeFile(ctx.intent, name, text, draft)`), `writeIntentPriority` (read with `parseIntentFile(draft.read(...)!)` in place of `readIntent`, then `writeForStep(ctx, { priority }, draft)`). `commitForStep` passes its `write` straight to `commitRecord`, now typed `(draft: RecordDraft) => Promise<boolean | void>`. `recordPersonEdits` is unchanged (no callback: what it commits is the person's files on disk).

- [ ] **Step 6: Replace the put-back tests in `tests/unit/context.test.ts`**

The tests "a write that throws after writing (a trace that cannot be written) is put back as it was…", "a write refused because a person changed the change keeps the person's edit…" and "a record whose commit landed before its error…" test the machinery this task removes. Delete them; `tests/unit/records.test.ts` covers what they meant (a throw changes nothing; a person's edit stays). Keep every other test in the file unchanged.

- [ ] **Step 7: Run the tests**

Run: `bun test tests/unit/records.test.ts tests/unit/context.test.ts tests/unit/intents-patch.test.ts tests/unit/stages-design.test.ts`
Expected: PASS. (`stages-design` exercises `setStatus` and `writeArtifact` through real steps.)

- [ ] **Step 8: Commit**

```bash
git add src/context.ts src/intents.ts tests/unit/records.test.ts tests/unit/context.test.ts
git commit -m "feat(records): commitRecord commits first, then writes the checkout; settleRecord finishes one a kill cut short"
```

---

### Task 4: settleRecord at the tick's start

**Files:**
- Modify: `src/scheduler.ts` (in `tick`, next to `settleCutShortMove`, around line 89)
- Test: `tests/integration/scheduler.test.ts`

- [ ] **Step 1: Write the failing test** (append to the "scheduler resilience" describe)

```ts
  test("a record a kill left between HEAD and the checkout is finished before the tick does anything else", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      const git = new Git(repo.path);
      const parent = (await git.headSha())!;
      const md = join(repo.path, "intent", SLUG, "intent.md");
      const text = readFileSync(md, "utf8").replace("status: draft", "status: closed");
      const commit = (await git.commitFiles(parent, [`intent/${SLUG}`], [{ rel: `intent/${SLUG}/intent.md`, text }], "loopstra(x): killed [skip ci]"))!;
      writeFileSync(join(repo.path, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
      await git.moveHead(parent, commit);
      await tick(repo.path);
      expect(readFileSync(md, "utf8")).toContain("status: closed");
      expect((await run(["git", "status", "--porcelain", "--", "intent"], repo.path)).out.trim()).toBe("");
    } finally { trace.close(); repo.cleanup(); }
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/integration/scheduler.test.ts -t "a kill left between HEAD and the checkout"`
Expected: FAIL (intent.md still says draft, and git status shows it modified).

- [ ] **Step 3: Call it in `tick`**, right after `settleCutShortMove` returns nothing:

```ts
    // A record a kill left between moving HEAD and writing the checkout is finished first (see commitRecord).
    await settleRecord(root, trace);
```

and import `settleRecord` from `./context`.

- [ ] **Step 4: Run it**

Run: `bun test tests/integration/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/integration/scheduler.test.ts
git commit -m "feat(records): the tick settles a record a kill cut short before anything else"
```

---

### Task 5: The other record writers draft

**Files:**
- Modify: `src/conversation.ts` (`appendConversation`, around line 153), `src/signals.ts` (`openFailureIntent`, around line 127), `src/questions.ts` (`recordQuestion` and its `putBack`, around lines 109-152)
- Test: `tests/unit/conversation.test.ts`, `tests/unit/signals.test.ts`, `tests/unit/questions.test.ts`

- [ ] **Step 1: `appendConversation`**

```ts
  await commitRecord(root, main, slug, "conversation", async (draft) => {
    const rel = `intent/${slug}/conversation.md`;
    const current = draft.read(rel) ?? "";
    if (opts.id && "who" in e && "text" in e && recordedAs(root, slug, opts.id, e, current)) return false;
    draft.write(rel, withEntry(current, e));
    if (opts.id) noteRecorded(root, slug, opts.id, e.kind);
    return true;
  });
```

Check `readConversation`'s return for a missing file (it is `""` today) and keep the same default.

- [ ] **Step 2: `openFailureIntent`**: the callback becomes `async (draft) => { draft.write(\`intent/${slug}/intent.md\`, <the same template string>); }`; drop the `mkdirSync`.

- [ ] **Step 3: `recordQuestion`**: the callback becomes

```ts
    await commitForStep(ctx, `${a.phase} asks a question`, async (draft) => {
      // Never over a status a person set while the session ran (PersonChangedStatus instead).
      await writeForStep(ctx, { question: "open" }, draft);
      const rel = `intent/${ctx.slug}/conversation.md`;
      draft.write(rel, withEntryOnce(draft.read(rel) ?? "", { kind: "question", phase: a.phase, text: a.text, why: a.why, options: a.options, at }));
    });
```

with no `try`/`catch` around it; delete `written`, the `files` list, and the `putBack` function (and imports only it used: `matchesHead`, `fileHash`, `asAtHead`, `onCheckout`, `Git`, if nothing else in the file uses them).

- [ ] **Step 4: Run the tests**

Run: `bun test tests/unit/conversation.test.ts tests/unit/signals.test.ts tests/unit/questions.test.ts tests/unit/steering.test.ts`
Expected: PASS. A test that wrote a file and made the commit fail to check the put-back now checks that nothing was written (the commit is made first); adjust its expectation, not the code.

- [ ] **Step 5: Commit**

```bash
git add src/conversation.ts src/signals.ts src/questions.ts tests/unit
git commit -m "refactor(records): conversation, the main-health draft and questions write through the draft; the question's put-back goes"
```

---

### Task 6: The applier asks git whether a request landed

**Files:**
- Modify: `src/apply.ts` (the whole put-back family, lines ~205-362; `applyAccept`, `applyNew`, `applyStatus`, `applyField`, `applyAnswer`, `movedOn`, the give-up in `applyPass`)
- Modify: `src/requests.ts` (drop `written`, `writtenHash`, `recordHash` from the schema)
- Test: `tests/unit/apply.test.ts`, `tests/integration/chat.test.ts`

- [ ] **Step 1: Write the failing test** (in `tests/unit/apply.test.ts`)

```ts
  test("a request whose record landed but whose pass was killed before it finished is finished as applied, with no second commit", async () => {
    const r = await repoWithChange("plan-review");
    try {
      const req = submitRequest(r.root, { kind: "approve", slug: "x", expect: "plan-review", by: "u", byName: "U", via: "the dashboard", transport: CONSOLE, thread: "" });
      claimRequest(r.root, req.id);
      // The record landed with the request's id, as a pass the loop was killed in would leave it.
      await commitRecord(r.root, "main", "x", "plan approved by U from the dashboard", async (d) => {
        const rel = "intent/x/intent.md";
        d.write(rel, d.read(rel)!.replace("status: plan-review", "status: plan-approved"));
      }, { request: req.id });
      const commits = (await run(["git", "rev-list", "--count", "HEAD"], r.root)).out.trim();
      await applyRequests(r.root, r.cfg, r.trace);
      expect(requestState(r.root, req.id)).toMatchObject({ state: "done", result: { ok: true, status: "plan-approved" } });
      expect((await run(["git", "rev-list", "--count", "HEAD"], r.root)).out.trim()).toBe(commits);
    } finally { r.cleanup(); }
  });
```

(`repoWithChange` stands for the helper `apply.test.ts` already uses to make a repository with change `x` at a status; use that helper's real name and shape. `CONSOLE`, `submitRequest`, `claimRequest`, `requestState` come from `src/requests`; `applyRequests` from `src/apply`; `commitRecord` from `src/context`.)

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/unit/apply.test.ts -t "landed but whose pass was killed"`
Expected: FAIL: the pass finds `plan-approved`, not the `plan-review` the request expects, and finishes it as "moved on".

- [ ] **Step 3: Add `landed`, and tag every record with its request** (`src/apply.ts`)

```ts
/**
 * True when a record of this request landed on main for `slug` (its commit carries the request's id,
 * see commitRecord): a pass the loop was killed in after the commit and before it finished the
 * request. Such a request is finished as applied, never written again.
 */
async function landed(root: string, id: string, slug: string): Promise<boolean> {
  const r = await new Git(root).run(["log", "-1", "--format=%H", "--fixed-strings", `--grep=Loopstra-Request: ${id}`, "HEAD", "--", `intent/${slug}`], { allowFail: true });
  return r.code === 0 && r.out.trim() !== "";
}
```

Every `commitRecord(...)` call in `src/apply.ts` passes `{ request: req.id }` as its last argument.

- [ ] **Step 4: Replace `stillOurs` with `landed` in each applier, and move the post-commit side effects after the commit**

- `applyAccept`: `const done = await landed(root, req.id, req.slug);` before the commit. When `done`, skip `commitRecord` and go to the trace and result lines. Otherwise the callback is `async (draft) => { const intent = await readIntent(root, req.slug); const was = intent.file.frontmatter.status; if (!(await writeIntent(intent, { status: "accepted", note: "" }, { expectStatus: "draft" }, draft))) { refused = was; return false; } return true; }`.
- `applyNew`: per intent, `const done = await landed(root, req.id, i.slug);`. The "already exists" check is skipped when `done`, and so is the commit; it is counted as added. The callback is `async (draft) => { draft.write(\`intent/${i.slug}/intent.md\`, i.text); }` (no `mkdirSync`).
- `applyStatus`: `const done = await landed(root, req.id, req.slug);`. When `done`, the `was !== req.expect` and `notAllowed` checks are skipped, and so is the commit. Otherwise the callback writes with `writeIntent(fresh, patchFor(req, to, note), { expectStatus: req.expect }, draft)` and the conversation entries with `writeRecord(req.slug, entry, draft)` (below). After the commit (or when `done`): `if (req.kind === "send-back") writeSentBack(root, req.slug, req.note.trim());`, then the existing trace lines and result. `writeSentBack` leaves the callback, since nothing must be kept for a record that did not land.
- `applyField`: `done` skips the hold/release refusals and the commit. The callback is `async (draft) => { await writeIntent(await readIntent(root, req.slug), patch, { remove }, draft); }`.
- `applyAnswer`: `done` skips the "no question waiting" and "question changed" refusals and the commit. The callback writes `writeIntent(..., {}, { remove: ["question"] }, draft)` and the answer entry with `writeRecord`. After the commit (or when `done`): `answerQuestion(root, req.slug, { text, by: req.byName, via: req.via });`.
- `writeRecord` becomes `function writeRecord(slug: string, entry: ConversationEntry, draft: RecordDraft): void { const rel = \`intent/${slug}/conversation.md\`; draft.write(rel, withEntry(draft.read(rel) ?? "", entry)); }`.
- `movedOn`: drop the two `written` lines. A send back that did not land wrote nothing, and its note is written only after a landed commit.
- `applyPass` give-up: drop `putBack`. When `tries >= MAX_TRIES && failing >= GIVE_UP_MS`, trace `result: "failed"` and finish with `"The loop could not apply this request; an engineer can find the details in the trace."`.
- Delete `CHANGED_SINCE`, `putBack`, `recordStillOurs`, `putBackConversation`, `intentHash`, `stillOurs`, `changedSince`, `markWritten`, `ownBefore`, and the imports only they used (`asAtHead`, `matchesHead`, `fileHash`, `onCheckout`, `takeBackAnswer` if nothing else uses it). `bun run deadcode` will name any export left without a user.

- [ ] **Step 5: Drop the fields from the request schema** (`src/requests.ts`): remove `written`, `writtenHash` and `recordHash` from `RequestSchema`'s base object. Confirm the base object is `.loose()` (or add it), so a claimed request an older version saved with them still reads.

- [ ] **Step 6: Replace the tests of the old machinery**

In `tests/unit/apply.test.ts` and `tests/integration/chat.test.ts`, find every test that sets `written`, `writtenHash` or `recordHash`, or writes intent.md by hand to stand for "an earlier try the loop was killed in before its commit" (`grep -n "killed before its commit\|writtenHash\|recordHash\|written:" tests/unit/apply.test.ts tests/integration/chat.test.ts`). Each becomes one of two cases:

- killed before its commit: nothing is on disk, and the request is applied fresh;
- killed after: the record is committed with `{ request: req.id }` as in Step 1, and the request is finished as applied without a second commit.

Rewrite each such test to the case it was protecting, and delete those that only tested the put-back of an uncommitted write. The give-up tests keep their wording, minus `CHANGED_SINCE`.

- [ ] **Step 7: Run the tests**

Run: `bun test tests/unit/apply.test.ts tests/unit/requests.test.ts tests/integration/chat.test.ts tests/unit/person-edits.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/apply.ts src/requests.ts tests/unit/apply.test.ts tests/integration/chat.test.ts
git commit -m "refactor(apply): a request's record carries its id, and a retry asks git whether it landed; the put-back family goes"
```

---

### Task 7: Docs and the whole suite

**Files:**
- Modify: `docs/decisions.md` (a new section at the end); README only if `grep -n "put back\|uncommitted" README.md` finds a description of the old behaviour.

- [ ] **Step 1: Write the decisions section**

```markdown
## Records through git plumbing (2026-10-19)

A record (a status, an artifact, a conversation entry, chat's drafts, the main-health draft) was written into the main checkout and then committed, and everything around it coped with the moment between: `commitRecord` snapshotted the files and put them back when the write threw or the commit failed, the applier kept hashes of what each request wrote to tell its own uncommitted write from a person's edit, and questions kept their own. The review of the hardening pass found two bugs in exactly that machinery. Now a record's write callback writes into a draft (`RecordDraft`), `commitRecord` builds the commit from main's HEAD, the change's folder and queue.md on disk and the draft over them in a temporary index (`Git.commitFiles`, hashing with `--path` so line endings are converted as `git add` converts them), moves HEAD with a compare-and-swap (`Git.moveHead`; tried once more when a person committed meanwhile, then `RecordRaced`), and only then writes the drafted files to the checkout, leaving any a person saved meanwhile. A kill between HEAD moving and the checkout matching leaves `.loopstra/recording.json`, which the next tick (and the next record) finishes (`settleRecord`). A request's commit carries `Loopstra-Request: <id>`, and a retried request asks git whether it landed instead of keeping hashes. `putBackRecord`, `nothingLanded`, the applier's `written`, `writtenHash`, `recordHash`, `stillOurs`, `ownBefore`, `changedSince`, `markWritten`, `putBack` and `putBackConversation`, and the question's `putBack` are gone.
```

Also edit the "Left as it was, on purpose" bullet in "Hardening pass (2026-10-18)" and the opening line of "The deferred items (2026-10-19)" so they no longer say this is left.

- [ ] **Step 2: The gates and the whole suite**

Run: `bun run typecheck && bun run lint && bun run deadcode && bun run test`
Expected: all clean; the suite's summary line ends `0 fail`.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions.md README.md
git commit -m "docs: records through git plumbing"
```
