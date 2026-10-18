import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamAgents } from "../../src/console/agents";
import { Hub } from "../../src/console/hub";
import type { AgentMessage } from "../../src/console/types";
import { writeHeartbeat } from "../../src/heartbeat";
import { Trace } from "../../src/trace";
import { config, intent, parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

const lines = (events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const TEXT = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const RESULT = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, structured_output: { summary: "Done." } };

/** A phase's raw.jsonl path, with its folder made. */
function raw(root: string, slug: string, seq: number, name: string): string {
  const dir = join(root, ".loopstra", "runs", slug, "phases", `${seq}-${name}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "raw.jsonl");
}

/** A repository whose loop is running and working on `slugs`, a minute into its tick. */
async function repo(slugs: string[]) {
  const t = tempDir();
  await config(t.path);
  for (const s of slugs) await intent(t.path, s, "status: building", `Title ${s}`);
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  writeHeartbeat(t.path, { pid: process.pid, startedAt: iso(600_000), lastTickAt: iso(60_000), lastBeatAt: iso(0), current: { slug: slugs[0]! }, working: slugs, stopping: false, stopped: false });
  return t;
}

/** A page for the agents stream. */
function page() {
  const frames: string[] = [];
  return { frames, send: (f: string) => { frames.push(f); return true; }, msgs: () => parseFrames(frames.join("")).filter((f) => f.event !== "ping").map((f) => f.data as AgentMessage) };
}

describe("the agents stream", () => {
  test("announces each running session, sends its rows with its key, says when it ends, and stops everything when the page goes", async () => {
    const t = await repo(["one", "two"]);
    const trace = Trace.open(t.path);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    let stop: (() => void) | null = null;
    try {
      const one = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", one, "build"), lines([TEXT("Looking.")]));
      const p = page();
      stop = await streamAgents(t.path, hub, p.send, { intervalMs: 20 });
      const k1 = `one:${one}`;
      await until(() => p.msgs().some((m) => m.type === "item" && m.key === k1));
      const first = p.msgs();
      expect(first[0]).toMatchObject({ type: "open", agent: { slug: "one", seq: one, title: "Title one", name: "build" } });
      expect(first.find((m) => m.type === "sync")).toEqual({ type: "sync", keys: [k1] });
      expect(first.find((m) => m.type === "item")).toMatchObject({ type: "item", key: k1, item: { kind: "text", text: "Looking." } });

      // A second session starting later is announced too.
      const two = trace.phaseStart("two", "plan", "agent");
      writeFileSync(raw(t.path, "two", two, "plan"), lines([TEXT("Planning.")]));
      const k2 = `two:${two}`;
      await until(() => p.msgs().some((m) => m.type === "item" && m.key === k2));
      expect(p.msgs().flatMap((m) => (m.type === "open" ? [m.agent.slug] : []))).toEqual(["one", "two"]);

      // The first ends: its last rows, its phase, then its end.
      appendFileSync(raw(t.path, "one", one, "build"), lines([RESULT]));
      trace.phaseEnd("one", one, { status: "success", costUsd: 0.1 });
      await until(() => p.msgs().some((m) => m.type === "end" && m.key === k1));
      const ofOne = p.msgs().flatMap((m) => ("key" in m && m.key === k1 ? [m.type] : []));
      expect(ofOne.slice(-3)).toEqual(["item", "phase", "end"]);
      // Announced once, however many looks saw it.
      expect(p.msgs().filter((m) => m.type === "open")).toHaveLength(2);

      // Once the page has gone, nothing more is sent, and the hub lets go.
      stop();
      stop = null;
      const sent = p.frames.length;
      appendFileSync(raw(t.path, "two", two, "plan"), lines([TEXT("More.")]));
      await until(() => hub.latest() === null);
      await Bun.sleep(100);
      expect(p.frames.length).toBe(sent);
    } finally {
      stop?.();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      trace.close();
      t.cleanup();
    }
  });

  test("a page that comes back is sent every running session again from its start, and sync names only those", async () => {
    const t = await repo(["one"]);
    const trace = Trace.open(t.path);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    const stops: Array<() => void> = [];
    try {
      const done = trace.phaseStart("one", "design", "agent");
      trace.phaseEnd("one", done, { status: "success", costUsd: 0.1 });
      const one = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", one, "build"), lines([TEXT("a"), TEXT("b")]));
      const first = page();
      stops.push(await streamAgents(t.path, hub, first.send, { intervalMs: 20 }));
      await until(() => first.msgs().filter((m) => m.type === "item").length === 2);
      const again = page();
      stops.push(await streamAgents(t.path, hub, again.send, { intervalMs: 20 }));
      await until(() => again.msgs().filter((m) => m.type === "item").length === 2);
      expect(again.msgs().find((m) => m.type === "sync")).toEqual({ type: "sync", keys: [`one:${one}`] });
      expect(again.msgs().filter((m) => m.type === "open")).toHaveLength(1);
    } finally {
      for (const s of stops) s();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      trace.close();
      t.cleanup();
    }
  });

  test("a page whose writes fail stops the stream", async () => {
    const t = await repo(["one"]);
    const trace = Trace.open(t.path);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    try {
      const one = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", one, "build"), lines([TEXT("a")]));
      let calls = 0;
      await streamAgents(t.path, hub, () => { calls++; return false; }, { intervalMs: 20 });
      // Its first write failed: the hub is let go and nothing more is tried.
      await until(() => hub.latest() === null);
      await Bun.sleep(100);
      expect(calls).toBe(1);
    } finally {
      await hub.whenStopped();
      trace.close();
      t.cleanup();
    }
  });

  test("a session the loop left running but no longer works on is let go, and said to have ended", async () => {
    const t = await repo(["one"]);
    const trace = Trace.open(t.path);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    let stop: (() => void) | null = null;
    try {
      const one = trace.phaseStart("one", "build", "agent");
      writeFileSync(raw(t.path, "one", one, "build"), lines([TEXT("a")]));
      const p = page();
      stop = await streamAgents(t.path, hub, p.send, { intervalMs: 20, goneMs: 100 });
      await until(() => p.msgs().some((m) => m.type === "item"));
      // The loop was killed and started again: its new tick works on nothing, and the old row still says running.
      const now = Date.now();
      writeHeartbeat(t.path, { pid: process.pid, startedAt: new Date(now).toISOString(), lastTickAt: new Date(now).toISOString(), lastBeatAt: new Date(now).toISOString(), current: null, working: [], stopping: false, stopped: false });
      await until(() => p.msgs().some((m) => m.type === "end"));
      expect(p.msgs().filter((m) => m.type === "end")).toEqual([{ type: "end", key: `one:${one}` }]);
    } finally {
      stop?.();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      trace.close();
      t.cleanup();
    }
  });

  test("pings while nothing else is sent", async () => {
    const t = await repo(["one"]);
    const hub = new Hub(t.path, { intervalMs: 20, minRebuildMs: 0 });
    let stop: (() => void) | null = null;
    try {
      const p = page();
      stop = await streamAgents(t.path, hub, p.send, { intervalMs: 20, pingMs: 30 });
      await until(() => parseFrames(p.frames.join("")).some((f) => f.event === "ping"));
    } finally {
      stop?.();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
      t.cleanup();
    }
  });
});
