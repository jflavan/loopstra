import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE, run, TEMPLATES, tempDir, tempGitRepo, withEnv } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));
const SLUG = "add-numbers";
const BRANCH = `intent/${SLUG}`;
const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

interface FakePr { number: number; state: string; reviewDecision: string; checks: string; merged: boolean; title?: string; body?: string; comments: string[] }

/**
 * A bare "GitHub" remote and a clone of it with Loopstra set up and one intent at plan-approved.
 * The fake gh merges on the bare remote for real, the way GitHub would.
 */
async function remoteSetup(config = "") {
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  const repo = await tempGitRepo();
  await run(["git", "remote", "add", "origin", remote.path], repo.path);
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: bun test\n${config}`);
  await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await Bun.write(join(repo.path, "tests", "smoke.test.ts"), 'import { expect, test } from "bun:test";\ntest("smoke", () => { expect(1 + 1).toBe(2); });\n');
  mkdirSync(join(repo.path, "intent", SLUG), { recursive: true });
  await Bun.write(join(repo.path, "intent", SLUG, "intent.md"), "---\nstatus: plan-approved\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n");
  await Bun.write(join(repo.path, "intent", SLUG, "spec.md"), "# Spec\n\n## Summary\ns\n");
  await Bun.write(join(repo.path, "intent", SLUG, "plan.md"), PLAN);
  await new Git(repo.path).commitAll("setup");
  await run(["git", "push", "-q", "-u", "origin", "main"], repo.path);
  // The fake gh keeps its pull requests next to the bare repository (git ignores the extra files).
  const state = join(remote.path, "fake-gh.json");
  const log = join(remote.path, "fake-gh.log");
  const env = { LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_STATE: state, LOOPSTRA_FAKE_GH_REMOTE: remote.path, LOOPSTRA_FAKE_GH_LOG: log };
  const pr = async (): Promise<FakePr> => (await Bun.file(state).json()).prs[BRANCH];
  const setPr = async (patch: Partial<FakePr>) => {
    const s = await Bun.file(state).json();
    Object.assign(s.prs[BRANCH], patch);
    await Bun.write(state, JSON.stringify(s));
  };
  const ghCalls = async (): Promise<string[][]> => existsSync(log) ? (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l)) : [];
  const cleanup = () => { repo.cleanup(); remote.cleanup(); };
  return { repo: repo.path, remote: remote.path, env, pr, setPr, ghCalls, cleanup };
}

async function intentOf(repo: string) {
  return (await readIntent(repo, SLUG)).file.frontmatter;
}

/** A separate clone of the remote, as a person elsewhere (or GitHub's web editor) would use. */
async function elsewhere(remote: string) {
  const t = tempDir("loopstra-elsewhere-");
  await run(["git", "clone", "-q", remote, "."], t.path);
  await run(["git", "config", "user.email", "person@example.com"], t.path);
  await run(["git", "config", "user.name", "Person"], t.path);
  return t;
}

async function onRemoteMain(remote: string, path: string): Promise<boolean> {
  return (await run(["git", "cat-file", "-e", `main:${path}`], remote)).code === 0;
}

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

  test("failed checks and a closed pull request block in plain words; a pull request merged on GitHub is recorded once", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      await s.setPr({ checks: "fail" });
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "blocked" });
      expect((await intentOf(s.repo)).note).toContain("The automatic checks on GitHub failed. An engineer should look at the pull request.");

      // Retry: back to waiting; this time a person closes the pull request.
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "merge-review", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: retry");
      await s.setPr({ state: "CLOSED", checks: "pass" });
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({
        status: "blocked",
        note: "The pull request was closed without merging. Set status to closed, or to plan-approved to rebuild.",
      });

      // Someone merged it on GitHub meanwhile: the loop records it without merging again.
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
      expect(await new Git(s.repo).branchExists(BRANCH)).toBe(false);
    });
    s.cleanup();
  }, 180_000);
});
