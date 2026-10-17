import { describe, expect, test } from "bun:test";
import { Hub, PING } from "../../src/console/hub";
import type { StreamMessage } from "../../src/console/types";
import { Trace } from "../../src/trace";
import { config, intent, parseFrames, until } from "../console-helpers";
import { tempDir } from "../helpers";

/** A page: collects what the hub sends it, until it is closed. */
function page() {
  const frames: string[] = [];
  let open = true;
  return {
    frames,
    send: (text: string) => { if (!open) return false; frames.push(text); return true; },
    close: () => { open = false; },
    messages: () => parseFrames(frames.join("")).filter((f) => f.data !== null && f.event === null).map((f) => ({ id: f.id, msg: f.data as StreamMessage })),
  };
}

const FAST = { intervalMs: 20, minRebuildMs: 0, pingMs: 60_000 };

describe("the console's live stream", () => {
  test("a page gets a snapshot, then only the sections that change, and new events in plain words", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, FAST);
    let off = async () => {};
    try {
      await config(t.path);
      await intent(t.path, "one", "status: accepted");
      const p = page();
      off = await hub.connect(p.send);
      const [first] = p.messages();
      if (first?.msg.type !== "snapshot") throw new Error("the first message is not a snapshot");
      expect(first.id).toBe("0");
      expect(first.msg.sections.changes.map((c) => c.slug)).toEqual(["one"]);

      await intent(t.path, "two", "status: accepted");
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
      const trace = Trace.open(t.path);
      trace.statusChange("one", "accepted", "designing");
      trace.close();
      await until(() => p.messages().some((m) => m.msg.type === "event"));
      const ev = p.messages().find((m) => m.msg.type === "event")!;
      expect(ev.msg).toMatchObject({ type: "event", item: { slug: "one", type: "status_change", text: "Designing." } });
      expect(Number(ev.id)).toBeGreaterThan(0);
      // Nothing about the totals changed, so they were never sent again.
      expect(p.messages().some((m) => m.msg.type === "section" && m.msg.name === "totals")).toBe(false);
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("a look that finds nothing new does not stop the next ones", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, FAST);
    let off = async () => {};
    try {
      await config(t.path);
      const p = page();
      off = await hub.connect(p.send);
      await Bun.sleep(200); // many idle looks
      await intent(t.path, "late", "status: accepted");
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("a page that comes back gets the events it missed, then a snapshot", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, FAST);
    let off = async () => {};
    try {
      await config(t.path);
      const trace = Trace.open(t.path);
      trace.event("_loop", "tick", {});
      const mark = trace.lastEventId();
      trace.phaseStart("one", "build", "agent");
      trace.event("_loop", "tick", {});
      trace.close();
      const p = page();
      off = await hub.connect(p.send, mark);
      const msgs = p.messages();
      expect(msgs.map((m) => m.msg.type)).toEqual(["event", "snapshot"]);
      expect(msgs[0]!.msg).toMatchObject({ item: { text: "Started build." } });
      expect(msgs[1]!.id).toBe(String(mark + 2));
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("pings keep a quiet stream alive", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, { ...FAST, pingMs: 30 });
    let off = async () => {};
    try {
      await config(t.path);
      const p = page();
      off = await hub.connect(p.send);
      await until(() => p.frames.includes(PING));
    } finally {
      await off();
      t.cleanup();
    }
  });

  test("a page that cannot be written to is dropped, and with no page left the hub stops", async () => {
    const t = tempDir();
    const hub = new Hub(t.path, { ...FAST, pingMs: 30 });
    try {
      await config(t.path);
      const p = page();
      await hub.connect(p.send);
      expect(hub.latest()).not.toBeNull();
      p.close();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
    } finally {
      t.cleanup();
    }
  });
});
