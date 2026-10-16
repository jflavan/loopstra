import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readPause } from "../../src/heartbeat";
import { readIntent, writeIntent } from "../../src/intents";
import { lanesRunning } from "../../src/lanes";
import { PROBE_AFTER, runStepGuarded, tick } from "../../src/scheduler";
import { syncMain } from "../../src/remote";
import { requestStop, resetStop } from "../../src/stop";
import { PR_PUSHING } from "../../src/stages/shared";
import { Trace } from "../../src/trace";
import { copyRepo, FAKE_CLAUDE, fixture, run, TEMPLATES, tempDir, tempGitRepo, withEnv } from "../helpers";

const FAKE_GH = fileURLToPath(new URL("../fake-gh/gh.ts", import.meta.url));

afterEach(() => resetStop());

/**
 * A change in a test repository. `writes`: the files its build writes (path → content); by default
 * only its own src/<slug>.ts, so changes never conflict. Its plan lists them. `planFiles`: the plan's
 * file list instead (null: a plan with no Files that change section).
 */
interface Change { slug: string; status: string; dependsOn?: string[]; writes?: Record<string, string>; planFiles?: string[] | null }

/** The files a change's build writes. */
const writesOf = (c: Change) => c.writes ?? { [`src/${c.slug}.ts`]: "export function add(a: number, b: number): number {\n  return a + b;\n}\n" };

/** A plan that lists the files the change's build writes (or `planFiles`); the change's own file is new. */
function planFor(c: Change): string {
  const files = c.planFiles === undefined ? Object.keys(writesOf(c)) : c.planFiles;
  const line = (f: string) => `- ${f}${f === `src/${c.slug}.ts` ? " (new)" : ""}`;
  const list = files === null ? "" : `## Files that change\n${files.map(line).join("\n")}\n\n`;
  return `# Plan: ${c.slug}\n\n${list}## Order of work\n1. x\n\n## Risks\nNone.\n\n## Proof\nbun test.\n`;
}

/** The change's build session, as a fake fixture: it writes the change's files. */
function buildFixture(c: Change): string {
  const lines = fixture("build").split("\n").filter((l) => l.trim());
  const writes = Object.entries(writesOf(c)).map(([path, content]) => JSON.stringify({ type: "fake_action", write: { path, content } }));
  return [lines[0], ...writes, lines.at(-1)].join("\n") + "\n";
}

/** Statuses at which a change already has its spec and plan. */
const PLANNED = new Set(["plan-approved", "building", "reviewing", "merge-review", "merge-approved"]);

/** Writes a change's intent (and spec and plan at the planned statuses), and its own build fixture. Not committed. */
async function writeChange(path: string, fixtures: string, c: Change): Promise<void> {
  const dir = join(path, "intent", c.slug);
  mkdirSync(dir, { recursive: true });
  const deps = c.dependsOn ? `depends_on: [${c.dependsOn.join(", ")}]\n` : "";
  await Bun.write(join(dir, "intent.md"), `---\nstatus: ${c.status}\n${deps}---\n# Intent: ${c.slug}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n`);
  if (PLANNED.has(c.status)) {
    await Bun.write(join(dir, "spec.md"), "# Spec\n\n## Summary\ns\n");
    await Bun.write(join(dir, "plan.md"), planFor(c));
  }
  mkdirSync(join(fixtures, c.slug), { recursive: true });
  writeFileSync(join(fixtures, c.slug, "build.jsonl"), buildFixture(c));
  writeFileSync(join(fixtures, c.slug, "plan.jsonl"), planFixture(c));
}

/** The change's plan session, as a fake fixture: it writes planFor(c), so changes planned in a test list their own files. */
function planFixture(c: Change): string {
  return fixture("plan").split("\n").filter((l) => l.trim()).map((l) => {
    const e = JSON.parse(l) as { type: string; structured_output?: { plan_markdown: string } };
    if (e.type === "result" && e.structured_output) e.structured_output.plan_markdown = planFor(c);
    return JSON.stringify(e);
  }).join("\n") + "\n";
}

/**
 * A repository with Loopstra set up, `max_parallel_changes: n`, these changes, and `files` committed
 * on main. Each change's build comes from its own fixture folder.
 */
