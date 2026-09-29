import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { syncMain } from "../../src/remote";
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

function syncErrors(trace: Trace): string[] {
  return trace.events("_loop").filter((e) => e.type === "error" && e.payload.includes("\"sync\"")).map((e) => JSON.parse(e.payload).what as string);
}

describe("syncMain", () => {
  test("pulls what was pushed elsewhere and never pushes main", async () => {
    const s = await setup();
    await pushFromOther(s.other, "theirs.md", "theirs\n");
    await Bun.write(join(s.repo, "ours.md"), "ours\n");
    await new Git(s.repo).commitAll("ours");
    await syncMain(s.repo, s.cfg, s.trace);
    expect(existsSync(join(s.repo, "theirs.md"))).toBe(true);
    expect(existsSync(join(s.repo, "ours.md"))).toBe(true);
    // Local commits are replayed on top, never pushed: they may be a person's own.
    expect((await run(["git", "log", "-1", "--format=%s", "main"], s.repo)).out.trim()).toBe("ours");
    expect((await run(["git", "cat-file", "-e", "main:ours.md"], s.remote)).code).not.toBe(0);
    expect(syncErrors(s.trace)).toEqual([]);
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
