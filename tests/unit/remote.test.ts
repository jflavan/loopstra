import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { shareMain, syncMain, SYNC_SIGNAL, SYNC_TEXT } from "../../src/remote";
import { Trace } from "../../src/trace";
import { run, tempDir, tempGitRepo } from "../helpers";

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
    expect(syncErrors(s.trace)).toEqual(["rebase onto the remote failed and was aborted; main is not synced"]);
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
    expect(syncErrors(s.trace)).toEqual(["skipped: the root checkout has changes to tracked files"]);
    s.cleanup();
  });

  test("a remote that cannot be reached is traced and never throws", async () => {
    const s = await setup();
    rmSync(s.remote, { recursive: true, force: true });
    await syncMain(s.repo, s.cfg, s.trace);
    expect(syncErrors(s.trace)).toEqual(["fetch failed"]);
    s.cleanup();
  });
});
