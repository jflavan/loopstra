import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRecord, landed, setStatus, settleRecord } from "../../src/context";
import { Git } from "../../src/git";
import type { RecordDraft } from "../../src/record-draft";
import { RecordRaced, RecordUnsettled, requestStop, resetStop } from "../../src/stop";
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
    const moveRef = Git.prototype.moveRef;
    try {
      const before = readFileSync(md(repo.path), "utf8");
      // The person saves after the commit was built and before HEAD moves.
      Git.prototype.moveRef = async function (this: Git, ref: string, from: string, to: string) {
        writeFileSync(md(repo.path), "a person's version\n");
        return moveRef.call(this, ref, from, to);
      };
      await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
      });
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toBe("a person's version\n");
    } finally { Git.prototype.moveRef = moveRef; trace.close(); repo.cleanup(); }
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
    const moveRef = Git.prototype.moveRef;
    try {
      let moves = 0;
      // A person commits elsewhere on main after the first commit was built and before HEAD moves.
      Git.prototype.moveRef = async function (this: Git, ref: string, from: string, to: string) {
        if (moves++ === 0) {
          writeFileSync(join(repo.path, "person.txt"), "p\n");
          await run(["git", "add", "person.txt"], repo.path);
          await run(["git", "commit", "-q", "-m", "a person's commit"], repo.path);
        }
        return moveRef.call(this, ref, from, to);
      };
      await setStatus(ctx, "designing", "on it");
      expect(moves).toBe(2);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(ctx.intent.file.frontmatter.status).toBe("designing");
      // Traced once, for the try that landed.
      expect(trace.events(SLUG).filter((e) => e.type === "status_change")).toHaveLength(1);
    } finally { Git.prototype.moveRef = moveRef; trace.close(); repo.cleanup(); }
  });
});

