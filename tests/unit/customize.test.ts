import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { customize } from "../../src/commands/customize";
import { init } from "../../src/init";
import { templatePath } from "../../src/package";
import { readStamp, STAMP_FILE, textSha } from "../../src/stamp";
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
      expect(await customize(repo.path, "review")).toEqual({ ok: false, text: "loopstra/prompts/review.md is already yours." });
      expect((await customize(repo.path, "nope")).text).toContain("No shipped prompt is called nope");
      expect((await customize(repo.path, "review.md")).ok).toBe(false);
      const list = await customize(repo.path, undefined);
      expect(list.ok).toBe(true);
      expect(list.text).toContain("  review (yours)\n");
      expect(list.text).toContain("  plan\n");
    } finally { repo.cleanup(); }
  });

  test("a repository with no stamp is upgraded first, so its old prompt copies are adopted", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      rmSync(join(repo.path, STAMP_FILE));
      const r = await customize(repo.path, "review");
      expect(r.ok).toBe(false);
      expect(r.text).toContain("run loopstra upgrade first");
      expect(existsSync(join(repo.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(existsSync(join(repo.path, STAMP_FILE))).toBe(false);
    } finally { repo.cleanup(); }
  });
});
