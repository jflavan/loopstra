import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configPath } from "../../src/config";
import type { StepContext } from "../../src/context";
import { Git, passOn, removeStaleLocks } from "../../src/git";
import { readIntent } from "../../src/intents";
import { fileURLToPath } from "node:url";
import { holdLoop, loopAlreadyRunning, readPause, releaseLoop, thisHost, writeHeartbeat, type Heartbeat } from "../../src/heartbeat";
import { othersRunning, othersRunningCommands } from "../../src/lanes";
import { claudeOverrideProblem, missingTools, preflight, runStepGuarded, sleepBetweenTicks, start, tick } from "../../src/scheduler";
import { endsStepQuietly, QuestionAsked, requestStop, resetStop, SessionStopped, StopRequested } from "../../src/stop";
import { init } from "../../src/init";
import { FAKE_CLAUDE, fixture, fixtureDir, NEVER_A_PID, run, setupRepo, tempDir, tempGitRepo, TEMPLATES, withEnv } from "../helpers";
import { touchWake, wakeStamp } from "../../src/wake";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

afterEach(() => resetStop());

const SLUG = "add-numbers";

/**
 * A reference-transaction hook that refuses to move a branch to a commit whose message matches
 * `pattern` (a grep pattern). Runtime commits skip the commit hooks, but not this one.
 */
