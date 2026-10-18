import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunks, DIFF_CHUNK, Git, GitError, GitTimeout, removeWorktree, withDetachedWorktree, RUNTIME_COMMIT_CONFIG, RUNTIME_EMAIL, RUNTIME_NAME } from "../../src/git";
import { checkoutKey, onCheckout, onRemoteKey } from "../../src/lanes";
import { moveMain } from "../../src/remote";
import { requestStop, resetStop, StopRequested } from "../../src/stop";
import { lastCommit, run, setEnv, tempDir, tempGitRepo, withEnv } from "../helpers";

afterEach(() => resetStop());

/** Merges `branch` into the checked-out main as the merge step does: the merge commit, then main moved to it. */
async function mergeInto(git: Git, branch: string, method: "squash" | "merge", message: string): Promise<void> {
  const { from, to } = await git.mergeCommit(branch, method, message);
  const moved = await moveMain(git, from, to);
  if (!moved.ok) throw new GitError(["merge", branch], "", moved.error, 1);
}

describe("Git", () => {
  test("branch, worktree, commit, changed files, merge, cleanup", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.remoteName()).toBeNull();

    await git.createBranch("intent/x", "main");
    expect(await git.branchExists("intent/x")).toBe(true);

    const wt = join(repo.path, ".loopstra", "worktrees", "x");
    await git.worktreeAdd(wt, "intent/x");
    expect(existsSync(join(wt, "README.md"))).toBe(true);

    await Bun.write(join(wt, "src", "new.ts"), "export const a = 1;\n");
    const wtGit = new Git(wt);
    expect(await wtGit.isDirty()).toBe(true);
    await wtGit.commitAll("add new");
    expect(await wtGit.isDirty()).toBe(false);
    expect(await wtGit.changedFilesSince("main")).toEqual(["src/new.ts"]);

    expect(await git.isAncestor("main", "intent/x")).toBe(true);
    await mergeInto(git, "intent/x", "squash", "merge x");
    expect(existsSync(join(repo.path, "src", "new.ts"))).toBe(true);
    expect(await lastCommit(repo.path)).toContain("merge x");

    await git.worktreeRemove(wt);
    expect(existsSync(wt)).toBe(false);
    await git.deleteBranch("intent/x");
    expect(await git.branchExists("intent/x")).toBe(false);
    repo.cleanup();
  });

  test("ensureWorktree replaces a plain leftover directory, and commits through it land on the intent branch, not main", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await git.createBranch("intent/x", "main");
    const wt = join(repo.path, ".loopstra", "worktrees", "x");
    mkdirSync(wt, { recursive: true });
    await Bun.write(join(wt, "leftover.txt"), "stale");
    const mainBefore = await git.headSha();

    // A plain directory inside the repo resolves to the main checkout: committing through it would hit main.
    await expect(new Git(wt).assertBranch("intent/x")).rejects.toThrow(/intent\/x/);
    expect(await new Git(wt).isWorktreeRoot()).toBe(false);

    await git.ensureWorktree(wt, "intent/x");
    expect(existsSync(join(wt, "leftover.txt"))).toBe(false);
    const wtGit = new Git(wt);
    expect(await wtGit.isWorktreeRoot()).toBe(true);
    await wtGit.assertBranch("intent/x");
    await Bun.write(join(wt, "src", "add.ts"), "export const add = 1;\n");
    await wtGit.commitAll("add");
    expect(await git.headSha()).toBe(mainBefore);
    expect((await git.run(["cat-file", "-e", "main:src/add.ts"], true)).code).not.toBe(0);
    expect((await git.run(["cat-file", "-e", "intent/x:src/add.ts"], true)).code).toBe(0);

    // A healthy worktree on the right branch is reused as is.
    await Bun.write(join(wt, "scratch.txt"), "keep");
    await git.ensureWorktree(wt, "intent/x");
    expect(existsSync(join(wt, "scratch.txt"))).toBe(true);

    // A worktree on the wrong branch is replaced.
    await git.createBranch("intent/y", "main");
    await git.worktreeRemove(wt);
    await git.worktreeAdd(wt, "intent/y");
    await git.ensureWorktree(wt, "intent/x");
    expect(await new Git(wt).currentBranch()).toBe("intent/x");

    await git.worktreeRemove(wt);
    repo.cleanup();
  });

  test("commitPaths commits only the given paths", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "a.md"), "a");
    await Bun.write(join(repo.path, "b.md"), "b");
    await git.commitPaths(["a.md"], "only a");
    expect(await git.isDirty()).toBe(true);
    const shown = await git.run(["show", "--stat", "--oneline", "HEAD"]);
    expect(shown.out).toContain("a.md");
    expect(shown.out).not.toContain("b.md");
    repo.cleanup();
  });

  test("commitPaths commits the removal of a tracked file, and skips a path git has never seen", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    mkdirSync(join(repo.path, "d"), { recursive: true });
    await Bun.write(join(repo.path, "d", "old.md"), "old");
    await Bun.write(join(repo.path, "gone.md"), "gone");
    await git.commitAll("files");
    rmSync(join(repo.path, "gone.md"));
    rmSync(join(repo.path, "d"), { recursive: true });
    // Staged, never committed, then deleted: its staging is undone, and it is not named in the commit.
    await Bun.write(join(repo.path, "staged.md"), "s");
    await run(["git", "add", "staged.md"], repo.path);
    rmSync(join(repo.path, "staged.md"));
    await Bun.write(join(repo.path, "new.md"), "new");
    expect(await git.commitPaths(["gone.md", "d", "never.md", "staged.md", "new.md"], "removals")).toBe(true);
    expect((await git.run(["show", "--name-status", "--format=", "HEAD"])).out.trim().split(/\r?\n/).sort()).toEqual(["A\tnew.md", "D\td/old.md", "D\tgone.md"]);
    expect((await git.run(["status", "--porcelain"])).out.trim()).toBe("");
    // Only paths git has never seen: nothing to do.
    expect(await git.commitPaths(["never.md"], "nothing")).toBe(false);
    repo.cleanup();
  });

  test("commitPaths throws when git cannot stage (the index is locked)", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "a.md"), "a");
    await Bun.write(join(repo.path, ".git", "index.lock"), "");
    await expect(git.commitPaths(["a.md"], "a")).rejects.toBeInstanceOf(GitError);
    repo.cleanup();
  });

  test("commitPaths leaves out a path that is ignored and untracked, file or folder", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, ".gitignore"), ".loopstra/\n.claude/\n");
    await git.commitAll("ignore .claude");
    // A tracked file in an ignored folder is still committed.
    await Bun.write(join(repo.path, ".claude", "tracked.md"), "t");
    await run(["git", "add", "-f", ".claude/tracked.md"], repo.path);
    await git.commitAll("track one");
    await Bun.write(join(repo.path, ".claude", "skills", "SKILL.md"), "skill");
    await Bun.write(join(repo.path, ".claude", "tracked.md"), "t2");
    await Bun.write(join(repo.path, "a.md"), "a");
    expect(await git.commitPaths([".claude/skills/SKILL.md", ".claude/skills", ".claude/tracked.md", "a.md"], "a")).toBe(true);
    expect((await git.run(["show", "--name-only", "--format=", "HEAD"])).out.trim().split(/\r?\n/).sort()).toEqual([".claude/tracked.md", "a.md"]);
    // Only ignored paths: nothing to do.
    expect(await git.commitPaths([".claude/skills/SKILL.md"], "nothing")).toBe(false);
    repo.cleanup();
  });

  test("commitPaths commits a removal already staged with git rm, file or folder", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "b.md"), "b");
    await Bun.write(join(repo.path, "intent", "x", "intent.md"), "x");
    await git.commitAll("files");
    await run(["git", "rm", "-q", "b.md"], repo.path);
    await run(["git", "rm", "-q", "-r", "intent/x"], repo.path);
    expect(await git.commitPaths(["b.md", "intent/x", "intent/queue.md"], "record")).toBe(true);
    expect((await git.run(["show", "--name-status", "--format=", "HEAD"])).out.trim().split(/\r?\n/).sort()).toEqual(["D\tb.md", "D\tintent/x/intent.md"]);
    expect((await git.run(["status", "--porcelain"])).out.trim()).toBe("");
    repo.cleanup();
  });

  test("commitPaths with nothing to commit is a no-op", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    const before = await git.headSha();
    await git.commitPaths(["README.md"], "nothing");
    expect(await git.headSha()).toBe(before);
    repo.cleanup();
  });

  test("a merge commit has main and the branch as parents and the branch's tree; one that has not got main is refused", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await git.createBranch("intent/x", "main");
    const wt = join(repo.path, ".loopstra", "worktrees", "x");
    await git.worktreeAdd(wt, "intent/x");
    await Bun.write(join(wt, "src", "x.ts"), "export const x = 1;\n");
    await new Git(wt).commitAll("x");
    const before = await git.headSha();
    await mergeInto(git, "intent/x", "merge", "x: merge");
    expect((await git.run(["rev-parse", "main^1", "main^2"])).out.trim().split(/\r?\n/)).toEqual([before, await new Git(wt).headSha()]);
    expect((await git.run(["rev-parse", "main^{tree}"])).out.trim()).toBe((await git.run(["rev-parse", "intent/x^{tree}"])).out.trim());
    expect(existsSync(join(repo.path, "src", "x.ts"))).toBe(true);

    // A branch whose changes clash with main is never merged in the checkout: it has not got main, so it is refused.
    await git.createBranch("intent/conflict", "main~1");
    await Bun.write(join(repo.path, "README.md"), "main change\n");
    await git.commitAll("main change");
    const head = await git.headSha();
    await expect(git.mergeCommit("intent/conflict", "merge", "conflict")).rejects.toThrow(/does not contain/);
    expect(await git.headSha()).toBe(head);
    expect((await git.run(["status", "--porcelain"])).out.trim()).toBe("");

    await git.worktreeRemove(wt);
    repo.cleanup();
  });

  test("commitPaths leaves what a person staged elsewhere staged and out of the commit", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "README.md"), "# staged by a person\n");
    await run(["git", "add", "README.md"], repo.path);
    const before = await git.headSha();
    // Nothing to commit under the given path: no commit, even though something else is staged.
    await Bun.write(join(repo.path, "a.md"), "a");
    await git.commitPaths(["a.md"], "only a");
    expect(await git.commitPaths(["a.md"], "nothing new")).toBe(false);
    expect((await git.run(["rev-list", "--count", `${before}..HEAD`])).out.trim()).toBe("1");
    expect((await git.run(["show", "--name-only", "--format=", "HEAD"])).out.trim()).toBe("a.md");
    expect((await git.run(["diff", "--cached", "--name-only"])).out.trim()).toBe("README.md");
    repo.cleanup();
  });

  test("runtime commits are Loopstra's, skip the owner's hooks, and never ask to sign", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    const hook = join(repo.path, ".git", "hooks", "pre-commit");
    await Bun.write(hook, "#!/bin/sh\necho refused by hook >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    await run(["git", "config", "commit.gpgsign", "true"], repo.path);
    await run(["git", "config", "gpg.program", "loopstra-no-such-gpg"], repo.path);
    await Bun.write(join(repo.path, "a.md"), "a");
    expect(await git.commitPaths(["a.md"], "a")).toBe(true);
    await Bun.write(join(repo.path, "b.md"), "b");
    expect(await git.commitAll("b")).toBe(true);
    const who = `${RUNTIME_NAME} <${RUNTIME_EMAIL}>`;
    const authors = (await git.run(["log", "-2", "--format=%an <%ae>|%cn <%ce>"])).out.trim().split(/\r?\n/);
    expect(authors).toEqual([`${who}|${who}`, `${who}|${who}`]);
    repo.cleanup();
  });

  test("runtime commits are Loopstra's even with an author or committer named in the environment", async () => {
    const repo = await tempGitRepo();
    const restore = setEnv({ GIT_AUTHOR_NAME: "Person", GIT_AUTHOR_EMAIL: "person@example.com", GIT_COMMITTER_NAME: "Person", GIT_COMMITTER_EMAIL: "person@example.com" });
    try {
      const git = new Git(repo.path);
      await Bun.write(join(repo.path, "a.md"), "a");
      expect(await git.commitAll("a")).toBe(true);
      expect((await git.run(["log", "-1", "--format=%an|%ae|%cn|%ce"])).out.trim()).toBe(`${RUNTIME_NAME}|${RUNTIME_EMAIL}|${RUNTIME_NAME}|${RUNTIME_EMAIL}`);
    } finally { restore(); repo.cleanup(); }
  });

  test("runtime commits never start git's automatic gc or maintenance (another change may be committing meanwhile)", async () => {
    const repo = await tempGitRepo();
    try {
      await run(["git", "config", "gc.auto", "1"], repo.path);
      await run(["git", "config", "maintenance.auto", "true"], repo.path);
      const git = new Git(repo.path);
      // The settings every runtime commit carries, as git reads them.
      expect((await git.run([...RUNTIME_COMMIT_CONFIG, "config", "--get", "gc.auto"])).out.trim()).toBe("0");
      expect((await git.run([...RUNTIME_COMMIT_CONFIG, "config", "--get", "maintenance.auto"])).out.trim()).toBe("false");
    } finally { repo.cleanup(); }
  });

  test("fetches and fast-forward merges in the main checkout never start git's automatic gc or maintenance", async () => {
    const remote = tempDir("loopstra-remote-");
    const repo = await tempGitRepo();
    const log = join(remote.path, "..", `git-trace-${Date.now()}.log`);
    try {
      await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
      await run(["git", "remote", "add", "origin", remote.path], repo.path);
      await run(["git", "push", "-q", "origin", "main"], repo.path);
      const git = new Git(repo.path);
      await git.createBranch("feature", "main");
      const feature = (await git.run([...RUNTIME_COMMIT_CONFIG, "commit-tree", "main^{tree}", "-p", "main", "-m", "feature"])).out.trim();
      await git.run(["update-ref", "refs/heads/feature", feature]);
      const started = (what: () => Promise<unknown>) => withEnv({ GIT_TRACE: log }, async () => {
        rmSync(log, { force: true });
        await what();
        return existsSync(log) && /maintenance run --auto|gc --auto/.test(await Bun.file(log).text());
      });
      // What the test looks for: a plain fetch does start it.
      expect(await started(() => git.run(["fetch", "--quiet", "origin"]))).toBe(true);
      expect(await started(() => git.fetch(["--quiet", "origin"]))).toBe(false);
      expect(await started(() => mergeInto(git, "feature", "squash", "feature"))).toBe(false);
    } finally { rmSync(log, { force: true }); repo.cleanup(); remote.cleanup(); }
  });

  test("a git error names the real problem, not git's line-ending warnings", () => {
    const e = new GitError(["commit"], "", "fatal: something broke\nwarning: in the working copy of 'a.md', LF will be replaced by CRLF\n", 128);
    expect(e.message).toContain("fatal: something broke");
    expect(e.message).not.toContain("warning");
  });

  test("git never waits for a person: prompts are off and askpass programs are cleared", async () => {
    const repo = await tempGitRepo();
    const restore = setEnv({ SSH_ASKPASS: "/usr/bin/some-askpass" });
    try {
      const r = await new Git(repo.path).run(["-c", "alias.showenv=!env", "showenv"]);
      const env: Record<string, string> = {};
      for (const l of r.out.split(/\r?\n/)) {
        const i = l.indexOf("=");
        if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
      }
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GCM_INTERACTIVE).toBe("never");
      expect(env.GIT_ASKPASS ?? "").toBe("");
      expect(env.SSH_ASKPASS).toBeUndefined();
      expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    } finally {
      restore();
      repo.cleanup();
    }
  });

  test("a git call past its time limit is stopped and reported as a timeout", async () => {
    const repo = await tempGitRepo();
    const started = Date.now();
    const p = new Git(repo.path, { timeoutMs: 300 }).run(["-c", "alias.hang=!sleep 20", "hang"], true);
    await expect(p).rejects.toBeInstanceOf(GitTimeout);
    expect(Date.now() - started).toBeLessThan(10_000);
    repo.cleanup();
  });

  test("a stop kills a running git call and throws StopRequested; nothing starts after it", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path, { stopGraceMs: 100 });
    const started = Date.now();
    setTimeout(() => requestStop(), 200);
    await expect(git.run(["-c", "alias.hang=!sleep 20", "hang"], true)).rejects.toBeInstanceOf(StopRequested);
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(git.run(["status"])).rejects.toBeInstanceOf(StopRequested);
    // A cleanup call (an abort that puts things back) still runs after a stop.
    expect((await git.run(["status", "--porcelain"], { cleanup: true })).code).toBe(0);
    repo.cleanup();
  });

  test("a squash merge is one commit with the branch's tree, and nothing changes when it cannot land", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await git.createBranch("intent/x", "main");
    const wt = join(repo.path, ".loopstra", "worktrees", "x");
    await git.worktreeAdd(wt, "intent/x");
    await Bun.write(join(wt, "src", "a.ts"), "export const a = 1;\n");
    await Bun.write(join(wt, "notes.md"), "branch\n");
    await new Git(wt).commitAll("one");
    await Bun.write(join(wt, "src", "b.ts"), "export const b = 2;\n");
    await new Git(wt).commitAll("two");

    // Cannot land: a person's unsaved file where the change writes one. Nothing moves.
    await Bun.write(join(repo.path, "notes.md"), "a person's unsaved notes\n");
    const before = await git.headSha();
    await expect(mergeInto(git, "intent/x", "squash", "x: merge")).rejects.toBeInstanceOf(GitError);
    expect(await git.headSha()).toBe(before);
    expect(await Bun.file(join(repo.path, "notes.md")).text()).toBe("a person's unsaved notes\n");
    expect(existsSync(join(repo.path, "src", "a.ts"))).toBe(false);
    expect(existsSync(join(repo.path, ".loopstra", "moving-main"))).toBe(false);

    // Lands: exactly one new commit on main, with the branch's tree, and a clean index.
    rmSync(join(repo.path, "notes.md"), { force: true });
    await mergeInto(git, "intent/x", "squash", "x: merge");
    expect((await git.run(["rev-list", "--count", `${before}..main`])).out.trim()).toBe("1");
    expect((await git.run(["rev-parse", "main^"])).out.trim()).toBe(before);
    expect((await git.run(["rev-parse", "main^{tree}"])).out.trim()).toBe((await git.run(["rev-parse", "intent/x^{tree}"])).out.trim());
    expect((await git.run(["status", "--porcelain", "--untracked-files=no"])).out.trim()).toBe("");
    expect(await lastCommit(repo.path)).toContain("x: merge");

    // A branch that does not contain main is refused before anything is written.
    await Bun.write(join(repo.path, "later.md"), "later\n");
    await git.commitAll("later on main");
    const head = await git.headSha();
    await expect(git.mergeCommit("intent/x", "squash", "x: again")).rejects.toThrow(/does not contain/);
    expect(await git.headSha()).toBe(head);

    await git.worktreeRemove(wt);
    repo.cleanup();
  });
});

