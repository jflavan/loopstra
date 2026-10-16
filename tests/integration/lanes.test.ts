import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readPause } from "../../src/heartbeat";
import { readIntent } from "../../src/intents";
import { lanesRunning } from "../../src/lanes";
import { tick } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE, fixture, run, TEMPLATES, tempDir, tempGitRepo, withEnv } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

afterEach(() => resetStop());

interface Change { slug: string; status: string; dependsOn?: string[] }

/** A plan whose only file is the change's own. */
const planFor = (slug: string) => `# Plan: ${slug}\n\n## Files that change\n- src/${slug}.ts (new)\n\n## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n`;

/** Statuses at which a change already has its spec and plan. */
const PLANNED = new Set(["plan-approved", "building", "reviewing", "merge-review", "merge-approved"]);

/**
 * A repository with Loopstra set up, `max_parallel_changes: n`, and these changes. Each change's
 * build writes its own file (src/<slug>.ts), from its own fixture folder, so changes never conflict.
 */
async function lanesRepo(n: number, changes: Change[], config = "") {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: echo ok\nspeed:\n  max_parallel_changes: ${n}\n${config}`);
  for (const c of changes) {
    const dir = join(repo.path, "intent", c.slug);
    mkdirSync(dir, { recursive: true });
    const deps = c.dependsOn ? `depends_on: [${c.dependsOn.join(", ")}]\n` : "";
    await Bun.write(join(dir, "intent.md"), `---\nstatus: ${c.status}\n${deps}---\n# Intent: ${c.slug}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`);
    if (PLANNED.has(c.status)) {
      await Bun.write(join(dir, "spec.md"), "# Spec\n\n## Summary\ns\n");
      await Bun.write(join(dir, "plan.md"), planFor(c.slug));
    }
  }
  await new Git(repo.path).commitAll("setup");
  const fixtures = tempDir("loopstra-fixtures-");
  for (const c of changes) {
    mkdirSync(join(fixtures.path, c.slug), { recursive: true });
    const build = fixture("build").replace('"path":"src/add.ts"', `"path":"src/${c.slug}.ts"`).split("\n").filter((l) => !l.includes("tests/add.test.ts")).join("\n");
    writeFileSync(join(fixtures.path, c.slug, "build.jsonl"), build);
  }
  const env: Record<string, string> = { LOOPSTRA_CLAUDE_EXECUTABLE: FAKE_CLAUDE, LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path };
  return { path: repo.path, fixtures: fixtures.path, env, cleanup: () => { repo.cleanup(); fixtures.cleanup(); } };
}

async function statusOf(repo: string, slug: string): Promise<string> {
  return (await readIntent(repo, slug)).file.frontmatter.status;
}

/** Reads the trace and closes it. */
function inTrace<T>(repo: string, fn: (t: Trace) => T): T {
  const t = Trace.open(repo);
  try { return fn(t); } finally { t.close(); }
}

/** The pause's back-off is over: the next tick runs steps again. */
async function expirePause(repo: string): Promise<void> {
  const p = readPause(repo)!;
  await Bun.write(join(repo, ".loopstra", "paused.json"), JSON.stringify({ ...p, until: new Date(Date.now() - 1000).toISOString() }));
}

const payloadOf = <T>(e: { payload: string }) => JSON.parse(e.payload) as T;

