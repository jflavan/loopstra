import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attention } from "../../src/attention";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git, GitTimeout } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { runStepGuarded, tick } from "../../src/scheduler";
import { PR_PUSHING } from "../../src/stages/shared";
import { requestStop, resetStop } from "../../src/stop";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE, fixture, fixtureDir, run, TEMPLATES, tempDir, tempGitRepo, withEnv } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

afterEach(() => resetStop());
const SLUG = "add-numbers";
const BRANCH = `intent/${SLUG}`;
const PLAN = "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n";

interface FakePr { number: number; state: string; reviewDecision: string; checks: string; checksHead?: string; merged: boolean; mergeCommit?: string; createdAt?: string; title?: string; body?: string; comments: string[] }

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

/** The change's branch head on the remote. */
async function headOn(remote: string): Promise<string> {
  return (await run(["git", "rev-parse", BRANCH], remote)).out.trim();
}

function inTrace<T>(repo: string, fn: (t: Trace) => T): T {
  const t = Trace.open(repo);
  try { return fn(t); } finally { t.close(); }
}

/**
 * A bun script for the fake gh's knobs: a person pushes a commit adding src/person.ts to the change's
 * branch on the remote, the first time it runs (`done` exists after).
 */
async function personPushesOnce(remote: string): Promise<{ script: string; done: string }> {
  const done = join(remote, "person-pushed");
  const script = join(remote, "person-pushes.ts");
  await Bun.write(script, [
    'import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    `if (!existsSync(${JSON.stringify(done)})) {`,
    '  const dir = mkdtempSync(join(tmpdir(), "loopstra-person-"));',
    '  const git = (...a: string[]) => Bun.spawnSync({ cmd: ["git", "-c", "user.name=Person", "-c", "user.email=person@example.com", ...a], cwd: dir });',
    `  git("clone", "-q", "-b", ${JSON.stringify(BRANCH)}, ${JSON.stringify(remote)}, ".");`,
    '  writeFileSync(join(dir, "src", "person.ts"), "export const person = 1;");',
    '  git("add", "-A");',
    '  git("commit", "-q", "-m", "person: a fix");',
    `  git("push", "-q", "origin", ${JSON.stringify(BRANCH)});`,
    '  rmSync(dir, { recursive: true, force: true });',
    `  writeFileSync(${JSON.stringify(done)}, "");`,
    "}",
    "",
  ].join("\n"));
  return { script, done };
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

  test("checks that pass while another change's step runs: the watcher merges the pull request then, not after the step", async () => {
    const s = await remoteSetup();
    mkdirSync(join(s.repo, "intent", "other"), { recursive: true });
    await Bun.write(join(s.repo, "intent", "other", "intent.md"), "---\nstatus: plan-approved\n---\n# Intent: other\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await Bun.write(join(s.repo, "intent", "other", "spec.md"), "# Spec\n\n## Summary\ns\n");
    await Bun.write(join(s.repo, "intent", "other", "plan.md"), PLAN);
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
    await withEnv(s.env, async () => {
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

  test("recording a merged pull request that keeps failing is traced once, and after 30 minutes blocks with a look again", async () => {
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
        // The failures started 31 minutes ago.
        writeFileSync(join(s.repo, ".loopstra", "runs", SLUG, "finish-failing"), new Date(Date.now() - 31 * 60_000).toISOString());
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

  test("no checks reported yet on a new pull request whose branch has workflows: waits, then merges once the grace period is over", async () => {
    const s = await remoteSetup();
    await Bun.write(join(s.repo, ".github", "workflows", "ci.yml"), "on: pull_request\njobs: {}\n");
    await new Git(s.repo).commitAll("ci");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      await s.setPr({ checks: "none" });
      const r = await tick(s.repo);
      expect(r.result).toEqual({ ok: true, waiting: true });
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect((await s.pr()).merged).toBe(false);

      // Opened long ago, but Loopstra pushed to it moments ago (a reworked change): still waits.
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      await s.setPr({ createdAt: old });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");

      // Both long ago, and still no checks: merges.
      await Bun.write(join(s.repo, ".loopstra", "runs", SLUG, "pr-pushed"), old);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
      expect(await onRemoteMain(s.remote, "src/add.ts")).toBe(true);
    });
    s.cleanup();
  }, 180_000);

  test("a pull request with no checks, on a branch without workflows, merges", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo);
      await tick(s.repo);
      await s.setPr({ checks: "none" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");
    });
    s.cleanup();
  }, 180_000);

  test("GitHub not answering is one signal, not a line per look; after 15 minutes it is in Needs attention, until GitHub answers", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      const cfg = await loadConfig(s.repo);
      const github = () => inTrace(s.repo, (t) => t.signals(500).filter((x) => x.name === "github"));
      const needs = async (minutes: number) => {
        const t = Trace.open(s.repo);
        try { return await attention(s.repo, cfg, t, new Date(Date.now() + minutes * 60_000)); } finally { t.close(); }
      };
      const AUTH = "HTTP 401: Bad credentials (https://api.github.com/graphql)";
      await withEnv({ LOOPSTRA_FAKE_GH_FAIL: "1" }, async () => {
        await tick(s.repo);
        await tick(s.repo);
      });
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect(github().map((x) => [x.result, x.output])).toEqual([["fail", AUTH]]);
      expect(inTrace(s.repo, (t) => t.events(SLUG).filter((e) => e.type === "error" && e.payload.includes("Bad credentials")))).toEqual([]);
      expect((await needs(0)).filter((i) => i.title === "GitHub")).toEqual([]);
      expect((await needs(20)).filter((i) => i.title === "GitHub")).toEqual([
        { kind: "sync", label: "GitHub", slug: null, title: "GitHub", what: `GitHub hasn't answered for 15 minutes: ${AUTH}` },
      ]);
      await tick(s.repo);
      expect(github().map((x) => x.result)).toEqual(["pass", "fail"]);
      expect((await needs(20)).filter((i) => i.title === "GitHub")).toEqual([]);
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

  test("a pull request closed without merging, whose branch a person then deleted on GitHub: a rebuild opens a new one", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      await s.setPr({ state: "CLOSED" });
      await tick(s.repo);
      expect((await intentOf(s.repo)).note).toContain("The pull request was closed without merging.");

      // GitHub's "Delete branch" button; the branch here still remembers it as pushed.
      expect((await run(["git", "branch", "-D", BRANCH], s.remote)).code).toBe(0);
      expect((await run(["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`], s.repo)).code).toBe(0);
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "plan-approved", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: rebuild");

      await tick(s.repo); // build again
      await tick(s.repo); // review, a new pull request
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review", note: "Waiting for the automatic checks on GitHub." });
      expect((await run(["git", "rev-parse", BRANCH], s.remote)).out.trim()).toBe((await run(["git", "rev-parse", BRANCH], s.repo)).out.trim());
      expect((await s.pr()).state).toBe("OPEN");
    });
    s.cleanup();
  }, 180_000);

  test("commits a person pushes to the pull request as it merges are not merged until their own checks pass", async () => {
    const s = await remoteSetup();
    const push = await personPushesOnce(s.remote);
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      await s.setPr({ checks: "pass", checksHead: await headOn(s.remote) });
      // The push lands between the look at the checks and GitHub's merge.
      await withEnv({ LOOPSTRA_FAKE_GH_BEFORE_MERGE: push.script }, () => tick(s.repo));
      expect(existsSync(push.done)).toBe(true);
      expect((await s.pr()).merged).toBe(false);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });
      inTrace(s.repo, (trace) => expect(trace.events(SLUG).some((e) => e.payload.includes("New commits arrived on the pull request"))).toBe(true));
      // GitHub's checks of the person's commit still run.
      await tick(s.repo);
      expect((await s.pr()).merged).toBe(false);
      // They pass: the commit is taken into the branch here, and the pull request merges with it.
      await s.setPr({ checksHead: await headOn(s.remote) });
      await tick(s.repo);
      expect((await s.pr()).merged).toBe(true);
      expect(await onRemoteMain(s.remote, "src/person.ts")).toBe(true);
      inTrace(s.repo, (trace) => expect(trace.events(SLUG).filter((e) => e.payload.includes("\"take pull request commits\""))).toHaveLength(1));
    });
    s.cleanup();
  }, 180_000);

  test("commits a person pushed after the checks were read are taken, and wait for their own checks before it merges", async () => {
    const s = await remoteSetup();
    const push = await personPushesOnce(s.remote);
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      await s.setPr({ checks: "pass", checksHead: await headOn(s.remote) });
      // The push lands just after the checks were read, before the step fetches the branch.
      await withEnv({ LOOPSTRA_FAKE_GH_AFTER_CHECKS: push.script }, () => tick(s.repo));
      expect(existsSync(push.done)).toBe(true);
      expect((await s.ghCalls()).some((a) => a[0] === "pr" && a[1] === "merge")).toBe(false);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });
      expect((await run(["git", "rev-parse", BRANCH], s.repo)).out.trim()).toBe(await headOn(s.remote));
      await s.setPr({ checksHead: await headOn(s.remote) });
      await tick(s.repo);
      expect((await s.pr()).merged).toBe(true);
      expect(await onRemoteMain(s.remote, "src/person.ts")).toBe(true);
    });
    s.cleanup();
  }, 180_000);
  test("an owner who closes the pull request while the change is reviewed again is not overridden by a new one", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request #1
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      // The owner closes it while the change goes round the review once more (as anotherRound sends it).
      await s.setPr({ state: "CLOSED" });
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "reviewing" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "loopstra: another round");
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "blocked" });
      expect((await intentOf(s.repo)).note).toContain("The pull request was closed without merging.");
      expect((await s.ghCalls()).filter((a) => a[0] === "pr" && a[1] === "create")).toHaveLength(1);
      expect((await Bun.file(join(s.remote, "fake-gh.json")).json()).next).toBe(2);
    });
    s.cleanup();
  }, 180_000);

  test("a rebuild after its pull request merged is not taken for merged by that old pull request", async () => {
    const s = await remoteSetup();
    // The rebuild changes the code again, so it has something of its own to merge.
    const build = fixture("build").replace("  return a + b;", "  // checked again\\n  return a + b;");
    const fixtures = fixtureDir({ "build-2": build });
    await withEnv({ ...s.env, LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request #1
      expect(readFileSync(join(s.repo, ".loopstra", "runs", SLUG, "pr-number"), "utf8")).toBe("1");
      // #1 merges on GitHub, and the loop records it.
      const other = await elsewhere(s.remote);
      await run(["git", "merge", "-q", "--squash", `origin/${BRANCH}`], other.path);
      await run(["git", "commit", "-q", "-m", "merged on GitHub"], other.path);
      await run(["git", "push", "-q", "origin", "main"], other.path);
      const mergeCommit = (await run(["git", "rev-parse", "HEAD"], other.path)).out.trim();
      other.cleanup();
      await s.setPr({ state: "MERGED", merged: true, mergeCommit });
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merged");

      // A person asks for a rebuild. Its review passes while GitHub cannot be reached, so no pull request opens.
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "plan-approved", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: rebuild");
      await tick(s.repo); // build again
      expect((await intentOf(s.repo)).status).toBe("reviewing");
      await run(["git", "remote", "set-url", "origin", join(s.remote, "gone")], s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("blocked");

      // GitHub is back and the person retries the merge: #1 is not this build's, so a new pull request opens.
      await run(["git", "remote", "set-url", "origin", s.remote], s.repo);
      const j = await readIntent(s.repo, SLUG);
      await writeIntent(j, { status: "merge-review", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: retry");
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
      expect((await s.ghCalls()).filter((a) => a[0] === "pr" && a[1] === "create")).toHaveLength(2);
      expect(readFileSync(join(s.repo, ".loopstra", "runs", SLUG, "pr-number"), "utf8")).toBe("2");
      expect(await s.pr()).toMatchObject({ number: 2, state: "OPEN" });
    });
    fixtures.cleanup();
    s.cleanup();
  }, 180_000);

  test("a push cut short that GitHub took is still known as Loopstra's own after GitHub could not be asked about it once", async () => {
    const s = await remoteSetup();
    const worktree = new Git(join(s.repo, ".loopstra", "worktrees", SLUG));
    const pushing = join(s.repo, ".loopstra", "runs", SLUG, PR_PUSHING);
    const mainMoves = async (file: string) => {
      await Bun.write(join(s.repo, "src", file), "export const x = 1;\n");
      await new Git(s.repo).commitAll(`person: ${file}`);
      await run(["git", "push", "-q", "origin", "main"], s.repo);
      expect(await worktree.rebaseOnto("main")).toBe(true);
    };
    const here = async () => (await run(["git", "rev-parse", BRANCH], s.repo)).out.trim();
    const onGitHub = async () => (await run(["git", "rev-parse", BRANCH], s.remote)).out.trim();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      expect((await intentOf(s.repo)).status).toBe("merge-review");

      // A push GitHub took, recorded only as in progress (a stop cut it short).
      await mainMoves("one.ts");
      const cutShort = await here();
      writeFileSync(pushing, cutShort);
      await run(["git", "push", "-q", "--force", "origin", BRANCH], s.repo);
      // Main moves on and the branch is rebased again; the pull request is gone from GitHub's list,
      // so the merge step opens it again, pushing first. GitHub cannot be reached this time.
      await mainMoves("two.ts");
      const state = await Bun.file(join(s.remote, "fake-gh.json")).json();
      delete state.prs[BRANCH];
      await Bun.write(join(s.remote, "fake-gh.json"), JSON.stringify(state));
      await run(["git", "remote", "set-url", "origin", join(s.remote, "gone")], s.repo);
      await tick(s.repo);
      expect((await intentOf(s.repo)).status).toBe("blocked");
      expect(readFileSync(pushing, "utf8").trim()).toBe(cutShort);

      // GitHub is back and a person retries: the push goes over Loopstra's own commit.
      await run(["git", "remote", "set-url", "origin", s.remote], s.repo);
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "merge-review", note: "" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "person: retry");
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review", note: "" });
      expect(await onGitHub()).toBe(await here());
      expect((await s.pr()).state).toBe("OPEN");
    });
    s.cleanup();
  }, 180_000);

  test("a push GitHub took just as a stop cut it short is Loopstra's own: the next push goes over it, and nothing is blocked", async () => {
    const s = await remoteSetup();
    const worktree = new Git(join(s.repo, ".loopstra", "worktrees", SLUG));
    /** Main gains code, and the branch here is rebased onto it: a new head to push. */
    const mainMoves = async (file: string) => {
      await Bun.write(join(s.repo, "src", file), "export const x = 1;\n");
      await new Git(s.repo).commitAll(`person: ${file}`);
      await run(["git", "push", "-q", "origin", "main"], s.repo);
      expect(await worktree.rebaseOnto("main")).toBe(true);
    };
    /** The pull request is gone from GitHub's list, so the merge step opens it again, pushing first. */
    const dropPr = async () => {
      const state = await Bun.file(join(s.remote, "fake-gh.json")).json();
      delete state.prs[BRANCH];
      await Bun.write(join(s.remote, "fake-gh.json"), JSON.stringify(state));
    };
    const onGitHub = async () => (await run(["git", "rev-parse", BRANCH], s.remote)).out.trim();
    const here = async () => (await run(["git", "rev-parse", BRANCH], s.repo)).out.trim();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      expect((await intentOf(s.repo)).status).toBe("merge-review");

      // GitHub takes the next push of the branch, then holds the push open until the stop ends it.
      await mainMoves("one.ts");
      await dropPr();
      const received = join(s.remote, "received").replace(/\\/g, "/");
      const hook = join(s.remote, "hooks", "post-receive");
      await Bun.write(hook, `#!/bin/sh\nif grep -q refs/heads/intent/; then echo > "${received}"; sleep 4; fi\n`);
      chmodSync(hook, 0o755);
      const stopper = (async () => {
        while (!existsSync(received)) await Bun.sleep(50);
        requestStop();
      })();
      const t = await tick(s.repo);
      await stopper;
      expect(t.stopped).toBe(true);
      expect(await onGitHub()).toBe(await here());
      rmSync(hook);
      resetStop();

      // Main moves on again and the branch is rebased: the push that follows goes over GitHub's copy.
      await mainMoves("two.ts");
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review", note: "Waiting for the automatic checks on GitHub." });
      expect(await onGitHub()).toBe(await here());
      expect((await s.pr()).state).toBe("OPEN");
    });
    s.cleanup();
  }, 180_000);
});