describe("Git across systems", () => {
  test("git speaks English whatever the machine's language", async () => {
    const repo = await tempGitRepo();
    const restore = setEnv({ LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LANGUAGE: "de" });
    try {
      // A shell alias prints the environment git itself was given.
      const env = (await new Git(repo.path).run(["-c", "alias.showenv=!env", "showenv"])).out.split(/\r?\n/);
      expect(env).toContain("LC_ALL=C");
      expect(env).toContain("LANG=C");
      expect(env.some((l) => l.startsWith("LANGUAGE="))).toBe(false);
      const err = await new Git(repo.path).run(["checkout", "no-such-branch"], true);
      expect(err.err).toContain("did not match any file(s) known to git");
    } finally { restore(); repo.cleanup(); }
  });

  test("chunks splits a list into slices of at most the given size", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });

  test("containsChanges compares hundreds of long paths without one huge command line", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      const dir = join("a-rather-long-folder-name", "with-another-long-folder-inside-it", "and-one-more-level");
      mkdirSync(join(repo.path, dir), { recursive: true });
      await run(["git", "checkout", "-q", "-b", "feature"], repo.path);
      const n = DIFF_CHUNK * 2 + 50;
      for (let i = 0; i < n; i++) await Bun.write(join(repo.path, dir, `generated-file-number-${String(i).padStart(4, "0")}.txt`), `${i}\n`);
      await git.commitAll("many files");
      await run(["git", "checkout", "-q", "main"], repo.path);
      await run(["git", "merge", "-q", "--squash", "feature"], repo.path);
      await run(["git", "commit", "-q", "-m", "squash"], repo.path);
      expect(await git.containsChanges("main", "feature")).toBe(true);
      // A difference in the last chunk is still seen.
      await Bun.write(join(repo.path, dir, `generated-file-number-${String(n - 1).padStart(4, "0")}.txt`), "changed\n");
      await git.commitAll("change the last file");
      expect(await git.containsChanges("main", "feature")).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("putBack puts back hundreds of files, and a name with brackets names only itself", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      const names = Array.from({ length: DIFF_CHUNK * 2 + 5 }, (_, i) => `generated-file-number-${String(i).padStart(4, "0")}.txt`);
      for (const f of [...names, "[id].txt", "i.txt"]) await Bun.write(join(repo.path, f), "first\n");
      await git.commitAll("files");
      for (const f of [...names, "[id].txt", "i.txt"]) await Bun.write(join(repo.path, f), "rewritten\n");
      await git.putBack([...names, "[id].txt"]);
      expect(await git.changedTrackedFiles()).toEqual(["i.txt"]);
    } finally { repo.cleanup(); }
  });

  test("containsChanges and changedFilesSince read non-ASCII paths and names with spaces", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      await git.createBranch("intent/x", "main");
      const wt = join(repo.path, ".loopstra", "worktrees", "x");
      await git.worktreeAdd(wt, "intent/x");
      await Bun.write(join(wt, "docs", "café.md"), "bonjour\n");
      await Bun.write(join(wt, "docs", "two words.md"), "spaced\n");
      await new Git(wt).commitAll("café");
      expect((await new Git(wt).changedFilesSince("main")).sort()).toEqual(["docs/café.md", "docs/two words.md"]);
      // git quotes such a name unless asked not to; quoted, it matched nothing, so main seemed to have it.
      expect(await git.containsChanges("main", "intent/x")).toBe(false);
      await run(["git", "merge", "-q", "--squash", "intent/x"], repo.path);
      await run(["git", "commit", "-q", "-m", "squash"], repo.path);
      expect(await git.containsChanges("main", "intent/x")).toBe(true);
      await git.worktreeRemove(wt);
    } finally { repo.cleanup(); }
  });
});

