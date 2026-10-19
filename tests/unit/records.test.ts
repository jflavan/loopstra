import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitRecord, RecordRaced, setStatus, settleRecord } from "../../src/context";
import { Git } from "../../src/git";
import { run, setupRepo } from "../helpers";

const SLUG = "add-numbers";
const md = (root: string) => join(root, "intent", SLUG, "intent.md");

describe("commitRecord through plumbing", () => {
  test("the commit lands before the file changes, and the checkout matches it after", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const before = readFileSync(md(repo.path), "utf8");
      const head = await new Git(repo.path).headSha();
      expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
        // Nothing is on disk yet while the callback runs.
        expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      })).toBe(true);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect(await new Git(repo.path).headSha()).not.toBe(head);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a callback that throws leaves HEAD, the index and the files as they were", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const before = readFileSync(md(repo.path), "utf8");
      const head = await new Git(repo.path).headSha();
      await expect(commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, "x");
        throw new Error("SQLITE_BUSY");
      })).rejects.toThrow("SQLITE_BUSY");
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect(await new Git(repo.path).headSha()).toBe(head);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a person's save of a drafted file during the record stays on disk, uncommitted; the commit has the record's", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const moveHead = Git.prototype.moveHead;
    try {
      const before = readFileSync(md(repo.path), "utf8");
      // The person saves after the commit was built and before HEAD moves.
      Git.prototype.moveHead = async function (this: Git, from: string, to: string) {
        writeFileSync(md(repo.path), "a person's version\n");
        return moveHead.call(this, from, to);
      };
      await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
      });
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toBe("a person's version\n");
    } finally { Git.prototype.moveHead = moveHead; trace.close(); repo.cleanup(); }
  });

  test("HEAD moved by a person's commit during the record is tried again from the new HEAD; moved every time, RecordRaced", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      let calls = 0;
      await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        if (calls++ === 0) {
          writeFileSync(join(repo.path, "person.txt"), "p\n");
          await run(["git", "add", "person.txt"], repo.path);
          await run(["git", "commit", "-q", "-m", "a person's commit"], repo.path);
        }
        d.write(`intent/${SLUG}/note.md`, "n\n");
      });
      expect(calls).toBe(2);
      expect((await run(["git", "log", "-2", "--format=%s"], repo.path)).out).toContain("a person's commit");
      let n = 0;
      await expect(commitRecord(repo.path, "main", SLUG, "racing", async (d) => {
        writeFileSync(join(repo.path, `p${n}.txt`), "p\n");
        await run(["git", "add", `p${n}.txt`], repo.path);
        await run(["git", "commit", "-q", "-m", `person ${n++}`], repo.path);
        d.write(`intent/${SLUG}/other.md`, "o\n");
      })).rejects.toBeInstanceOf(RecordRaced);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a step's status change that meets a person's commit is tried again from the status it began with", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const moveHead = Git.prototype.moveHead;
    try {
      let moves = 0;
      // A person commits elsewhere on main after the first commit was built and before HEAD moves.
      Git.prototype.moveHead = async function (this: Git, from: string, to: string) {
        if (moves++ === 0) {
          writeFileSync(join(repo.path, "person.txt"), "p\n");
          await run(["git", "add", "person.txt"], repo.path);
          await run(["git", "commit", "-q", "-m", "a person's commit"], repo.path);
        }
        return moveHead.call(this, from, to);
      };
      await setStatus(ctx, "designing", "on it");
      expect(moves).toBe(2);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(ctx.intent.file.frontmatter.status).toBe("designing");
    } finally { Git.prototype.moveHead = moveHead; trace.close(); repo.cleanup(); }
  });
});

describe("settleRecord", () => {
  async function killedAfterHeadMoved(root: string): Promise<{ parent: string; commit: string }> {
    const git = new Git(root);
    const parent = await git.headSha();
    const text = readFileSync(md(root), "utf8").replace("status: accepted", "status: designing");
    const commit = (await git.commitFiles(parent, [`intent/${SLUG}`], [{ rel: `intent/${SLUG}/intent.md`, text }], "loopstra(add-numbers): killed [skip ci]"))!;
    writeFileSync(join(root, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
    expect(await git.moveHead(parent, commit)).toBe(true);
    return { parent, commit };
  }

  test("HEAD moved, the file not yet written: it is brought up to the commit, and the index with it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await killedAfterHeadMoved(repo.path);
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a file a person edited since is left as they left it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await killedAfterHeadMoved(repo.path);
      writeFileSync(md(repo.path), "a person's version\n");
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toBe("a person's version\n");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("HEAD never moved: the marker goes and nothing else changes", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const git = new Git(repo.path);
      const parent = await git.headSha();
      writeFileSync(join(repo.path, ".loopstra", "recording.json"), JSON.stringify({ parent, commit: "1".repeat(40), slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
      const before = readFileSync(md(repo.path), "utf8");
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect(await git.headSha()).toBe(parent);
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("main reset by a person to something without the commit: the marker goes and the files stay", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const { parent } = await killedAfterHeadMoved(repo.path);
      await run(["git", "reset", "-q", "--hard", parent], repo.path);
      writeFileSync(join(repo.path, "person.txt"), "p\n");
      await run(["git", "add", "person.txt"], repo.path);
      await run(["git", "commit", "-q", "-m", "a person's commit"], repo.path);
      const before = readFileSync(md(repo.path), "utf8");
      await settleRecord(repo.path, trace);
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });
});
