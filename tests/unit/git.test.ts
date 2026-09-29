import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git, GitError, GitTimeout, RUNTIME_EMAIL, RUNTIME_NAME } from "../../src/git";
import { requestStop, resetStop, StopRequested } from "../../src/stop";
import { lastCommit, run, setEnv, tempGitRepo } from "../helpers";

afterEach(() => resetStop());

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
    await git.merge("intent/x", "squash", "merge x");
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

  test("commitPaths with nothing to commit is a no-op", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    const before = await git.headSha();
    await git.commitPaths(["README.md"], "nothing");
    expect(await git.headSha()).toBe(before);
    repo.cleanup();
  });

  test("a conflicting merge aborts cleanly and the error mentions the conflict", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await git.createBranch("intent/conflict", "main");
    const wt = join(repo.path, ".loopstra", "worktrees", "conflict");
    await git.worktreeAdd(wt, "intent/conflict");
    const wtGit = new Git(wt);
    await Bun.write(join(wt, "README.md"), "branch change\n");
    await wtGit.commitAll("branch change");
    await Bun.write(join(repo.path, "README.md"), "main change\n");
    await git.commitAll("main change");

    let error: Error | undefined;
    try {
      await git.merge("intent/conflict", "merge", "merge conflict");
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/README\.md|conflict/i);
    expect(await git.isDirty()).toBe(false);
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
    await Bun.write(join(repo.path, "README.md"), "# staged by a person\n");
    await run(["git", "add", "README.md"], repo.path);
    const before = await git.headSha();
    await expect(git.merge("intent/x", "squash", "x: merge")).rejects.toBeInstanceOf(GitError);
    expect(await git.headSha()).toBe(before);
    expect((await git.run(["diff", "--cached", "--name-only"])).out.trim()).toBe("README.md");
    expect(await Bun.file(join(repo.path, "notes.md")).text()).toBe("a person's unsaved notes\n");
    expect(existsSync(join(repo.path, "src", "a.ts"))).toBe(false);

    // Lands: exactly one new commit on main, with the branch's tree, and a clean index.
    await run(["git", "reset", "-q"], repo.path);
    await run(["git", "checkout", "-q", "--", "README.md"], repo.path);
    rmSync(join(repo.path, "notes.md"), { force: true });
    await git.merge("intent/x", "squash", "x: merge");
    expect((await git.run(["rev-list", "--count", `${before}..main`])).out.trim()).toBe("1");
    expect((await git.run(["rev-parse", "main^"])).out.trim()).toBe(before);
    expect((await git.run(["rev-parse", "main^{tree}"])).out.trim()).toBe((await git.run(["rev-parse", "intent/x^{tree}"])).out.trim());
    expect((await git.run(["status", "--porcelain", "--untracked-files=no"])).out.trim()).toBe("");
    expect(await lastCommit(repo.path)).toContain("x: merge");

    // A branch that does not contain main is refused before anything is written.
    await Bun.write(join(repo.path, "later.md"), "later\n");
    await git.commitAll("later on main");
    const head = await git.headSha();
    await expect(git.merge("intent/x", "squash", "x: again")).rejects.toThrow(/does not contain/);
    expect(await git.headSha()).toBe(head);

    await git.worktreeRemove(wt);
    repo.cleanup();
  });
});