describe("more than one change at a time (speed.max_parallel_changes)", () => {
  test("two accepted changes both reach their next status in one tick; the second starts before the first ends", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    await withEnv(r.env, async () => {
      const t = await tick(r.path);
      expect(t.steps?.map((s) => s.slug).sort()).toEqual(["alpha", "beta"]);
      expect(await statusOf(r.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(r.path, "beta")).toBe("spec-approved");
      expect(lanesRunning()).toBe(0);
      inTrace(r.path, (trace) => {
        // Judged by start order, not by time: beta's first session started before alpha's last one ended.
        const betaStart = trace.events("beta").find((e) => e.type === "phase_start")!;
        const alphaEnd = trace.events("alpha").filter((e) => e.type === "phase_end").at(-1)!;
        expect(betaStart.id).toBeLessThan(alphaEnd.id);
        const together = trace.events("_loop").filter((e) => e.type === "command" && e.payload.includes("\"changes worked on together\""));
        expect(together).toHaveLength(1);
        expect(payloadOf<{ lanes: number; steps: string[]; busyMs: number }>(together[0]!)).toMatchObject({ lanes: 2, steps: expect.arrayContaining(["alpha", "beta"]) });
      });
      // Only the generated queue may be unsaved.
      expect((await new Git(r.path).run(["status", "--porcelain"])).out.trim()).toMatch(/^(M intent\/queue\.md)?$/);
    });
    r.cleanup();
  }, 120_000);

  test("with the default of one, the second change is untouched after the tick", async () => {
    const r = await lanesRepo(1, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    await withEnv(r.env, async () => {
      const t = await tick(r.path);
      expect(t.picked).toBe("alpha");
      expect(t.steps?.map((s) => s.slug)).toEqual(["alpha"]);
      expect(await statusOf(r.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(r.path, "beta")).toBe("accepted");
      inTrace(r.path, (trace) => {
        expect(trace.phases("beta")).toEqual([]);
        expect(trace.events("_loop").some((e) => e.payload.includes("\"changes worked on together\""))).toBe(false);
      });
    });
    r.cleanup();
  }, 120_000);

  test("two build steps in one tick each get their own worktree, and neither is blocked", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("reviewing");
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      const list = (await new Git(r.path).run(["worktree", "list", "--porcelain"])).out.replaceAll("\\", "/");
      for (const slug of ["alpha", "beta"]) {
        expect(existsSync(join(r.path, ".loopstra", "worktrees", slug, "src", `${slug}.ts`))).toBe(true);
        expect(list).toContain(`.loopstra/worktrees/${slug}`);
      }
      inTrace(r.path, (trace) => expect(trace.phases("beta")[0]!.name).toBe("branch"));
    });
    r.cleanup();
  }, 120_000);

  test("a change that depends on another waits for it to merge, then builds on a branch with its code", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "plan-approved", dependsOn: ["alpha"] }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // alpha builds
      expect(await statusOf(r.path, "alpha")).toBe("reviewing");
      inTrace(r.path, (trace) => expect(trace.phases("beta")).toEqual([]));
      await tick(r.path); // alpha merges; beta still waited when the tick began
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect(await statusOf(r.path, "beta")).toBe("plan-approved");
      await tick(r.path); // beta builds (and alpha is checked in the other lane)
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      expect((await new Git(r.path).run(["cat-file", "-e", "intent/beta:src/alpha.ts"], true)).code).toBe(0);
    });
    r.cleanup();
  }, 180_000);

  test("a stop while two changes run interrupts both, keeps their statuses, and leaves no lock held", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    const intake = join(r.path, "loopstra", "prompts", "intake.md");
    await Bun.write(intake, "{{intent}} FIXTURE:hang");
    await withEnv(r.env, async () => {
      const trace = Trace.open(r.path);
      const stopper = (async () => {
        while (!["alpha", "beta"].every((s) => trace.phases(s).some((p) => p.name === "intake"))) await Bun.sleep(50);
        requestStop();
      })();
      const t = await tick(r.path);
      await stopper;
      expect(t.stopped).toBe(true);
      for (const slug of ["alpha", "beta"]) {
        expect(await statusOf(r.path, slug)).toBe("designing");
        expect(trace.phases(slug).map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);
        expect(trace.events(slug).filter((e) => e.type === "stop")).toHaveLength(1);
      }
      trace.close();
      expect(lanesRunning()).toBe(0);

      // A second tick in the same process runs normally.
      resetStop();
      cpSync(join(TEMPLATES, "intake.md"), intake);
      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(r.path, "beta")).toBe("spec-approved");
    });
    r.cleanup();
  }, 120_000);

  test("an outage in one change only: it stays the pause's cause each tick, reaches the probe and is blocked, while the other moves on", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    writeFileSync(join(r.fixtures, "alpha", "intake.jsonl"), fixture("outage"));
    await withEnv({ ...r.env, LOOPSTRA_FAKE_DELAY_MS: "intake=500" }, async () => {
      for (const n of [1, 2]) {
        const t = await tick(r.path);
        expect(t.paused).toMatch(/^The assistant is unavailable/);
        expect(readPause(r.path)).toMatchObject({ slug: "alpha", phase: "intake", repeats: n, failures: 1 });
        await expirePause(r.path);
      }
      expect(await statusOf(r.path, "beta")).toBe("plan-approved");
      const third = await tick(r.path);
      expect(third.paused).toBeUndefined();
      expect(readPause(r.path)).toBeNull();
      const alpha = await readIntent(r.path, "alpha");
      expect(alpha.file.frontmatter.status).toBe("blocked");
      expect(alpha.file.frontmatter.note).toMatch(/^The assistant stopped unexpectedly\./);
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      inTrace(r.path, (trace) => {
        expect(trace.phases("alpha").map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted", "intake:interrupted", "intake:interrupted", "probe:success"]);
      });
    });
    r.cleanup();
  }, 180_000);

  test("when every lane meets the outage, one pause is written per tick and no further change starts", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }, { slug: "gamma", status: "accepted" }]);
    await withEnv({ ...r.env, LOOPSTRA_FAKE_FIXTURE: join(import.meta.dir, "..", "fake-claude", "fixtures", "outage.jsonl") }, async () => {
      for (const n of [1, 2]) {
        const t = await tick(r.path);
        expect(t.paused).toMatch(/^The assistant is unavailable/);
        expect(readPause(r.path)).toMatchObject({ slug: "alpha", failures: n, repeats: n });
        await expirePause(r.path);
      }
      inTrace(r.path, (trace) => {
        expect(trace.phases("alpha").map((p) => p.name)).toEqual(["intake", "intake"]);
        expect(trace.phases("beta").map((p) => p.name)).toEqual(["intake", "intake"]);
        expect(trace.phases("gamma")).toEqual([]);
        const pauses = ["alpha", "beta", "gamma", "_loop"].flatMap((s) => trace.events(s).filter((e) => e.type === "pause"));
        expect(pauses).toHaveLength(2);
      });
    });
    r.cleanup();
  }, 120_000);

  test("the day's budget decides how many changes run at once, and says so when it is fewer", async () => {
    const tight = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }], "claude:\n  max_budget_usd: 2\n  max_budget_usd_per_day: 3\n");
    await withEnv(tight.env, async () => {
      await tick(tight.path);
      expect(await statusOf(tight.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(tight.path, "beta")).toBe("accepted");
      await tick(tight.path);
      inTrace(tight.path, (trace) => {
        const notes = trace.events("_loop").filter((e) => e.type === "command" && e.payload.includes("changes at a time"));
        // Once, not on every tick.
        expect(notes).toHaveLength(1);
        expect(payloadOf<{ note: string }>(notes[0]!).note).toBe("Today's budget has room for 1 change at a time instead of 2.");
      });
    });
    tight.cleanup();

    const roomy = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }], "claude:\n  max_budget_usd: 2\n  max_budget_usd_per_day: 8\n");
    await withEnv(roomy.env, async () => {
      const t = await tick(roomy.path);
      expect(t.paused).toBeUndefined();
      expect(await statusOf(roomy.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(roomy.path, "beta")).toBe("spec-approved");
      inTrace(roomy.path, (trace) => {
        expect(["alpha", "beta", "_loop"].flatMap((s) => trace.events(s).filter((e) => e.type === "pause"))).toEqual([]);
        expect(trace.events("_loop").some((e) => e.payload.includes("changes at a time"))).toBe(false);
      });
    });
    roomy.cleanup();
  }, 180_000);

  test("three changes at once through every step: no index.lock error, nothing blocked, main clean, every status change committed", async () => {
    const slugs = ["alpha", "beta", "gamma"];
    const r = await lanesRepo(3, slugs.map((slug) => ({ slug, status: "accepted" })));
    await withEnv(r.env, async () => {
      for (let i = 0; i < 5; i++) await tick(r.path);
      for (const slug of slugs) expect(await statusOf(r.path, slug)).toBe("done");
      const git = new Git(r.path);
      expect((await git.run(["status", "--porcelain"])).out.trim()).toMatch(/^(M intent\/queue\.md)?$/);
      for (const slug of slugs) expect((await git.run(["cat-file", "-e", `main:src/${slug}.ts`], true)).code).toBe(0);
      const subjects = (await git.run(["log", "--format=%s", "main"])).out;
      inTrace(r.path, (trace) => {
        const errors = [...slugs, "_loop"].flatMap((s) => trace.events(s).filter((e) => e.type === "error"));
        expect(errors.filter((e) => e.payload.includes("index.lock"))).toEqual([]);
        for (const slug of slugs) {
          const moves = trace.events(slug).filter((e) => e.type === "status_change").map((e) => payloadOf<{ from: string; to: string }>(e));
          expect(moves.length).toBeGreaterThanOrEqual(8);
          for (const m of moves) expect(subjects).toContain(`loopstra(${slug}): ${m.from} → ${m.to}`);
        }
      });
    });
    r.cleanup();
  }, 300_000);
});

