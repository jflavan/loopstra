import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildState, resolveRunFile, serveUi } from "../../src/commands/ui";
import { configPath } from "../../src/config";
import { writeHeartbeat } from "../../src/heartbeat";
import { SYNC_TEXT } from "../../src/remote";
import { Trace } from "../../src/trace";
import { tempDir } from "../helpers";

const BODY = "# Intent: {title}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n";

async function intent(root: string, slug: string, fm: string, title = slug): Promise<void> {
  mkdirSync(join(root, "intent", slug), { recursive: true });
  await Bun.write(join(root, "intent", slug, "intent.md"), `---\n${fm}\n---\n${BODY.replace("{title}", title)}`);
}

async function config(root: string, extra = ""): Promise<void> {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  await Bun.write(configPath(root), `version: 1\ncommands:\n  test: echo ok\n${extra}`);
}

/** Moves a phase's start time, which the trace otherwise stamps with the real clock. */
function setStarted(root: string, slug: string, seq: number, iso: string): void {
  const db = new Database(join(root, ".loopstra", "trace.db"));
  try { db.run("UPDATE phases SET started = ?, ended = ? WHERE slug = ? AND seq = ?", [iso, iso, slug, seq]); } finally { db.close(); }
}

describe("ui state", () => {
  test("assembles intents, phases, gates, signals, and recent events", async () => {
    const t = tempDir();
    try {
      await intent(t.path, "one", "status: building\npriority: high", "one");
      const trace = Trace.open(t.path);
      trace.upsertIntent("one", "building", "high");
      const seq = trace.phaseStart("one", "build", "agent");
      trace.phaseEnd("one", seq, { status: "success", costUsd: 0.3 });
      trace.gate("one", "plan", "headings", "pass", "ok");
      trace.signal("main_health", "pass", "");
      trace.close();
      const s = await buildState(t.path, 0);
      expect(s.intents[0]).toMatchObject({ slug: "one", title: "one", status: "building", plain: "building and testing", priority: "high", costUsd: 0.3 });
      expect(s.intents[0]?.phases[0]).toMatchObject({ seq: 1, name: "build", kind: "agent", status: "success", costUsd: 0.3 });
      expect(s.intents[0]?.gates[0]).toMatchObject({ gate: "plan", check: "headings", result: "pass" });
      expect(s.signals[0]?.name).toBe("main_health");
      expect(s.health).toMatchObject({ result: "pass" });
      expect(s.events.length).toBeGreaterThan(0);
      expect(s.lastEventId).toBeGreaterThan(0);
      // Only newer events on the next poll.
      expect((await buildState(t.path, s.lastEventId)).events).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("an intent without a stated priority shows as normal", async () => {
    const t = tempDir();
    try {
      await intent(t.path, "one", "status: accepted");
      const s = await buildState(t.path, 0);
      expect(s.intents[0]).toMatchObject({ priority: "normal", costUsd: 0, phases: [] });
    } finally {
      t.cleanup();
    }
  });

  test("the loop state comes from the heartbeat, with the running phase", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      await intent(t.path, "one", "status: building");
      const trace = Trace.open(t.path);
      trace.phaseStart("one", "build", "agent");
      trace.close();
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      expect((await buildState(t.path, 0, now)).loop).toMatchObject({ state: "stopped", text: "Stopped" });
      writeHeartbeat(t.path, { pid: 1, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "one", phase: null }, stopping: false, stopped: false });
      const s = await buildState(t.path, 0, now);
      expect(s.loop).toMatchObject({ state: "running", text: "Running — working on one, last check 20s ago", current: { slug: "one", phase: "build" } });
      writeHeartbeat(t.path, { pid: 1, startedAt: iso(3600), lastTickAt: iso(840), lastBeatAt: iso(840), current: null, stopping: false, stopped: false });
      expect((await buildState(t.path, 0, now)).loop).toMatchObject({ state: "not-responding", text: "Not responding (last check 14 min ago)" });
    } finally {
      t.cleanup();
    }
  });
});

