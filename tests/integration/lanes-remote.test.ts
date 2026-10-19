import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { claim, release } from "../../src/lanes";
import { runStepGuarded, tick } from "../../src/scheduler";
import { resetStop } from "../../src/stop";
import { PR_PUSHING } from "../../src/stages/shared";
import { Trace } from "../../src/trace";
import { run, tempDir, withEnv, writeIntentOnDisk } from "../helpers";
import { writeChange, statusOf, inTrace, payloadOf, numbered, type RemoteRepo, remoteLanesRepo, copyRemoteRepo, checksPass, commitWithLanes, personPushes, holdSession, traceShows } from "./lanes-helpers";

afterEach(() => resetStop());

describe("more than one change at a time, with a GitHub remote", () => {
  test("one change at a time: a change that changes the same files as an open pull request waits for it to merge, then builds on main with it", async () => {
    const r = await remoteLanesRepo(1, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha", 2: "beta" }) } },
    ], "", { "src/shared.ts": numbered() });
    const note = "Waits for alpha to be merged first, because both change the same files.";
    const queueRow = async (slug: string) => (await Bun.file(join(r.path, "intent", "queue.md")).text()).split("\n").find((l) => l.startsWith(`| ${slug} |`)) ?? "";
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      // Alpha's pull request is the watcher's; the one lane is free, but beta waits for it.
      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect(await statusOf(r.path, "beta")).toBe("plan-approved");
      inTrace(r.path, (trace) => expect(trace.phases("beta")).toEqual([]));
      expect(await queueRow("beta")).toContain(note);
      await checksPass(r);
      await tick(r.path); // the watcher merges alpha; beta still waited when the tick began
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect(await queueRow("beta")).not.toContain(note);
      await tick(r.path); // alpha's final check, first in the queue
      expect(await statusOf(r.path, "alpha")).toBe("done");
      await tick(r.path); // beta builds on main with alpha
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      expect((await new Git(r.path).run(["show", "intent/beta:src/shared.ts"])).out).toBe(numbered({ 1: "alpha", 2: "beta" }));
    });
    r.cleanup();
  }, 240_000);

  test("a change watching its pull request is the watcher's, never a lane's: it merges, once, while another change builds", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");

      // Another change to build (only records reach main, so alpha's pull request stays up to date), and alpha's checks pass.
      await writeChange(r.path, r.fixtures, { slug: "beta", status: "plan-approved" });
      await commitWithLanes(r, 2);
      await checksPass(r);
      const t = await tick(r.path);
      // The lanes ran beta only; the watcher merged alpha, and main here took it at once.
      expect(t.picked).toBe("beta");
      expect(t.steps?.map((s) => s.slug).sort()).toEqual(["alpha", "beta"]);
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect((await new Git(r.path).run(["cat-file", "-e", "main:src/alpha.ts"], true)).code).toBe(0);
      inTrace(r.path, (trace) => {
        const merges = trace.events("alpha").filter((e) => e.type === "status_change" && payloadOf<{ to: string }>(e).to === "merged");
        expect(merges).toHaveLength(1);
        // Never run twice: one merge step looked at the checks, and merged on GitHub.
        expect(trace.gates("alpha").filter((g) => g.check === "pr-checks")).toHaveLength(1);
        expect(trace.phases("alpha").filter((p) => p.name === "merge")).toHaveLength(1);
        expect(trace.events("alpha").filter((e) => e.type === "error")).toEqual([]);
      });
      const s = await Bun.file(r.state).json();
      expect(Object.values(s.prs as Record<string, { merged: boolean }>).filter((p) => p.merged)).toHaveLength(1);
    });
    r.cleanup();
  }, 180_000);

  test("a main checkout that fetches only main from GitHub (a single-branch clone): a ready pull request still merges", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await run(["git", "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main"], r.path);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      await run(["git", "update-ref", "-d", "refs/remotes/origin/intent/alpha"], r.path);
      await checksPass(r);
      await tick(r.path);
      expect((await Bun.file(r.state).json()).prs["intent/alpha"].merged).toBe(true);
      inTrace(r.path, (trace) => expect(trace.events("alpha").some((e) => e.payload.includes("Brought up to date"))).toBe(false));
    });
    r.cleanup();
  }, 180_000);

  test("a push GitHub took although a stop cut it short is not taken for a person's commits when the pull request is looked at again", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    const worktree = new Git(join(r.path, ".loopstra", "worktrees", "alpha"));
    const head = async () => (await run(["git", "rev-parse", "intent/alpha"], r.path)).out.trim();
    /** Main gains code, and the branch here is rebased onto it. */
    const mainMoves = async (file: string) => {
      await Bun.write(join(r.path, "src", file), "export const x = 1;\n");
      await new Git(r.path).commitAll(`person: ${file}`);
      await run(["git", "push", "-q", "origin", "main"], r.path);
      expect(await worktree.rebaseOnto("main")).toBe(true);
    };
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      await checksPass(r);

      // A push reached GitHub, but the stop that cut it short left it recorded only as in progress.
      await mainMoves("one.ts");
      const cutShort = await head();
      writeFileSync(join(r.path, ".loopstra", "runs", "alpha", PR_PUSHING), cutShort);
      await run(["git", "push", "-q", "--force", "origin", "intent/alpha"], r.path);
      // Then main gained more code, and the branch here was rebased again before it was pushed.
      await mainMoves("two.ts");

      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect((await run(["git", "rev-parse", "intent/alpha"], r.remote)).out.trim()).toBe(await head());
      inTrace(r.path, (trace) => {
        expect(trace.events("alpha").some((e) => e.payload.includes("\"take pull request commits\""))).toBe(false);
        expect(trace.events("alpha").filter((e) => e.payload.includes("Brought up to date"))).toHaveLength(1);
      });
    });
    r.cleanup();
  }, 180_000);

  test("a pull request merged while another change's session runs: main moves under it at once, and the merge is recorded in the same tick", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      await checksPass(r);
    });

    for (const n of [1, 2]) {
      // Beta's intake is held until alpha's merge is recorded, so main moves while beta's session runs. It
      // ends with a question, so beta's step has no later phase.
      const c = await copyRemoteRepo(r);
      await writeChange(c.path, c.fixtures, { slug: "beta", status: "accepted" });
      rmSync(join(c.fixtures, "release-beta-intake"), { force: true }); // the fixtures are shared with the copy before
      const release = holdSession(c, "beta", "intake", "intake-question");
      await commitWithLanes(c, n);
      // Alpha's pull request already has the commit that set n at a time, as if checked with it.
      expect(await new Git(join(c.path, ".loopstra", "worktrees", "alpha")).rebaseOnto("main")).toBe(true);
      expect((await run(["git", "push", "-q", "--force", "origin", "intent/alpha"], c.path)).code).toBe(0);
      await withEnv(c.env, async () => {
        const running = tick(c.path);
        try {
          await traceShows(c.path, (t) => t.phases("beta").length > 0 && t.events("alpha").some((e) => e.type === "status_change" && e.payload.includes("\"merged\"")));
          // Recorded while beta's intake still runs, in its snapshot of main from before the merge.
          expect(inTrace(c.path, (t) => t.phases("beta").map((p) => p.status))).toEqual(["running"]);
        } finally {
          release();
        }
        await running;
        expect(await statusOf(c.path, "alpha")).toBe("merged");
        // Its question asks a person: the change waits at its status, with the question open.
        expect(await statusOf(c.path, "beta")).toBe("designing");
        expect((await readIntent(c.path, "beta")).file.frontmatter.question).toBe("open");
        expect((await new Git(c.path).run(["cat-file", "-e", "main:src/alpha.ts"], true)).code).toBe(0);
        expect(existsSync(join(c.path, ".loopstra", "snapshots", "beta"))).toBe(false);
        inTrace(c.path, (trace) => expect(trace.events("alpha").some((e) => e.payload.includes("\"finish merge\""))).toBe(false));
      });
      c.cleanup();
    }
    r.cleanup();
  }, 240_000);

  test("two ready pull requests: the first merges and is recorded at once; the second is brought up to date and checked again before it merges", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // both build
      await tick(r.path); // both are reviewed and get a pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect(await statusOf(r.path, "beta")).toBe("merge-review");
      await checksPass(r);
    });
    const prs = async (repo: RemoteRepo) => (await Bun.file(repo.state).json()).prs as Record<string, { checks: string; merged: boolean }>;

    // One change at a time: the watcher still runs beside the lane, so one merge can leave another pull
    // request out of date. The first merges; the second is brought up to date and waits for its checks again.
    const one = await copyRemoteRepo(r);
    await commitWithLanes(one, 1);
    for (const slug of ["alpha", "beta"]) {
      // Both pull requests already have the commit that set one at a time, as if checked with it.
      expect(await new Git(join(one.path, ".loopstra", "worktrees", slug)).rebaseOnto("main")).toBe(true);
      expect((await run(["git", "push", "-q", "--force", "origin", `intent/${slug}`], one.path)).code).toBe(0);
    }
    await withEnv(one.env, async () => {
      await tick(one.path);
      const merged = Object.entries(await prs(one)).filter(([, p]) => p.merged).map(([branch]) => branch.replace("intent/", ""));
      expect(merged).toHaveLength(1);
      const first = merged[0]!;
      const second = first === "alpha" ? "beta" : "alpha";
      expect(await statusOf(one.path, first)).toBe("merged");
      expect(await statusOf(one.path, second)).toBe("merge-review");
      expect((await run(["git", "cat-file", "-e", `intent/${second}:src/${first}.ts`], one.remote)).code).toBe(0);
      inTrace(one.path, (trace) => {
        expect(trace.events(second).filter((e) => e.payload.includes("Brought up to date"))).toHaveLength(1);
        expect(trace.phases(second).some((p) => p.name === "merge-test-1")).toBe(true);
      });
      await checksPass(one);
      await tick(one.path);
      expect((await prs(one))[`intent/${second}`]!.merged).toBe(true);
    });
    one.cleanup();

    // A re-check that rebased the branch here but stopped before its push (a stop, an outage, a
    // failed push): the pull request on GitHub still has the old head, which never met main's newer
    // code. It is checked again and pushed, never merged as it is.
    const stale = await copyRemoteRepo(r);
    try {
      await commitWithLanes(stale, 2);
      expect(await new Git(join(stale.path, ".loopstra", "worktrees", "alpha")).rebaseOnto("main")).toBe(true);
      await withEnv(stale.env, async () => {
        const staleTrace = Trace.open(stale.path);
        try {
          const ctx = new StepContext(stale.path, await loadConfig(stale.path), staleTrace, await readIntent(stale.path, "alpha"));
          expect(await runStepGuarded(ctx)).toEqual({ ok: true });
          expect(staleTrace.events("alpha").filter((e) => e.payload.includes("Brought up to date"))).toHaveLength(1);
        } finally { staleTrace.close(); }
      });
      expect((await prs(stale))["intent/alpha"]!.merged).toBe(false);
      expect((await run(["git", "rev-parse", "intent/alpha"], stale.remote)).out.trim()).toBe((await run(["git", "rev-parse", "intent/alpha"], stale.path)).out.trim());
    } finally { stale.cleanup(); }

    await withEnv(r.env, async () => {
      // While main here cannot be brought up to date (a person's unsaved edit), the first to take the merge
      // lock merges on GitHub and waits to be recorded; the second waits for main here, traced once.
      await Bun.write(join(r.path, "README.md"), "# a person's unsaved edit\n");
      await tick(r.path);
      const merged = Object.entries(await prs(r)).filter(([, p]) => p.merged).map(([branch]) => branch.replace("intent/", ""));
      expect(merged).toHaveLength(1);
      const first = merged[0]!;
      const second = first === "alpha" ? "beta" : "alpha";
      expect(await statusOf(r.path, first)).toBe("merge-review");
      const remoteAheadWaits = () => inTrace(r.path, (trace) => trace.events(second).filter((e) => e.type === "command" && payloadOf<{ command: string; waiting?: string }>(e).command === "up to date" && e.payload.includes("\"waiting\"")));
      expect(remoteAheadWaits()).toHaveLength(1);
      expect(payloadOf<{ waiting: string }>(remoteAheadWaits()[0]!).waiting).toContain("the main_sync signal says why");
      await tick(r.path);
      expect(remoteAheadWaits()).toHaveLength(1);
      expect(await statusOf(r.path, first)).toBe("merge-review");
      await run(["git", "checkout", "--", "README.md"], r.path);

      // With every lane busy, a pull request that main here has overtaken waits for a free one before it is checked again.
      const cfg = await loadConfig(r.path);
      const trace = Trace.open(r.path);
      claim("busy-1");
      claim("busy-2");
      try {
        expect(await runStepGuarded(new StepContext(r.path, cfg, trace, await readIntent(r.path, second)))).toEqual({ ok: true, waiting: true });
        expect(trace.phases(second).some((p) => p.name === "merge-test-1")).toBe(false);
        expect(trace.events(second).some((e) => e.payload.includes("Brought up to date"))).toBe(false);
      } finally {
        release("busy-1");
        release("busy-2");
        trace.close();
      }

      // Main here has the first change now: it is recorded; the second is rebased onto it, tested again,
      // and pushed again, and its pull request stays open and it keeps its status.
      await tick(r.path);
      expect(await statusOf(r.path, first)).toBe("merged");
      expect(await statusOf(r.path, second)).toBe("merge-review");
      expect((await prs(r))[`intent/${second}`]!.merged).toBe(false);
      expect((await run(["git", "cat-file", "-e", `intent/${second}:src/${first}.ts`], r.remote)).code).toBe(0);
      inTrace(r.path, (trace) => {
        const again = trace.events(second).filter((e) => e.payload.includes("Brought up to date with changes merged meanwhile; waiting for the automatic checks on GitHub again."));
        expect(again).toHaveLength(1);
        expect(trace.phases(second).some((p) => p.name === "merge-test-1")).toBe(true);
      });

      // GitHub runs the checks again; the pull request merges once they pass.
      const s = await Bun.file(r.state).json();
      s.prs[`intent/${second}`].checks = "pending";
      await Bun.write(r.state, JSON.stringify(s));
      await tick(r.path);
      expect((await prs(r))[`intent/${second}`]!.merged).toBe(false);
      await checksPass(r);
      await tick(r.path);
      expect((await prs(r))[`intent/${second}`]!.merged).toBe(true);
      for (let i = 0; i < 2 && (await statusOf(r.path, second)) !== "merged"; i++) await tick(r.path);
      expect(await statusOf(r.path, second)).toBe("merged");
    });
    r.cleanup();
  }, 300_000);

  test("a fix a person pushed to the pull request is kept when it is brought up to date, and never overwritten when the branch here changed too", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
    });
    // An engineer pushes a fix to the pull request's branch on GitHub; meanwhile main gains code.
    await personPushes(r, "alpha", "src/fix.ts");
    await Bun.write(join(r.path, "src", "other.ts"), "export const other = 1;\n");
    await new Git(r.path).commitAll("other code");
    await run(["git", "push", "-q", "origin", "main"], r.path);
    await checksPass(r);
    const onRemote = async (repo: RemoteRepo, file: string) => (await run(["git", "cat-file", "-e", `intent/alpha:${file}`], repo.remote)).code === 0;

    // The branch here was also changed and not pushed (a bring-up-to-date that stopped before its
    // push): neither side is overwritten, and an engineer is asked to bring them together.
    const both = await copyRemoteRepo(r);
    try {
      expect(await new Git(join(both.path, ".loopstra", "worktrees", "alpha")).rebaseOnto("main")).toBe(true);
      await withEnv(both.env, async () => {
        const trace = Trace.open(both.path);
        try {
          const ctx = new StepContext(both.path, await loadConfig(both.path), trace, await readIntent(both.path, "alpha"));
          expect((await runStepGuarded(ctx)).ok).toBe(false);
        } finally { trace.close(); }
      });
      expect(await statusOf(both.path, "alpha")).toBe("blocked");
      expect((await readIntent(both.path, "alpha")).file.frontmatter.note).toContain("added commits to the pull request's branch on GitHub");
      expect(await onRemote(both, "src/fix.ts")).toBe(true);

      // An engineer brings the two together here, as the note asks, and retries: the branch here now
      // has GitHub's copy, so it is pushed over it, and the pull request keeps the fix.
      const wt = join(both.path, ".loopstra", "worktrees", "alpha");
      expect((await run(["git", "-c", "user.name=Engineer", "-c", "user.email=engineer@example.com", "merge", "-q", "--no-edit", "refs/remotes/origin/intent/alpha"], wt)).code).toBe(0);
      await writeIntentOnDisk(await readIntent(both.path, "alpha"), { status: "merge-review", note: "" });
      await new Git(both.path).commitPaths(["intent/alpha"], "person: retry");
      await withEnv(both.env, async () => {
        const trace = Trace.open(both.path);
        try {
          const ctx = new StepContext(both.path, await loadConfig(both.path), trace, await readIntent(both.path, "alpha"));
          expect(await runStepGuarded(ctx)).toEqual({ ok: true });
        } finally { trace.close(); }
      });
      expect(await statusOf(both.path, "alpha")).toBe("merge-review");
      expect(await onRemote(both, "src/fix.ts")).toBe(true);
      expect(await onRemote(both, "src/other.ts")).toBe(true);
    } finally { both.cleanup(); }

    // Otherwise the person's commits are taken into the branch here, which is checked again with
    // them and pushed: the pull request keeps the fix and gains main's code.
    await withEnv(r.env, async () => {
      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect(await onRemote(r, "src/fix.ts")).toBe(true);
      expect(await onRemote(r, "src/other.ts")).toBe(true);
      expect((await Bun.file(r.state).json()).prs["intent/alpha"].merged).toBe(false);
      inTrace(r.path, (trace) => {
        expect(trace.events("alpha").filter((e) => e.payload.includes("\"take pull request commits\""))).toHaveLength(1);
        expect(trace.events("alpha").filter((e) => e.payload.includes("Brought up to date"))).toHaveLength(1);
      });
    });
    r.cleanup();
  }, 240_000);

  test("a fix a person pushed that the workspace here cannot take: blocked saying so, not as if the branch here had changed too", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
    });
    await personPushes(r, "alpha", "src/fix.ts");
    await checksPass(r);
    // Unsaved edits in the change's workspace to the file the person's commit adds: git will not take it.
    await Bun.write(join(r.path, ".loopstra", "worktrees", "alpha", "src", "fix.ts"), "export const mine = 2;\n");
    await withEnv(r.env, async () => { await tick(r.path); });
    const alpha = await readIntent(r.path, "alpha");
    expect(alpha.file.frontmatter.status).toBe("blocked");
    expect(alpha.file.frontmatter.note).toMatch(/^Someone added commits to the pull request's branch on GitHub, and they could not be taken into the workspace here/);
    expect(alpha.file.frontmatter.note).not.toContain("the branch here changed too");
    inTrace(r.path, (trace) => {
      const blocked = trace.events("alpha").filter((e) => e.type === "status_change" && payloadOf<{ to: string }>(e).to === "blocked");
      expect(blocked).toHaveLength(1);
      expect(trace.events("alpha").map((e) => e.payload).join("\n")).not.toContain("each have commits the other lacks");
    });
    expect((await Bun.file(r.state).json()).prs["intent/alpha"].merged).toBe(false);
    r.cleanup();
  }, 240_000);

  test("a pull request a person updated with rebase on GitHub is taken as it is, not blocked as if the branch here had changed too", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
    });
    // Main gains code, and a person presses GitHub's "Update with rebase": the branch there is rewritten onto it.
    await Bun.write(join(r.path, "src", "other.ts"), "export const other = 1;\n");
    await new Git(r.path).commitAll("other code");
    await run(["git", "push", "-q", "origin", "main"], r.path);
    const clone = tempDir("loopstra-person-");
    try {
      const git = (args: string[]) => run(["git", ...args], clone.path).then((x) => expect(x.code).toBe(0));
      await git(["clone", "-q", "-b", "intent/alpha", r.remote, "."]);
      await git(["-c", "user.name=GitHub", "-c", "user.email=github@example.test", "rebase", "-q", "origin/main"]);
      await git(["push", "-q", "--force", "origin", "intent/alpha"]);
    } finally { clone.cleanup(); }
    await checksPass(r);
    const onGitHub = async () => (await run(["git", "rev-parse", "intent/alpha"], r.remote)).out.trim();
    const rebased = await onGitHub();
    await withEnv(r.env, async () => {
      await tick(r.path);
      const alpha = (await readIntent(r.path, "alpha")).file.frontmatter;
      expect(alpha.status).not.toBe("blocked");
      expect(alpha.note ?? "").not.toContain("the branch here changed too");
      for (let i = 0; i < 2 && !(await Bun.file(r.state).json()).prs["intent/alpha"].merged; i++) await tick(r.path);
      expect((await Bun.file(r.state).json()).prs["intent/alpha"].merged).toBe(true);
      expect((await run(["git", "cat-file", "-e", "main:src/alpha.ts"], r.remote)).code).toBe(0);
      // GitHub's rewritten copy was taken as it is, once.
      inTrace(r.path, (trace) => {
        const taken = trace.events("alpha").filter((e) => e.payload.includes("\"take pull request commits\""));
        expect(taken.map((e) => payloadOf<{ head: string }>(e).head)).toEqual([rebased]);
      });
    });
    r.cleanup();
  }, 240_000);

  test("an outage in a lane also ends the pull request watcher: it looks at no further pull request, and the tick pauses once", async () => {
    // Two pull requests with their checks pending, so their steps only look. GitHub answers the
    // watcher's first look only once beta has met the outage in the lane.
    const r = await remoteLanesRepo(1, [{ slug: "alpha", status: "merge-review" }, { slug: "delta", status: "merge-review" }, { slug: "beta", status: "accepted" }]);
    const pr = (n: number) => ({ number: n, state: "OPEN", reviewDecision: "", checks: "pending", merged: false, comments: [] });
    await Bun.write(r.state, JSON.stringify({ prs: { "intent/alpha": pr(1), "intent/delta": pr(2) }, next: 3 }));
    const answer = join(r.fixtures, "github-answers");
    const outage = join(import.meta.dir, "..", "fake-claude", "fixtures", "outage.jsonl");
    await withEnv({ ...r.env, LOOPSTRA_FAKE_GH_WAIT_FOR: answer, LOOPSTRA_FAKE_FIXTURE: outage }, async () => {
      const running = tick(r.path);
      try {
        await traceShows(r.path, (t) => t.phases("beta").some((p) => p.status === "interrupted"));
        // A moment for beta's lane to pass the outage on (GitHub's answer takes two gh calls anyway).
        await Bun.sleep(300);
      } finally {
        writeFileSync(answer, "");
      }
      const t = await running;
      expect(t.paused).toMatch(/^The assistant is unavailable/);
      expect(t.steps?.map((s) => s.slug).sort()).toEqual(["alpha", "beta"]);
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      inTrace(r.path, (trace) => {
        expect(trace.phases("beta").map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);
        expect(trace.events("delta").filter((e) => e.type !== "status_change")).toEqual([]);
        expect(trace.events("beta").filter((e) => e.type === "pause")).toHaveLength(1);
      });
    });
    r.cleanup();
  }, 120_000);
});