async function refuseCommits(repo: string, pattern: string): Promise<void> {
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  await Bun.write(hook, [
    "#!/bin/sh",
    '[ "$1" = prepared ] || exit 0',
    "while read old new ref; do",
    `  if git log -1 --format=%s "$new" 2>/dev/null | grep -q "${pattern}"; then exit 1; fi`,
    "done",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(hook, 0o755); // git on macOS and Linux ignores a hook without the executable bit
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

  test("a change that depends on a blocked one is not started, and the queue says why", async () => {
    const { repo, trace } = await setupRepo("blocked");
    mkdirSync(join(repo.path, "intent", "show-sums"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "show-sums", "intent.md"), `---\nstatus: accepted\ndepends_on: [${SLUG}]\n---\n# Intent: show sums\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`);
    await new Git(repo.path).commitAll("a dependent intent");
    const r = await tick(repo.path);
    expect(r.picked).toBeNull();
    expect((await readIntent(repo.path, "show-sums")).file.frontmatter.status).toBe("accepted");
    const queue = await Bun.file(join(repo.path, "intent", "queue.md")).text();
    expect(queue).toContain(`Waits for ${SLUG} to be merged (now: needs a person).`);
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
    // Not the change's fault: nothing about the stop, the snapshot's removal included, is an error of the change.
    expect(trace.events(SLUG).filter((e) => e.type === "error")).toEqual([]);

    resetStop();
    cpSync(join(TEMPLATES, "intake.md"), join(repo.path, "loopstra", "prompts", "intake.md"));
    await tick(repo.path);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("spec-approved");
    trace.close(); repo.cleanup();
  }, 60_000);

  test("a design step counts as running none of the project's commands, with think-ahead off too", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "speed:\n  think_ahead: false\n" });
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:hang");
    // Seen from another change while the design step's session runs.
    const during: Array<{ running: number; runningCommands: number }> = [];
    const stopper = (async () => {
      while (!trace.phases(SLUG).some((p) => p.name === "intake")) await Bun.sleep(50);
      during.push({ running: othersRunning("another-change"), runningCommands: othersRunningCommands("another-change") });
      requestStop();
    })();
    const r = await tick(repo.path);
    await stopper;
    expect(r.stopped).toBe(true);
    expect(during).toEqual([{ running: 1, runningCommands: 0 }]);
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

  test("only the strong model is out: the cheap intake getting through keeps the pause, and the probe asks the strong model", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const dir = fixtureDir({ "design@opus": fixture("outage"), "probe@opus": fixture("outage") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        for (const n of [1, 2, 3]) {
          const r = await tick(repo.path);
          expect(r.paused).toMatch(/^The assistant is unavailable/);
          expect(readPause(repo.path)).toMatchObject({ phase: "design", model: "opus", repeats: n, failures: n });
          const p = readPause(repo.path)!;
          await Bun.write(join(repo.path, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
        }
      });
      // A probe on the cheap model would have got through and blocked the change.
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
      expect(trace.phases(SLUG).filter((p) => p.name === "probe").map((p) => p.status)).toEqual(["fail"]);
    } finally {
      dir.cleanup(); trace.close(); repo.cleanup();
    }
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

  test("the start of a tick packs the repository when git thinks it is time", async () => {
    const { repo, trace } = await setupRepo("draft");
    const git = new Git(repo.path);
    // Three packs, and a limit of two: git's own --auto rule says to pack them into one.
    for (const n of [1, 2, 3]) {
      await Bun.write(join(repo.path, `note-${n}.txt`), `${n}\n`);
      await git.commitAll(`note ${n}`);
      await git.run(["repack", "-q"]);
    }
    await git.run(["config", "gc.autoPackLimit", "2"]);
    const packs = () => [...new Bun.Glob("*.pack").scanSync(join(repo.path, ".git", "objects", "pack"))].length;
    expect(packs()).toBe(3);
    await tick(repo.path);
    expect(packs()).toBe(1);
    expect(trace.events("_loop").some((e) => e.type === "error" && e.payload.includes("\"where\":\"gc\""))).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a git gc that fails at the start of a tick is traced once and not tried again on every tick", async () => {
    const { repo, trace } = await setupRepo("draft");
    // gc refuses to run with a setting it cannot read; other git commands do not read it.
    const git = new Git(repo.path);
    await git.run(["config", "gc.pruneExpire", "bogus"]);
    try {
      await tick(repo.path);
      await tick(repo.path);
      const failures = trace.events("_loop").filter((e) => e.type === "error" && e.payload.includes("\"where\":\"gc\""));
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0]!.payload).note).toContain("tried again tomorrow");
    } finally {
      await git.run(["config", "--unset", "gc.pruneExpire"], true);
      trace.close(); repo.cleanup();
    }
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

  test("a snapshot of main a killed loop left behind is removed at the start of the next tick, and a step's own is gone when it ends", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const git = new Git(repo.path);
    const left = join(repo.path, ".loopstra", "snapshots", "gone-change");
    await git.run(["worktree", "add", "--detach", left, "main"]);
    await tick(repo.path); // the design step reads its own snapshot, then removes it
    expect(existsSync(left)).toBe(false);
    expect(existsSync(join(repo.path, ".loopstra", "snapshots", ctx.slug))).toBe(false);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("spec-approved");
    expect((await git.run(["worktree", "list", "--porcelain"])).out.match(/^worktree /gm)).toHaveLength(1);
    trace.close(); repo.cleanup();
  });

  test("a chat hand-off's throwaway checkout left behind is removed once its process is gone and an hour has passed, not while it runs", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const git = new Git(repo.path);
    const left = join(repo.path, ".loopstra", "chat", "worktrees", `handoff-1-${NEVER_A_PID}`);
    const running = join(repo.path, ".loopstra", "chat", "worktrees", `handoff-2-${process.pid}`);
    await git.run(["worktree", "add", "--detach", left, "main"]);
    await git.run(["worktree", "add", "--detach", running, "main"]);
    // A pid not alive here may be a hand-off on another machine sharing the repository, mid-push.
    await tick(repo.path);
    expect(existsSync(left)).toBe(true);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(left, old, old);
    utimesSync(running, old, old);
    await tick(repo.path);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(running)).toBe(true);
    expect((await git.run(["worktree", "list", "--porcelain"])).out.match(/^worktree /gm)).toHaveLength(2);
    trace.close(); repo.cleanup();
  });

  test("a move of main that a kill cut short is put back before the tick does anything else", async () => {
    const { repo, trace } = await setupRepo("accepted");
    const git = new Git(repo.path);
    const from = await git.headSha();
    await Bun.write(join(repo.path, "moved.md"), "moved\n");
    await git.commitAll("later");
    const to = await git.headSha();
    await git.run(["reset", "-q", "--hard", from]);
    // As a killed move leaves it: the new commit's file written, the branch not moved, the marker there.
    await Bun.write(join(repo.path, "moved.md"), "moved\n");
    await Bun.write(join(repo.path, ".loopstra", "moving-main"), `${from}\n${to}\n`);
    await tick(repo.path);
    expect(existsSync(join(repo.path, "moved.md"))).toBe(false);
    expect(existsSync(join(repo.path, ".loopstra", "moving-main"))).toBe(false);
    expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("spec-approved");
    expect(trace.events("_loop").some((e) => e.payload.includes("a move of main cut short was put back"))).toBe(true);
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

  test("start refuses while a loop is running in the repository, and not once it stopped", async () => {
    const { repo, trace } = await setupRepo("draft");
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const beat = (over: Partial<Heartbeat> = {}): Heartbeat =>
      ({ pid: process.pid, startedAt: at(600_000), lastTickAt: at(20_000), lastBeatAt: at(1_000), current: null, stopping: false, stopped: false, ...over });
    try {
      const refused = loopAlreadyRunning(process.pid);
      expect(refused).toBe(`A loop is already running in this repository (process ${process.pid}). Stop it (Ctrl-C in its terminal) before starting another. If no loop is running here, delete .loopstra/loop.lock and .loopstra/heartbeat.json, then start again.`);
      expect(await preflight(repo.path)).toBeNull();
      writeHeartbeat(repo.path, beat());
      expect(await preflight(repo.path)).toBe(refused);
      // Paused for the assistant: still running.
      writeHeartbeat(repo.path, beat({ pausedUntil: at(-60_000), pauseReason: "The assistant is unavailable." }));
      expect(await preflight(repo.path)).toBe(refused);
      // Not responding, but its process is alive: it may still be running.
      writeHeartbeat(repo.path, beat({ lastBeatAt: at(3_600_000) }));
      expect(await preflight(repo.path)).toBe(refused);
      // Stopped, or gone without shutting down cleanly: it may start.
      writeHeartbeat(repo.path, beat({ stopped: true }));
      expect(await preflight(repo.path)).toBeNull();
      writeHeartbeat(repo.path, beat({ pid: NEVER_A_PID, lastBeatAt: at(3_600_000) }));
      expect(await preflight(repo.path)).toBeNull();
      // Fresh, but written on this machine by a process that is gone (its window closed, say): it may start at once.
      writeHeartbeat(repo.path, beat({ pid: NEVER_A_PID, host: thisHost() }));
      expect(await preflight(repo.path)).toBeNull();
      // Fresh from another machine sharing the folder: its process id says nothing here.
      writeHeartbeat(repo.path, beat({ pid: NEVER_A_PID, host: "elsewhere" }));
      expect(await preflight(repo.path)).toBe(loopAlreadyRunning(NEVER_A_PID));
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("start refuses a folder below the repository's top, naming the top", async () => {
    const { repo, trace } = await setupRepo("draft");
    const sub = join(repo.path, "packages", "app");
    mkdirSync(join(sub, "loopstra"), { recursive: true });
    await Bun.write(join(sub, "loopstra", "config.yaml"), await Bun.file(join(repo.path, "loopstra", "config.yaml")).text());
    const top = (await new Git(repo.path).run(["rev-parse", "--show-toplevel"])).out.trim();
    expect(await preflight(sub)).toBe(`This folder is inside the git repository at ${top}. Loopstra works on a whole repository: run it in ${top}.`);
    trace.close(); repo.cleanup();
  });

  test("start refuses, listing them, Loopstra's own files that are not committed on main", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      await init(repo.path);
      await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE }, async () => {
        expect(await preflight(repo.path)).toBe("These Loopstra files are not committed on main yet, so the loop's own checkouts would not see them: loopstra/config.yaml, loopstra/stamp.json. Commit them, then start again.");
        const git = new Git(repo.path);
        await git.run(["add", "loopstra/config.yaml"]);
        await git.run(["commit", "-q", "-m", "loopstra config"]);
        // A prompt override must be committed too.
        await Bun.write(join(repo.path, "loopstra", "prompts", "review.md"), "our review prompt");
        expect(await preflight(repo.path)).toBe("These Loopstra files are not committed on main yet, so the loop's own checkouts would not see them: loopstra/stamp.json, loopstra/prompts/. Commit them, then start again.");
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

  test("start refuses a claude override that cannot be run", () => {
    const PATH = process.env.PATH ?? process.env.Path;
    expect(claudeOverrideProblem({ PATH })).toBeNull();
    expect(claudeOverrideProblem({ PATH, LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE })).toBeNull();
    expect(claudeOverrideProblem({ PATH, LOOPSTRA_CLAUDE_EXECUTABLE: join(resolve("."), "no-such-claude") }))
      .toMatch(/^LOOPSTRA_CLAUDE_EXECUTABLE is set to .*no-such-claude, which was not found\./);
    expect(claudeOverrideProblem({ PATH, LOOPSTRA_CLAUDE_EXECUTABLE: "no-such-claude-on-path" })).toContain("which was not found");
  });

  test.skipIf(process.platform === "win32")("start refuses a claude override that is not executable (POSIX)", () => {
    const t = tempDir();
    try {
      const exe = join(t.path, "claude");
      writeFileSync(exe, "#!/bin/sh\necho hi\n");
      chmodSync(exe, 0o644);
      expect(claudeOverrideProblem({ LOOPSTRA_CLAUDE_EXECUTABLE: exe })).toBe(`LOOPSTRA_CLAUDE_EXECUTABLE is set to ${exe}, which is not executable. Run chmod +x on it, or unset it to use claude from PATH.`);
      chmodSync(exe, 0o755);
      expect(claudeOverrideProblem({ LOOPSTRA_CLAUDE_EXECUTABLE: exe })).toBeNull();
    } finally { t.cleanup(); }
  });

  test("a record a kill left between HEAD and the checkout is finished before the tick does anything else", async () => {
    const { repo, trace } = await setupRepo("draft");
    try {
      const git = new Git(repo.path);
      const parent = await git.headSha();
      const md = join(repo.path, "intent", SLUG, "intent.md");
      const text = readFileSync(md, "utf8").replace("status: draft", "status: closed");
      const commit = (await git.commitFiles(parent, [`intent/${SLUG}`], [{ rel: `intent/${SLUG}/intent.md`, text }], "loopstra(x): killed [skip ci]"))!;
      writeFileSync(join(repo.path, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug: SLUG, paths: [`intent/${SLUG}/intent.md`] }));
      await git.moveHead(parent, commit);
      await tick(repo.path);
      expect(readFileSync(md, "utf8")).toContain("status: closed");
      // The change's folder: queue.md, which every tick renders, is committed with the next record.
      expect((await run(["git", "status", "--porcelain", "--", `intent/${SLUG}`], repo.path)).out.trim()).toBe("");
    } finally { trace.close(); repo.cleanup(); }
  });
});

describe("holds", () => {
  test("a held change gets no step; released, it runs again", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      const path = join(repo.path, "intent", SLUG, "intent.md");
      await Bun.write(path, (await Bun.file(path).text()).replace("status: accepted", "status: accepted\nhold: waiting for legal"));
      await run(["git", "commit", "-qam", "hold it"], repo.path);
      const r = await tick(repo.path);
      expect(r.steps ?? []).toEqual([]);
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("accepted");
      await Bun.write(path, (await Bun.file(path).text()).replace("hold: waiting for legal\n", ""));
      await run(["git", "commit", "-qam", "release it"], repo.path);
      const again = await tick(repo.path);
      expect(again.picked).toBe(SLUG);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a change with an open question gets no step; once the line is gone, it runs again", async () => {
    const { repo, trace } = await setupRepo("designing");
    try {
      const path = join(repo.path, "intent", SLUG, "intent.md");
      await Bun.write(path, (await Bun.file(path).text()).replace("status: designing", "status: designing\nquestion: open"));
      await run(["git", "commit", "-qam", "ask"], repo.path);
      const r = await tick(repo.path);
      expect(r.steps ?? []).toEqual([]);
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.status).toBe("designing");
      await Bun.write(path, (await Bun.file(path).text()).replace("question: open\n", ""));
      await run(["git", "commit", "-qam", "answered"], repo.path);
      const again = await tick(repo.path);
      expect(again.picked).toBe(SLUG);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("while a person has paused the loop, the tick starts no step and says so", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      holdLoop(repo.path, "John");
      const r = await tick(repo.path);
      expect(r.paused).toBe("Paused by John: running steps finish, nothing new starts.");
      expect(r.steps).toBeUndefined();
      // Traced once per pause: again for a new pause by the same person, not on every tick.
      const pauses = () => trace.lastEvents("_loop", 50).filter((e) => e.type === "pause").length;
      await tick(repo.path);
      expect(pauses()).toBe(1);
      holdLoop(repo.path, "John", new Date(Date.now() + 1000));
      await tick(repo.path);
      expect(pauses()).toBe(2);
      releaseLoop(repo.path);
      expect((await tick(repo.path)).picked).toBe(SLUG);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("while a person has paused the loop, main's tests do not run, but the queue is still written", async () => {
    const { repo, trace } = await setupRepo("accepted");
    try {
      holdLoop(repo.path, "John");
      const r = await tick(repo.path);
      expect(r.paused).toBe("Paused by John: running steps finish, nothing new starts.");
      expect(r.signal).toBeUndefined();
      expect(trace.lastSignal("main_health")).toBeNull();
      expect(existsSync(join(repo.path, "intent", "queue.md"))).toBe(true);
      releaseLoop(repo.path);
      expect((await tick(repo.path)).signal).toBe("pass");
    } finally {
      trace.close(); repo.cleanup();
    }
  });
});

describe("sleeping between ticks", () => {
  test("ends at once when the wake file changed since the tick began, early when it changes, else at the timeout", async () => {
    const t = tempDir();
    try {
      const seen = wakeStamp(t.path);
      touchWake(t.path);
      expect(await sleepBetweenTicks(t.path, 60_000, seen, 20)).toBe("woken");
      const now = wakeStamp(t.path);
      setTimeout(() => touchWake(t.path), 50);
      const t0 = Date.now();
      expect(await sleepBetweenTicks(t.path, 60_000, now, 20)).toBe("woken");
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(await sleepBetweenTicks(t.path, 30, wakeStamp(t.path), 10)).toBe("timeout");
      // A wait longer than a timer can hold (poll_seconds of 2,147,484 and up) is not cut to 1 ms.
      const before = wakeStamp(t.path);
      setTimeout(() => touchWake(t.path), 100);
      expect(await sleepBetweenTicks(t.path, 2_147_484_000, before, 20)).toBe("woken");
    } finally {
      t.cleanup();
    }
  });
});

describe("steps that end quietly", () => {
  // The step's first session asks for its snapshot of main: throwing there ends the step from inside a stage.
  const throwAtFirstSession = (ctx: StepContext, e: Error) => spyOn(ctx, "snapshot").mockImplementation(async () => { throw e; });

  test("a session a person stopped ends the step without blocking; the change keeps its status, and the trace says who", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      throwAtFirstSession(ctx, new SessionStopped("John"));
      const r = await runStepGuarded(ctx);
      expect(r).toEqual({ ok: true, stoppedBy: "John" });
      const i = await readIntent(repo.path, SLUG);
      // The design step had moved it on before its first session; nothing was written after.
      expect(i.file.frontmatter.status).toBe("designing");
      expect(i.file.frontmatter.note ?? "").toBe("");
      const stop = trace.events(SLUG).find((e) => e.type === "stop");
      expect(JSON.parse(stop!.payload)).toMatchObject({ by: "John" });
      expect(trace.events(SLUG).some((e) => e.type === "error")).toBe(false);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a question asked ends the step without blocking or advancing", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      throwAtFirstSession(ctx, new QuestionAsked("design", "Which rounding?"));
      const r = await runStepGuarded(ctx);
      expect(r).toEqual({ ok: true, asked: true });
      const i = await readIntent(repo.path, SLUG);
      expect(i.file.frontmatter.status).toBe("designing");
      expect(i.file.frontmatter.note ?? "").toBe("");
      expect(trace.events(SLUG).some((e) => e.type === "error")).toBe(false);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("passOn lets a stopped session and a question through, like a stop request", () => {
    expect(() => passOn(new SessionStopped("John"))).toThrow(SessionStopped);
    expect(() => passOn(new QuestionAsked("build", "Keep the old API?"))).toThrow(QuestionAsked);
    expect(() => passOn(new Error("the step's own"))).not.toThrow();
    expect(endsStepQuietly(new SessionStopped("John"))).toBe(true);
    expect(endsStepQuietly(new QuestionAsked("plan", "?"))).toBe(true);
    expect(endsStepQuietly(new StopRequested())).toBe(false);
  });
});
