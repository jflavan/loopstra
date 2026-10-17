import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildModel, nowLine, stripOf } from "../../src/console/model";
import { scanRepo } from "../../src/intents";
import { holdLoop, pauseAfterUnavailable, writeHeartbeat } from "../../src/heartbeat";
import { CONSOLE, submitRequest } from "../../src/requests";
import { SYNC_TEXT } from "../../src/remote";
import { tick } from "../../src/scheduler";
import { Trace } from "../../src/trace";
import { config, intent, model, setStarted, withTrace } from "../console-helpers";
import { tempDir } from "../helpers";

describe("changes", () => {
  test("in queue order, with plain status, stage, cost and why they wait", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building\npriority: high", "One");
      await intent(t.path, "two", "status: accepted\ndepends_on: one");
      withTrace(t.path, (trace) => {
        const a = trace.phaseStart("one", "build", "agent");
        trace.phaseEnd("one", a, { status: "success", costUsd: 0.3 });
        trace.phaseStart("one", "fix-1", "agent", 2); // running, holding $2: a hold is not spending
      });
      const m = await model(t.path);
      expect(m.sections.changes.map((c) => c.slug)).toEqual(["one", "two"]);
      expect(m.sections.changes[0]).toMatchObject({ title: "One", status: "building", plain: "building and testing", priority: "high", stage: "build", waiting: null, running: false });
      expect(m.sections.changes[0]?.costUsd).toBeCloseTo(0.3);
      expect(m.sections.changes[1]).toMatchObject({ stage: "design", priority: "normal", costUsd: 0 });
      expect(m.sections.changes[1]?.waiting).toContain("one");
      expect(m.meta).toEqual({ chat: false, usdPerMinute: 0.2, pollSeconds: 60 });
      expect((await model(t.path, new Date(), { chat: true })).meta.chat).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("with changes worked on together, one whose plan lists a file another holds waits for it", async () => {
    const t = tempDir();
    try {
      await config(t.path, "speed:\n  max_parallel_changes: 2\n");
      await intent(t.path, "alpha", "status: building");
      await intent(t.path, "beta", "status: plan-approved");
      await intent(t.path, "gamma", "status: plan-approved");
      const plan = (files: string) => `# Plan\n\n## Files that change\n${files}\n\n## Steps\n1. Do it.\n`;
      await Bun.write(join(t.path, "intent", "alpha", "plan.md"), plan("- `src/csv.ts`\n- src/a.ts (new)"));
      await Bun.write(join(t.path, "intent", "beta", "plan.md"), plan("- src/csv.ts: export rows"));
      await Bun.write(join(t.path, "intent", "gamma", "plan.md"), plan("- src/other.ts"));
      const by = Object.fromEntries((await model(t.path)).sections.changes.map((c) => [c.slug, c.waiting]));
      expect(by).toEqual({ alpha: null, beta: "Waits for alpha to be merged first, because both change the same files.", gamma: null });

      // One change at a time: the loop never builds two at once, so nothing waits for files.
      await config(t.path);
      expect((await model(t.path)).sections.changes.every((c) => c.waiting === null)).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

describe("the loop and running steps", () => {
  test("the loop state comes from the heartbeat, with each change's running phases", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      await intent(t.path, "one", "status: building");
      withTrace(t.path, (trace) => trace.phaseStart("one", "build", "agent"));
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "stopped", text: "Stopped", nextCheck: null });
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "one" }, stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "running", text: "Running — working on one, last check 20s ago", working: [{ slug: "one", phase: "build" }] });
      // Two phases at once: both are named, in the order they started. A row left running before
      // this tick (its process was killed) is not.
      setStarted(t.path, "one", 1, iso(60));
      withTrace(t.path, (trace) => {
        trace.phaseStart("one", "verify", "agent");
        trace.phaseStart("one", "early-review", "agent");
      });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ working: [{ slug: "one", phase: "verify + early-review" }] });
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(3600), lastTickAt: iso(840), lastBeatAt: iso(840), current: null, stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "not-responding", text: "Not responding (last check 14 min ago)" });
      writeHeartbeat(t.path, { pid: 999_999, startedAt: iso(3600), lastTickAt: iso(840), lastBeatAt: iso(840), current: null, stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "stopped", text: "Stopped — it did not shut down cleanly (last check 14 min ago)" });
    } finally {
      t.cleanup();
    }
  });

  test("while the loop sleeps between ticks, it says when the next one is due", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: iso(20), lastBeatAt: iso(1), current: null, working: [], stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop.nextCheck).toBe(new Date(Date.parse(iso(20)) + 60_000).toISOString());
    } finally {
      t.cleanup();
    }
  });

  test("a heartbeat with a last check that is not a time gives no next check, and does not stop the model", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600), lastTickAt: "not a time", lastBeatAt: iso(1), current: null, working: [], stopping: false, stopped: false });
      expect((await model(t.path, now)).sections.loop).toMatchObject({ state: "running", nextCheck: null });
    } finally {
      t.cleanup();
    }
  });

  test("a running step's card: its model, what it is doing, and its activity", async () => {
    const t = tempDir();
    try {
      await config(t.path, "poll_seconds: 60\n");
      await intent(t.path, "one", "status: building", "One");
      const [old, seq] = withTrace(t.path, (trace) => {
        const plan = trace.phaseStart("one", "plan", "agent");
        const build = trace.phaseStart("one", "build", "agent");
        trace.event("one", "claude_event", { type: "system", subtype: "init", model: "claude-sonnet-5-5" }, build);
        trace.event("one", "claude_event", { type: "assistant", items: ["text:Reading the parser first.", "tool:Read"], targets: ["", "src/csv.ts"] }, build);
        trace.event("one", "claude_event", { type: "user" }, build);
        trace.event("one", "claude_event", { type: "assistant", items: ["tool:Bash"], targets: ["bun test"] }, build);
        return [plan, build];
      });
      const now = new Date();
      const iso = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
      // The plan phase was left running by a process killed before this tick: still running, but not current.
      setStarted(t.path, "one", old, iso(600));
      writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(900), lastTickAt: iso(20), lastBeatAt: iso(1), current: { slug: "one" }, working: ["one"], stopping: false, stopped: false });
      const m = await model(t.path, now);
      expect(m.sections.running.now).toEqual([{
        slug: "one", title: "One", seq, name: "build", model: "claude-sonnet-5-5", started: expect.any(String),
        now: "Running bun test", strip: ["text", "tool", "tool"],
      }]);
      expect(m.sections.changes[0]?.running).toBe(true);
      expect(m.sections.loop.working).toEqual([{ slug: "one", phase: "build" }]);
    } finally {
      t.cleanup();
    }
  });

  test("what a session is doing, from its newest summaries", () => {
    expect(nowLine([])).toBe("Starting");
    expect(nowLine([{ type: "assistant", items: ["text:Reading the parser first.\nmore"], targets: [""] }])).toBe("Reading the parser first.");
    expect(nowLine([{ type: "assistant", items: ["thinking"] }])).toBe("Thinking");
    expect(nowLine([{ type: "assistant", items: ["tool:Edit"], targets: ["src/a.ts"] }, { type: "user" }])).toBe("Editing src/a.ts");
    expect(nowLine([{ type: "result" }])).toBe("Finishing");
    expect(stripOf([{ type: "assistant", items: ["text:a", "tool:Bash", "thinking"] }, { type: "result" }])).toEqual(["text", "tool", "result"]);
  });

  test("the newest finished steps, without chat's", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      withTrace(t.path, (trace) => {
        const a = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", a, { status: "success", costUsd: 0.2 });
        const c = trace.phaseStart("_chat", "orchestrator", "agent"); trace.phaseEnd("_chat", c, { status: "success" });
        const b = trace.phaseStart("two", "design", "agent"); trace.phaseEnd("two", b, { status: "fail" });
      });
      const m = await model(t.path);
      expect(m.sections.running.recent.map((p) => [p.slug, p.name, p.status])).toEqual([["two", "design", "fail"], ["one", "build", "success"]]);
    } finally {
      t.cleanup();
    }
  });

  test("a part that cannot be read becomes a problem in the inbox, and the rest still come", async () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      await config(t.path);
      await intent(t.path, "one", "status: accepted");
      const broken = new Proxy(trace, {
        get(target, key) {
          if (key === "allPhases") return () => { throw new Error("disk on fire"); };
          const v = Reflect.get(target, key) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const m = await buildModel(t.path, broken);
      expect(m.sections.changes.map((c) => c.slug)).toEqual(["one"]);
      expect(m.sections.totals).toEqual({ todayUsd: 0, weekUsd: 0, allUsd: 0 });
      expect(m.sections.inbox).toEqual([{ kind: "config", label: "Console", slug: null, title: "Part of the console could not be read", what: "costs: disk on fire" }]);
    } finally {
      trace.close();
      t.cleanup();
    }
  });

  test("a scan handed in is used instead of reading the intent folder again", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "one", "status: accepted");
      const scan = await scanRepo(t.path);
      rmSync(join(t.path, "intent"), { recursive: true });
      const m = await model(t.path, new Date(), { scan });
      expect(m.sections.changes.map((c) => c.slug)).toEqual(["one"]);
      expect(m.sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("an intent folder that cannot be read is named in the inbox, and the rest of the model is still built", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await Bun.write(join(t.path, "intent"), "not a folder");
      const m = await model(t.path);
      expect(m.sections.changes).toEqual([]);
      expect(m.sections.loop.state).toBe("stopped");
      expect(m.sections.inbox).toHaveLength(1);
      expect(m.sections.inbox[0]).toMatchObject({ title: "Part of the console could not be read" });
      expect(m.sections.inbox[0]!.what).toStartWith("intent folder: ");
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
      withTrace(t.path, (trace) => {
        trace.signal("main_health", "pass", "");
        trace.signal("main_health", "fail", "1 failing");
      });

      const inbox = (await model(t.path)).sections.inbox;
      const by = Object.fromEntries(inbox.map((a) => [a.slug ?? a.kind, a]));
      expect(inbox[0]).toMatchObject({ kind: "health", slug: null });
      expect(inbox[0]?.what).toContain("The tests on main are failing");
      expect(by.stuck).toMatchObject({ kind: "blocked", label: "Blocked", what: "The tests failed three times." });
      expect(by["spec-ready"]).toMatchObject({ kind: "waiting", label: "Waiting for you", what: "Read spec.md. When you are happy with it, change the status line to spec-approved." });
      expect(by.idea).toMatchObject({ kind: "waiting", label: "Waiting for you" });
      expect(by.idea?.what).toContain("accepted");
      expect(by.broken).toMatchObject({ kind: "unreadable" });
      expect(by.broken?.what).toContain("The status line at the top of intent.md");
      expect(by["plan-ready"]).toBeUndefined();
      expect(by.busy).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  test("before main has ever passed, red tests say so instead of calling main failing", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      withTrace(t.path, (trace) => {
        trace.signal("main_health", "fail", "MSB1009: Project file does not exist.");
        trace.signal("main_health", "error", "install failed");
        trace.signal("main_health", "fail", "MSB1009: Project file does not exist.");
      });
      const inbox = (await model(t.path)).sections.inbox;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.what).toMatch(/^The tests on main have not passed yet \(checked .* ago\)\. On a new repository that is expected until the first change merges\.$/);
      withTrace(t.path, (trace) => {
        trace.signal("main_health", "pass", "");
        trace.signal("main_health", "fail", "1 failing");
      });
      expect((await model(t.path)).sections.inbox[0]?.what).toContain("The tests on main are failing");
    } finally {
      t.cleanup();
    }
  });

  test("a check that could not run, and a config problem, need a person too; green main does not", async () => {
    const t = tempDir();
    try {
      await intent(t.path, "busy", "status: building");
      withTrace(t.path, (trace) => {
        trace.signal("main_health", "error", "install failed");
      });
      const inbox = (await model(t.path)).sections.inbox;
      expect(inbox.map((a) => a.kind).sort()).toEqual(["config", "health"]);
      expect(inbox.find((a) => a.kind === "config")?.what).toContain("loopstra init");
      await config(t.path);
      withTrace(t.path, (trace) => {
        trace.signal("main_health", "pass", "");
      });
      expect((await model(t.path)).sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a pause because the assistant is unavailable is listed first, until it runs out", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      const p = pauseAfterUnavailable(t.path);
      expect((await model(t.path)).sections.inbox).toEqual([{ kind: "paused", label: "Paused", slug: null, title: "Loopstra is paused", what: p.reason }]);
      expect((await model(t.path, new Date(Date.parse(p.until) + 1000))).sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a config problem the loop hit is traced by the tick and listed", async () => {
    const t = tempDir();
    try {
      await Bun.write(join(t.path, "loopstra", "config.yaml"), "version: 1\nbogus: true\n");
      const r = await tick(t.path);
      expect(r.error).toContain("bogus");
      const inbox = (await model(t.path)).sections.inbox;
      expect(inbox.find((a) => a.kind === "config")).toMatchObject({ label: "Settings", what: expect.stringContaining("bogus") });
    } finally {
      t.cleanup();
    }
  });

  test("main out of step with GitHub needs a person; back in step it does not", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      withTrace(t.path, (trace) => {
        trace.signal("main_sync", "waiting", SYNC_TEXT.ownCommits);
      });
      expect((await model(t.path)).sections.inbox).toEqual([{ kind: "sync", label: "GitHub", slug: null, title: "Main and GitHub", what: SYNC_TEXT.ownCommits }]);
      withTrace(t.path, (trace) => {
        trace.signal("main_sync", "pass", SYNC_TEXT.inStep);
      });
      expect((await model(t.path)).sections.inbox).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe("totals", () => {
  test("cost today, this week and overall, per change, and time in the current status", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "one", "status: building");
      await intent(t.path, "two", "status: accepted");
      const [a, b, c] = withTrace(t.path, (trace) => {
        const build = trace.phaseStart("one", "build", "agent"); trace.phaseEnd("one", build, { status: "success", costUsd: 0.3 });
        const fix = trace.phaseStart("one", "fix-1", "agent"); trace.phaseEnd("one", fix, { status: "fail", costUsd: 1 });
        const intake = trace.phaseStart("two", "intake", "agent"); trace.phaseEnd("two", intake, { status: "success", costUsd: 2 });
        trace.statusChange("one", "plan-approved", "building");
        return [build, fix, intake];
      });
      // Wednesday 30 September 2026, noon, local time. The week starts on Monday the 28th.
      const now = new Date(2026, 8, 30, 12, 0, 0);
      setStarted(t.path, "one", a, new Date(2026, 8, 30, 9, 0, 0).toISOString());
      setStarted(t.path, "one", b, new Date(2026, 8, 28, 10, 0, 0).toISOString());
      setStarted(t.path, "two", c, new Date(2026, 8, 20, 10, 0, 0).toISOString());
      const m = await model(t.path, now);
      expect(m.sections.totals.todayUsd).toBeCloseTo(0.3);
      expect(m.sections.totals.weekUsd).toBeCloseTo(1.3);
      expect(m.sections.totals.allUsd).toBeCloseTo(3.3);
      expect(m.sections.changes.find((x) => x.slug === "one")?.costUsd).toBeCloseTo(1.3);
      // The status change was traced just now (real clock); check against a clock two hours on.
      const later = await model(t.path, new Date(Date.now() + 2 * 3600_000));
      expect(later.sections.changes.find((x) => x.slug === "one")?.inStatus).toBe("2 h");
      // No traced change into its status: the time since intent.md was last written.
      expect(later.sections.changes.find((x) => x.slug === "two")?.inStatus).toBe("2 h");
    } finally {
      t.cleanup();
    }
  });
});

describe("controls", () => {
  test("each change carries what it offers and whether it is held; pending requests and the loop's pause are there", async () => {
    const t = tempDir();
    try {
      await config(t.path, "gates:\n  plan: { human: status }\n");
      await intent(t.path, "a", "status: plan-review");
      await intent(t.path, "b", "status: building\nhold: waiting for legal");
      const m = await model(t.path);
      const a = m.sections.changes.find((c) => c.slug === "a")!;
      expect(a.offers.map((o) => o.kind)).toEqual(["approve", "send-back", "hold", "priority", "close"]);
      expect(a.held).toBeNull();
      const b = m.sections.changes.find((c) => c.slug === "b")!;
      expect(b.held).toBe("waiting for legal");
      expect(b.offers.map((o) => o.kind)).toEqual(["release", "priority", "close"]);
      expect(m.sections.requests).toEqual([]);
      expect(m.sections.loop.held).toBeNull();
      submitRequest(t.path, { by: "u", byName: "John", via: "the dashboard", transport: CONSOLE, thread: "", kind: "approve", slug: "a", expect: "plan-review" });
      holdLoop(t.path, "John");
      const m2 = await model(t.path);
      expect(m2.sections.requests).toEqual([expect.objectContaining({ kind: "approve", slug: "a", label: "Approve the plan", byName: "John", via: "the dashboard" })]);
      expect(m2.sections.loop.held).toMatchObject({ by: "John" });
    } finally {
      t.cleanup();
    }
  });

  test("a blocked change offers retry from what its block recorded", async () => {
    const t = tempDir();
    try {
      await config(t.path);
      await intent(t.path, "c", `status: blocked\nnote: ${JSON.stringify("The build broke. When that is sorted out, set status to plan-approved to try again.")}`);
      const m = await model(t.path);
      expect(m.sections.changes.find((c) => c.slug === "c")!.offers.filter((o) => o.kind === "retry")).toEqual([{ kind: "retry", label: "Retry from plan-approved", to: "plan-approved" }]);
    } finally {
      t.cleanup();
    }
  });
});
