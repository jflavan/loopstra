import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import { run, tempGitRepo } from "../helpers";

async function repo() {
  const r = await tempGitRepo();
  mkdirSync(join(r.path, "intent", "a"), { recursive: true });
  writeFileSync(join(r.path, "intent", "a", "intent.md"), "---\nstatus: draft\n---\n");
  writeFileSync(join(r.path, "intent", "a", "old.md"), "old\n");
  writeFileSync(join(r.path, "other.txt"), "other\n");
  await run(["git", "add", "-A"], r.path);
  await run(["git", "commit", "-q", "-m", "base"], r.path);
  return r;
}

describe("Git.commitFiles", () => {
  test("a commit of the paths on disk with the changes over them; the checkout, its index and HEAD are untouched", async () => {
    const r = await repo();
    try {
      const git = new Git(r.path);
      const parent = await git.headSha();
      // A person's uncommitted edit in the folder is taken along; one outside it is not.
      writeFileSync(join(r.path, "intent", "a", "notes.md"), "a person's notes\n");
      writeFileSync(join(r.path, "other.txt"), "edited elsewhere\n");
      const commit = await git.commitFiles(parent, ["intent/a", "intent/queue.md"], [
        { rel: "intent/a/intent.md", text: "---\nstatus: accepted\n---\n" },
        { rel: "intent/a/old.md", text: null },
        { rel: "intent/queue.md", text: "# Queue\n" },
      ], "loopstra(a): accepted [skip ci]");
      expect(commit).not.toBeNull();
      expect((await run(["git", "show", `${commit}:intent/a/intent.md`], r.path)).out).toBe("---\nstatus: accepted\n---\n");
      expect((await run(["git", "show", `${commit}:intent/a/notes.md`], r.path)).out).toBe("a person's notes\n");
      expect((await run(["git", "cat-file", "-e", `${commit}:intent/a/old.md`], r.path)).code).not.toBe(0);
      expect((await run(["git", "show", `${commit}:other.txt`], r.path)).out).toBe("other\n");
      expect((await run(["git", "log", "-1", "--format=%P%n%s", commit!], r.path)).out.trim()).toBe(`${parent}\nloopstra(a): accepted [skip ci]`);
      // Untouched: HEAD, the index, the files.
      expect(await git.headSha()).toBe(parent);
      expect((await run(["git", "diff", "--cached", "--name-only"], r.path)).out.trim()).toBe("");
      expect(readFileSync(join(r.path, "intent", "a", "intent.md"), "utf8")).toBe("---\nstatus: draft\n---\n");
    } finally { r.cleanup(); }
  });

  test("nothing to commit gives null; no hook runs", async () => {
    const r = await repo();
    try {
      const git = new Git(r.path);
      writeFileSync(join(r.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const parent = await git.headSha();
      expect(await git.commitFiles(parent, ["intent/a"], [], "nothing")).toBeNull();
      expect(await git.commitFiles(parent, ["intent/a"], [{ rel: "intent/a/x.md", text: "x\n" }], "with a hook")).not.toBeNull();
    } finally { r.cleanup(); }
  });
});

describe("Git.moveHead", () => {
  test("moves HEAD only from the commit it expects", async () => {
    const r = await repo();
    try {
      const git = new Git(r.path);
      const parent = await git.headSha();
      const commit = (await git.commitFiles(parent, ["intent/a"], [{ rel: "intent/a/x.md", text: "x\n" }], "x"))!;
      expect(await git.moveHead("0".repeat(40), commit)).toBe(false);
      expect(await git.headSha()).toBe(parent);
      expect(await git.moveHead(parent, commit)).toBe(true);
      expect(await git.headSha()).toBe(commit);
      expect(await git.currentBranch()).toBe("main");
    } finally { r.cleanup(); }
  });
});