describe("Git and the locks", () => {
  /** Holds the checkout lock of `root` (or with `remote`, its remote lock) until the returned function is called. */
  function hold(root: string, which: "checkout" | "remote" = "checkout"): () => Promise<void> {
    let open = () => {};
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const held = which === "checkout" ? onCheckout(root, () => opened) : onRemoteKey(checkoutKey(root)!, () => opened);
    return async () => { open(); await held; };
  }

  /** True when `p` is still waiting after a moment. */
  async function waits(p: Promise<unknown>): Promise<boolean> {
    let done = false;
    void p.then(() => { done = true; }, () => { done = true; });
    await Bun.sleep(400);
    return !done;
  }

  test("a command that writes the main checkout's index or files waits for its checkout lock", async () => {
    const repo = await tempGitRepo();
    try {
      const free = hold(repo.path);
      const status = new Git(repo.path).run(["status", "--porcelain"]);
      expect(await waits(status)).toBe(true);
      await free();
      await status;
    } finally { repo.cleanup(); }
  });

  test("worktree administration, branches and reads of refs never wait for the checkout lock", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      const free = hold(repo.path);
      try {
        expect(await git.currentBranch()).toBe("main");
        await git.createBranch("intent/x", "main");
        const wt = join(repo.path, ".loopstra", "worktrees", "x");
        await git.ensureWorktree(wt, "intent/x");
        expect(await new Git(wt).currentBranch()).toBe("intent/x");
        await removeWorktree(git, wt);
        expect(existsSync(wt)).toBe(false);
        await git.deleteBranch("intent/x");
      } finally { await free(); }
    } finally { repo.cleanup(); }
  });

  test("fetch and push wait for the remote lock only", async () => {
    const remote = tempDir("loopstra-remote-");
    const repo = await tempGitRepo();
    try {
      await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
      await run(["git", "remote", "add", "origin", remote.path], repo.path);
      const git = new Git(repo.path);
      const freeCheckout = hold(repo.path);
      await git.run(["push", "-q", "origin", "main"]);
      await freeCheckout();
      const freeRemote = hold(repo.path, "remote");
      const fetch = git.fetch(["--quiet", "origin"]);
      expect(await waits(fetch)).toBe(true);
      await freeRemote();
      await fetch;
    } finally { repo.cleanup(); remote.cleanup(); }
  });

  test("a command inside the holder's own section goes straight through", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      expect(await onCheckout(repo.path, async () => (await git.run(["status", "--porcelain"])).code)).toBe(0);
    } finally { repo.cleanup(); }
  });

  test("a change's worktree takes no lock, whatever runs there", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      await git.createBranch("intent/x", "main");
      const wt = join(repo.path, ".loopstra", "worktrees", "x");
      await git.worktreeAdd(wt, "intent/x");
      const free = hold(repo.path);
      try {
        expect((await new Git(wt).run(["status", "--porcelain"])).code).toBe(0);
      } finally { await free(); }
    } finally { repo.cleanup(); }
  });

  test("a worktree whose add was killed part way (left locked) is removed, so it can be added again", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      const dir = join(repo.path, ".loopstra", "health", "main");
      await git.run(["worktree", "add", "--detach", dir, "main"]);
      await git.run(["worktree", "lock", "--reason", "initializing", dir]);
      rmSync(dir, { recursive: true, force: true });
      await removeWorktree(git, dir);
      await git.run(["worktree", "add", "--detach", dir, "main"]);
      expect(existsSync(join(dir, "README.md"))).toBe(true);
      await git.run(["worktree", "lock", dir]);
      await removeWorktree(git, dir);
      expect(existsSync(dir)).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a change's worktree whose folder is gone but whose entry is still locked 'initializing' can be ensured again", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      await git.createBranch("intent/x", "main");
      const wt = join(repo.path, ".loopstra", "worktrees", "x");
      await git.run(["worktree", "add", wt, "intent/x"]);
      await git.run(["worktree", "lock", "--reason", "initializing", wt]);
      rmSync(wt, { recursive: true, force: true });
      // A prune never takes a locked entry, so the add used to fail the same way on every try.
      await git.ensureWorktree(wt, "intent/x");
      expect(existsSync(join(wt, "README.md"))).toBe(true);
      expect(await new Git(wt).currentBranch()).toBe("intent/x");
      await removeWorktree(git, wt);
    } finally { repo.cleanup(); }
  });

  test("ensureWorktree replaces a worktree whose add was cut short, so no file is committed as deleted", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      for (let i = 0; i < 6; i++) await Bun.write(join(repo.path, `f${i}.txt`), `${i}\n`);
      await git.commitAll("files");
      await git.createBranch("intent/x", "main");
      const wt = join(repo.path, ".loopstra", "worktrees", "x");
      await git.ensureWorktree(wt, "intent/x");
      // What a `worktree add` killed part way leaves: its "initializing" lock, no index, half the files.
      const admin = join(repo.path, ".git", "worktrees", "x");
      rmSync(join(admin, "index"));
      for (let i = 3; i < 6; i++) rmSync(join(wt, `f${i}.txt`));
      writeFileSync(join(admin, "locked"), "initializing");

      await git.ensureWorktree(wt, "intent/x");
      for (let i = 0; i < 6; i++) expect(existsSync(join(wt, `f${i}.txt`))).toBe(true);
      expect(existsSync(join(admin, "locked"))).toBe(false);
      const wtGit = new Git(wt);
      expect(await wtGit.isDirty()).toBe(false);
      await Bun.write(join(wt, "new.txt"), "n\n");
      await wtGit.commitAll("save");
      expect((await wtGit.run(["show", "--name-status", "--format=", "HEAD"])).out.trim()).toBe("A\tnew.txt");
      await removeWorktree(git, wt);
    } finally { repo.cleanup(); }
  });
});

