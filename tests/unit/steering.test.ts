import { describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendConversation, readConversation } from "../../src/conversation";
import { changeStoppedBy, inboxDir, inboxFor, leaveDelivered, sendToSession, writeChangeStop, type InboxMessage } from "../../src/inbox";
import { StepContext } from "../../src/context";
import { agentPhase } from "../../src/phases";
import { runStepGuarded } from "../../src/scheduler";
import { runDesignStep } from "../../src/stages/design";
import { deliverInbox, sweepInbox } from "../../src/steering";
import { requestStop, resetStop, SessionStopped } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { until } from "../console-helpers";
import { fixture, fixtureDir, lastCommit, setupRepo, tempDir, withEnv } from "../helpers";

const SLUG = "add-numbers";

/** A fixture held until `gate` exists: the wait comes after its init line, so the session id is known first. */
function gated(name: string, gate: string): string {
  const [init, ...rest] = fixture(name).split("\n");
  return [init, JSON.stringify({ type: "fake_action", wait_for: gate }), ...rest].join("\n");
}

/** How an inbox message ended, once it is in delivered/ (null while it waits). */
function howDone(root: string, m: InboxMessage): string | null {
  const p = join(inboxDir(root, SLUG), "delivered", `${m.id}.json`);
  if (!existsSync(p)) return null;
  try { return (JSON.parse(readFileSync(p, "utf8")) as { how?: string }).how ?? null; } catch { return null; }
}

/** The seq of the running row of phase `name`, or null. */
function running(trace: Trace, name: string): number | null {
  return trace.phases(SLUG).find((p) => p.name === name && p.status === "running")?.seq ?? null;
}

