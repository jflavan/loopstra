import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { changeDiff, cutDiff, DIFF_MAX_CHARS, DIFF_MAX_LINES } from "../../src/console/diff";
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
      expect(await changeDiff(repo.path, "main", "csv", { timeoutMs: 1 })).toEqual(none);
      expect(await changeDiff(repo.path, "main", "csv")).toEqual({ exists: true, stat: "", patch: "", cut: false });
    } finally {
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
