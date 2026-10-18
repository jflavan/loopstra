import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseText, buildShippedIndex, closestBase, wasShipped, type ShippedIndex } from "../../src/shipped";
import { textSha } from "../../src/stamp";
import { run, tempGitRepo } from "../helpers";

async function commitFile(dir: string, rel: string, text: string): Promise<string> {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
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
      const c4 = await commitFile(repo.path, "templates/prompts/review.md", "ünïcode prompt\n");
      await commitFile(repo.path, "templates/REVIEW.md", "one\n");
      const index = await buildShippedIndex(repo.path);
      expect(index["templates/REVIEW.md"]).toEqual([
        { sha: textSha("one\n"), commit: c1 },
        { sha: textSha("two\n"), commit: c3 },
      ]);
      expect(index["templates/prompts/review.md"]).toEqual([{ sha: textSha("ünïcode prompt\n"), commit: c4 }]);
      expect(index["src/x.ts"]).toBeUndefined();
      expect(wasShipped(index, "templates/REVIEW.md", "two\r\n")).toBe(true);
      expect(wasShipped(index, "templates/REVIEW.md", "three\n")).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a repository with no templates has an empty index", async () => {
    const repo = await tempGitRepo();
    try {
      expect(await buildShippedIndex(repo.path)).toEqual({});
    } finally { repo.cleanup(); }
  });

  test("closestBase picks the version with the fewest differing lines", async () => {
    const texts: Record<string, string> = { a: "l1\nl2\nl3\n", b: "l1\nl2\nl3\nl4\nl5\n" };
    const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: textSha(texts.a!), commit: "a" }, { sha: textSha(texts.b!), commit: "b" }] };
    const fetch = async (_t: string, commit: string) => texts[commit] ?? null;
    const best = await closestBase(index, "templates/REVIEW.md", "l1\nl2\nl3\nl4\nmine\n", fetch);
    expect(best).toEqual({ sha: textSha(texts.b!), commit: "b", text: texts.b! });
    expect(await closestBase(index, "templates/REVIEW.md", "x\n", async () => null)).toBeNull();
  });

  test("baseText finds the text for a sha through the index", async () => {
    const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: "s1", commit: "c1" }] };
    const fetch = async (t: string, commit: string) => `${t}@${commit}`;
    expect(await baseText(index, "templates/REVIEW.md", "s1", fetch)).toBe("templates/REVIEW.md@c1");
    expect(await baseText(index, "templates/REVIEW.md", "nope", fetch)).toBeNull();
  });
});
