import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath } from "../../src/config";
import { Git, removeStaleLocks } from "../../src/git";
import { readIntent } from "../../src/intents";
import { fileURLToPath } from "node:url";
import { readPause } from "../../src/heartbeat";
import { missingTools, preflight, start, tick } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { init } from "../../src/init";
import { setupRepo, tempGitRepo, TEMPLATES, withEnv } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

afterEach(() => resetStop());

const SLUG = "add-numbers";

/**
 * A reference-transaction hook that refuses to move a branch to a commit whose message matches
 * `pattern` (a grep pattern). Runtime commits skip the commit hooks, but not this one.
 */
async function refuseCommits(repo: string, pattern: string): Promise<void> {
  await Bun.write(join(repo, ".git", "hooks", "reference-transaction"), [
    "#!/bin/sh",
    '[ "$1" = prepared ] || exit 0',
    "while read old new ref; do",
    `  if git log -1 --format=%s "$new" 2>/dev/null | grep -q "${pattern}"; then exit 1; fi`,
    "done",
    "exit 0",
    "",
  ].join("\n"));
}

describe("scheduler resilience", () => {
  test("an exception inside a step blocks the intent with a plain note and the detail in the trace", async () => {
    const { repo, trace } = await setupRepo("accepted");
    await refuseCommits(repo.path, "accepted.*designing");
    const r = await tick(repo.path);
    expect(r.picked).toBe(SLUG);
    const i = await readIntent(repo.path, SLUG);
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toBe("Something unexpected went wrong in this step. An engineer can find the details in the trace. When that is sorted out, set status to accepted to try again.");
    expect(trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes("\"where\":\"step\""))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("when even blocking fails, the tick traces it and the loop carries on", async () => {
    const { repo, trace } = await setupRepo("accepted");
    await refuseCommits(repo.path, `loopstra(${SLUG})`);
    const r = await tick(repo.path);
    expect(r.picked).toBe(SLUG);
    expect(r.result?.ok).toBe(false);
    expect(trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes("\"where\":\"block\""))).toBe(true);
    const again = await tick(repo.path);
    expect(again.crashed).toBeUndefined();
    trace.close(); repo.cleanup();
  });

  test("an unreadable intent is listed for a person and the others still run", async () => {
    const { repo, trace } = await setupRepo("accepted");
    mkdirSync(join(repo.path, "intent", "broken"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "broken", "intent.md"), "---\nstatus: nearly-done\n---\n# Intent: broken\n");
    await new Git(repo.path).commitAll("a broken intent");
    const r = await tick(repo.path);
    expect(r.picked).toBe(SLUG);
    expect(r.crashed).toBeUndefined();
    const queue = await Bun.file(join(repo.path, "intent", "queue.md")).text();
    const needs = queue.slice(queue.indexOf("## Needs a person"), queue.indexOf("## Finished"));
    expect(needs).toContain("| broken |");
    expect(needs).toContain("The status line at the top of intent.md has a value Loopstra does not understand.");
    expect(needs).not.toMatch(/Invalid|enum|zod/i);
    const scanErrors = () => trace.events("broken").filter((e) => e.type === "error" && e.payload.includes("\"where\":\"scan\""));
    expect(scanErrors()).toHaveLength(1);
    // The same problem is traced once, not on every tick; a different problem is traced again.
    await tick(repo.path);
    expect(scanErrors()).toHaveLength(1);
    await Bun.write(join(repo.path, "intent", "broken", "intent.md"), "---\nstatus: [unclosed\n---\n# Intent: broken\n");
    await tick(repo.path);
    expect(scanErrors()).toHaveLength(2);
    trace.close(); repo.cleanup();
  });

  test("a stop during a step interrupts it without blocking, and the next tick resumes it", async () => {
    const { repo, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:hang");
    const stopper = (async () => {
      while (!trace.phases(SLUG).some((p) => p.name === "intake")) await Bun.sleep(50);
      requestStop();
    })();
    const r = await tick(repo.path);
    await stopper;
    expect(r.stopped).toBe(true);
    expect(r.picked).toBe(SLUG);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
    expect(trace.phases(SLUG).map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);

    resetStop();
    cpSync(join(TEMPLATES, "intake.md"), join(repo.path, "loopstra", "prompts", "intake.md"));
    await tick(repo.path);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("spec-approved");
    trace.close(); repo.cleanup();
  }, 60_000);

  test("an unavailable assistant pauses the loop without blocking; it backs off, and a working phase ends the pause", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const outage = join(import.meta.dir, "..", "fake-claude", "fixtures", "outage.jsonl");
    const r = await withEnv({ LOOPSTRA_FAKE_FIXTURE: outage }, () => tick(repo.path));
    expect(r.picked).toBe(SLUG);
    expect(r.paused).toMatch(/^The assistant is unavailable \(sign-in, usage limit, or network\)\. Retrying at \d\d:\d\d\.$/);
    // Not the change's fault: it keeps its in-progress status, and nothing is blocked.
    const i = await readIntent(repo.path, SLUG);
    expect(i.file.frontmatter.status).toBe("designing");
    expect(i.file.frontmatter.note).toBe("");
    expect(trace.phases(SLUG).map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);
    const pause = trace.events(SLUG).find((e) => e.type === "pause")!;
    expect(JSON.parse(pause.payload)).toMatchObject({ failures: 1, detail: expect.stringContaining("Please run /login") });
    expect(readPause(repo.path)?.failures).toBe(1);

    // While paused, no step runs.
    const waiting = await tick(repo.path);
    expect(waiting.paused).toBe(r.paused);
    expect(waiting.picked).toBeNull();
    expect(trace.phases(SLUG)).toHaveLength(1);

    // Once the pause runs out, the step resumes; a working phase ends the backoff.
    const p = readPause(repo.path)!;
    await Bun.write(join(repo.path, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
    const resumed = await tick(repo.path);
    expect(resumed.paused).toBeUndefined();
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("spec-approved");
    expect(readPause(repo.path)).toBeNull();
    trace.close(); repo.cleanup();
  }, 60_000);

  test("the third pause in a row for the same phase and line runs a probe; the probe gets through, so the phase's own failure blocks", async () => {
    const { repo, trace } = await setupRepo("accepted");
    // Only the intake phase fails, always with the same sign-in words; the probe (its own phase) answers.
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:outage");
    const expire = async () => {
      const p = readPause(repo.path)!;
      await Bun.write(join(repo.path, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
    };
    for (const n of [1, 2]) {
      const r = await tick(repo.path);
      expect(r.paused).toBeDefined();
      expect(readPause(repo.path)).toMatchObject({ slug: SLUG, phase: "intake", line: "Invalid API key · Please run /login", repeats: n });
      await expire();
    }
    expect(trace.phases(SLUG).some((p) => p.name === "probe")).toBe(false);
    const third = await tick(repo.path);
    expect(third.paused).toBeUndefined();
    expect(readPause(repo.path)).toBeNull();
    const i = await readIntent(repo.path, SLUG);
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toMatch(/^The assistant stopped unexpectedly\./);
    expect(i.file.frontmatter.note).toContain("accepted");
    expect(trace.phases(SLUG).map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted", "intake:interrupted", "intake:interrupted", "probe:success"]);
    const why = trace.events(SLUG).filter((e) => e.type === "error" && e.payload.includes("\"probe\""));
    expect(why).toHaveLength(1);
    expect(JSON.parse(why[0]!.payload)).toMatchObject({ where: "probe", phase: "intake", line: "Invalid API key · Please run /login" });
    trace.close(); repo.cleanup();
  }, 60_000);

  test("when the probe cannot reach the assistant either, the loop keeps backing off and nothing is blocked", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const outage = join(import.meta.dir, "..", "fake-claude", "fixtures", "outage.jsonl");
    await withEnv({ LOOPSTRA_FAKE_FIXTURE: outage }, async () => {
      for (const n of [1, 2, 3]) {
        const r = await tick(repo.path);
        expect(r.paused).toMatch(/^The assistant is unavailable/);
        expect(readPause(repo.path)).toMatchObject({ repeats: n, failures: n });
        const p = readPause(repo.path)!;
        await Bun.write(join(repo.path, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
      }
    });
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
    expect(trace.phases(SLUG).filter((p) => p.name === "probe").map((p) => p.status)).toEqual(["fail"]);
    trace.close(); repo.cleanup();
  }, 60_000);

  test("queue.md is written every tick but committed only along with another runtime commit", async () => {
    const { repo, trace } = await setupRepo("draft");
    const git = new Git(repo.path);
    const queue = join(repo.path, "intent", "queue.md");
    const head = await git.headSha();
    // Nothing else to commit: the queue is written and left uncommitted.
    await tick(repo.path);
    expect(await git.headSha()).toBe(head);
    expect(await Bun.file(queue).text()).toContain("| add-numbers |");
    expect((await git.run(["status", "--porcelain", "--", "intent/queue.md"])).out.trim()).toBe("?? intent/queue.md");

    // A step that commits takes the queue along in its first commit; there is no queue commit of its own.
    const i = await readIntent(repo.path, SLUG);
    await Bun.write(join(i.dir, "intent.md"), (await Bun.file(join(i.dir, "intent.md")).text()).replace("status: draft", "status: accepted"));
    await tick(repo.path);
    const subjects = (await git.run(["log", "--format=%s", `${head}..main`])).out.trim().split(/\r?\n/);
    expect(subjects.some((s) => /queue/.test(s))).toBe(false);
    const queueCommits = (await git.run(["log", "--format=%s", "--", "intent/queue.md"])).out.trim().split(/\r?\n/);
    expect(queueCommits).toEqual([`loopstra(${SLUG}): accepted → designing [skip ci]`]);
    // The file itself is brought up to date at the end of the tick, uncommitted until the next commit.
    expect(await Bun.file(queue).text()).toContain("spec approved, waiting to plan");
    trace.close(); repo.cleanup();
  }, 60_000);

  test("a git index lock older than ten minutes is removed at the start of a tick and traced; a fresh one is left", async () => {
    const { repo, ctx, trace } = await setupRepo("draft");
    const git = new Git(repo.path);
    await git.createBranch(ctx.branch, "main");
    await git.worktreeAdd(ctx.worktreeDir, ctx.branch);
    const rootLock = join(repo.path, ".git", "index.lock");
    const wtLock = join(repo.path, ".git", "worktrees", SLUG, "index.lock");
    const old = new Date(Date.now() - 11 * 60_000);
    for (const p of [rootLock, wtLock]) { writeFileSync(p, ""); utimesSync(p, old, old); }
    await tick(repo.path);
    expect(existsSync(rootLock)).toBe(false);
    expect(existsSync(wtLock)).toBe(false);
    const removed = trace.events("_loop").filter((e) => e.type === "stale-lock-removed").map((e) => JSON.parse(e.payload).path as string);
    expect(removed.map((p) => resolve(p)).sort()).toEqual([rootLock, wtLock].map((p) => resolve(p)).sort());
    // A lock a running git command might hold is left alone.
    writeFileSync(wtLock, "");
    expect(await removeStaleLocks(repo.path)).toEqual([]);
    expect(existsSync(wtLock)).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("start keeps going after a problem and a stop cuts its sleep short", async () => {
    const { repo, trace } = await setupRepo("draft");
    await Bun.write(configPath(repo.path), "version: 1\nbogus: true\n");
    const started = Date.now();
    setTimeout(() => requestStop(), 500);
    await start(repo.path, { once: false, installSignals: false });
    // The config problem falls back to a 60 second poll; the stop ends the sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
    trace.close(); repo.cleanup();
  }, 30_000);

  test("a merged change's leftover worktree and branch are cleaned up on a later tick", async () => {
    const { repo, ctx, trace } = await setupRepo("done");
    const git = new Git(repo.path);
    await git.createBranch(ctx.branch, "main");
    await git.worktreeAdd(ctx.worktreeDir, ctx.branch);
    await tick(repo.path);
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    expect(await git.branchExists(ctx.branch)).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a change set to merged by hand whose branch never merged keeps its branch and worktree, traced once", async () => {
    const { repo, ctx, trace } = await setupRepo("merged");
    const git = new Git(repo.path);
    await Bun.write(join(repo.path, "intent", SLUG, "spec.md"), "# Spec\n\n## Summary\ns\n");
    await Bun.write(join(repo.path, "intent", SLUG, "plan.md"), "# Plan\n\n## Proof\nbun test.\n");
    await git.commitAll("artifacts");
    await git.createBranch(ctx.branch, "main");
    await git.worktreeAdd(ctx.worktreeDir, ctx.branch);
    await Bun.write(join(ctx.worktreeDir, "work.ts"), "export const work = 1;\n");
    await new Git(ctx.worktreeDir).commitAll("work that never reached main");
    await tick(repo.path);
    await tick(repo.path);
    expect(await git.branchExists(ctx.branch)).toBe(true);
    expect(existsSync(join(ctx.worktreeDir, "work.ts"))).toBe(true);
    const kept = trace.events(SLUG).filter((e) => e.type === "command" && e.payload.includes("\"kept\""));
    expect(kept).toHaveLength(1);
    // Once main has the change (merged by hand), the next tick tidies up.
    await git.run(["merge", "--squash", ctx.branch]);
    await git.run(["commit", "-q", "-m", "merged by hand"]);
    await tick(repo.path);
    expect(await git.branchExists(ctx.branch)).toBe(false);
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a closed change's worktree is removed once it holds nothing uncommitted; its branch is kept", async () => {
    const { repo, ctx, trace } = await setupRepo("closed");
    const git = new Git(repo.path);
    await git.createBranch(ctx.branch, "main");
    await git.worktreeAdd(ctx.worktreeDir, ctx.branch);
    await Bun.write(join(ctx.worktreeDir, "work.ts"), "export const work = 1;\n");
    // Uncommitted work: kept, and said once.
    await tick(repo.path);
    await tick(repo.path);
    expect(existsSync(join(ctx.worktreeDir, "work.ts"))).toBe(true);
    expect(trace.events(SLUG).filter((e) => e.type === "command" && e.payload.includes("\"kept\""))).toHaveLength(1);
    // Committed on the branch: the worktree goes, the branch and its work stay.
    await new Git(ctx.worktreeDir).commitAll("work");
    await tick(repo.path);
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    expect(await git.branchExists(ctx.branch)).toBe(true);
    expect((await git.run(["cat-file", "-e", `${ctx.branch}:work.ts`], true)).code).toBe(0);
    trace.close(); repo.cleanup();
  });

  test("start refuses, in plain words, a checkout off main and a remote without gh", async () => {
    const { repo, trace } = await setupRepo("draft");
    const git = new Git(repo.path);
    await withEnv({ LOOPSTRA_GH_EXECUTABLE: join(repo.path, "missing-gh.exe") }, async () => {
      expect(await preflight(repo.path)).toBeNull();
      await git.run(["checkout", "-q", "-b", "elsewhere"]);
      expect(await preflight(repo.path)).toBe("Run loopstra from a checkout of main; you are on elsewhere.");
      await git.run(["checkout", "-q", "main"]);
      await git.run(["remote", "add", "origin", join(repo.path, "nowhere.git")]);
      expect(await preflight(repo.path)).toBe("This repo has a remote but gh was not found. Install GitHub CLI or remove the remote.");
    });
    await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_SIGNED_OUT: "1" }, async () => {
      expect(await preflight(repo.path)).toBe("GitHub CLI is installed but not signed in. Run gh auth login, then start again.");
    });
    await withEnv({ LOOPSTRA_GH_EXECUTABLE: FAKE_GH }, async () => {
      expect(await preflight(repo.path)).toBeNull();
    });
    trace.close(); repo.cleanup();
  });

  test("start refuses, listing them, Loopstra's own files that are not committed on main", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      await init(repo.path);
      await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: "fake" }, async () => {
        expect(await preflight(repo.path)).toBe("These Loopstra files are not committed on main yet, so the loop's own checkouts would not see them: loopstra/config.yaml, loopstra/prompts/, .claude/settings.json, .claude/hooks/loopstra-protect-tests.ts. Commit them, then start again.");
        const git = new Git(repo.path);
        await git.run(["add", "loopstra/config.yaml", "loopstra/prompts"]);
        await git.run(["commit", "-q", "-m", "loopstra config"]);
        expect(await preflight(repo.path)).toBe("These Loopstra files are not committed on main yet, so the loop's own checkouts would not see them: .claude/settings.json, .claude/hooks/loopstra-protect-tests.ts. Commit them, then start again.");
        await git.commitAll("the rest of init");
        expect(await preflight(repo.path)).toBeNull();
      });
    } finally {
      repo.cleanup();
    }
  });

  test("start names a missing tool in plain words", () => {
    expect(missingTools({ PATH: "" })).toBe("git was not found. Install Git, then start Loopstra again.");
    expect(missingTools({ PATH: process.env.PATH ?? process.env.Path, LOOPSTRA_CLAUDE_EXECUTABLE: "fake" })).toBeNull();
  });
});
