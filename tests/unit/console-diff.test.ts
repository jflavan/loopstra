import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { changeDiff, cutDiff, DIFF_MAX_CHARS, DIFF_MAX_LINES } from "../../src/console/diff";
import { Git, GitTimeout, type GitRunOptions } from "../../src/git";
import { run, tempGitRepo } from "../helpers";

describe("a change's diff", () => {
  test("its branch against main, and none for a change without a branch", async () => {
    const repo = await tempGitRepo();
    try {
      await run(["git", "checkout", "-q", "-b", "intent/csv"], repo.path);
      await Bun.write(join(repo.path, "src.txt"), "hello\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "add"], repo.path);
      await run(["git", "checkout", "-q", "main"], repo.path);
      const d = await changeDiff(repo.path, "main", "csv");
      expect(d).toMatchObject({ exists: true, cut: false });
      expect(d.stat).toContain("src.txt");
      expect(d.patch).toContain("+hello");
      expect(await changeDiff(repo.path, "main", "nope")).toEqual({ exists: false, stat: "", patch: "", cut: false });
    } finally {
      repo.cleanup();
    }
  });

  test("the patch names its files a/ and b/ even in a repository set to leave those prefixes out", async () => {
    const repo = await tempGitRepo();
    try {
      await run(["git", "config", "diff.noprefix", "true"], repo.path);
      await run(["git", "checkout", "-q", "-b", "intent/csv"], repo.path);
      await Bun.write(join(repo.path, "src.txt"), "hello\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "add"], repo.path);
      await run(["git", "checkout", "-q", "main"], repo.path);
      const d = await changeDiff(repo.path, "main", "csv");
      expect(d.patch).toContain("diff --git a/src.txt b/src.txt");
      expect(d.patch).toContain("+++ b/src.txt");
    } finally {
      repo.cleanup();
    }
  });

  test("none for a name that is not a change's, a main that is not a branch, or one that is missing; git that does not answer in time is not an error", async () => {
    const repo = await tempGitRepo();
    try {
      for (const branch of ["intent/csv", "intent/a_b"]) {
        await run(["git", "branch", branch], repo.path);
      }
      const none = { exists: false, stat: "", patch: "", cut: false };
      expect(await changeDiff(repo.path, "main", "a_b")).toEqual(none);
      expect(await changeDiff(repo.path, "--output=out.txt", "csv")).toEqual(none);
      expect(await changeDiff(repo.path, "main..x", "csv")).toEqual(none);
      expect(await changeDiff(repo.path, "trunk", "csv")).toEqual(none);
      // Where 1 ms runs out (finding the branches, or the diff) depends on the machine; either way it is no error.
      const late = await changeDiff(repo.path, "main", "csv", { timeoutMs: 1 });
      expect(late.problem).toBeUndefined();
      expect(late).toMatchObject({ stat: "", patch: "" });
      expect(await changeDiff(repo.path, "main", "csv")).toEqual({ exists: true, stat: "", patch: "", cut: false });
    } finally {
      repo.cleanup();
    }
  });

  test("a diff git fails to produce says so, rather than looking like no changes", async () => {
    const repo = await tempGitRepo();
    try {
      await run(["git", "checkout", "-q", "-b", "intent/csv"], repo.path);
      await Bun.write(join(repo.path, "src.txt"), "hello\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "add"], repo.path);
      await run(["git", "checkout", "-q", "main"], repo.path);
      // The branch is there, but one of its files is not: git finds the commit and fails on the diff.
      const blob = (await run(["git", "rev-parse", "intent/csv:src.txt"], repo.path)).out.trim();
      rmSync(join(repo.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
      const d = await changeDiff(repo.path, "main", "csv");
      expect(d).toMatchObject({ exists: true, stat: "", patch: "", cut: false });
      expect(d.problem).toMatch(/^The diff could not be read: \S/);
      expect(d.problem).not.toContain("\n");
    } finally {
      repo.cleanup();
    }
  });

  test("a diff that takes too long to produce, once the branches are found, is shown as cut", async () => {
    const repo = await tempGitRepo();
    const realRun = Git.prototype.run;
    try {
      await new Git(repo.path).run(["branch", "intent/csv"]);
      // A tiny time limit cannot be relied on to land after the branch checks and before the diff,
      // so the diff itself is the call that times out.
      Git.prototype.run = function (this: Git, args: string[], opts?: boolean | GitRunOptions) {
        if (args[0] === "diff") return Promise.reject(new GitTimeout(args, 30_000));
        return realRun.call(this, args, opts);
      };
      expect(await changeDiff(repo.path, "main", "csv")).toEqual({ exists: true, stat: "", patch: "", cut: true });
    } finally {
      Git.prototype.run = realRun;
      repo.cleanup();
    }
  });

  test("the repository's own diff converters are not run", async () => {
    const repo = await tempGitRepo();
    try {
      await run(["git", "config", "diff.shout.textconv", "echo CONVERTED"], repo.path);
      await run(["git", "checkout", "-q", "-b", "intent/csv"], repo.path);
      await Bun.write(join(repo.path, ".gitattributes"), "*.txt diff=shout\n");
      await Bun.write(join(repo.path, "src.txt"), "hello\n");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "add"], repo.path);
      const d = await changeDiff(repo.path, "main", "csv");
      expect(d.patch).toContain("+hello");
      expect(d.patch).not.toContain("CONVERTED");
    } finally {
      repo.cleanup();
    }
  });

  test("a long diff is cut, by lines and by size", () => {
    const long = Array.from({ length: DIFF_MAX_LINES + 10 }, (_, i) => `+${i}`).join("\n");
    expect(cutDiff(long).cut).toBe(true);
    expect(cutDiff(long).text.split("\n")).toHaveLength(DIFF_MAX_LINES);
    expect(cutDiff("x".repeat(DIFF_MAX_CHARS + 5)).text).toHaveLength(DIFF_MAX_CHARS);
    expect(cutDiff("+a\n-b")).toEqual({ text: "+a\n-b", cut: false });
  });
});