/** The change's steer events' payloads. */
function steers(trace: Trace): Array<Record<string, unknown>> {
  return trace.events(SLUG).filter((e) => e.type === "steer").map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** Waits for a conversation entry and its commit, so nothing writes to the repository once the test ends. */
async function recorded(root: string, text: string): Promise<void> {
  await until(() => readConversation(root, SLUG).includes(text));
  await until(async () => (await lastCommit(root)).includes(`loopstra(${SLUG}): conversation`));
}

const design = { name: "design" as const, model: "default" as const, permissionMode: "default" as const, tools: "read" as const, vars: { intent: "add numbers" } };
const check = { name: "spec-check" as const, model: "default" as const, permissionMode: "default" as const, tools: "read" as const, vars: { intent: "add numbers", spec: "a spec" } };

describe("steering a running session", () => {
  test("a message reaches a running work session, is traced and recorded, and the result after it counts", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const t = tempDir();
    const gate = join(t.path, "go");
    const fixtures = fixtureDir({ design: gated("design", gate) });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, async () => {
        const run = agentPhase(ctx, design);
        await until(() => running(trace, "design") !== null);
        const seq = running(trace, "design")!;
        const m = sendToSession(repo.path, SLUG, { seq, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
        await until(() => howDone(repo.path, m) === "delivered");
        writeFileSync(gate, "");
        const r = await run;
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.envelope.summary.startsWith("heard: ")).toBe(true);
          expect(r.envelope.summary).toContain("cover negatives");
        }
        expect(steers(trace)).toHaveLength(1);
        expect(steers(trace)[0]).toMatchObject({ kind: "message", by: "John", seq });
        await recorded(repo.path, "· John (the dashboard) → design\ncover negatives");
      });
    } finally {
      trace.close(); fixtures.cleanup(); t.cleanup(); repo.cleanup();
    }
  }, 30_000);

  test("a message to a check is not written to it; it is kept for the change's next session", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const t = tempDir();
    const gate = join(t.path, "go");
    const log = join(t.path, "steer.jsonl");
    const fixtures = fixtureDir({ "spec-check": gated("spec-check", gate) });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_STEER_LOG: log }, async () => {
        const run = agentPhase(ctx, check);
        await until(() => running(trace, "spec-check") !== null);
        const seq = running(trace, "spec-check")!;
        const m = sendToSession(repo.path, SLUG, { seq, kind: "message", text: "also zero", by: "John", via: "the dashboard" });
        await until(() => howDone(repo.path, m) === "next session");
        await recorded(repo.path, "· John (the dashboard) → the next session\nalso zero");
        writeFileSync(gate, "");
        const r = await run;
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.envelope.summary).not.toContain("heard:");
        expect(existsSync(log) ? readFileSync(log, "utf8").trim() : "").toBe("");
        expect(steers(trace)).toEqual([]);
      });
    } finally {
      trace.close(); fixtures.cleanup(); t.cleanup(); repo.cleanup();
    }
  }, 30_000);

  test("stop ends the session: the phase is interrupted by the person, and the step's error says so", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "design.md"), "x FIXTURE:hang\n");
      const run = agentPhase(ctx, design);
      run.catch(() => {}); // awaited below
      await until(() => running(trace, "design") !== null);
      const seq = running(trace, "design")!;
      const m = sendToSession(repo.path, SLUG, { seq, kind: "stop", text: "", by: "John", via: "the dashboard" });
      const e = await run.then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(SessionStopped);
      expect((e as SessionStopped).by).toBe("John");
      const row = trace.phases(SLUG).find((p) => p.seq === seq)!;
      expect(row.status).toBe("interrupted");
      expect(row.error).toBe("stopped by John");
      expect(howDone(repo.path, m)).toBe("delivered");
      expect(steers(trace)).toEqual([expect.objectContaining({ kind: "stop", by: "John", seq })]);
      // Not retried: the person's stop ends the phase.
      expect(trace.phases(SLUG).filter((p) => p.name.startsWith("design"))).toHaveLength(1);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("redirect resumes the same session in the same phase; the trace and conversation.md have it", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const t = tempDir();
    const gate = join(t.path, "go");
    const calls = join(t.path, "calls.jsonl");
    const fixtures = fixtureDir({ design: gated("design", gate) });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls }, async () => {
        const run = agentPhase(ctx, design);
        await until(() => running(trace, "design") !== null);
        const seq = running(trace, "design")!;
        const m = sendToSession(repo.path, SLUG, { seq, kind: "redirect", text: "do it in two steps", by: "John", via: "the dashboard" });
        await until(() => howDone(repo.path, m) === "delivered");
        writeFileSync(gate, "");
        const r = await run;
        expect(r.ok).toBe(true);
        expect(trace.phases(SLUG).filter((p) => p.name.startsWith("design")).map((p) => p.status)).toEqual(["success"]);
        expect(steers(trace)).toEqual([expect.objectContaining({ kind: "redirect", by: "John", seq, text: "do it in two steps" })]);
        const args = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
        expect(args).toHaveLength(2);
        expect(args[1]![args[1]!.indexOf("--resume") + 1]).toBe("fake-design");
        await recorded(repo.path, "· John (the dashboard) redirects design\ndo it in two steps");
      });
    } finally {
      trace.close(); fixtures.cleanup(); t.cleanup(); repo.cleanup();
    }
  }, 30_000);

  test("a message that arrives after the session ended goes to the next session, through conversation.md", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const m = sendToSession(repo.path, SLUG, { seq: 7, kind: "message", text: "use two steps", by: "John", via: "Slack" });
      const s = sendToSession(repo.path, SLUG, { seq: 7, kind: "stop", text: "", by: "John", via: "Slack" });
      await sweepInbox(ctx);
      expect(howDone(repo.path, m)).toBe("next session");
      expect(howDone(repo.path, s)).toBe("dropped");
      expect(inboxFor(repo.path, SLUG, 7)).toEqual([]);
      await recorded(repo.path, "· John (Slack) → the next session\nuse two steps");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a step sweeps what a stopped loop left in the inbox before it starts", async () => {
    const { repo, ctx, trace } = await setupRepo("done");
    try {
      const m = sendToSession(repo.path, SLUG, { seq: 3, kind: "redirect", text: "keep it small", by: "Ana", via: "the dashboard" });
      expect(await runStepGuarded(ctx)).toEqual({ ok: true });
      expect(howDone(repo.path, m)).toBe("next session");
      await recorded(repo.path, "· Ana (the dashboard) → the next session\nkeep it small");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message kept for the next session whose words are already in the record is still recorded once its first commit failed", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      await appendConversation(repo.path, "main", SLUG, { kind: "message", who: "John", via: "Slack", phase: "design", text: "use bun, ok", at: new Date() });
      const m = sendToSession(repo.path, SLUG, { seq: 7, kind: "message", text: "ok", by: "John", via: "Slack" });
      // A lock on main's ref: the record's commit fails, and nothing is written (recorded.json does not name the id).
      const lock = join(repo.path, ".git", "refs", "heads", "main.lock");
      writeFileSync(lock, "");
      await sweepInbox(ctx);
      expect(howDone(repo.path, m)).toBeNull();
      expect(readConversation(repo.path, SLUG)).not.toContain("the next session");
      rmSync(lock);
      await sweepInbox(ctx);
      expect(howDone(repo.path, m)).toBe("next session");
      expect(readConversation(repo.path, SLUG)).toContain("· John (Slack) → the next session\nok\n");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message for a session that ended is kept for the next session by the session running now, not held until the next step", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const ctl = { message: () => true, stop: () => false, redirect: () => false };
      const detach = deliverInbox(ctx, 6, "design", ctl);
      const late = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      const stop = sendToSession(repo.path, SLUG, { seq: 5, kind: "stop", text: "", by: "John", via: "the dashboard" });
      const ahead = sendToSession(repo.path, SLUG, { seq: 7, kind: "message", text: "later still", by: "John", via: "the dashboard" });
      await until(() => howDone(repo.path, late) === "next session");
      expect(howDone(repo.path, stop)).toBe("dropped");
      await detach();
      expect(readConversation(repo.path, SLUG)).toContain("· John (the dashboard) → the next session\ncover negatives");
      expect(steers(trace)).toEqual([]);
      // One for a session yet to come waits for it.
      expect(howDone(repo.path, ahead)).toBeNull();
      expect(inboxFor(repo.path, SLUG, 7).map((x) => x.id)).toEqual([ahead.id]);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message for a session alongside that ended while a later one runs is kept for the next session; one for a session yet to come waits", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const ctl = { message: () => true, stop: () => false, redirect: () => false };
      const first = trace.phaseStart(SLUG, "design", "agent");
      const alongside = trace.phaseStart(SLUG, "plan-ahead", "agent");
      trace.phaseEnd(SLUG, alongside, { status: "success" });
      const detach = deliverInbox(ctx, first, "design", ctl);
      const late = sendToSession(repo.path, SLUG, { seq: alongside, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      const ahead = sendToSession(repo.path, SLUG, { seq: alongside + 1, kind: "message", text: "later still", by: "John", via: "the dashboard" });
      await until(() => howDone(repo.path, late) === "next session");
      await detach();
      expect(readConversation(repo.path, SLUG)).toContain("· John (the dashboard) → the next session\ncover negatives");
      expect(howDone(repo.path, ahead)).toBeNull();
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("an ended session's message whose record keeps failing is tried a few times, further apart each time, and traced once", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    // Every try reads the name of the branch it records on, once; nothing else in the watching does.
    let tries = 0;
    const counting = { ...ctx.cfg, get main_branch() { tries++; return ctx.cfg.main_branch; } };
    const watching = new StepContext(repo.path, counting, trace, ctx.intent);
    const lock = join(repo.path, ".git", "refs", "heads", "main.lock");
    const start = Date.now();
    let detach: (() => Promise<void>) | null = null;
    try {
      // A lock on main's ref: every record's commit fails.
      writeFileSync(lock, "");
      const ctl = { message: () => true, stop: () => false, redirect: () => false };
      detach = deliverInbox(watching, 6, "design", ctl);
      const m = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      await until(() => tries === 1);
      // Looks every second: none tries again within the wait.
      await Bun.sleep(2500);
      expect(tries).toBe(1);
      // Past each wait (one minute, then two, then four) one more try; then it is left for the next step's sweep.
      for (const [minutes, expected] of [[1.1, 2], [3.2, 3], [7.3, 4], [60, 4], [120, 4]] as const) {
        setSystemTime(new Date(start + minutes * 60_000));
        await Bun.sleep(1500);
        expect(tries).toBe(expected);
      }
      const errors = trace.events(SLUG).filter((e) => e.type === "error" && e.payload.includes(m.id));
      expect(errors).toHaveLength(1);
      expect(howDone(repo.path, m)).toBeNull();
      setSystemTime();
      rmSync(lock);
      await detach();
      detach = null;
      await sweepInbox(ctx);
      expect(howDone(repo.path, m)).toBe("next session");
    } finally {
      setSystemTime();
      await detach?.();
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message for an earlier session still running alongside is left to that session", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      // The earlier session cannot take a message just now (a redirect is resuming it).
      const busy = { message: () => false, stop: () => false, redirect: () => false };
      const detachEarlier = deliverInbox(ctx, 5, "design", busy);
      const detachLater = deliverInbox(ctx, 6, "spec-check", busy);
      const m = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      await Bun.sleep(1500);
      expect(howDone(repo.path, m)).toBeNull();
      await detachLater();
      expect(howDone(repo.path, m)).toBeNull();
      expect(inboxFor(repo.path, SLUG, 5).map((x) => x.id)).toEqual([m.id]);
      // Its own session's end keeps it for the next one.
      await detachEarlier();
      expect(howDone(repo.path, m)).toBe("next session");
      expect(readConversation(repo.path, SLUG).match(/cover negatives/g)).toHaveLength(1);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message kept for the next session stays in the inbox when the loop starts stopping before its record lands", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const m = sendToSession(repo.path, SLUG, { seq: 7, kind: "message", text: "use two steps", by: "John", via: "Slack" });
      requestStop();
      await sweepInbox(ctx);
      expect(howDone(repo.path, m)).toBeNull();
      expect(inboxFor(repo.path, SLUG, 7).map((x) => x.id)).toEqual([m.id]);
      expect(readConversation(repo.path, SLUG)).toBe("");
      resetStop();
      // The next sweep records it; two looks at once record it once.
      await Promise.all([sweepInbox(ctx), sweepInbox(ctx)]);
      expect(howDone(repo.path, m)).toBe("next session");
      expect(readConversation(repo.path, SLUG).match(/use two steps/g)).toHaveLength(1);
      expect(await lastCommit(repo.path)).toContain(`loopstra(${SLUG}): conversation`);
    } finally {
      resetStop(); trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("what a stopped loop left in the inbox reaches the step's very first session", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const t = tempDir();
    const prompts = join(t.path, "prompts.jsonl");
    try {
      sendToSession(repo.path, SLUG, { seq: 3, kind: "redirect", text: "keep it small", by: "Ana", via: "the dashboard" });
      await withEnv({ LOOPSTRA_FAKE_PROMPTS: prompts }, () => runStepGuarded(ctx));
      const first = JSON.parse(readFileSync(prompts, "utf8").split("\n")[0]!) as { prompt: string };
      expect(first.prompt).toContain("keep it small");
    } finally {
      trace.close(); t.cleanup(); repo.cleanup();
    }
  }, 60_000);

  test("once watching ends, what is left for the session is recorded before the phase goes on", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      // A session that cannot take a message now (a redirect is resuming it).
      const ctl = { message: () => false, stop: () => false, redirect: () => false };
      const detach = deliverInbox(ctx, 5, "design", ctl);
      const m = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      await detach();
      expect(howDone(repo.path, m)).toBe("next session");
      expect(readConversation(repo.path, SLUG)).toContain("· John (the dashboard) → the next session\ncover negatives");
      expect(await lastCommit(repo.path)).toContain(`loopstra(${SLUG}): conversation`);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message written while the end's records land is looked for again, and recorded for the next session too", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const ctl = { message: () => false, stop: () => false, redirect: () => false };
      const detach = deliverInbox(ctx, 5, "design", ctl);
      const m1 = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      // The end looks once at once, then waits for m1's record: m2 comes in between.
      const ending = detach();
      const m2 = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "and zero", by: "Ana", via: "the dashboard" });
      await ending;
      expect(howDone(repo.path, m1)).toBe("next session");
      expect(howDone(repo.path, m2)).toBe("next session");
      const record = readConversation(repo.path, SLUG);
      expect(record).toContain("· John (the dashboard) → the next session\ncover negatives");
      expect(record).toContain("· Ana (the dashboard) → the next session\nand zero");
      expect(inboxFor(repo.path, SLUG, 5)).toEqual([]);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message whose move to delivered/ fails is written to the session once, traced once it is moved, and the error once", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const written: string[] = [];
      const ctl = { message: (text: string) => { written.push(text); return true; }, stop: () => false, redirect: () => false };
      // A folder where the move would put the message: the move fails until it is gone.
      const id = `${Date.now().toString().padStart(15, "0")}-1-0001`;
      const blocker = join(inboxDir(repo.path, SLUG), "delivered", `${id}.json`);
      mkdirSync(join(blocker, "x"), { recursive: true });
      const m1: InboxMessage = { id, seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard", at: new Date().toISOString() };
      writeFileSync(join(inboxDir(repo.path, SLUG), `${id}.json`), JSON.stringify(m1));
      const detach = deliverInbox(ctx, 5, "design", ctl);
      const errors = () => trace.events(SLUG).filter((e) => e.type === "error" && e.payload.includes(id));
      await until(() => errors().length > 0);
      // A later look (it delivers the next message) leaves the first one alone.
      const m2 = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "and zero", by: "John", via: "the dashboard" });
      await until(() => howDone(repo.path, m2) === "delivered");
      expect(written).toHaveLength(2);
      expect(steers(trace).map((s) => s.text)).toEqual(["and zero"]);
      rmSync(blocker, { recursive: true, force: true });
      await until(() => howDone(repo.path, m1) === "delivered");
      await detach();
      expect(written).toHaveLength(2);
      expect(written[0]).toContain("cover negatives");
      expect(steers(trace).map((s) => s.text)).toEqual(["and zero", "cover negatives"]);
      expect(errors()).toHaveLength(1);
      const record = readConversation(repo.path, SLUG);
      expect(record.match(/cover negatives/g)).toHaveLength(1);
      expect(record.match(/and zero/g)).toHaveLength(1);
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message delivered while the loop starts stopping is recorded, to its phase, by the next step's sweep", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const written: string[] = [];
      const ctl = { message: (text: string) => { written.push(text); return true; }, stop: () => false, redirect: () => false };
      requestStop();
      const detach = deliverInbox(ctx, 5, "design", ctl);
      const m = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      await until(() => howDone(repo.path, m) === "delivered");
      await detach();
      expect(written).toHaveLength(1);
      expect(readConversation(repo.path, SLUG)).toBe("");
      const marker = join(inboxDir(repo.path, SLUG), "unrecorded", `${m.id}.json`);
      expect(existsSync(marker)).toBe(true);
      // Still stopping: the sweep records nothing, and the marker stays.
      await sweepInbox(ctx);
      expect(existsSync(marker)).toBe(true);
      resetStop();
      await sweepInbox(ctx);
      expect(existsSync(marker)).toBe(false);
      const record = readConversation(repo.path, SLUG);
      expect(record).toContain("· John (the dashboard) → design\ncover negatives");
      expect(record).not.toContain("the next session");
      expect(await lastCommit(repo.path)).toContain(`loopstra(${SLUG}): conversation`);
    } finally {
      resetStop(); trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a message the session got whose move to delivered/ still fails at the end is recorded to its phase, and traced", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const ctl = { message: () => true, stop: () => false, redirect: () => false };
      const id = `${Date.now().toString().padStart(15, "0")}-1-0002`;
      const blocker = join(inboxDir(repo.path, SLUG), "delivered", `${id}.json`);
      mkdirSync(join(blocker, "x"), { recursive: true });
      const m: InboxMessage = { id, seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard", at: new Date().toISOString() };
      writeFileSync(join(inboxDir(repo.path, SLUG), `${id}.json`), JSON.stringify(m));
      const detach = deliverInbox(ctx, 5, "design", ctl);
      await until(() => trace.events(SLUG).some((e) => e.type === "error" && e.payload.includes(id)));
      await detach();
      expect(steers(trace)).toEqual([expect.objectContaining({ kind: "message", by: "John", seq: 5, text: "cover negatives" })]);
      expect(readConversation(repo.path, SLUG)).toContain("· John (the dashboard) → design\ncover negatives");
      // The next sweep moves it at last, and keeps nothing for the next session.
      rmSync(blocker, { recursive: true, force: true });
      await sweepInbox(ctx);
      expect(howDone(repo.path, m)).toBe("delivered");
      const record = readConversation(repo.path, SLUG);
      expect(record.match(/cover negatives/g)).toHaveLength(1);
      expect(record).not.toContain("the next session");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("after a restart, a message the session got whose move failed is not recorded again: its copy or its entry says it was delivered", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      const inbox = inboxDir(repo.path, SLUG);
      const entry = (m: InboxMessage) => appendConversation(repo.path, "main", SLUG, { kind: "message", who: m.by, via: m.via, phase: "design", text: m.text, at: new Date() }, { id: m.id });
      // Its delivered copy was left, but the original could not be removed then.
      const m1 = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
      await entry(m1);
      leaveDelivered(repo.path, SLUG, m1, "delivered");
      writeFileSync(join(inbox, `${m1.id}.json`), JSON.stringify(m1));
      // Not even its copy could be written: its entry is all there is.
      const m2 = sendToSession(repo.path, SLUG, { seq: 5, kind: "message", text: "and zero", by: "John", via: "the dashboard" });
      await entry(m2);
      // The process that knew of them is gone; the next step's sweep runs in a new one.
      await sweepInbox(ctx);
      expect(howDone(repo.path, m1)).toBe("delivered");
      expect(howDone(repo.path, m2)).toBe("delivered");
      expect(existsSync(join(inbox, `${m1.id}.json`))).toBe(false);
      expect(existsSync(join(inbox, `${m2.id}.json`))).toBe(false);
      const record = readConversation(repo.path, SLUG);
      expect(record.match(/cover negatives/g)).toHaveLength(1);
      expect(record.match(/and zero/g)).toHaveLength(1);
      expect(record).not.toContain("the next session");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 30_000);

  test("a change stopped while a code phase runs ends its step before the next phase", async () => {
    const t = tempDir();
    const gate = join(t.path, "go").replaceAll("\\", "/");
    const script = join(t.path, "wait.ts").replaceAll("\\", "/");
    writeFileSync(script, "while (!(await Bun.file(process.argv[2]!).exists())) await Bun.sleep(50);\n");
    const { repo, ctx, trace } = await setupRepo("plan-approved", { commands: { install: `bun "${script}" "${gate}"`, test: "echo ok" } });
    try {
      await Bun.write(join(repo.path, "intent", SLUG, "spec.md"), "# Spec\n");
      await Bun.write(join(repo.path, "intent", SLUG, "plan.md"), "# Plan\n");
      const run = runStepGuarded(ctx);
      await until(() => running(trace, "branch") !== null);
      writeChangeStop(repo.path, SLUG, "John");
      writeFileSync(gate, "");
      expect(await run).toEqual({ ok: true, stoppedBy: "John" });
      expect(trace.phases(SLUG).map((p) => p.name)).toEqual(["branch"]);
      expect(trace.phases(SLUG)[0]!.status).toBe("success");
    } finally {
      trace.close(); t.cleanup(); repo.cleanup();
    }
  }, 90_000);

  test("a change's stop is cleared at its next step's start: the step it was for has ended", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      writeChangeStop(repo.path, SLUG, "John");
      const r = await runStepGuarded(ctx);
      expect(r).toEqual({ ok: true });
      expect(changeStoppedBy(repo.path, SLUG)).toBeNull();
      expect(trace.phases(SLUG).map((p) => p.name)).toContain("design");
    } finally {
      trace.close(); repo.cleanup();
    }
  }, 60_000);

  test("a retry after a crash renders its prompt again, so it has what people told the crashed attempt", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const t = tempDir();
    const gate = join(t.path, "go");
    const prompts = join(t.path, "prompts.jsonl");
    // The first attempt waits, then ends without a result (a crash); the retry succeeds.
    const crash = [fixture("design").split("\n")[0], JSON.stringify({ type: "fake_action", wait_for: gate })].join("\n");
    const fixtures = fixtureDir({ "design-1": crash, design: fixture("design") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        const run = agentPhase(ctx, design);
        await until(() => running(trace, "design") !== null);
        const seq = running(trace, "design")!;
        const m = sendToSession(repo.path, SLUG, { seq, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
        await until(() => howDone(repo.path, m) === "delivered");
        writeFileSync(gate, "");
        const r = await run;
        expect(r.ok).toBe(true);
        expect(trace.phases(SLUG).map((p) => p.name)).toEqual(["design", "design-retry"]);
        const sent = readFileSync(prompts, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { prompt: string }).prompt);
        expect(sent[0]).not.toContain("cover negatives");
        expect(sent.at(-1)).toContain("cover negatives");
      });
    } finally {
      trace.close(); fixtures.cleanup(); t.cleanup(); repo.cleanup();
    }
  }, 60_000);

  test("a writer's retry after a crash has what people told the crashed attempt, though the stage rendered its prompt", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const t = tempDir();
    const gate = join(t.path, "go");
    const prompts = join(t.path, "prompts.jsonl");
    const crash = [fixture("design").split("\n")[0], JSON.stringify({ type: "fake_action", wait_for: gate })].join("\n");
    const fixtures = fixtureDir({ "design-1": crash, design: fixture("design") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        const run = runDesignStep(ctx);
        await until(() => running(trace, "design") !== null);
        const seq = running(trace, "design")!;
        const m = sendToSession(repo.path, SLUG, { seq, kind: "message", text: "cover negatives", by: "John", via: "the dashboard" });
        await until(() => howDone(repo.path, m) === "delivered");
        writeFileSync(gate, "");
        expect(await run).toEqual({ ok: true });
        expect(trace.phases(SLUG).map((p) => p.name)).toContain("design-retry");
        const sent = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { phase: string; prompt: string }).filter((p) => p.phase === "design").map((p) => p.prompt);
        expect(sent).toHaveLength(2);
        expect(sent[0]).not.toContain("cover negatives");
        expect(sent[1]).toContain("cover negatives");
      });
    } finally {
      trace.close(); fixtures.cleanup(); t.cleanup(); repo.cleanup();
    }
  }, 90_000);
});
