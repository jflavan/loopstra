import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConversation } from "../../src/conversation";
import { inboxDir, inboxFor, sendToSession, type InboxMessage } from "../../src/inbox";
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
