import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readPause } from "../../src/heartbeat";
import { readIntent } from "../../src/intents";
import { othersRunning } from "../../src/lanes";
import { PROBE_AFTER, tick } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { Trace } from "../../src/trace";
import { fixture, TEMPLATES, tempDir, withEnv } from "../helpers";
import { lanesRepo, resolveFixture, statusOf, inTrace, expirePause, payloadOf, numbered, phaseEndId, mergeOrder, holdSession, traceShows, statusShows } from "./lanes-helpers";

afterEach(() => resetStop());

describe("more than one change at a time (speed.max_parallel_changes)", () => {
  test("two accepted changes both reach their next status in one tick; the second starts before the first ends", async () => {
    const r = await lanesRepo(2, [{ slug: "alpha", status: "accepted" }, { slug: "beta", status: "accepted" }]);
    await withEnv(r.env, async () => {
      const t = await tick(r.path);
      expect(t.steps?.map((s) => s.slug).sort()).toEqual(["alpha", "beta"]);
      expect(await statusOf(r.path, "alpha")).toBe("spec-approved");
      expect(await statusOf(r.path, "beta")).toBe("spec-approved");
      expect(othersRunning("")).toBe(0);
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

  test("with one at a time and think_ahead off, the second change is untouched after the tick", async () => {
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

  test("two builds running at once get different slots, ports and temp folders", async () => {
    const out = tempDir("loopstra-slots-");
    const script = join(out.path, "slot.ts").replaceAll("\\", "/");
    const log = join(out.path, "slots.log").replaceAll("\\", "/");
    writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2]!, [process.env.LOOPSTRA_SLUG, process.env.LOOPSTRA_SLOT, process.env.LOOPSTRA_PORT_BASE, process.env.TMPDIR].join("\\t") + "\\n");\n`);
    const r = await lanesRepo(2, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "plan-approved" }],
      `stages:\n  build:\n    before:\n      - 'bun "${script}" "${log}"'\n`);
    // alpha's step holds at its verifier until beta's build has started: the two run at once.
    const releaseAlpha = holdSession(r, "alpha", "verify");
    await withEnv(r.env, async () => {
      const ticking = tick(r.path);
      await traceShows(r.path, (t) => t.phases("beta").some((p) => p.name === "build"));
      releaseAlpha();
      await ticking;
      expect(await statusOf(r.path, "alpha")).toBe("reviewing");
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
    });
    const lines = (await Bun.file(log).text()).trim().split("\n").map((l) => l.split("\t"));
    expect(lines.map((l) => l[1]).sort()).toEqual(["0", "1"]);
    // Ten ports each, no overlap, and each its own temp folder.
    const ports = lines.map((l) => Number(l[2])).sort((a, b) => a - b);
    expect(ports[1]! - ports[0]!).toBeGreaterThanOrEqual(10);
    expect(new Set(lines.map((l) => l[3])).size).toBe(2);
    r.cleanup();
    out.cleanup();
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
      expect(othersRunning("")).toBe(0);

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
        expect(othersRunning("")).toBeGreaterThanOrEqual(1);
        releaseBeta();
        const t = await running;
        expect(t.crashed).toBe("disk full");
        expect(await statusOf(r.path, "beta")).toBe("spec-approved");
        expect(othersRunning("")).toBe(0);
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
        // beta's sessions after its intake ask other models than alpha's intake, so they do not end the back-off.
        expect(readPause(r.path)).toMatchObject({ slug: "alpha", phase: "intake", model: "haiku", repeats: n, failures: n });
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

  test("two changes that clash: the first merges, and the second's conflict is resolved, tested and reviewed before it merges too", async () => {
    // As below, beta's plan lists no files: the same-file wait would otherwise keep the two apart.
    const r = await lanesRepo(2, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "beta" }) }, planFiles: null },
    ], "", { "src/shared.ts": numbered() });
    // Whichever merges second resolves line 1 to keep both.
    for (const slug of ["alpha", "beta"]) resolveFixture(r.fixtures, slug, { "src/shared.ts": numbered({ 1: "alpha and beta" }) });
    await withEnv(r.env, async () => {
      for (let i = 0; i < 4 && ((await statusOf(r.path, "alpha")) !== "merged" || (await statusOf(r.path, "beta")) !== "merged"); i++) await tick(r.path);
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      expect(await statusOf(r.path, "beta")).toBe("merged");
      expect((await new Git(r.path).run(["show", "main:src/shared.ts"])).out).toBe(numbered({ 1: "alpha and beta" }));
      inTrace(r.path, (trace) => {
        const [, second] = mergeOrder(trace, ["alpha", "beta"]) as [string, string];
        const names = trace.phases(second).map((p) => p.name);
        // Resolved, then tested, then reviewed again, all before it merged.
        expect(names.indexOf("resolve")).toBeGreaterThan(-1);
        expect(names.indexOf("merge-test-1")).toBeGreaterThan(names.indexOf("resolve"));
        expect(names.lastIndexOf("review-2")).toBeGreaterThan(names.indexOf("merge-test-1"));
      });
    });
    r.cleanup();
  }, 180_000);

  test("two changes that clash and cannot be resolved: the first merges, the second is blocked as out of date, and main keeps only the first", async () => {
    // As above, beta's plan lists no files: the same-file wait would otherwise keep the two apart.
    const r = await lanesRepo(2, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "beta" }) }, planFiles: null },
    ], "", { "src/shared.ts": numbered() });
    for (const slug of ["alpha", "beta"]) resolveFixture(r.fixtures, slug, {}, false);
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
      expect((await git.run(["show", `main:intent/${second}/conflict.md`])).out).toContain("the two changes want different things");
      expect((await git.run(["status", "--porcelain"])).out.trim()).toMatch(/^(M intent\/queue\.md)?$/);
    });
    r.cleanup();
  }, 180_000);

  test("without a remote, a change waiting for a person that another change's merge conflicts with is brought up to date and reviewed again", async () => {
    const r = await lanesRepo(2, [
      { slug: "alpha", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "alpha" }) } },
      { slug: "beta", status: "plan-approved", writes: { "src/shared.ts": numbered({ 1: "beta" }) }, planFiles: null },
    ], "gates:\n  merge:\n    human: status\n", { "src/shared.ts": numbered() });
    for (const slug of ["alpha", "beta"]) resolveFixture(r.fixtures, slug, { "src/shared.ts": numbered({ 1: "alpha and beta" }) });
    await withEnv(r.env, async () => {
      await tick(r.path); // both build
      await tick(r.path); // both are reviewed and wait for a person
      expect(await statusOf(r.path, "alpha")).toBe("merge-review");
      expect(await statusOf(r.path, "beta")).toBe("merge-review");
      // A person lets alpha in.
      const alpha = await readIntent(r.path, "alpha");
      await Bun.write(join(alpha.dir, "intent.md"), (await Bun.file(join(alpha.dir, "intent.md")).text()).replace("status: merge-review", "status: merge-approved"));
      await new Git(r.path).commitAll("person: merge-approved");
      await tick(r.path); // alpha merges
      expect(await statusOf(r.path, "alpha")).toBe("merged");
      await tick(r.path); // beta no longer merges cleanly: resolved, tested, back to review
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      expect((await readIntent(r.path, "beta")).file.frontmatter.note).toMatch(/^Other work merged into main meanwhile conflicted/);
      await tick(r.path); // reviewed again, and back with the person
      expect(await statusOf(r.path, "beta")).toBe("merge-review");
      expect((await new Git(r.path).run(["show", "intent/beta:src/shared.ts"])).out).toBe(numbered({ 1: "alpha and beta" }));
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

describe("design and plan steps beside the lanes (speed.think_ahead)", () => {
  test("at one change at a time, a change accepted while another builds is designed and planned before the build ends", async () => {
    const r = await lanesRepo(1, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "accepted" }], "", {}, true);
    // alpha's build step holds at its verifier until beta has been planned.
    const releaseAlpha = holdSession(r, "alpha", "verify");
    await withEnv(r.env, async () => {
      const ticking = tick(r.path);
      await statusShows(r.path, "beta", "plan-approved");
      releaseAlpha();
      const t = await ticking;
      expect(t.picked).toBe("alpha");
      expect(t.steps?.map((s) => s.slug)).toEqual(["alpha", "beta", "beta"]);
      expect(await statusOf(r.path, "alpha")).toBe("reviewing");
      expect(await statusOf(r.path, "beta")).toBe("plan-approved");
      expect(othersRunning("")).toBe(0);
      inTrace(r.path, (trace) => {
        const together = trace.events("_loop").filter((e) => e.type === "command" && e.payload.includes("\"changes worked on together\""));
        expect(together.map((e) => payloadOf<{ steps: string[] }>(e).steps)).toEqual([["alpha", "beta", "beta"]]);
      });
    });
    r.cleanup();
  }, 120_000);

  test("once the lane has ended it starts nothing more: a change it designed is planned on the next tick", async () => {
    const r = await lanesRepo(1, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "accepted" }], "", {}, true);
    const releaseAlpha = holdSession(r, "alpha", "verify");
    const releaseBeta = holdSession(r, "beta", "design");
    await withEnv(r.env, async () => {
      const ticking = tick(r.path);
      await traceShows(r.path, (t) => t.phases("beta").some((p) => p.name === "design"));
      releaseAlpha();
      // alpha's step has ended, and its lane with it: only beta is still running.
      await statusShows(r.path, "alpha", "reviewing", () => othersRunning("beta") === 0);
      releaseBeta();
      const t = await ticking;
      expect(t.steps?.map((s) => s.slug)).toEqual(["alpha", "beta"]);
      expect(await statusOf(r.path, "beta")).toBe("spec-approved");
      inTrace(r.path, (trace) => expect(trace.phases("beta").map((p) => p.name)).not.toContain("plan"));
    });
    r.cleanup();
  }, 120_000);

  test("the lane takes the build before a more urgent change waiting to be planned, and that one is planned beside it", async () => {
    const r = await lanesRepo(1, [{ slug: "alpha", status: "spec-approved", priority: "urgent" }, { slug: "beta", status: "plan-approved" }], "", {}, true);
    const releaseBeta = holdSession(r, "beta", "verify");
    await withEnv(r.env, async () => {
      const ticking = tick(r.path);
      await statusShows(r.path, "alpha", "plan-approved");
      releaseBeta();
      const t = await ticking;
      expect(t.picked).toBe("beta");
      expect(await statusOf(r.path, "beta")).toBe("reviewing");
      expect(await statusOf(r.path, "alpha")).toBe("plan-approved");
    });
    r.cleanup();
  }, 120_000);

  test("a design stage with before commands is left to a lane", async () => {
    const r = await lanesRepo(1, [{ slug: "alpha", status: "plan-approved" }, { slug: "beta", status: "accepted" }], "stages:\n  design:\n    before:\n      - echo hi\n", {}, true);
    await withEnv(r.env, async () => {
      const t = await tick(r.path);
      expect(t.steps?.map((s) => s.slug)).toEqual(["alpha"]);
      expect(await statusOf(r.path, "beta")).toBe("accepted");
      inTrace(r.path, (trace) => expect(trace.phases("beta")).toEqual([]));
    });
    r.cleanup();
  }, 120_000);

  test("with a daily budget and no session limit, nothing runs beside the lane, which keeps the queue's order", async () => {
    const changes = [{ slug: "alpha", status: "spec-approved", priority: "urgent" }, { slug: "beta", status: "plan-approved" }, { slug: "gamma", status: "accepted" }];
    const r = await lanesRepo(1, changes, "claude:\n  max_budget_usd_per_day: 100\n", {}, true);
    await withEnv(r.env, async () => {
      const t = await tick(r.path);
      // The urgent plan first, as without think_ahead: no thinker could take it.
      expect(t.steps?.map((s) => s.slug)).toEqual(["alpha"]);
      expect(await statusOf(r.path, "alpha")).toBe("plan-approved");
      expect(await statusOf(r.path, "beta")).toBe("plan-approved");
      expect(await statusOf(r.path, "gamma")).toBe("accepted");
    });
    r.cleanup();
  }, 120_000);

  test("a change set to a status its folder does not match during the tick is left to the next tick's start, which blocks it", async () => {
    const r = await lanesRepo(1, [{ slug: "alpha", status: "plan-approved" }], "poll_seconds: 1\n", {}, true);
    const releaseAlpha = holdSession(r, "alpha", "verify");
    await withEnv(r.env, async () => {
      const ticking = tick(r.path);
      await traceShows(r.path, (t) => t.phases("alpha").some((p) => p.name === "verify"));
      // spec-approved with no spec.md, written while alpha is held at its verifier.
      mkdirSync(join(r.path, "intent", "beta"), { recursive: true });
      writeFileSync(join(r.path, "intent", "beta", "intent.md"), "---\nstatus: spec-approved\n---\n# Intent: beta\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
      // Several of the thinker's looks (one a second).
      await Bun.sleep(3000);
      releaseAlpha();
      const t = await ticking;
      expect(t.steps?.map((s) => s.slug)).toEqual(["alpha"]);
      inTrace(r.path, (trace) => expect(trace.phases("beta")).toEqual([]));
      await tick(r.path);
      expect(await statusOf(r.path, "beta")).toBe("blocked");
    });
    r.cleanup();
  }, 120_000);
});