describe("more than one change at a time, with a GitHub remote", () => {
  test("a change merging in one lane is never also run by the other lane's between-phases merge", async () => {
    const remote = tempDir("loopstra-remote-");
    await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
    const r = await lanesRepo(1, [{ slug: "alpha", status: "plan-approved" }]);
    await run(["git", "remote", "add", "origin", remote.path], r.path);
    await run(["git", "push", "-q", "-u", "origin", "main"], r.path);
    const state = join(remote.path, "fake-gh.json");
    const env = { ...r.env, LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_STATE: state, LOOPSTRA_FAKE_GH_REMOTE: remote.path };
    await withEnv(env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");

      // Another change to build, two lanes, and alpha's checks pass.
      mkdirSync(join(r.path, "intent", "beta"), { recursive: true });
      await Bun.write(join(r.path, "intent", "beta", "intent.md"), "---\nstatus: plan-approved\n---\n# Intent: beta\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
      await Bun.write(join(r.path, "intent", "beta", "spec.md"), "# Spec\n\n## Summary\ns\n");
      await Bun.write(join(r.path, "intent", "beta", "plan.md"), planFor("beta"));
      mkdirSync(join(r.fixtures, "beta"), { recursive: true });
      writeFileSync(join(r.fixtures, "beta", "build.jsonl"), readFileSync(join(r.fixtures, "alpha", "build.jsonl"), "utf8").replace("src/alpha.ts", "src/beta.ts"));
      await Bun.write(configPath(r.path), (await Bun.file(configPath(r.path)).text()).replace("max_parallel_changes: 1", "max_parallel_changes: 2"));
      await new Git(r.path).commitAll("another change, two at a time");
      await run(["git", "push", "-q", "origin", "main"], r.path);
      const s = await Bun.file(state).json();
      for (const pr of Object.values(s.prs) as { checks: string }[]) pr.checks = "pass";
      await Bun.write(state, JSON.stringify(s));

      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      inTrace(r.path, (trace) => {
        const merges = trace.events("alpha").filter((e) => e.type === "status_change" && payloadOf<{ to: string }>(e).to === "merged");
        expect(merges).toHaveLength(1);
        expect(trace.events("alpha").some((e) => e.payload.includes("\"merge step between phases\""))).toBe(false);
      });
    });
    r.cleanup(); remote.cleanup();
  }, 180_000);
});