describe("needs attention", () => {
  test("lists blocked, waiting for a person, unreadable, and a red main", async () => {
    const t = tempDir();
    try {
      await config(t.path, "gates:\n  spec:\n    human: status\n");
      await intent(t.path, "stuck", "status: blocked\nnote: The tests failed three times.");
      await intent(t.path, "spec-ready", "status: spec-review\nnote: Read spec.md. When you are happy with it, change the status line to spec-approved.");
      await intent(t.path, "idea", "status: draft");
      await intent(t.path, "plan-ready", "status: plan-review");
      await intent(t.path, "busy", "status: building");
      mkdirSync(join(t.path, "intent", "broken"), { recursive: true });
      await Bun.write(join(t.path, "intent", "broken", "intent.md"), "---\nstatus: nearly-done\n---\n# Intent: broken\n");
      const trace = Trace.open(t.path);
      trace.signal("main_health", "pass", "");
      trace.signal("main_health", "fail", "1 failing");
      trace.close();

      const s = await buildState(t.path, 0);
      const by = Object.fromEntries(s.attention.map((a) => [a.slug ?? a.kind, a]));
      expect(s.attention[0]).toMatchObject({ kind: "health", slug: null });
      expect(s.attention[0]?.what).toContain("The tests on main are failing");
      expect(by.stuck).toMatchObject({ kind: "blocked", what: "The tests failed three times." });
      expect(by["spec-ready"]).toMatchObject({ kind: "waiting", what: "Read spec.md. When you are happy with it, change the status line to spec-approved." });
      expect(by.idea).toMatchObject({ kind: "waiting" });
      expect(by.idea?.what).toContain("accepted");
      expect(by.broken).toMatchObject({ kind: "unreadable" });
      expect(by.broken?.what).toContain("The status line at the top of intent.md");
      // The plan gate has no person on it, and a building change needs nobody.
      expect(by["plan-ready"]).toBeUndefined();
      expect(by.busy).toBeUndefined();
      expect(s.unreadable.map((u) => u.slug)).toEqual(["broken"]);
    } finally {
      t.cleanup();
    }
  });

  test("a check that could not run, and a config problem, need a person too; green main does not", async () => {
    const t = tempDir();
    try {
      await intent(t.path, "busy", "status: building");
      const trace = Trace.open(t.path);
      trace.signal("main_health", "error", "install failed");
      trace.close();
      const s = await buildState(t.path, 0);
      expect(s.attention.map((a) => a.kind).sort()).toEqual(["config", "health"]);
      expect(s.attention.find((a) => a.kind === "config")?.what).toContain("loopstra init");

      await config(t.path);
      const t2 = Trace.open(t.path);
      t2.signal("main_health", "pass", "");
      t2.close();
      expect((await buildState(t.path, 0)).attention).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("main out of step with GitHub (waiting on a person, or failing) needs a person; back in step it does not", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const trace = Trace.open(t.path);
      trace.signal("main_sync", "waiting", SYNC_TEXT.ownCommits);
      trace.close();
      expect((await buildState(t.path, 0)).attention).toEqual([{ kind: "sync", slug: null, title: "Main and GitHub", what: SYNC_TEXT.ownCommits }]);
      const t2 = Trace.open(t.path);
      t2.signal("main_sync", "fail", SYNC_TEXT.pushFailed);
      t2.close();
      expect((await buildState(t.path, 0)).attention.map((a) => a.what)).toEqual([SYNC_TEXT.pushFailed]);
      const t3 = Trace.open(t.path);
      t3.signal("main_sync", "pass", SYNC_TEXT.inStep);
      t3.close();
      expect((await buildState(t.path, 0)).attention).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe("totals", () => {
  test("cost today, this week, overall, and per intent; time in the current status", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building");
      await intent(t.path, "two", "status: accepted");
      const trace = Trace.open(t.path);
      const a = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", a, { status: "success", costUsd: 0.3 });
      const b = trace.phaseStart("one", "fix-1", "agent"); trace.phaseEnd("one", b, { status: "fail", costUsd: 1 });
      const c = trace.phaseStart("two", "intake", "agent"); trace.phaseEnd("two", c, { status: "success", costUsd: 2 });
      trace.statusChange("one", "plan-approved", "building");
      trace.close();
      // Wednesday 30 September 2026, noon, local time. The week starts on Monday the 28th.
      const now = new Date(2026, 8, 30, 12, 0, 0);
      setStarted(t.path, "one", a, new Date(2026, 8, 30, 9, 0, 0).toISOString());
      setStarted(t.path, "one", b, new Date(2026, 8, 28, 10, 0, 0).toISOString());
      setStarted(t.path, "two", c, new Date(2026, 8, 20, 10, 0, 0).toISOString());

      const s = await buildState(t.path, 0, now);
      expect(s.totals.todayUsd).toBeCloseTo(0.3);
      expect(s.totals.weekUsd).toBeCloseTo(1.3);
      expect(s.totals.allUsd).toBeCloseTo(3.3);
      const one = s.intents.find((i) => i.slug === "one")!;
      expect(one.costUsd).toBeCloseTo(1.3);
      expect(one.phases.map((p) => p.durationMs)).toEqual([0, 0]);
      // The status change was traced just now (real clock); the fixed `now` is days away from it,
      // so check against a clock two hours on instead.
      const later = await buildState(t.path, 0, new Date(Date.now() + 2 * 3600_000));
      expect(later.intents.find((i) => i.slug === "one")?.inStatus).toBe("2 h");
      // No traced change into its status: the time since intent.md was last written.
      expect(later.intents.find((i) => i.slug === "two")?.inStatus).toBe("2 h");
    } finally {
      t.cleanup();
    }
  });
});

describe("phase files", () => {
  async function seeded() {
    const t = tempDir();
    await intent(t.path, "one", "status: building");
    const trace = Trace.open(t.path);
    const seq = trace.phaseStart("one", "build", "agent");
    trace.phaseEnd("one", seq, { status: "success", costUsd: 0.1 });
    trace.close();
    const dir = join(t.path, ".loopstra", "runs", "one", "phases", "1-build");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "prompt.md"), "# the prompt <b>");
    await Bun.write(join(dir, "envelope.json"), "{}");
    await Bun.write(join(t.path, ".loopstra", "secret.txt"), "no");
    await Bun.write(join(t.path, "secret.txt"), "no");
    return t;
  }

  test("each phase links the files it left", async () => {
    const t = await seeded();
    try {
      const s = await buildState(t.path, 0);
      expect(s.intents[0]?.phases[0]?.files).toEqual([
        { name: "prompt.md", url: "/files/one/phases/1-build/prompt.md" },
        { name: "envelope.json", url: "/files/one/phases/1-build/envelope.json" },
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("only files under .loopstra/runs resolve", async () => {
    const t = await seeded();
    try {
      expect(resolveRunFile(t.path, "one/phases/1-build/prompt.md")).not.toBeNull();
      for (const bad of [
        "../secret.txt", "one/../../secret.txt", "one/../../../secret.txt", "..\\secret.txt", "one\\..\\..\\secret.txt",
        join(t.path, "secret.txt"), "/etc/passwd", "C:\\Windows\\win.ini", "C:secret.txt", "one/phases/1-build",
        "one/phases/1-build/missing.md", "", "one/phases/1-build/prompt.md\0", "one/phases/1-build/prompt.md:stream",
      ]) {
        expect({ bad, r: resolveRunFile(t.path, bad) }).toEqual({ bad, r: null });
      }
    } finally {
      t.cleanup();
    }
  });

  test("the server serves the page, the state, and run files as plain text, and nothing else", async () => {
    const t = await seeded();
    const server = serveUi(t.path, 0);
    try {
      const base = server.url.href.replace(/\/$/, "");
      const page = await fetch(`${base}/`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("<title>Loopstra</title>");
      const state = await (await fetch(`${base}/api/state?after=0`)).json() as { intents: Array<{ slug: string }> };
      expect(state.intents[0]?.slug).toBe("one");
      const file = await fetch(`${base}/files/one/phases/1-build/prompt.md`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await file.text()).toBe("# the prompt <b>");
      for (const bad of ["/files/one%2F..%2F..%2Fsecret.txt", "/files/..%5C..%5Csecret.txt", "/files/..%2Fsecret.txt", "/files/C:%5CWindows%5Cwin.ini", "/files/", "/nope"]) {
        const r = await fetch(`${base}${bad}`);
        expect({ bad, status: r.status }).toEqual({ bad, status: 404 });
        expect(await r.text()).not.toBe("no");
      }
    } finally {
      server.stop(true);
      t.cleanup();
    }
  });
});
