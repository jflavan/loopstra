import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git, GitTimeout } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { runStepGuarded, tick } from "../../src/scheduler";
import { resetStop } from "../../src/stop";
import { Trace } from "../../src/trace";
import { fixture, run, tempDir, withEnv } from "../helpers";
import { FAKE_GH, SLUG, BRANCH, PLAN, remoteSetup, intentOf, elsewhere, onRemoteMain } from "./remote-helpers";

afterEach(() => resetStop());

describe("the loop with a GitHub remote", () => {
  test("merge approved on GitHub: opens a pull request, waits for checks and approval, merges through gh, and syncs main", async () => {
    const s = await remoteSetup("gates:\n  merge:\n    human: pr\n");
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      expect((await intentOf(s.repo)).status).toBe("reviewing");
      // Two status changes in the tick (building, reviewing), one push of main, at its end.
      const shares = () => {
        const t = Trace.open(s.repo);
        try { return t.events("_loop").filter((e) => e.type === "command" && e.payload.includes("\"share main\"")).length; } finally { t.close(); }
      };
      expect(shares()).toBe(1);
      expect((await run(["git", "show", `main:intent/${SLUG}/intent.md`], s.remote)).out).toContain("status: reviewing");
      await tick(s.repo); // review, merge checks, pull request
      const waiting = await intentOf(s.repo);
      expect(waiting.status).toBe("merge-review");
      expect(waiting.note).toBe("A pull request is open. Approve it on GitHub to merge, or close it to stop.");
      let pr = await s.pr();
      expect(pr.title).toBe("add-numbers: add numbers");
      expect(pr.body).toContain(`intent/${SLUG}/review.md`);
      expect(pr.comments).toHaveLength(1);
      expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], s.remote)).code).toBe(0);
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(false);
      // Loopstra's own records on main are shared (only its commits are ahead); the code is not.
      expect((await run(["git", "show", `main:intent/${SLUG}/intent.md`], s.remote)).out).toContain("status: merge-review");
      expect((await run(["git", "log", "--format=%ae", "main"], s.remote)).out).toContain("loopstra@localhost");

      // Checks still running: the loop waits without touching the status or its note.
      const lastEdit = () => new Git(s.repo).run(["log", "-1", "--format=%H", "--", `intent/${SLUG}/intent.md`]).then((x) => x.out.trim());
      const edited = await lastEdit();
      const r = await tick(s.repo);
      expect(r.picked).toBe(SLUG);
      expect(r.result).toEqual({ ok: true, waiting: true });
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect(await lastEdit()).toBe(edited);

      // Checks pass but nobody approved yet: still waiting.
      await s.setPr({ checks: "pass" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");

      await s.setPr({ reviewDecision: "APPROVED" });
      await tick(s.repo);
      const merged = await intentOf(s.repo);
      expect(merged.status).toBe("merged");
      pr = await s.pr();
      expect(pr.merged).toBe(true);
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
      // Local main has the merge, the branch and worktree are gone, and main's health check is due.
      const git = new Git(s.repo);
      expect((await git.run(["cat-file", "-e", "main:src/add.ts"], true)).code).toBe(0);
      expect(await git.branchExists(BRANCH)).toBe(false);
      expect(existsSync(join(s.repo, ".loopstra", "worktrees", SLUG))).toBe(false);
      expect(await Bun.file(join(s.repo, ".loopstra", "health-pending")).text()).toBe(SLUG);
      expect((await run(["git", "show", `main:intent/${SLUG}/intent.md`], s.remote)).out).toContain("status: merged");
      // Loopstra's bookkeeping on main skips CI; the change itself does not.
      const subjects = (await run(["git", "log", "--format=%s", "main"], s.remote)).out.trim().split(/\r?\n/);
      const bookkeeping = subjects.filter((l) => l.startsWith(`loopstra(${SLUG}): `));
      expect(bookkeeping.length).toBeGreaterThan(3);
      for (const l of bookkeeping) expect(l).toEndWith(" [skip ci]");
      expect(subjects).toContain("add-numbers: add numbers");
      expect(subjects.some((l) => l.includes("update queue"))).toBe(false);
      // queue.md lives on as a generated file; unsaved, it holds nothing up.
      expect((await git.run(["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)intent/queue.md"])).out.trim()).toBe("");
      const trace = Trace.open(s.repo);
      try {
        expect(trace.events(SLUG).some((e) => e.type === "command" && e.payload.includes("\"pull request\""))).toBe(true);
      } finally {
        trace.close();
      }
    });
    s.cleanup();
  }, 180_000);

  test("no person on the merge gate: an owner's acceptance pushed from elsewhere runs while the pull request waits on GitHub's checks", async () => {
    const s = await remoteSetup();
    mkdirSync(join(s.repo, "intent", "other"), { recursive: true });
    await Bun.write(join(s.repo, "intent", "other", "intent.md"), "---\nstatus: draft\n---\n# Intent: other\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await new Git(s.repo).commitAll("another change");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review", note: "Waiting for the automatic checks on GitHub." });

      // The owner accepts the draft in another clone and pushes it. The next tick pulls it in and,
      // while the checks still run, moves that change on in the same tick.
      const clone = await elsewhere(s.remote);
      const other = await readIntent(clone.path, "other");
      await writeIntent(other, { status: "accepted" });
      await run(["git", "commit", "-q", "-am", "person: accepted"], clone.path);
      await run(["git", "push", "-q", "origin", "main"], clone.path);
      clone.cleanup();
      const r = await tick(s.repo);
      expect(r.picked).toBe("other");
      expect((await readIntent(s.repo, "other")).file.frontmatter.status).toBe("spec-approved");
      expect((await intentOf(s.repo)).status).toBe("merge-review");

      await s.setPr({ checks: "pass" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
    });
    s.cleanup();
  }, 180_000);

  test("checks that pass while another change's step runs: the watcher merges the pull request then, not after the step", async () => {
    const s = await remoteSetup();
    mkdirSync(join(s.repo, "intent", "other"), { recursive: true });
    await Bun.write(join(s.repo, "intent", "other", "intent.md"), "---\nstatus: plan-approved\n---\n# Intent: other\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await Bun.write(join(s.repo, "intent", "other", "spec.md"), "# Spec\n\n## Summary\ns\n");
    // Other changes files of its own: one that changes add-numbers' files would wait for its pull request to merge.
    await Bun.write(join(s.repo, "intent", "other", "plan.md"), PLAN.replaceAll("add", "sub"));
    const fixtures = tempDir("loopstra-fixtures-");
    mkdirSync(join(fixtures.path, "other"));
    writeFileSync(join(fixtures.path, "other", "build.jsonl"), fixture("build").replaceAll("add", "sub"));
    // The test command of the next build: GitHub's checks pass while it runs, and it keeps running
    // until the pull request has merged (or 30 seconds have passed).
    await Bun.write(join(s.repo, "flip-checks.ts"), [
      "const path = process.env.LOOPSTRA_FAKE_GH_STATE!;",
      "const state = await Bun.file(path).json();",
      "for (const pr of Object.values(state.prs) as { checks: string }[]) pr.checks = \"pass\";",
      "await Bun.write(path, JSON.stringify(state));",
      "const until = Date.now() + 30_000;",
      "while (Date.now() < until && !(Object.values((await Bun.file(path).json()).prs) as { merged: boolean }[]).some((p) => p.merged)) await Bun.sleep(100);",
      "",
    ].join("\n"));
    await new Git(s.repo).commitAll("another change");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    await withEnv({ ...s.env, LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, async () => {
      await tick(s.repo); // build add-numbers
      await tick(s.repo); // review, pull request
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review", note: "Waiting for the automatic checks on GitHub." });

      await Bun.write(configPath(s.repo), "version: 1\ncommands:\n  test: bun flip-checks.ts\npoll_seconds: 1\n");
      await new Git(s.repo).commitAll("test command");
      await run(["git", "push", "-q", "origin", "main"], s.repo);
      // The pull request already has that commit, as if checked with it; otherwise it is out of date and brought up to date first.
      expect(await new Git(join(s.repo, ".loopstra", "worktrees", SLUG)).rebaseOnto("main")).toBe(true);
      expect((await run(["git", "push", "-q", "--force", "origin", BRANCH], s.repo)).code).toBe(0);
      const r = await tick(s.repo); // other is built, its tests let the checks pass, and add-numbers merges meanwhile
      expect(r.picked).toBe("other");
      expect((await readIntent(s.repo, "other")).file.frontmatter.status).toBe("reviewing");
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect((await s.pr()).merged).toBe(true);
      expect(await new Git(s.repo).run(["cat-file", "-e", "main:src/add.ts"], true).then((x) => x.code)).toBe(0);
      const trace = Trace.open(s.repo);
      try {
        // The merge started while other's test command still ran, which waited for it (well under its 30 seconds).
        const test = trace.events("other").filter((e) => e.type === "command" && e.payload.includes("flip-checks")).at(-1)!;
        const mergeStarted = trace.events(SLUG).find((e) => e.type === "phase_start" && e.payload.includes("\"name\":\"merge\""))!;
        expect(mergeStarted.id).toBeLessThan(test.id);
        expect(JSON.parse(test.payload).durationMs).toBeLessThan(25_000);
      } finally {
        trace.close();
      }
    });
    s.cleanup();
    fixtures.cleanup();
  }, 180_000);

  test("merged through gh while main here cannot be brought up to date: waits, and finishes once main has the merged commit", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      await s.setPr({ checks: "pass" });
      // A person is editing a tracked file in the main checkout, so the sync leaves main alone.
      const smoke = join(s.repo, "tests", "smoke.test.ts");
      const original = await Bun.file(smoke).text();
      await Bun.write(smoke, `${original}// editing\n`);
      const r = await tick(s.repo);
      expect(r.picked).toBe(SLUG);
      expect(r.result).toEqual({ ok: true, waiting: true });
      expect((await s.pr()).merged).toBe(true);
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
      // Not recorded as merged against a stale main, so the done-check does not run on it yet.
      const git = new Git(s.repo);
      expect((await git.run(["cat-file", "-e", "main:src/add.ts"], true)).code).not.toBe(0);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect(existsSync(join(s.repo, ".loopstra", "health-pending"))).toBe(false);
      // gh is not asked to delete the branch (the worktree still has it checked out); Loopstra
      // deletes the remote branch itself and keeps the local one until main has its changes.
      const merges = (await s.ghCalls()).filter((a) => a[0] === "pr" && a[1] === "merge");
      expect(merges).toHaveLength(1);
      expect(merges[0]).not.toContain("--delete-branch");
      expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], s.remote)).code).not.toBe(0);
      expect(await git.branchExists(BRANCH)).toBe(true);

      // The person puts the file back: the next tick brings main up to date and finishes, without merging again.
      await Bun.write(smoke, original);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect((await git.run(["cat-file", "-e", "main:src/add.ts"], true)).code).toBe(0);
      expect(await git.branchExists(BRANCH)).toBe(false);
      expect(await Bun.file(join(s.repo, ".loopstra", "health-pending")).text()).toBe(SLUG);
      expect((await s.ghCalls()).filter((a) => a[0] === "pr" && a[1] === "merge")).toHaveLength(1);
    });
    s.cleanup();
  }, 180_000);

  test("git timing out once the pull request merged waits, and the next look records the merge, not a rebuild", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      await s.setPr({ checks: "pass" });
      // Every git command of the step times out once GitHub has merged the pull request.
      const merged = () => JSON.parse(readFileSync(join(s.remote, "fake-gh.json"), "utf8")).prs[BRANCH].merged === true;
      const git = new Git(s.repo);
      git.run = async (args, opts) => {
        if (merged()) throw new GitTimeout(args, 1);
        return Git.prototype.run.call(git, args, opts);
      };
      const trace = Trace.open(s.repo);
      try {
        const ctx = new StepContext(s.repo, await loadConfig(s.repo), trace, await readIntent(s.repo, SLUG));
        (ctx as { git: Git }).git = git;
        expect(await runStepGuarded(ctx)).toEqual({ ok: true, waiting: true });
        expect(merged()).toBe(true);
        expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });
        expect((await intentOf(s.repo)).note).not.toContain("plan-approved");
        expect(trace.events(SLUG).filter((e) => e.type === "error" && e.payload.includes("\"finish merge\""))).toHaveLength(1);
        expect(await runStepGuarded(new StepContext(s.repo, await loadConfig(s.repo), trace, await readIntent(s.repo, SLUG)))).toEqual({ ok: true });
      } finally { trace.close(); }
      expect((await intentOf(s.repo)).status).toBe("merged");
    });
    s.cleanup();
  }, 180_000);

  test("recording a merged pull request that keeps failing is traced once, and after 30 minutes blocks with a look again; a pause of over 10 minutes starts the count again", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      await s.setPr({ checks: "pass" });
      // The step's git commands after `git remote` fail the same way once GitHub has merged the pull request.
      const merged = () => JSON.parse(readFileSync(join(s.remote, "fake-gh.json"), "utf8")).prs[BRANCH].merged === true;
      const git = new Git(s.repo);
      git.run = async (args, opts) => {
        if (merged() && args[0] !== "remote") throw new Error("fatal: unable to read the repository");
        return Git.prototype.run.call(git, args, opts);
      };
      const trace = Trace.open(s.repo);
      const look = async () => {
        const ctx = new StepContext(s.repo, await loadConfig(s.repo), trace, await readIntent(s.repo, SLUG));
        (ctx as { git: Git }).git = git;
        return runStepGuarded(ctx);
      };
      try {
        expect(await look()).toEqual({ ok: true, waiting: true });
        expect(await look()).toEqual({ ok: true, waiting: true });
        expect(trace.events(SLUG).filter((e) => e.type === "error" && e.payload.includes("\"finish merge\""))).toHaveLength(1);
        expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });
        const failing = join(s.repo, ".loopstra", "runs", SLUG, "finish-failing");
        const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
        // The failures started 31 minutes ago, but the last was 11 minutes ago (the loop was off since): the count starts again.
        writeFileSync(failing, `${ago(31)}\n${ago(11)}`);
        expect(await look()).toEqual({ ok: true, waiting: true });
        expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });
        // They started 31 minutes ago and went on since.
        writeFileSync(failing, `${ago(31)}\n${ago(1)}`);
        expect((await look()).ok).toBe(false);
        const blocked = await intentOf(s.repo);
        expect(blocked.status).toBe("blocked");
        expect(blocked.note).toContain("The pull request merged on GitHub, but recording it here kept failing: fatal: unable to read the repository");
        expect(blocked.note).toContain("set status to merge-review");
        await writeIntent(await readIntent(s.repo, SLUG), { status: "merge-review", note: "" });
        await new Git(s.repo).commitAll("person: look again");
        expect(await runStepGuarded(new StepContext(s.repo, await loadConfig(s.repo), trace, await readIntent(s.repo, SLUG)))).toEqual({ ok: true });
      } finally { trace.close(); }
      expect((await intentOf(s.repo)).status).toBe("merged");
    });
    s.cleanup();
  }, 180_000);

  test("a merge gh only queued waits with the branch kept, and is recorded once it merges", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      await s.setPr({ checks: "pass" });
      await withEnv({ LOOPSTRA_FAKE_GH_QUEUE: "1" }, async () => {
        const r = await tick(s.repo);
        expect(r.result).toEqual({ ok: true, waiting: true });
      });
      // Deleting the branch would close the pull request and drop it from the queue.
      expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], s.remote)).code).toBe(0);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });

      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
    });
    s.cleanup();
  }, 180_000);

  test("merged on GitHub, then main moved on in the same files: main has the merge commit, so the merge is recorded", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      const other = await elsewhere(s.remote);
      await run(["git", "merge", "-q", "--squash", `origin/${BRANCH}`], other.path);
      await run(["git", "commit", "-q", "-m", "merged on GitHub"], other.path);
      const mergeCommit = (await run(["git", "rev-parse", "HEAD"], other.path)).out.trim();
      await Bun.write(join(other.path, "src", "add.ts"), "export const add = (a: number, b: number) => b + a;\n");
      await run(["git", "commit", "-q", "-am", "later edit"], other.path);
      await run(["git", "push", "-q", "origin", "main"], other.path);
      other.cleanup();
      await s.setPr({ state: "MERGED", merged: true, mergeCommit });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect((await new Git(s.repo).run(["merge-base", "--is-ancestor", mergeCommit, "main"], true)).code).toBe(0);
    });
    s.cleanup();
  }, 180_000);

  test("a person on the status line: merge-approved waits for GitHub's checks, then merges", async () => {
    const s = await remoteSetup("gates:\n  merge:\n    human: status\n");
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      // The step looks at the pull request but changes nothing until a person decides.
      const looked = await tick(s.repo);
      expect(looked.picked).toBe(SLUG);
      expect(looked.result).toEqual({ ok: true, waiting: true });
      expect((await s.ghCalls()).some((a) => a[0] === "pr" && a[1] === "checks")).toBe(false);

      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "merge-approved", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: merge-approved");

      const r = await tick(s.repo);
      expect(r.picked).toBe(SLUG);
      expect((await intentOf(s.repo)).status).toBe("merge-approved");
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(false);

      await s.setPr({ checks: "pass" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
    });
    s.cleanup();
  }, 180_000);

  test("a person on the status line who saves merge-approved without committing it: merges and records it in one tick", async () => {
    const s = await remoteSetup("gates:\n  merge:\n    human: status\n");
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      await s.setPr({ checks: "pass" });
      // Saved, not committed: the sync skips a main checkout with unsaved tracked files, so the
      // merge step commits the change's own folder before it brings main up to date.
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "merge-approved", note: "" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect((await new Git(s.repo).run(["cat-file", "-e", "main:src/add.ts"], true)).code).toBe(0);
    });
    s.cleanup();
  }, 180_000);

  test("a person on the status line who merges or closes the pull request on GitHub instead: the loop sees it", async () => {
    const s = await remoteSetup("gates:\n  merge:\n    human: status\n");
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      // Closed on GitHub: blocked in plain words, without anyone touching the status line.
      await s.setPr({ state: "CLOSED" });
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "blocked", note: "The pull request was closed without merging. Set status to closed, or to plan-approved to rebuild." });

      // Reopened and merged on GitHub by the person: recorded as merged, never merged again.
      const j = await readIntent(s.repo, SLUG);
      await writeIntent(j, { status: "merge-review", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: retry");
      const other = await elsewhere(s.remote);
      await run(["git", "merge", "-q", "--squash", `origin/${BRANCH}`], other.path);
      await run(["git", "commit", "-q", "-m", "merged on GitHub"], other.path);
      await run(["git", "push", "-q", "origin", "main"], other.path);
      other.cleanup();
      await s.setPr({ state: "MERGED", merged: true });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect((await s.ghCalls()).some((a) => a[0] === "pr" && a[1] === "merge")).toBe(false);
      expect((await new Git(s.repo).run(["cat-file", "-e", "main:src/add.ts"], true)).code).toBe(0);
    });
    s.cleanup();
  }, 180_000);
});
