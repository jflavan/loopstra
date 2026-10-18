import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baseOf, baseText, buildShippedIndex, closestBase, wasShipped, type ShippedIndex } from "../../src/shipped";
import { textSha } from "../../src/stamp";
import { run, tempDir, tempGitRepo } from "../helpers";

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

  test("closestBase: a tie goes to the newer version; any version that cannot be read gives null", async () => {
    const texts: Record<string, string> = { a: "l1\nA\n", b: "l1\nB\n", c: "l1\nC\n" };
    const index: ShippedIndex = { "templates/REVIEW.md": ["a", "b", "c"].map((c) => ({ sha: textSha(texts[c]!), commit: c })) };
    expect((await closestBase(index, "templates/REVIEW.md", "l1\nX\n", async (_t, commit) => texts[commit]!))?.commit).toBe("c");
    // The one that cannot be read may be the closest: no choice among the rest.
    expect(await closestBase(index, "templates/REVIEW.md", "l1\nX\n", async (_t, commit) => (commit === "c" ? null : texts[commit]!))).toBeNull();
  });

  test("baseOf: the shipped version a file is, today's text with no versions known, else the closest; offline throws", async () => {
    const t = tempDir();
    try {
      writeFileSync(join(t.path, "REVIEW.md"), "today\n");
      const file = { path: "REVIEW.md", template: "templates/REVIEW.md", shipped: join(t.path, "REVIEW.md") };
      const texts: Record<string, string> = { a: "l1\nl2\n", b: "l1\nl2\nl3\n" };
      const index: ShippedIndex = { "templates/REVIEW.md": ["a", "b"].map((c) => ({ sha: textSha(texts[c]!), commit: c })) };
      const fetch = async (_t: string, commit: string) => texts[commit] ?? null;
      expect(await baseOf(index, file, texts.a!, async () => null)).toEqual({ sha: textSha(texts.a!) });
      expect(await baseOf({}, file, "mine\n", fetch)).toEqual({ sha: textSha("today\n"), note: "REVIEW.md is your own; Loopstra knows no earlier version of it, so it is left as it is." });
      expect(await baseOf(index, file, "l1\nl2\nl3\nmine\n", fetch)).toEqual({ sha: textSha(texts.b!), note: "REVIEW.md is your own; it is merged from the shipped version of commit b." });
      await expect(baseOf(index, file, "mine\n", async () => null)).rejects.toThrow("Loopstra's shipped versions of REVIEW.md could not be read to merge from; check the connection and run loopstra upgrade again.");
    } finally { t.cleanup(); }
  });

  test("baseText finds the text for a sha through the index", async () => {
    const index: ShippedIndex = { "templates/REVIEW.md": [{ sha: "s1", commit: "c1" }] };
    const fetch = async (t: string, commit: string) => `${t}@${commit}`;
    expect(await baseText(index, "templates/REVIEW.md", "s1", fetch)).toBe("templates/REVIEW.md@c1");
    expect(await baseText(index, "templates/REVIEW.md", "nope", fetch)).toBeNull();
  });
});
