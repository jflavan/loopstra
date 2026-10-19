import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, configPath } from "../../src/config";
import { Git, GitError } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import {
  StepContext, block, blockNote, clearMarker, commitRecord, MainCheckoutMoved, OFF_MAIN_NOTE, onceMarker, PersonChangedStatus,
  readArtifact, setStatus, statusPatch, writeArtifact, writeIntentPriority, clearSession, loadSessions, saveSession,
} from "../../src/context";
import { requestStop, resetStop, StopRequested } from "../../src/stop";
import { lastCommit, run, setupRepo, tempGitRepo } from "../helpers";

async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("intent");
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const intent = await readIntent(repo.path, "x");
  const ctx = new StepContext(repo.path, cfg, trace, intent);
  return { repo, ctx, trace };
}

describe("StepContext", () => {
  test("setStatus writes frontmatter, records resume_from on approved states, commits, and traces", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review", "Read spec.md.");
    let i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toBe("Read spec.md.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
    await setStatus(ctx, "spec-approved");
    i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("spec-approved");
    expect(i.file.frontmatter.note).toBe("");
    expect(await lastCommit(repo.path)).toContain("loopstra(x)");
    expect(trace.events("x").some((e) => e.type === "status_change")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("resume_from follows a status a person approved by hand, even with a stale resume_from already set", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review");
    await setStatus(ctx, "spec-approved");
    await ctx.reload();
    // Simulate a person editing the status directly (skipping the runtime), leaving resume_from stale.
    await writeIntent(ctx.intent, { status: "plan-approved" });
    await ctx.reload();
    await setStatus(ctx, "building");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("plan-approved");
    trace.close(); repo.cleanup();
  });

  test("accepted through spec-approved then planning yields resume_from spec-approved", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await setStatus(ctx, "spec-review");
    await setStatus(ctx, "spec-approved");
    await setStatus(ctx, "planning");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.resume_from).toBe("spec-approved");
    trace.close(); repo.cleanup();
  });

  test("block sets blocked with a note and keeps resume_from", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await block(ctx, "The intent needs a Done when section.");
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("The intent needs a Done when section. When that is sorted out, set status to accepted to try again.");
    expect(i.file.frontmatter.resume_from).toBe("accepted");
    trace.close(); repo.cleanup();
  });

  test("block owns the retry wording: it adds the status to set, unless the note already says one", async () => {
    const { repo, ctx, trace } = await setup();
    // From an approved status, that status is the one to set again. A passing hiccup (the assistant
    // crashed or took too long) needs nothing sorted out first: just try again.
    expect(blockNote(ctx, "The assistant stopped unexpectedly.")).toBe("The assistant stopped unexpectedly. To try again, set status to accepted.");
    expect(blockNote(ctx, "The finished change could not be checked. The assistant took too long on this step.")).toBe("The finished change could not be checked. The assistant took too long on this step. To try again, set status to accepted.");
    await setStatus(ctx, "designing");
    expect(blockNote(ctx, "A project command failed.")).toBe("A project command failed. When that is sorted out, set status to accepted to try again.");
    expect(blockNote(ctx, "The pull request could not be merged.", "merge-approved")).toBe("The pull request could not be merged. When that is sorted out, set status to merge-approved to try again.");
    // A note that already says what to set is left as it is.
    for (const n of ["Update intent.md, then set status to accepted.", "Read review.md, then change the status line to merge-approved.", "Decide, then set this one to done or closed."]) {
      expect(blockNote(ctx, n)).toBe(n);
    }
    trace.close(); repo.cleanup();
  });

  test("artifacts read and write in the intent folder and are committed", async () => {
    const { repo, ctx, trace } = await setup();
    expect(await readArtifact(ctx, "spec.md")).toBeNull();
    await writeArtifact(ctx, "spec.md", "# Spec\n");
    expect(await readArtifact(ctx, "spec.md")).toBe("# Spec\n");
    expect(ctx.intent.artifacts.has("spec.md")).toBe(true);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("with the main checkout on another branch, status and artifact writes refuse before touching anything", async () => {
    const { repo, ctx, trace } = await setup();
    await new Git(repo.path).run(["checkout", "-q", "-b", "someone-elses-work"]);
    const head = await new Git(repo.path).headSha();
    await expect(setStatus(ctx, "designing")).rejects.toBeInstanceOf(MainCheckoutMoved);
    await expect(writeArtifact(ctx, "spec.md", "# Spec\n")).rejects.toThrow(OFF_MAIN_NOTE);
    expect(existsSync(join(repo.path, "intent", "x", "spec.md"))).toBe(false);
    expect(await new Git(repo.path).isDirty()).toBe(false);
    expect(await new Git(repo.path).headSha()).toBe(head);
    trace.close(); repo.cleanup();
  });

  test("a change folder a person deleted while the step ran is not brought back", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      rmSync(join(repo.path, "intent", "x"), { recursive: true, force: true });
      const head = await new Git(repo.path).headSha();
      await expect(setStatus(ctx, "designing")).rejects.toBeInstanceOf(PersonChangedStatus);
      await expect(writeArtifact(ctx, "spec.md", "# Spec\n")).rejects.toBeInstanceOf(PersonChangedStatus);
      await expect(writeIntentPriority(ctx, "high")).rejects.toBeInstanceOf(PersonChangedStatus);
      expect(existsSync(join(repo.path, "intent", "x"))).toBe(false);
      expect(await new Git(repo.path).headSha()).toBe(head);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("block on a moved main checkout commits nothing, returns the plain note, and traces why", async () => {
    const { repo, ctx, trace } = await setup();
    await new Git(repo.path).run(["checkout", "-q", "-b", "someone-elses-work"]);
    const r = await block(ctx, "The tests kept failing.");
    expect(r).toEqual({ ok: false, note: OFF_MAIN_NOTE });
    expect(await new Git(repo.path).isDirty()).toBe(false);
    expect((await readIntent(repo.path, "x")).file.frontmatter.status).toBe("accepted");
    const err = trace.events("x").find((e) => e.type === "error");
    expect(err?.payload).toContain("The tests kept failing.");
    expect(err?.payload).toContain("someone-elses-work");
    trace.close(); repo.cleanup();
  });

  test("block with a detail puts the plain note on the intent and the detail in the trace", async () => {
    const { repo, ctx, trace } = await setup();
    await block(ctx, "A project command failed.", { detail: "`bun run lint` exited 2" });
    const i = await readIntent(repo.path, "x");
    expect(i.file.frontmatter.note).toBe("A project command failed. When that is sorted out, set status to accepted to try again.");
    expect(trace.events("x").some((e) => e.type === "error" && e.payload.includes("bun run lint"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("writeIntentPriority commits the priority at once (record priority) and leaves main clean", async () => {
    const { repo, ctx, trace } = await setup();
    await setStatus(ctx, "designing");
    await writeIntentPriority(ctx, "high");
    expect((await readIntent(repo.path, "x")).file.frontmatter.priority).toBe("high");
    expect(await lastCommit(repo.path)).toContain("loopstra(x): record priority");
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a stop that lands while a record is written still commits it; one asked for before writes nothing", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      // Asked for between the write and the commit: the commit still lands, so main is never left with a record half saved.
      await commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(join(ctx.intent.dir, "note.md"), "# Note\n");
        requestStop();
      });
      // (Read with plain git: Loopstra's own git calls refuse to start after a stop.)
      expect((await run(["git", "log", "-1", "--format=%s"], repo.path)).out).toContain("loopstra(x): a note");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      // Asked for before: nothing is written, and the stop goes on.
      let wrote = false;
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "another", async () => { wrote = true; })).rejects.toBeInstanceOf(StopRequested);
      expect(wrote).toBe(false);
    } finally {
      resetStop();
      trace.close(); repo.cleanup();
    }
  });

  test("a record whose commit fails is put back as it was, nothing staged, and the error surfaces", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      const before = await Bun.file(intentMd).text();
      // Runtime commits skip the commit hooks, but not this one: the commit itself fails.
      writeFileSync(join(repo.path, ".git", "hooks", "prepare-commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(intentMd, before.replace("status: accepted", "status: designing"));
        await Bun.write(join(ctx.intent.dir, "note.md"), "# Note\n");
        await Bun.write(join(repo.path, "intent", "queue.md"), "# Queue\n");
      })).rejects.toBeInstanceOf(GitError);
      expect(await Bun.file(intentMd).text()).toBe(before);
      expect(existsSync(join(ctx.intent.dir, "note.md"))).toBe(false);
      expect(existsSync(join(repo.path, "intent", "queue.md"))).toBe(false);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect((await run(["git", "diff", "--cached", "--name-only"], repo.path)).out.trim()).toBe("");
      expect(await lastCommit(repo.path)).toContain("intent");
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a write that throws after writing (a trace that cannot be written) is put back as it was, nothing staged, and the error surfaces", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      const before = await Bun.file(intentMd).text();
      const head = await new Git(repo.path).headSha();
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(intentMd, before.replace("status: accepted", "status: designing"));
        await Bun.write(join(ctx.intent.dir, "note.md"), "# Note\n");
        throw new Error("SQLITE_BUSY: the trace could not be written");
      })).rejects.toThrow("SQLITE_BUSY");
      expect(await Bun.file(intentMd).text()).toBe(before);
      expect(existsSync(join(ctx.intent.dir, "note.md"))).toBe(false);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect((await run(["git", "diff", "--cached", "--name-only"], repo.path)).out.trim()).toBe("");
      expect(await new Git(repo.path).headSha()).toBe(head);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a write refused because a person changed the change keeps the person's edit, and their deletion", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      const before = await Bun.file(intentMd).text();
      const theirs = before.replace("status: accepted", "status: closed");
      // The person saves while the step is about to write; the step's write sees it and refuses.
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(intentMd, theirs);
        throw new PersonChangedStatus("accepted", "closed");
      })).rejects.toBeInstanceOf(PersonChangedStatus);
      expect(await Bun.file(intentMd).text()).toBe(theirs);
      // Deleted by the person instead: the folder is not brought back.
      await run(["git", "checkout", "--", "intent"], repo.path);
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        rmSync(ctx.intent.dir, { recursive: true, force: true });
        throw new PersonChangedStatus("accepted", "deleted");
      })).rejects.toBeInstanceOf(PersonChangedStatus);
      expect(existsSync(ctx.intent.dir)).toBe(false);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a record whose commit landed before its error (git's time limit after the commit) is kept, not put back behind HEAD", async () => {
    const { repo, ctx, trace } = await setup();
    const commitPaths = Git.prototype.commitPaths;
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      const before = await Bun.file(intentMd).text();
      Git.prototype.commitPaths = async function (this: Git, ...args: Parameters<Git["commitPaths"]>) {
        await commitPaths.apply(this, args);
        throw new GitError(["commit"], "", "", 124, "git commit timed out");
      };
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(intentMd, before.replace("status: accepted", "status: designing"));
      })).rejects.toBeInstanceOf(GitError);
      expect(await Bun.file(intentMd).text()).toContain("status: designing");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
      expect(await lastCommit(repo.path)).toContain("a note");
    } finally {
      Git.prototype.commitPaths = commitPaths;
      trace.close(); repo.cleanup();
    }
  });

  test("a record whose commit failed while HEAD cannot be read is left written: it may have landed", async () => {
    const { repo, ctx, trace } = await setup();
    const commitPaths = Git.prototype.commitPaths;
    const headFile = join(repo.path, ".git", "HEAD");
    const head = readFileSync(headFile, "utf8");
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      const before = await Bun.file(intentMd).text();
      Git.prototype.commitPaths = async function () {
        writeFileSync(headFile, "not a ref\n");
        throw new GitError(["commit"], "", "", 124, "git commit timed out");
      };
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(intentMd, before.replace("status: accepted", "status: designing"));
      })).rejects.toBeInstanceOf(GitError);
      expect(await Bun.file(intentMd).text()).toContain("status: designing");
    } finally {
      Git.prototype.commitPaths = commitPaths;
      writeFileSync(headFile, head);
      trace.close(); repo.cleanup();
    }
  });

  test("a record whose commit failed while a person committed in the main checkout is put back: only its own commit counts as landed", async () => {
    const { repo, ctx, trace } = await setup();
    const commitPaths = Git.prototype.commitPaths;
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      const before = await Bun.file(intentMd).text();
      Git.prototype.commitPaths = async function () {
        writeFileSync(join(repo.path, "notes.txt"), "the person's\n");
        await run(["git", "add", "notes.txt"], repo.path);
        await run(["git", "commit", "-q", "-m", "the person's commit"], repo.path);
        throw new GitError(["commit"], "", "", 128, "fatal: Unable to create '.git/index.lock': File exists.");
      };
      await expect(commitRecord(repo.path, ctx.cfg.main_branch, "x", "a note", async () => {
        await Bun.write(intentMd, before.replace("status: accepted", "status: designing"));
      })).rejects.toBeInstanceOf(GitError);
      expect(await Bun.file(intentMd).text()).toBe(before);
      expect(await lastCommit(repo.path)).toContain("the person's commit");
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("");
    } finally {
      Git.prototype.commitPaths = commitPaths;
      trace.close(); repo.cleanup();
    }
  });

  test("a status a person set while a step's commit failed is kept: the step's intent goes back to before its write, so a block after meets the person's status", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      // The person sets closed while the commit runs; the commit then fails, and leaves their status.
      const sed = "sed 's/^status: .*/status: closed/' intent/x/intent.md > .git/edited && mv .git/edited intent/x/intent.md";
      writeFileSync(join(repo.path, ".git", "hooks", "prepare-commit-msg"), `#!/bin/sh\n${sed}\nexit 1\n`, { mode: 0o755 });
      await expect(setStatus(ctx, "designing", "go")).rejects.toBeInstanceOf(GitError);
      rmSync(join(repo.path, ".git", "hooks", "prepare-commit-msg"));
      expect((await readIntent(repo.path, "x")).file.frontmatter.status).toBe("closed");
      expect(ctx.intent.file.frontmatter.status).toBe("accepted");
      await expect(block(ctx, "Something went wrong.")).rejects.toBeInstanceOf(PersonChangedStatus);
      expect((await readIntent(repo.path, "x")).file.frontmatter.status).toBe("closed");
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a record whose commit meets a held index lock goes back to what was there, a person's uncommitted edit included", async () => {
    const { repo, ctx, trace } = await setup();
    const lock = join(repo.path, ".git", "index.lock");
    try {
      const intentMd = join(ctx.intent.dir, "intent.md");
      // A person's edit, not committed, before the loop writes the record.
      const persons = (await Bun.file(intentMd).text()).replace("## Problem\np", "## Problem\nthe person's words");
      await Bun.write(intentMd, persons);
      await Bun.write(lock, "");
      await expect(setStatus(ctx, "designing")).rejects.toBeInstanceOf(GitError);
      expect(await Bun.file(intentMd).text()).toBe(persons);
      rmSync(lock);
      expect((await run(["git", "status", "--porcelain"], repo.path)).out.trim()).toBe("M intent/x/intent.md");
    } finally {
      rmSync(lock, { force: true });
      trace.close(); repo.cleanup();
    }
  });

  test("a stop asked for while setStatus checks the branch is a stop, never 'the main checkout is on a different branch'", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      requestStop();
      await expect(setStatus(ctx, "designing")).rejects.toBeInstanceOf(StopRequested);
      expect((await readIntent(repo.path, "x")).file.frontmatter.status).toBe("accepted");
    } finally {
      resetStop();
      trace.close(); repo.cleanup();
    }
  });

  test("onceMarker is true only the first time; clearMarker resets it", async () => {
    const { repo, ctx, trace } = await setup();
    expect(onceMarker(ctx, "replanned")).toBe(true);
    expect(onceMarker(ctx, "replanned")).toBe(false);
    clearMarker(ctx, "replanned");
    expect(onceMarker(ctx, "replanned")).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("sessions persist per intent", async () => {
    const { repo, ctx, trace } = await setup();
    expect(loadSessions(ctx)).toEqual({});
    saveSession(ctx, "build", "sid-1");
    expect(loadSessions(ctx)).toEqual({ build: "sid-1" });
    trace.close(); repo.cleanup();
  });

  test("loadSessions returns {} for a corrupt sessions.json", async () => {
    const { repo, ctx, trace } = await setup();
    mkdirSync(ctx.runDir, { recursive: true });
    await Bun.write(join(ctx.runDir, "sessions.json"), "not json");
    expect(loadSessions(ctx)).toEqual({});
    trace.close(); repo.cleanup();
  });

  test("loadSessions takes only a plain object, and only its string values, so clearSession never meets anything else", async () => {
    const { repo, ctx, trace } = await setup();
    mkdirSync(ctx.runDir, { recursive: true });
    for (const notAnObject of ["null", '["sid-1"]', '"sid-1"', "7"]) {
      await Bun.write(join(ctx.runDir, "sessions.json"), notAnObject);
      expect(loadSessions(ctx)).toEqual({});
      clearSession(ctx, "build");
      expect(loadSessions(ctx)).toEqual({});
    }
    await Bun.write(join(ctx.runDir, "sessions.json"), JSON.stringify({ build: "sid-1", verify: 3, judge: null, design: { id: "sid-2" } }));
    expect(loadSessions(ctx)).toEqual({ build: "sid-1" });
    clearSession(ctx, "build");
    expect(loadSessions(ctx)).toEqual({});
    trace.close(); repo.cleanup();
  });
});

describe("the retry status of a block", () => {
  test("the block's status_change carries the status its note tells a person to set", async () => {
    const { repo, ctx, trace } = await setupRepo("plan-approved");
    try {
      await block(ctx, "The build broke.");
      const e = trace.lastEvent("add-numbers", "status_change")!;
      expect(JSON.parse(e.payload)).toMatchObject({ from: "plan-approved", to: "blocked", retry: "plan-approved" });
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a note that already says what to set gives no retry of its own", async () => {
    const { repo, ctx, trace } = await setupRepo("plan-approved");
    try {
      await block(ctx, "Set status to accepted to write it again.");
      const p = JSON.parse(trace.lastEvent("add-numbers", "status_change")!.payload) as { retry?: string };
      expect(p.retry).toBeUndefined();
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("statusPatch keeps resume_from on the approved state", () => {
    expect(statusPatch("plan-review", "plan-approved", "")).toEqual({ status: "plan-approved", note: "", resume_from: "plan-approved" });
    expect(statusPatch("plan-approved", "building", "x")).toEqual({ status: "building", note: "x", resume_from: "plan-approved" });
    expect(statusPatch("building", "blocked", "y")).toEqual({ status: "blocked", note: "y" });
  });
});
