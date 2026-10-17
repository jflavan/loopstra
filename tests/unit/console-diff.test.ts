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

  test("a long diff is cut, by lines and by size", () => {
    const long = Array.from({ length: DIFF_MAX_LINES + 10 }, (_, i) => `+${i}`).join("\n");
    expect(cutDiff(long).cut).toBe(true);
    expect(cutDiff(long).text.split("\n")).toHaveLength(DIFF_MAX_LINES);
    expect(cutDiff("x".repeat(DIFF_MAX_CHARS + 5)).text).toHaveLength(DIFF_MAX_CHARS);
    expect(cutDiff("+a\n-b")).toEqual({ text: "+a\n-b", cut: false });
  });
});