describe("worktree administration", () => {
  test("worktrees whose folders share a name (a snapshot and a done-check copy) can be added and removed at once", async () => {
    const repo = await tempGitRepo();
    try {
      const git = new Git(repo.path);
      // Both folders end in the same name, so git records both under .git/worktrees/<name>: added at
      // the same moment, with prunes beside them, one used to fail ("could not open ... gitdir").
      for (let round = 0; round < 8; round++) {
        const seen = await Promise.all(["snapshots", "verify", "sync"].map((where) =>
          withDetachedWorktree(git, join(repo.path, ".loopstra", where, "add-numbers"), "main", async (dir) => existsSync(join(dir, "README.md")))));
        expect(seen).toEqual([true, true, true]);
      }
      expect((await git.run(["worktree", "list", "--porcelain"])).out.match(/^worktree /gm)?.length).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  test.if(process.platform === "win32")("a teardown Windows refuses never hides the work's result (Windows)", async () => {
    const repo = await tempGitRepo();
    let child = null as ReturnType<typeof Bun.spawn<"pipe", "ignore", "ignore">> | null;
    try {
      const git = new Git(repo.path);
      const dir = join(repo.path, ".loopstra", "verify", "x");
      // A process the work left running in the copy (a test runner, a server): Windows will not delete the folder it runs in.
      const failed: unknown[] = [];
      const r = await withDetachedWorktree(git, dir, "main", async (cwd) => {
        child = Bun.spawn({ cmd: [process.execPath, "-e", "await Bun.stdin.text()"], cwd, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
        await Bun.sleep(300);
        return "passed";
      }, (e) => failed.push(e));
      expect(r).toBe("passed");
      // The failed removal is not lost: the caller is told, to trace it.
      expect(failed).toHaveLength(1);
      child!.stdin.end();
      await child!.exited;
      // What was left is removed by the next add at that path.
      expect(await withDetachedWorktree(git, dir, "main", async (cwd) => existsSync(join(cwd, "README.md")))).toBe(true);
    } finally {
      child?.kill();
      repo.cleanup();
    }
  });
});