describe("settleRecord", () => {
  async function killedAfterHeadMoved(root: string): Promise<{ parent: string; commit: string }> {
    const git = new Git(root);
    const parent = await git.headSha();
    const text = readFileSync(md(root), "utf8").replace("status: accepted", "status: designing");
    const commit = (await git.commitFiles(parent, [`intent/${SLUG}`], [{ rel: `intent/${SLUG}/intent.md`, text }], "loopstra(add-numbers): killed [skip ci]"))!;
    writeFileSync(join(root, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
    expect(await git.moveRef("refs/heads/main", parent, commit)).toBe(true);
    return { parent, commit };
  }

  test("HEAD moved, the file not yet written: it is brought up to the commit, and the index with it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await killedAfterHeadMoved(repo.path);
      expect(await settleRecord(repo.path, "main", trace)).toBe(true);
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
      expect(await settleRecord(repo.path, "main", trace)).toBe(true);
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
      expect(await settleRecord(repo.path, "main", trace)).toBe(true);
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
      expect(await settleRecord(repo.path, "main", trace)).toBe(true);
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a record a kill cut short that cannot be finished yet stops the next record, which commits nothing over it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const lock = join(repo.path, ".git", "index.lock");
    try {
      const { commit } = await killedAfterHeadMoved(repo.path);
      // A person's git holds the index: the checkout cannot be brought up to the landed record.
      writeFileSync(lock, "");
      expect(await settleRecord(repo.path, "main", trace)).toBe(false);
      const refused = await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/note.md`, "n\n");
      }, { trace }).then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(RecordUnsettled);
      expect((refused as Error).message).toBe("a record a kill cut short could not be finished yet; it is tried again");
      expect(await new Git(repo.path).headSha()).toBe(commit);
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(true);
      rmSync(lock);
      expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/note.md`, "n\n");
      }, { trace })).toBe(true);
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally { rmSync(lock, { force: true }); trace.close(); repo.cleanup(); }
  });

  test("off main, the marker and the files are left alone; back on main, the record is finished", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await killedAfterHeadMoved(repo.path);
      const before = readFileSync(md(repo.path), "utf8");
      await run(["git", "checkout", "-q", "-b", "elsewhere"], repo.path);
      expect(await settleRecord(repo.path, "main", trace)).toBe(false);
      expect(readFileSync(md(repo.path), "utf8")).toBe(before);
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(true);
      await run(["git", "checkout", "-q", "main"], repo.path);
      expect(await settleRecord(repo.path, "main", trace)).toBe(true);
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("commitRecord after HEAD moved", () => {
  test("a drafted file that cannot be written does not stop the others; the record is reported landed, the marker stays and the trace says so", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const moveRef = Git.prototype.moveRef;
    try {
      // A folder appears where the first drafted file goes, after the commit was built.
      Git.prototype.moveRef = async function (this: Git, ref: string, from: string, to: string) {
        mkdirSync(join(repo.path, "intent", SLUG, "note.md"), { recursive: true });
        return moveRef.call(this, ref, from, to);
      };
      expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/note.md`, "n\n");
        d.write(`intent/${SLUG}/other.md`, "o\n");
      }, { trace })).toBe(true);
      expect((await run(["git", "log", "-1", "--format=%s"], repo.path)).out).toContain("loopstra(add-numbers): a note");
      expect(readFileSync(join(repo.path, "intent", SLUG, "other.md"), "utf8")).toBe("o\n");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(true);
      expect(trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes("note.md"))).toBe(true);
    } finally { Git.prototype.moveRef = moveRef; trace.close(); repo.cleanup(); }
  });

  test("a person's save between the draft reading a file and writing it stays on disk, uncommitted", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        const read = d.read(`intent/${SLUG}/intent.md`)!;
        // The person saves after the draft read the file, while the callback is still running.
        writeFileSync(md(repo.path), "a person's version\n");
        d.write(`intent/${SLUG}/intent.md`, read.replace("status: accepted", "status: designing"));
      });
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toBe("a person's version\n");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a stop asked for once the commit is built does not stop the record: it lands and the checkout matches", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const moveRef = Git.prototype.moveRef;
    try {
      Git.prototype.moveRef = async function (this: Git, ref: string, from: string, to: string) {
        requestStop();
        return moveRef.call(this, ref, from, to);
      };
      const before = readFileSync(md(repo.path), "utf8");
      expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
      })).toBe(true);
      // (Read with plain git: Loopstra's own git calls refuse to start after a stop.)
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "recording.json"))).toBe(false);
    } finally { Git.prototype.moveRef = moveRef; resetStop(); trace.close(); repo.cleanup(); }
  });
});

describe("commitRecord beside a person's branch switch", () => {
  const marker = (root: string) => join(root, ".loopstra", "recording.json");
  const sha = async (root: string, ref: string) => (await run(["git", "rev-parse", ref], root)).out.trim();

  for (const how of ["a new branch", "a branch that exists"] as const) {
    test(`a switch to ${how} during the record: it lands on main, their branch is left as it was, the checkout is not written off main, and back on main a settle finishes it`, async () => {
      const { repo, trace } = await setupRepo("accepted");
      try {
        if (how === "a branch that exists") {
          await run(["git", "switch", "-q", "-c", "theirs"], repo.path);
          writeFileSync(join(repo.path, "theirs.txt"), "t\n");
          await run(["git", "add", "theirs.txt"], repo.path);
          await run(["git", "commit", "-q", "-m", "their work"], repo.path);
          await run(["git", "switch", "-q", "main"], repo.path);
        }
        const parent = await sha(repo.path, "main");
        const theirs = how === "a branch that exists" ? await sha(repo.path, "theirs") : parent;
        const before = readFileSync(md(repo.path), "utf8");
        expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
          d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
          await run(how === "a new branch" ? ["git", "switch", "-q", "-c", "theirs"] : ["git", "switch", "-q", "theirs"], repo.path);
        }, { trace })).toBe(true);
        expect((await run(["git", "show", `main:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
        expect(await sha(repo.path, "main^")).toBe(parent);
        expect(await sha(repo.path, "theirs")).toBe(theirs);
        expect((await run(["git", "symbolic-ref", "--short", "HEAD"], repo.path)).out.trim()).toBe("theirs");
        // Off main the checkout is the person's branch: nothing of the record is written there.
        expect(readFileSync(md(repo.path), "utf8")).toContain("status: accepted");
        expect(existsSync(marker(repo.path))).toBe(true);
        await run(["git", "switch", "-q", "main"], repo.path);
        expect(await settleRecord(repo.path, "main", trace)).toBe(true);
        expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
        expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
        expect(existsSync(marker(repo.path))).toBe(false);
      } finally { trace.close(); repo.cleanup(); }
    });
  }

  test("a failure after main moved (the marker cannot be removed) does not make the record a failed one", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const moveRef = Git.prototype.moveRef;
    try {
      // A folder stands where the marker was once main has moved, so removing the marker throws.
      Git.prototype.moveRef = async function (this: Git, ref: string, from: string, to: string) {
        const moved = await moveRef.call(this, ref, from, to);
        if (moved) { rmSync(marker(repo.path)); mkdirSync(join(marker(repo.path), "x"), { recursive: true }); }
        return moved;
      };
      const before = readFileSync(md(repo.path), "utf8");
      expect(await commitRecord(repo.path, "main", SLUG, "a note", async (d) => {
        d.write(`intent/${SLUG}/intent.md`, before.replace("status: accepted", "status: designing"));
      }, { trace })).toBe(true);
      expect((await run(["git", "show", `HEAD:intent/${SLUG}/intent.md`], repo.path)).out).toContain("status: designing");
      expect(readFileSync(md(repo.path), "utf8")).toContain("status: designing");
      expect(trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes('"where":"record"'))).toBe(true);
    } finally { Git.prototype.moveRef = moveRef; trace.close(); repo.cleanup(); }
  });

  test("two records of different changes made at once both land, one after the other, and the checkout matches both", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      mkdirSync(join(repo.path, "intent", "other"), { recursive: true });
      const parent = await sha(repo.path, "main");
      const landedBoth = await Promise.all([
        commitRecord(repo.path, "main", SLUG, "one", async (d) => { d.write(`intent/${SLUG}/one.md`, "1\n"); }, { trace }),
        commitRecord(repo.path, "main", "other", "two", async (d) => { d.write("intent/other/two.md", "2\n"); }, { trace }),
      ]);
      expect(landedBoth).toEqual([true, true]);
      expect((await run(["git", "rev-list", "--count", `${parent}..main`], repo.path)).out.trim()).toBe("2");
      expect((await run(["git", "show", `main:intent/${SLUG}/one.md`], repo.path)).out).toBe("1\n");
      expect((await run(["git", "show", "main:intent/other/two.md"], repo.path)).out).toBe("2\n");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("landed", () => {
  const ID = "000000000000001-1-0001";
  /** A record of SLUG that adds one file, so each commits something. */
  const note = (n: string) => async (d: RecordDraft) => { d.write(`intent/${SLUG}/note-${n}.md`, n); };

  test("only a record whose trailer line is exactly the id landed for it, and only in its change's folder", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      // A subject that names the id (a person's name can say anything), and a longer id the id begins.
      await commitRecord(repo.path, "main", SLUG, `accepted by Loopstra-Request: ${ID}`, note("1"));
      await commitRecord(repo.path, "main", SLUG, "a note", note("2"), { request: `${ID}0` });
      expect(await landed(repo.path, "main", ID, SLUG)).toBe(false);
      await commitRecord(repo.path, "main", SLUG, "a note", note("3"), { request: ID });
      expect(await landed(repo.path, "main", ID, SLUG)).toBe(true);
      expect(await landed(repo.path, "main", ID, "another-change")).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("it asks the main branch, not the branch a person has the checkout on", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await commitRecord(repo.path, "main", SLUG, "a note", note("1"), { request: ID });
      // A branch from before the record: its history does not have it, main's does.
      await run(["git", "switch", "-q", "-c", "theirs", "main^"], repo.path);
      expect(await landed(repo.path, "main", ID, SLUG)).toBe(true);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("since bounds the walk to an hour before it; one that is not a date bounds nothing", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      await commitRecord(repo.path, "main", SLUG, "a note", note("1"), { request: ID });
      expect(await landed(repo.path, "main", ID, SLUG, new Date().toISOString())).toBe(true);
      // A request made two hours after the record: the record is older than the walk looks.
      expect(await landed(repo.path, "main", ID, SLUG, new Date(Date.now() + 2 * 3_600_000).toISOString())).toBe(false);
      expect(await landed(repo.path, "main", ID, SLUG, "not a date")).toBe(true);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a git log that fails throws, never reads as not landed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loopstra-not-a-repo-"));
    try {
      await expect(landed(dir, "main", ID, SLUG)).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
