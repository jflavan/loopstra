import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextVersion, plan, shipsChanges } from "../../scripts/release";
import { run, tempGitRepo } from "../helpers";

describe("release", () => {
  test("next version: patch by default, minor for a breaking change, 0.1.0 first", () => {
    expect(nextVersion(null, [])).toBe("0.1.0");
    expect(nextVersion("0.4.2", [{ subject: "fix(x): y", body: "" }])).toBe("0.4.3");
    expect(nextVersion("0.4.2", [{ subject: "feat(x)!: y", body: "" }])).toBe("0.5.0");
    expect(nextVersion("0.4.2", [{ subject: "feat: y", body: "BREAKING CHANGE: z" }])).toBe("0.5.0");
    expect(nextVersion("0.4.2", [], "minor")).toBe("0.5.0");
    expect(nextVersion("0.4.2", [{ subject: "feat!: y", body: "" }], "patch")).toBe("0.4.3");
  });

  test("ships only when src/, templates/ or package.json changed", () => {
    expect(shipsChanges(["docs/a.md", "README.md"])).toBe(false);
    expect(shipsChanges(["src/cli.ts"])).toBe(true);
    expect(shipsChanges(["templates/REVIEW.md"])).toBe(true);
    expect(shipsChanges(["package.json"])).toBe(true);
  });

  test("plan: the first release, nothing new since a tag, a change to ship, and a commit already released", async () => {
    const repo = await tempGitRepo();
    try {
      const commit = async (path: string, subject: string) => {
        mkdirSync(join(repo.path, path, ".."), { recursive: true });
        writeFileSync(join(repo.path, path), `${subject}\n`);
        await run(["git", "add", "-A"], repo.path);
        await run(["git", "commit", "-qm", subject], repo.path);
      };
      await commit("src/cli.ts", "feat: a start");
      expect(await plan(repo.path)).toEqual({ version: "0.1.0", ship: true, previous: null });

      await run(["git", "tag", "v0.1.0"], repo.path);
      expect((await plan(repo.path)).ship).toBe(false);
      // A manual run asks for a release, but this commit is the release already.
      expect((await plan(repo.path, "patch")).ship).toBe(false);

      await commit("docs/a.md", "docs: a note");
      expect(await plan(repo.path)).toEqual({ version: "0.1.1", ship: false, previous: "0.1.0" });
      expect(await plan(repo.path, "minor")).toEqual({ version: "0.2.0", ship: true, previous: "0.1.0" });

      await commit("src/cli.ts", "feat!: a new start");
      expect(await plan(repo.path)).toEqual({ version: "0.2.0", ship: true, previous: "0.1.0" });

      // A run for an older commit that arrives after a newer one was released ships nothing.
      await run(["git", "tag", "v0.2.0"], repo.path);
      await run(["git", "checkout", "-q", "HEAD~1"], repo.path);
      expect((await plan(repo.path)).ship).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});