async function lanesRepo(n: number, changes: Change[], config = "", files: Record<string, string> = {}) {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: echo ok\nspeed:\n  max_parallel_changes: ${n}\n${config}`);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(repo.path, path), content);
  const fixtures = tempDir("loopstra-fixtures-");
  for (const c of changes) await writeChange(repo.path, fixtures.path, c);
  await new Git(repo.path).commitAll("setup");
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

/** A file of 20 numbered lines, with `edit` replacing some of them (by line number). */
function numbered(edit: Record<number, string> = {}): string {
  return Array.from({ length: 20 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
}

/** The id of the event that ended a change's (first) phase called `name`. */
function phaseEndId(trace: Trace, slug: string, name: string): number {
  const events = trace.events(slug);
  const start = events.findIndex((e) => e.type === "phase_start" && payloadOf<{ name: string }>(e).name === name);
  expect(start).toBeGreaterThanOrEqual(0);
  return events.slice(start).find((e) => e.type === "phase_end")!.id;
}

/** The changes in the order their merge phases ended. */
function mergeOrder(trace: Trace, slugs: string[]): string[] {
  return [...slugs].sort((a, b) => phaseEndId(trace, a, "merge") - phaseEndId(trace, b, "merge"));
}

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

  test("a lane whose problem cannot even be traced: the tick still waits for the other lane, which finishes its step", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    const releaseBeta = holdSession(r, "beta", "intake");
    // Every trace write for alpha fails (as with a full disk): its step fails, and so does tracing why.
    const event = Trace.prototype.event;
    let failed = 0;
    Trace.prototype.event = function (this: Trace, slug: string, ...rest: [never, unknown, (number | null)?]) {
      if (slug === "alpha") {
        failed++;
        throw new Error("disk full");
      }
      return event.call(this, slug, ...rest);
    };
    try {
      await withEnv(r.env, async () => {
        let ended = false;
        const running = tick(r.path).then((t) => { ended = true; return t; });
        await traceShows(r.path, (t) => t.phases("beta").some((p) => p.name === "intake"));
        const until = Date.now() + 60_000;
        while (failed < 2 && Date.now() < until) await Bun.sleep(50);
        expect(failed).toBeGreaterThanOrEqual(2);
        await Bun.sleep(500);
        // beta's session is still held: the tick has not ended under it.
        expect(ended).toBe(false);
        expect(lanesRunning()).toBeGreaterThanOrEqual(1);
        releaseBeta();
        const t = await running;
        expect(t.crashed).toBe("disk full");
        expect(await statusOf(r.path, "beta")).toBe("spec-approved");
        expect(lanesRunning()).toBe(0);
      });
    } finally { Trace.prototype.event = event; }
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

  test("a change the probe blocks in the second lane: the tick's picked and result stay the first lane's step", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    writeFileSync(join(r.fixtures, "beta", "intake.jsonl"), fixture("outage"));
    await withEnv(r.env, async () => {
      await tick(r.path);
      expect(readPause(r.path)).toMatchObject({ slug: "beta", phase: "intake", repeats: 1 });
      // One more repeat reaches the probe. beta is set back to accepted, so it is again second in the queue and runs in the second lane.
      await Bun.write(join(r.path, ".loopstra", "paused.json"), JSON.stringify({ ...readPause(r.path)!, repeats: PROBE_AFTER - 1, until: new Date(Date.now() - 1000).toISOString() }));
      const intent = join(r.path, "intent", "beta", "intent.md");
      await Bun.write(intent, (await Bun.file(intent).text()).replace("status: designing", "status: accepted"));
      await new Git(r.path).commitAll("beta back to accepted");

      const t = await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("plan-approved");
      expect(await statusOf(r.path, "beta")).toBe("blocked");
      expect(t.picked).toBe("alpha");
      expect(t.result?.ok).toBe(true);
      expect(t.steps?.find((s) => s.slug === "beta")?.result).toMatchObject({ ok: false });
    });
    r.cleanup();
  }, 120_000);

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

  test("fewer changes at a time, back to the configured number, then fewer again on the same day: each change is traced", async () => {
    const r = await lanesRepo(2, [], "claude:\n  max_budget_usd: 2\n  max_budget_usd_per_day: 3\n");
    const dayOf = async (usd: number) => Bun.write(configPath(r.path), (await Bun.file(configPath(r.path)).text()).replace(/max_budget_usd_per_day: \d+/, `max_budget_usd_per_day: ${usd}`));
    await withEnv(r.env, async () => {
      await tick(r.path); // room for 1
      await tick(r.path); // still 1: not traced again
      await dayOf(8);
      await tick(r.path); // room for 2 again
      await tick(r.path);
      await dayOf(3);
      await tick(r.path); // 1 again
    });
    inTrace(r.path, (trace) => {
      const notes = trace.events("_loop").filter((e) => e.type === "command" && e.payload.includes("changes at a time")).map((e) => payloadOf<{ note: string }>(e).note);
      expect(notes).toEqual([
        "Today's budget has room for 1 change at a time instead of 2.",
        "Today's budget has room for 2 changes at a time again.",
        "Today's budget has room for 1 change at a time instead of 2.",
      ]);
    });
    r.cleanup();
  }, 120_000);

  test("two changes reaching a local merge together merge one at a time: the second is tested again on a main with the first", async () => {
    // beta's plan lists no files, so the same-file wait does not keep it from building beside alpha.
    const r = await lanesRepo(2, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 20: "beta" }) }, planFiles: null },
    ], "", { "src/shared.ts": numbered() });
    await withEnv(r.env, async () => {
      await tick(r.path); // both build
      expect(await statusOf(r.path, "alpha")).toBe("reviewing");
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      await tick(r.path); // both are reviewed and merge
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect(await statusOf(r.path, "beta")).toBe("merged");
      expect((await new Git(r.path).run(["show", "main:src/shared.ts"])).out).toBe(numbered({ 1: "alpha", 20: "beta" }));
      inTrace(r.path, (trace) => {
        const [first, second] = mergeOrder(trace, ["alpha", "beta"]) as [string, string];
        // The second's merge checks ran after the first had merged, and ran the tests again: the code changed.
        const retest = trace.events(second).find((e) => e.type === "phase_start" && payloadOf<{ name: string }>(e).name === "merge-test-1");
        expect(retest).toBeDefined();
        expect(retest!.id).toBeGreaterThan(phaseEndId(trace, first, "merge"));
        expect(trace.phases(first).some((p) => p.name === "merge-test-1")).toBe(false);
      });
    });
    r.cleanup();
  }, 180_000);

  test("two changes that clash: the first merges, the second is blocked as out of date, and main keeps only the first", async () => {
    // As above, beta's plan lists no files: the same-file wait would otherwise keep the two apart.
    const r = await lanesRepo(2, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "beta" }) }, planFiles: null },
    ], "", { "src/shared.ts": numbered() });
    await withEnv(r.env, async () => {
      await tick(r.path);
      await tick(r.path);
      const first = (await statusOf(r.path, "alpha")) === "merged" ? "alpha" : "beta";
      const second = first === "alpha" ? "beta" : "alpha";
      expect(await statusOf(r.path, first)).toBe("merged");
      expect(await statusOf(r.path, second)).toBe("blocked");
      expect((await readIntent(r.path, second)).file.frontmatter.note).toMatch(/^The change overlaps with other recent changes/);
      const git = new Git(r.path);
      expect((await git.run(["show", "main:src/shared.ts"])).out).toBe(numbered({ 1: first }));
      expect((await git.run(["status", "--porcelain"])).out.trim()).toMatch(/^(M intent\/queue\.md)?$/);
    });
    r.cleanup();
  }, 180_000);

  test("two plan-approved changes that change the same file: only the first builds, the second waits with a note and builds once it merged", async () => {
    const r = await lanesRepo(2, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha", 2: "beta" }) } },
    ], "", { "src/shared.ts": numbered() });
    const note = "Waits for alpha to be merged first, because both change the same files.";
    const queueRow = async (slug: string) => (await Bun.file(join(r.path, "intent", "queue.md")).text()).split("\n").find((l) => l.startsWith(`| ${slug} |`)) ?? "";
    await withEnv(r.env, async () => {
      await tick(r.path); // alpha builds; beta waits
      expect(await statusOf(r.path, "alpha")).toBe("reviewing");
      expect(await statusOf(r.path, "beta")).toBe("plan-approved");
      expect(await queueRow("beta")).toContain(note);
      await tick(r.path); // alpha merges; beta still waited when the tick began
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      inTrace(r.path, (trace) => expect(trace.phases("beta")).toEqual([]));
      expect(await queueRow("beta")).not.toContain(note);
      await tick(r.path); // beta builds on main with alpha
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      expect((await new Git(r.path).run(["show", "intent/beta:src/shared.ts"])).out).toBe(numbered({ 1: "alpha", 2: "beta" }));
    });
    r.cleanup();
  }, 180_000);

  test("design commands that run in the main checkout run one at a time, and nothing commits on main while one runs", async () => {
    // The command notes, in order, when it starts and ends and where main is at each moment. It keeps
    // running a while, so another change's commit, or the other change's command, has time to land.
    const out = tempDir("loopstra-hooks-");
    const script = join(out.path, "hook.ts").replaceAll("\\", "/");
    const log = join(out.path, "hook.log").replaceAll("\\", "/");
    writeFileSync(script, [
      `import { appendFileSync } from "node:fs";`,
      `const head = () => Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();`,
      `const note = (what: string) => appendFileSync(process.argv[2]!, what + " " + process.env.LOOPSTRA_SLUG + " " + head() + "\\n");`,
      `note("start");`,
      `await Bun.sleep(1500);`,
      `note("end");`,
    ].join("\n"));
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }],
      `stages:\n  design:\n    before:\n      - 'bun "${script}" "${log}"'\n`);
    await withEnv(r.env, async () => {
      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(r.path, "beta")).toBe("spec-approved");
    });
    const lines = (await Bun.file(log).text()).trim().split("\n").map((l) => l.split(" ") as [string, string, string]);
    // Each run's start is followed by its own end: the two runs never overlap.
    expect(lines.map(([what]) => what)).toEqual(["start", "end", "start", "end"]);
    expect(lines.map(([, slug]) => slug).sort()).toEqual(["alpha", "alpha", "beta", "beta"]);
    for (const i of [0, 2]) {
      expect(lines[i + 1]![1]).toBe(lines[i]![1]);
      // Main did not move while the command ran.
      expect(lines[i + 1]![2]).toBe(lines[i]![2]);
    }
    r.cleanup();
    out.cleanup();
  }, 120_000);

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

type LanesRepo = Awaited<ReturnType<typeof lanesRepo>>;
type RemoteRepo = LanesRepo & { remote: string; state: string };

/** The fake gh's settings for a repository whose remote is the bare repository `remote`. */
function ghEnv(env: Record<string, string>, remote: string): Record<string, string> {
  return { ...env, LOOPSTRA_GH_EXECUTABLE: FAKE_GH, LOOPSTRA_FAKE_GH_STATE: join(remote, "fake-gh.json"), LOOPSTRA_FAKE_GH_REMOTE: remote };
}

/** lanesRepo with a bare repository as its GitHub remote, and the fake gh, which merges there for real. */
async function remoteLanesRepo(n: number, changes: Change[], config = ""): Promise<RemoteRepo> {
  const remote = tempDir("loopstra-remote-");
  await run(["git", "init", "-q", "--bare", "-b", "main"], remote.path);
  const r = await lanesRepo(n, changes, config);
  await run(["git", "remote", "add", "origin", remote.path], r.path);
  await run(["git", "push", "-q", "-u", "origin", "main"], r.path);
  return { ...r, remote: remote.path, state: join(remote.path, "fake-gh.json"), env: ghEnv(r.env, remote.path), cleanup: () => { r.cleanup(); remote.cleanup(); } };
}

/** A copy of a remote repository and of its remote (with the fake gh's pull requests), wired to each other. */
async function copyRemoteRepo(r: RemoteRepo): Promise<RemoteRepo> {
  const repo = await copyRepo(r.path);
  const remote = tempDir("loopstra-remote-");
  cpSync(r.remote, remote.path, { recursive: true });
  await run(["git", "remote", "set-url", "origin", remote.path], repo.path);
  return { ...r, path: repo.path, remote: remote.path, state: join(remote.path, "fake-gh.json"), env: ghEnv(r.env, remote.path), cleanup: () => { repo.cleanup(); remote.cleanup(); } };
}

/** Every open pull request's checks have passed on GitHub. */
async function checksPass(r: RemoteRepo): Promise<void> {
  const s = await Bun.file(r.state).json();
  for (const pr of Object.values(s.prs) as { checks: string }[]) pr.checks = "pass";
  await Bun.write(r.state, JSON.stringify(s));
}

/**
 * Sets speed.max_parallel_changes, commits everything, and pushes main. A changed config is code
 * outside intent/: with more than one change at a time, open pull requests are then out of date.
 */
async function commitWithLanes(r: RemoteRepo, n: number): Promise<void> {
  await Bun.write(configPath(r.path), (await Bun.file(configPath(r.path)).text()).replace(/max_parallel_changes: \d/, `max_parallel_changes: ${n}`));
  await new Git(r.path).commitAll(`${n} at a time`);
  await run(["git", "push", "-q", "origin", "main"], r.path);
}

/** A person pushes a commit adding `file` to the change's branch on GitHub (its pull request's branch). */
async function personPushes(r: RemoteRepo, slug: string, file: string): Promise<void> {
  const clone = tempDir("loopstra-person-");
  try {
    const git = (args: string[]) => run(["git", ...args], clone.path).then((x) => expect(x.code).toBe(0));
    await git(["clone", "-q", "-b", `intent/${slug}`, r.remote, "."]);
    await Bun.write(join(clone.path, file), "export const fix = 1;\n");
    await git(["add", "-A"]);
    await git(["-c", "user.name=Person", "-c", "user.email=person@example.com", "commit", "-q", "-m", `person: ${file}`]);
    await git(["push", "-q", "origin", `intent/${slug}`]);
  } finally { clone.cleanup(); }
}

/** A held session: the change's `phase` session waits until the returned `release` is called, then replays `answer`. */
function holdSession(r: LanesRepo, slug: string, phase: string, answer = phase): () => void {
  const release = join(r.fixtures, `release-${slug}-${phase}`);
  mkdirSync(join(r.fixtures, slug), { recursive: true });
  writeFileSync(join(r.fixtures, slug, `${phase}.jsonl`), `${JSON.stringify({ type: "fake_action", wait_for: release })}\n${fixture(answer)}`);
  return () => writeFileSync(release, "");
}

/** Waits until `done` is true of the trace (read afresh each time), or a minute has passed. */
async function traceShows(repo: string, done: (t: Trace) => boolean): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !inTrace(repo, done)) await Bun.sleep(100);
}

describe("more than one change at a time, with a GitHub remote", () => {
  test("a change merging in one lane is never also run by the other lane's between-phases merge", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");

      // Another change to build (only records reach main, so alpha's pull request stays up to date), and alpha's checks pass.
      await writeChange(r.path, r.fixtures, { slug: "beta", status: "plan-approved" });
      await commitWithLanes(r, 2);
      await checksPass(r);

      // GitHub answers alpha's lane only once beta's first phase has started, so beta's phase boundary
      // (the between-phases merge) always runs while alpha's step is under way.
      const answer = join(r.fixtures, "github-answers");
      await withEnv({ LOOPSTRA_FAKE_GH_WAIT_FOR: answer }, async () => {
        const running = tick(r.path);
        try {
          // Without the claim the boundary would wait on GitHub too, so beta's phase would never start:
          // GitHub answers after a while all the same.
          const until = Date.now() + 15_000;
          while (Date.now() < until && !inTrace(r.path, (t) => t.phases("beta").length > 0)) await Bun.sleep(50);
        } finally {
          writeFileSync(answer, "");
        }
        await running;
      });
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      // Merged on GitHub in alpha's own lane. While beta's lane runs, main here is not brought up to
      // date, so the merge may be recorded only by a later look (between beta's phases once alpha's
      // lane has ended, or on the next tick).
      for (let i = 0; i < 2 && (await statusOf(r.path, "alpha")) !== "merged"; i++) await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      inTrace(r.path, (trace) => {
        const merges = trace.events("alpha").filter((e) => e.type === "status_change" && payloadOf<{ to: string }>(e).to === "merged");
        expect(merges).toHaveLength(1);
        // Never run twice at once: one merge step looked at the checks, and merged on GitHub.
        expect(trace.gates("alpha").filter((g) => g.check === "pr-checks")).toHaveLength(1);
        expect(trace.phases("alpha").filter((p) => p.name === "merge")).toHaveLength(1);
        expect(trace.events("alpha").filter((e) => e.type === "error")).toEqual([]);
        expect(trace.events("alpha").some((e) => e.payload.includes("merge step between phases"))).toBe(false);
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

  test("a pull request merged while another change's session runs: main is not rebased during the tick, and the merge is recorded on the next", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // build
      await tick(r.path); // review, pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      await checksPass(r);
    });

    // One change at a time: the merge is recorded in the same tick, as before.
    const one = await copyRemoteRepo(r);
    await commitWithLanes(one, 1);
    await withEnv(one.env, async () => {
      await tick(one.path);
      expect(await statusOf(one.path, "alpha")).toBe("merged");
    });
    one.cleanup();

    // Two at a time: GitHub answers alpha's lane only once beta's intake has started, so beta's phase
    // boundary always runs while alpha's lane is under way (once alpha's lane ended, with one lane left,
    // a merge between beta's phases could rightly bring main up to date in this tick). Beta's intake
    // then runs until alpha's step has looked at main. It ends with a question, so beta's step has no
    // later phase.
    await writeChange(r.path, r.fixtures, { slug: "beta", status: "accepted" });
    const release = holdSession(r, "beta", "intake", "intake-question");
    await commitWithLanes(r, 2);
    const answer = join(r.fixtures, "github-answers");
    await withEnv({ ...r.env, LOOPSTRA_FAKE_GH_WAIT_FOR: answer }, async () => {
      const looked = (t: Trace) => t.events("alpha").some((e) => e.payload.includes("\"finish merge\"") || (e.type === "status_change" && e.payload.includes("merged")));
      const running = tick(r.path);
      try {
        await traceShows(r.path, (t) => t.phases("beta").length > 0);
        writeFileSync(answer, "");
        await traceShows(r.path, looked);
      } finally {
        writeFileSync(answer, "");
        release();
      }
      await running;
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect(await statusOf(r.path, "beta")).toBe("blocked");
      const git = new Git(r.path);
      expect((await git.run(["cat-file", "-e", "main:src/alpha.ts"], true)).code).not.toBe(0);
      inTrace(r.path, (trace) => {
        const waited = trace.events("alpha").filter((e) => e.payload.includes("\"finish merge\""));
        expect(waited).toHaveLength(1);
        expect(payloadOf<{ waiting: string }>(waited[0]!).waiting).toContain("because other changes are being worked on");
        expect(trace.events("_loop").some((e) => e.payload.includes("\"sync main\""))).toBe(false);
      });

      // The next tick's start brings main up to date, and the merge watch records the merge.
      await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect((await git.run(["cat-file", "-e", "main:src/alpha.ts"], true)).code).toBe(0);
      inTrace(r.path, (trace) => expect(trace.events("_loop").some((e) => e.payload.includes("\"sync main\""))).toBe(true));
    });
    r.cleanup();
  }, 240_000);

  test("two ready pull requests: after the first merges, the second is brought up to date and checked again before it merges", async () => {
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "plan-approved" }]);
    await withEnv(r.env, async () => {
      await tick(r.path); // both build
      await tick(r.path); // both are reviewed and get a pull request
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect(await statusOf(r.path, "beta")).toBe("merge-review");
      await checksPass(r);
    });
    const prs = async (repo: RemoteRepo) => (await Bun.file(repo.state).json()).prs as Record<string, { checks: string; merged: boolean }>;

    // One change at a time: both merge as before, with no second look.
    const one = await copyRemoteRepo(r);
    await commitWithLanes(one, 1);
    await withEnv(one.env, async () => {
      await tick(one.path);
      await tick(one.path);
      expect(await statusOf(one.path, "alpha")).toBe("merged");
      expect(await statusOf(one.path, "beta")).toBe("merged");
      inTrace(one.path, (trace) => {
        for (const slug of ["alpha", "beta"]) {
          expect(trace.events(slug).some((e) => e.payload.includes("Brought up to date"))).toBe(false);
          expect(trace.phases(slug).some((p) => p.name === "merge-test-1")).toBe(false);
        }
      });
    });
    one.cleanup();

    await withEnv(r.env, async () => {
      // The first to take the merge lock merges on GitHub; the second waits, as GitHub's main has code it never saw.
      await tick(r.path);
      const merged = Object.entries(await prs(r)).filter(([, p]) => p.merged).map(([branch]) => branch.replace("intent/", ""));
      expect(merged).toHaveLength(1);
      const first = merged[0]!;
      const second = first === "alpha" ? "beta" : "alpha";

      const cfg = await loadConfig(r.path);
      const trace = Trace.open(r.path);
      try {
        // Looked at again before main here has the first change: it still waits, and the wait is traced once.
        const remoteAheadWaits = () => trace.events(second).filter((e) => e.type === "command" && payloadOf<{ command: string; waiting?: string }>(e).command === "up to date" && e.payload.includes("\"waiting\""));
        expect(remoteAheadWaits()).toHaveLength(1);
        expect(await runStepGuarded(new StepContext(r.path, cfg, trace, await readIntent(r.path, second)))).toEqual({ ok: true, waiting: true });
        expect(remoteAheadWaits()).toHaveLength(1);

        // Started between another change's phases, a pull request that main here has overtaken waits for its own turn.
        await syncMain(r.path, cfg, trace);
        const ctx = new StepContext(r.path, cfg, trace, await readIntent(r.path, second));
        ctx.betweenPhases = true;
        expect(await runStepGuarded(ctx)).toEqual({ ok: true, waiting: true });
        expect(trace.phases(second).some((p) => p.name === "merge-test-1")).toBe(false);
        expect(trace.events(second).some((e) => e.payload.includes("Brought up to date"))).toBe(false);
      } finally { trace.close(); }

      // A re-check that rebased the branch here but stopped before its push (a stop, an outage, a
      // failed push): the pull request on GitHub still has the old head, which never met the first
      // change. It is checked again and pushed, never merged as it is.
      const stale = await copyRemoteRepo(r);
      try {
        expect(await new Git(join(stale.path, ".loopstra", "worktrees", second)).rebaseOnto("main")).toBe(true);
        await withEnv(stale.env, async () => {
          const staleTrace = Trace.open(stale.path);
          try {
            const ctx = new StepContext(stale.path, await loadConfig(stale.path), staleTrace, await readIntent(stale.path, second));
            expect(await runStepGuarded(ctx)).toEqual({ ok: true, waiting: true });
            expect(staleTrace.events(second).filter((e) => e.payload.includes("Brought up to date"))).toHaveLength(1);
          } finally { staleTrace.close(); }
        });
        expect((await prs(stale))[`intent/${second}`]!.merged).toBe(false);
        expect((await run(["git", "cat-file", "-e", `intent/${second}:src/${first}.ts`], stale.remote)).code).toBe(0);
      } finally { stale.cleanup(); }

      // Main here gets the first change at the next tick's start. The second is rebased onto it, tested
      // again, and pushed again; its pull request stays open and it keeps its status.
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
      await writeIntent(await readIntent(both.path, "alpha"), { status: "merge-review", note: "" });
      await new Git(both.path).commitPaths(["intent/alpha"], "person: retry");
      await withEnv(both.env, async () => {
        const trace = Trace.open(both.path);
        try {
          const ctx = new StepContext(both.path, await loadConfig(both.path), trace, await readIntent(both.path, "alpha"));
          expect(await runStepGuarded(ctx)).toEqual({ ok: true, waiting: true });
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

  test("an outage in one lane: the other lane, whose step only looked at a pull request, starts no further change", async () => {
    // alpha's pull request has its checks pending, so its step only looks, and its lane would then
    // take the next change. GitHub answers that look only once beta has met the outage in the other lane.
    const r = await remoteLanesRepo(2, [{ slug: "alpha", status: "merge-review" }, { slug: "beta", status: "accepted" }, { slug: "gamma", status: "accepted" }]);
    await Bun.write(r.state, JSON.stringify({ prs: { "intent/alpha": { number: 1, state: "OPEN", reviewDecision: "", checks: "pending", merged: false, comments: [] } }, next: 2 }));
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
        expect(trace.phases("gamma")).toEqual([]);
      });
    });
    r.cleanup();
  }, 120_000);
});
