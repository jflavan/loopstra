import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { tempGitRepo } from "../helpers";

describe("Git", () => {
  test("branch, worktree, commit, changed files, merge, cleanup", async () => {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.hasRemote()).toBe(false);

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
    expect((await git.log(1))[0]).toContain("merge x");

    await git.worktreeRemove(wt);
    expect(existsSync(wt)).toBe(false);
    await git.deleteBranch("intent/x");
    expect(await git.branchExists("intent/x")).toBe(false);
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
      await git.merge("intent/conflict", "squash", "merge conflict");
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
});
