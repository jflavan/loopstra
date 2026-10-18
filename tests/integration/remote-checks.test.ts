import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attention } from "../../src/attention";
import { loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { PR_PUSHING } from "../../src/stages/shared";
import { requestStop, resetStop } from "../../src/stop";
import { Trace } from "../../src/trace";
import { fixture, fixtureDir, run, withEnv } from "../helpers";
import { FAKE_GH, SLUG, BRANCH, remoteSetup, intentOf, elsewhere, onRemoteMain, headOn, inTrace, personPushesOnce } from "./remote-helpers";

afterEach(() => resetStop());

describe("the loop with a GitHub remote: checks, people's pushes, and closed pull requests", () => {
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
      expect((await needs(0)).filter((i) => i.title === "Not answering")).toEqual([]);
      expect((await needs(20)).filter((i) => i.title === "Not answering")).toEqual([
        { kind: "sync", label: "GitHub", slug: null, title: "Not answering", what: `GitHub hasn't answered for 15 minutes: ${AUTH}` },
      ]);
      await tick(s.repo);
      expect(github().map((x) => x.result)).toEqual(["pass", "fail"]);
      expect((await needs(20)).filter((i) => i.title === "Not answering")).toEqual([]);
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

  test("commits a person pushed to an old pull request get the grace period for their checks to start, as Loopstra's own push does", async () => {
    const s = await remoteSetup();
    await Bun.write(join(s.repo, ".github", "workflows", "ci.yml"), "on: pull_request\njobs: {}\n");
    await new Git(s.repo).commitAll("ci");
    await run(["git", "push", "-q", "origin", "main"], s.repo);
    const push = await personPushesOnce(s.remote);
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request
      // Opened and pushed long ago; its checks passed.
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      await s.setPr({ checks: "pass", checksHead: await headOn(s.remote), createdAt: old });
      await Bun.write(join(s.repo, ".loopstra", "runs", SLUG, "pr-pushed"), old);
      await withEnv({ LOOPSTRA_FAKE_GH_AFTER_CHECKS: push.script }, () => tick(s.repo));
      expect(existsSync(push.done)).toBe(true);
      inTrace(s.repo, (trace) => expect(trace.events(SLUG).some((e) => e.payload.includes("\"take pull request commits\""))).toBe(true));
      // GitHub has not registered the checks of the person's commit yet: the change waits for them.
      await s.setPr({ checks: "none", checksHead: "" });
      await tick(s.repo);
      expect((await s.pr()).merged).toBe(false);
      expect((await intentOf(s.repo)).status).toBe("merge-review");
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

  test("a change built before Loopstra knew its pull request's number opens a new one when the branch's is closed, as it did then", async () => {
    const s = await remoteSetup();
    await withEnv(s.env, async () => {
      await tick(s.repo); // build
      await tick(s.repo); // review, pull request #1
      await s.setPr({ state: "CLOSED" });
      rmSync(join(s.repo, ".loopstra", "runs", SLUG, "pr-number"));
      const i = await readIntent(s.repo, SLUG);
      await writeIntent(i, { status: "reviewing" });
      await new Git(s.repo).commitPaths([`intent/${SLUG}`], "loopstra: another round");
      await tick(s.repo);
      expect(await intentOf(s.repo)).toMatchObject({ status: "merge-review" });
      expect((await s.ghCalls()).filter((a) => a[0] === "pr" && a[1] === "create")).toHaveLength(2);
      expect(readFileSync(join(s.repo, ".loopstra", "runs", SLUG, "pr-number"), "utf8")).toBe("2");
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
