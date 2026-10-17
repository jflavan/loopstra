import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { setStatus, StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { MOVE_CUT_SHORT_NOTE, moveMain, pushBranch, settleCutShortMove, shareMain, syncMain, SYNC_SIGNAL, SYNC_TEXT } from "../../src/remote";
import { Trace } from "../../src/trace";
import { run, tempDir, tempGitRepo, withEnv } from "../helpers";

/** A repo with a bare remote holding its main, a second clone of that remote, and a trace. */
async function setup() {
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  const repo = await tempGitRepo();
  await Bun.write(join(repo.path, "loopstra", "config.yaml"), "version: 1\ncommands:\n  test: echo ok\n");
  await new Git(repo.path).commitAll("config");
  await run(["git", "remote", "add", "origin", remote.path], repo.path);
  await run(["git", "push", "-q", "-u", "origin", "main"], repo.path);
  const other = tempDir("loopstra-other-");
  await run(["git", "clone", "-q", remote.path, "."], other.path);
  await run(["git", "config", "user.email", "person@example.com"], other.path);
  await run(["git", "config", "user.name", "Person"], other.path);
  const trace = Trace.open(repo.path);
  const cfg = await loadConfig(repo.path);
  const cleanup = () => { trace.close(); repo.cleanup(); remote.cleanup(); other.cleanup(); };
  return { repo: repo.path, remote: remote.path, other: other.path, trace, cfg, cleanup };
}

async function pushFromOther(other: string, file: string, text: string): Promise<void> {
  await Bun.write(join(other, file), text);
  await run(["git", "add", "-A"], other);
  await run(["git", "commit", "-q", "-m", `elsewhere: ${file}`], other);
  await run(["git", "push", "-q", "origin", "main"], other);
}

/** A commit a person makes in the main checkout with their own identity (not Loopstra's). */
async function personCommits(repo: string, file: string, text: string): Promise<void> {
  await Bun.write(join(repo, file), text);
  await run(["git", "add", "--", file], repo);
  await run(["git", "commit", "-q", "-m", `person: ${file}`], repo);
}

function syncErrors(trace: Trace): string[] {
  return trace.events("_loop").filter((e) => e.type === "error" && e.payload.includes("\"sync\"")).map((e) => JSON.parse(e.payload).what as string);
}

describe("syncMain", () => {
  test("pulls what was pushed elsewhere, and never pushes a person's own unpushed commits", async () => {
    const s = await setup();
    await pushFromOther(s.other, "theirs.md", "theirs\n");
    await personCommits(s.repo, "ours.md", "ours\n");
    await Bun.write(join(s.repo, "intent", "x", "intent.md"), "---\nstatus: draft\n---\n# Intent: x\n");
    await new Git(s.repo).commitPaths(["intent/x"], "loopstra(x): record");
    await syncMain(s.repo, s.cfg, s.trace);
    expect(existsSync(join(s.repo, "theirs.md"))).toBe(true);
    expect(existsSync(join(s.repo, "ours.md"))).toBe(true);
    // Local commits are replayed on top. The person's commit is theirs to share, so nothing is pushed.
    expect((await run(["git", "log", "-1", "--format=%s", "main"], s.repo)).out.trim()).toBe("loopstra(x): record");
    expect((await run(["git", "cat-file", "-e", "main:ours.md"], s.remote)).code).not.toBe(0);
    expect((await run(["git", "cat-file", "-e", "main:intent/x/intent.md"], s.remote)).code).not.toBe(0);
    expect(s.trace.lastSignal(SYNC_SIGNAL)).toMatchObject({ result: "waiting", output: SYNC_TEXT.ownCommits });

    // Once the person pushes their own, Loopstra shares its records too.
    await run(["git", "push", "-q", "origin", `${(await run(["git", "rev-parse", "main~1"], s.repo)).out.trim()}:refs/heads/main`], s.repo);
    await syncMain(s.repo, s.cfg, s.trace);
    expect((await run(["git", "cat-file", "-e", "main:intent/x/intent.md"], s.remote)).code).toBe(0);
    expect(s.trace.lastSignal(SYNC_SIGNAL)).toMatchObject({ result: "pass", output: SYNC_TEXT.inStep });
    s.cleanup();
  });

  test("only Loopstra's commits ahead: they are pushed right after they are committed", async () => {
    const s = await setup();
    await Bun.write(join(s.repo, "intent", "x", "intent.md"), "---\nstatus: draft\n---\n# Intent: x\n");
    await new Git(s.repo).commitPaths(["intent/x"], "loopstra(x): record");
    await shareMain(s.repo, s.cfg, s.trace);
    expect((await run(["git", "cat-file", "-e", "main:intent/x/intent.md"], s.remote)).code).toBe(0);
    expect(s.trace.lastSignal(SYNC_SIGNAL)?.result).toBe("pass");
    s.cleanup();
  });

  test("a status change is committed on main with [skip ci] and not pushed by itself (the tick shares main once, at its end)", async () => {
    const s = await setup();
    await Bun.write(join(s.repo, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await new Git(s.repo).commitAll("x");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    const ctx = new StepContext(s.repo, s.cfg, s.trace, await readIntent(s.repo, "x"));
    await setStatus(ctx, "designing");
    expect((await run(["git", "log", "-1", "--format=%s", "main"], s.repo)).out.trim()).toBe("loopstra(x): accepted → designing [skip ci]");
    expect((await run(["git", "show", "main:intent/x/intent.md"], s.remote)).out).toContain("status: accepted");
    s.cleanup();
  });

  test("a queue.md left uncommitted does not hold up the sync: it is regenerated every tick", async () => {
    const s = await setup();
    await Bun.write(join(s.repo, "intent", "queue.md"), "# Queue\n");
    await new Git(s.repo).commitAll("queue");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    await run(["git", "pull", "-q"], s.other);
    await pushFromOther(s.other, "theirs.md", "theirs\n");
    await Bun.write(join(s.repo, "intent", "queue.md"), "# Queue\n\nnewer, not committed\n");
    await syncMain(s.repo, s.cfg, s.trace);
    expect(existsSync(join(s.repo, "theirs.md"))).toBe(true);
    expect(s.trace.lastSignal(SYNC_SIGNAL)).toMatchObject({ result: "pass" });
    s.cleanup();
  });

  test("a push the remote refuses is a main_sync failure, recorded once, and never throws", async () => {
    const s = await setup();
    const hook = join(s.remote, "hooks", "pre-receive");
    await Bun.write(hook, "#!/bin/sh\necho protected branch >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    for (const n of [1, 2]) {
      await Bun.write(join(s.repo, "intent", "x", "intent.md"), `---\nstatus: draft\n---\n# Intent: x ${n}\n`);
      await new Git(s.repo).commitPaths(["intent/x"], `loopstra(x): record ${n}`);
      await shareMain(s.repo, s.cfg, s.trace);
      await syncMain(s.repo, s.cfg, s.trace);
    }
    expect(s.trace.signals().filter((g) => g.name === SYNC_SIGNAL)).toHaveLength(1);
    expect(s.trace.lastSignal(SYNC_SIGNAL)).toMatchObject({ result: "fail", output: SYNC_TEXT.pushFailed });
    expect(syncErrors(s.trace)).toEqual(["push of main failed"]);
    s.cleanup();
  });

  test("a remote without main is one sync failure in the trace, however many ticks", async () => {
    const s = await setup();
    await run(["git", "symbolic-ref", "HEAD", "refs/heads/nothing"], s.remote);
    await run(["git", "push", "-q", "origin", "--delete", "main"], s.repo);
    await run(["git", "update-ref", "-d", "refs/remotes/origin/main"], s.repo);
    await syncMain(s.repo, s.cfg, s.trace);
    await syncMain(s.repo, s.cfg, s.trace);
    expect(syncErrors(s.trace)).toEqual(["remote has no main"]);
    expect(s.trace.lastSignal(SYNC_SIGNAL)).toMatchObject({ result: "fail", output: SYNC_TEXT.noMain });
    s.cleanup();
  });

  test("a conflict with the remote is aborted and traced, and main is left as it was", async () => {
    const s = await setup();
    await pushFromOther(s.other, "README.md", "# theirs\n");
    await Bun.write(join(s.repo, "README.md"), "# ours\n");
    const git = new Git(s.repo);
    await git.commitAll("ours");
    const head = await git.headSha();
    await syncMain(s.repo, s.cfg, s.trace);
    expect(await git.headSha()).toBe(head);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.isDirty()).toBe(false);
    expect(existsSync(join(s.repo, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(s.repo, ".loopstra", "sync"))).toBe(false);
    expect(syncErrors(s.trace)).toEqual(["replaying main onto the remote's main hit a conflict; main is not synced"]);
    s.cleanup();
  });

  test("a clash inside intent/ takes the remote's version (an owner's edit on GitHub wins); local work elsewhere is kept", async () => {
    const s = await setup();
    const intent = "intent/x/intent.md";
    await Bun.write(join(s.repo, intent), "---\nstatus: draft\n---\n# Intent: x\n");
    await new Git(s.repo).commitAll("draft x");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    await run(["git", "pull", "-q"], s.other);
    await pushFromOther(s.other, intent, "---\nstatus: closed\n---\n# Intent: x\n");
    await Bun.write(join(s.repo, intent), "---\nstatus: accepted\n---\n# Intent: x\n");
    await Bun.write(join(s.repo, "ours.md"), "ours\n");
    const git = new Git(s.repo);
    await git.commitAll("loopstra: draft -> accepted, and ours");
    await syncMain(s.repo, s.cfg, s.trace);
    expect(await Bun.file(join(s.repo, intent)).text()).toContain("status: closed");
    expect(existsSync(join(s.repo, "ours.md"))).toBe(true);
    expect(await git.isDirty()).toBe(false);
    expect(existsSync(join(s.repo, ".git", "rebase-merge"))).toBe(false);
    expect(syncErrors(s.trace)).toEqual([]);
    s.cleanup();
  });

  test("a person's unsaved changes in the main checkout are never touched", async () => {
    const s = await setup();
    await pushFromOther(s.other, "theirs.md", "theirs\n");
    await Bun.write(join(s.repo, "README.md"), "# work in progress\n");
    await syncMain(s.repo, s.cfg, s.trace);
    // A condition that lasts is recorded once, not on every tick.
    await syncMain(s.repo, s.cfg, s.trace);
    expect(s.trace.lastSignal(SYNC_SIGNAL)).toMatchObject({ result: "waiting", output: SYNC_TEXT.unsaved });
    expect(existsSync(join(s.repo, "theirs.md"))).toBe(false);
    expect(await Bun.file(join(s.repo, "README.md")).text()).toBe("# work in progress\n");
    expect(syncErrors(s.trace)).toEqual(["skipped: the main checkout has changes to tracked files"]);
    s.cleanup();
  });

  test("main is replayed in a worktree of its own and moved once: the main checkout is never mid-rebase, and the worktree is gone after", async () => {
    const s = await setup();
    await pushFromOther(s.other, "theirs.md", "theirs\n");
    await Bun.write(join(s.repo, "intent", "x", "intent.md"), "---\nstatus: draft\n---\n# Intent: x\n");
    await new Git(s.repo).commitPaths(["intent/x"], "loopstra(x): record");
    // The replay's own checkout runs git's post-checkout hook: it shows where the replay happens.
    const seen = join(s.repo, "..", `replay-${Date.now()}.txt`);
    const hook = join(s.repo, ".git", "hooks", "post-checkout");
    await Bun.write(hook, `#!/bin/sh\npwd >> "${seen.replaceAll("\\", "/")}"\n`);
    chmodSync(hook, 0o755);
    try {
      expect(await syncMain(s.repo, s.cfg, s.trace)).toBe("pass");
      const where = (await Bun.file(seen).text()).trim().split(/\r?\n/);
      expect(where.every((w) => w.replaceAll("\\", "/").endsWith(".loopstra/sync"))).toBe(true);
      expect(existsSync(join(s.repo, ".loopstra", "sync"))).toBe(false);
      expect(existsSync(join(s.repo, ".loopstra", "moving-main"))).toBe(false);
      expect(existsSync(join(s.repo, "theirs.md"))).toBe(true);
      expect((await run(["git", "log", "-2", "--format=%s", "main"], s.repo)).out.trim().split(/\r?\n/)).toEqual(["loopstra(x): record", "elsewhere: theirs.md"]);
      expect((await run(["git", "worktree", "list", "--porcelain"], s.repo)).out.match(/^worktree /gm)).toHaveLength(1);
      expect(s.trace.events("_loop").some((e) => e.payload.includes("\"sync main\"") && e.payload.includes("\"pulled\":1"))).toBe(true);
    } finally { rmSync(seen, { force: true }); s.cleanup(); }
  });

  test("a record committed on main while the replay runs is kept: it is replayed on top before main moves", async () => {
    const s = await setup();
    await pushFromOther(s.other, "theirs.md", "theirs\n");
    await Bun.write(join(s.repo, "intent", "x", "intent.md"), "---\nstatus: draft\n---\n# Intent: x\n");
    await new Git(s.repo).commitPaths(["intent/x"], "loopstra(x): record");
    // Another change records its status in the middle of the replay (the hook runs once, when the replay's worktree is checked out).
    const root = s.repo.replaceAll("\\", "/");
    const hook = join(s.repo, ".git", "hooks", "post-checkout");
    await Bun.write(hook, [
      "#!/bin/sh",
      `[ -f "${root}/.git/once" ] || exit 0`,
      `rm -f "${root}/.git/once"`,
      `mkdir -p "${root}/intent/y" && printf -- '---\\nstatus: draft\\n---\\n# Intent: y\\n' > "${root}/intent/y/intent.md"`,
      `git -C "${root}" add intent/y && git -C "${root}" -c user.name=Loopstra -c user.email=loopstra@localhost commit -q -m "loopstra(y): record"`,
      "",
    ].join("\n"));
    chmodSync(hook, 0o755);
    await Bun.write(join(s.repo, ".git", "once"), "");
    expect(await syncMain(s.repo, s.cfg, s.trace)).toBe("pass");
    expect((await run(["git", "log", "-3", "--format=%s", "main"], s.repo)).out.trim().split(/\r?\n/)).toEqual(["loopstra(y): record", "loopstra(x): record", "elsewhere: theirs.md"]);
    expect(existsSync(join(s.repo, "intent", "y", "intent.md"))).toBe(true);
    expect(await new Git(s.repo).isDirty()).toBe(false);
    // Both records reached GitHub.
    expect((await run(["git", "cat-file", "-e", "main:intent/y/intent.md"], s.remote)).code).toBe(0);
    s.cleanup();
  });

  test("its fetch, replay and move never start git's automatic gc or maintenance (other changes may be committing meanwhile)", async () => {
    const s = await setup();
    const log = join(s.other, "..", `git-trace-${Date.now()}.log`);
    try {
      await pushFromOther(s.other, "theirs.md", "theirs\n");
      await withEnv({ GIT_TRACE: log }, () => syncMain(s.repo, s.cfg, s.trace));
      // A commit of main's own, so this sync replays (it is a person's, so nothing is pushed: the remote's own
      // maintenance after a push is not this repository's).
      await pushFromOther(s.other, "more.md", "more\n");
      await personCommits(s.repo, "ours.md", "ours\n");
      await withEnv({ GIT_TRACE: log }, () => syncMain(s.repo, s.cfg, s.trace));
      expect(await Bun.file(log).text()).toContain("rebase");
      expect(existsSync(join(s.repo, "theirs.md"))).toBe(true);
      expect(existsSync(join(s.repo, "more.md"))).toBe(true);
      expect(await Bun.file(log).text()).not.toMatch(/maintenance run --auto|gc --auto/);
    } finally { rmSync(log, { force: true }); s.cleanup(); }
  });

  test("a remote that cannot be reached is traced and never throws", async () => {
    const s = await setup();
    rmSync(s.remote, { recursive: true, force: true });
    await syncMain(s.repo, s.cfg, s.trace);
    expect(syncErrors(s.trace)).toEqual(["fetch failed"]);
    s.cleanup();
  });
});

/** A file's text with Windows line endings (what a checkout writes there) made plain. */
async function text(path: string): Promise<string> {
  return (await Bun.file(path).text()).replace(/\r\n/g, "\n");
}

describe("moving main", () => {
  /** A repo whose main has two commits apart: `from`, and `to`, which changes a.md, removes b.md and adds c.md. */
  async function twoCommits() {
    const repo = await tempGitRepo();
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "a.md"), "a1\n");
    await Bun.write(join(repo.path, "b.md"), "b1\n");
    await git.commitAll("from");
    const from = await git.headSha();
    await Bun.write(join(repo.path, "a.md"), "a2\n");
    rmSync(join(repo.path, "b.md"));
    await Bun.write(join(repo.path, "c.md"), "c2\n");
    await git.commitAll("to");
    const to = await git.headSha();
    await run(["git", "reset", "-q", "--hard", from], repo.path);
    return { repo, git, from, to };
  }

  test("a move lands whole: the branch, the index and the files", async () => {
    const { repo, git, from, to } = await twoCommits();
    try {
      expect(await moveMain(git, from, to)).toEqual({ ok: true });
      expect(await git.headSha()).toBe(to);
      expect(await git.isDirty()).toBe(false);
      expect(existsSync(join(repo.path, "b.md"))).toBe(false);
      expect(existsSync(join(repo.path, ".loopstra", "moving-main"))).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a move that cannot land leaves main, its files and a person's file as they were", async () => {
    const { repo, git, from, to } = await twoCommits();
    try {
      await Bun.write(join(repo.path, "c.md"), "a person's own c\n");
      const r = await moveMain(git, from, to);
      expect(r.ok).toBe(false);
      expect(await git.headSha()).toBe(from);
      expect(await text(join(repo.path, "a.md"))).toBe("a1\n");
      expect(await text(join(repo.path, "c.md"))).toBe("a person's own c\n");
      expect((await git.run(["status", "--porcelain", "--untracked-files=no"])).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "moving-main"))).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a move a kill cut short is put back at the next tick's start; a person's file is left alone", async () => {
    const { repo, git, from, to } = await twoCommits();
    const trace = Trace.open(repo.path);
    try {
      // As a killed `reset --keep` leaves it: some files written, the index half-written, the branch not moved.
      await Bun.write(join(repo.path, "a.md"), "a2\n");
      rmSync(join(repo.path, "b.md"));
      await Bun.write(join(repo.path, "c.md"), "c2\n");
      await run(["git", "update-index", "--add", "c.md"], repo.path);
      await Bun.write(join(repo.path, "notes.md"), "a person's notes\n");
      await Bun.write(join(repo.path, ".loopstra", "moving-main"), `${from}\n${to}\n`);
      expect(await settleCutShortMove(repo.path, trace)).toBeNull();
      expect(await git.headSha()).toBe(from);
      expect(await text(join(repo.path, "a.md"))).toBe("a1\n");
      expect(await text(join(repo.path, "b.md"))).toBe("b1\n");
      expect(existsSync(join(repo.path, "c.md"))).toBe(false);
      expect(await text(join(repo.path, "notes.md"))).toBe("a person's notes\n");
      expect((await git.run(["status", "--porcelain", "--untracked-files=no"])).out.trim()).toBe("");
      expect(existsSync(join(repo.path, ".loopstra", "moving-main"))).toBe(false);
      expect(trace.events("_loop").some((e) => e.payload.includes("a move of main cut short was put back"))).toBe(true);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a move a kill cut short after it landed, or a main a person moved since, is left as it is", async () => {
    const { repo, git, from, to } = await twoCommits();
    const trace = Trace.open(repo.path);
    try {
      await run(["git", "reset", "-q", "--hard", to], repo.path);
      await Bun.write(join(repo.path, ".loopstra", "moving-main"), `${from}\n${to}\n`);
      expect(await settleCutShortMove(repo.path, trace)).toBeNull();
      expect(await git.headSha()).toBe(to);
      expect(await git.isDirty()).toBe(false);
      expect(existsSync(join(repo.path, ".loopstra", "moving-main"))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a move that cannot be put back yet (git's lock is still there) pauses with a plain note, and settles once the lock is gone", async () => {
    const { repo, git, from, to } = await twoCommits();
    const trace = Trace.open(repo.path);
    try {
      await Bun.write(join(repo.path, "a.md"), "a2\n");
      await Bun.write(join(repo.path, ".loopstra", "moving-main"), `${from}\n${to}\n`);
      await Bun.write(join(repo.path, ".git", "index.lock"), "");
      expect(await settleCutShortMove(repo.path, trace)).toBe(MOVE_CUT_SHORT_NOTE);
      rmSync(join(repo.path, ".git", "index.lock"));
      expect(await settleCutShortMove(repo.path, trace)).toBeNull();
      expect(await text(join(repo.path, "a.md"))).toBe("a1\n");
      expect(await git.headSha()).toBe(from);
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("pushBranch", () => {
  test("overwrites only what Loopstra pushed last: a commit a person added is kept, even after a fetch", async () => {
    const s = await setup();
    try {
      const git = new Git(s.repo);
      const sha = async () => (await git.run(["rev-parse", "intent/x"])).out.trim();
      /** Gives the branch here a new head in place of its last commit, as a rebase does. */
      const rewrite = async (text: string) => {
        await run(["git", "checkout", "-q", "intent/x"], s.repo);
        await Bun.write(join(s.repo, "x.md"), text);
        await run(["git", "commit", "-q", "-a", "--amend", "-m", text], s.repo);
        await run(["git", "checkout", "-q", "main"], s.repo);
      };
      await run(["git", "checkout", "-q", "-b", "intent/x"], s.repo);
      await Bun.write(join(s.repo, "x.md"), "first\n");
      await run(["git", "add", "x.md"], s.repo);
      await run(["git", "commit", "-q", "-m", "first"], s.repo);
      await run(["git", "checkout", "-q", "main"], s.repo);
      expect(await pushBranch(git, "intent/x")).toEqual({ ok: true });

      // Rewritten here: Loopstra's own last push is overwritten.
      const first = await sha();
      await rewrite("second\n");
      expect(await pushBranch(git, "intent/x", first)).toEqual({ ok: true });

      // A person adds a commit on GitHub; the branch here is rewritten again and the remote fetched.
      const second = await sha();
      await run(["git", "fetch", "-q", "origin"], s.other);
      await run(["git", "checkout", "-q", "-b", "intent/x", "origin/intent/x"], s.other);
      await Bun.write(join(s.other, "fix.md"), "fix\n");
      await run(["git", "add", "fix.md"], s.other);
      await run(["git", "commit", "-q", "-m", "fix"], s.other);
      await run(["git", "push", "-q", "origin", "intent/x"], s.other);
      await rewrite("third\n");
      await git.fetch(["--quiet", "origin"]);
      const refused = await pushBranch(git, "intent/x", second);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.moved).toBe(true);
      expect((await run(["git", "cat-file", "-e", "intent/x:fix.md"], s.remote)).code).toBe(0);
    } finally { s.cleanup(); }
  });

  test("an empty lease: pushes while the remote has no such branch, though a fetch saw one, and is refused once it has one", async () => {
    const s = await setup();
    try {
      const git = new Git(s.repo);
      await run(["git", "checkout", "-q", "-b", "intent/x"], s.repo);
      await Bun.write(join(s.repo, "x.md"), "first\n");
      await run(["git", "add", "x.md"], s.repo);
      await run(["git", "commit", "-q", "-m", "first"], s.repo);
      await run(["git", "checkout", "-q", "main"], s.repo);
      expect(await pushBranch(git, "intent/x")).toEqual({ ok: true });
      // Deleted on the remote; the remote-tracking ref here still has it.
      await run(["git", "branch", "-D", "intent/x"], s.remote);
      expect((await pushBranch(git, "intent/x")).ok).toBe(false);
      expect(await pushBranch(git, "intent/x", "")).toEqual({ ok: true });
      await run(["git", "checkout", "-q", "intent/x"], s.repo);
      await Bun.write(join(s.repo, "x.md"), "second\n");
      await run(["git", "commit", "-q", "-a", "-m", "second"], s.repo);
      await run(["git", "checkout", "-q", "main"], s.repo);
      const refused = await pushBranch(git, "intent/x", "");
      expect(!refused.ok && refused.moved).toBe(true);
    } finally { s.cleanup(); }
  });
});
