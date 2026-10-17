import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Hub, PING, type HubOptions, type Send } from "../../src/console/hub";
import type { Sections, StreamMessage } from "../../src/console/types";
import { holdLoop, writeHeartbeat } from "../../src/heartbeat";
import { CONSOLE, submitRequest } from "../../src/requests";
import { scanRepo, type Scan } from "../../src/intents";
import { Trace } from "../../src/trace";
import { config, intent, parseFrames, until, withTrace } from "../console-helpers";
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

const events = (p: ReturnType<typeof page>) => p.messages().filter((m) => m.msg.type === "event");

const FAST = { intervalMs: 20, minRebuildMs: 0, pingMs: 60_000 };

interface HubTest {
  root: string;
  hub: Hub;
  /** `hub.connect`, with the page remembered so that it is removed at the end. */
  connect: (send: Send, lastEventId?: number) => Promise<() => Promise<void>>;
}

/**
 * Runs `fn` with a hub on a new folder. However `fn` ends, every page it connected is removed and
 * the hub has let go of the trace before the folder is removed: Windows keeps an open file locked,
 * and a failed removal would hide the test's own failure.
 */
async function withHub(opts: HubOptions, fn: (h: HubTest) => Promise<void>): Promise<void> {
  const t = tempDir();
  const hub = new Hub(t.path, opts);
  const offs: Array<() => Promise<void>> = [];
  try {
    await fn({
      root: t.path, hub,
      connect: async (send, lastEventId) => {
        const off = await hub.connect(send, lastEventId);
        offs.push(off);
        return off;
      },
    });
  } finally {
    for (const off of offs) await off();
    await hub.whenStopped();
    t.cleanup();
  }
}

/** Adds `n` status changes of "one" to the trace in one transaction, as another process could. */
function manyEvents(root: string, n: number): void {
  const db = new Database(join(root, ".loopstra", "trace.db"));
  try {
    const add = db.prepare("INSERT INTO events (slug, phase_seq, type, ts, payload) VALUES ('one', NULL, 'status_change', ?, ?)");
    db.transaction(() => {
      for (let k = 0; k < n; k++) add.run(new Date().toISOString(), JSON.stringify({ from: "accepted", to: "designing", note: "" }));
    })();
    // A statement left open keeps the database file open after close.
    add.finalize();
  } finally {
    db.close();
  }
}

describe("the console's live stream", () => {
  test("a page gets a snapshot, then only the sections that change, and new events in plain words", async () => {
    await withHub(FAST, async ({ root, connect }) => {
      await config(root);
      await intent(root, "one", "status: accepted");
      const p = page();
      await connect(p.send);
      const [first] = p.messages();
      if (first?.msg.type !== "snapshot") throw new Error("the first message is not a snapshot");
      expect(first.id).toBe("0");
      expect(first.msg.sections.changes.map((c) => c.slug)).toEqual(["one"]);

      await intent(root, "two", "status: accepted");
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
      withTrace(root, (trace) => trace.statusChange("one", "accepted", "designing"));
      await until(() => events(p).length > 0);
      const ev = events(p)[0]!;
      expect(ev.msg).toMatchObject({ type: "event", item: { slug: "one", type: "status_change", text: "Designing." } });
      expect(Number(ev.id)).toBeGreaterThan(0);
      // Nothing about the totals changed, so they were never sent again.
      expect(p.messages().some((m) => m.msg.type === "section" && m.msg.name === "totals")).toBe(false);
    });
  });

  test("a rebuild caused only by a new event or the heartbeat does not read the intent folder again; a new file under intent/ or an edited plan does", async () => {
    let scans = 0;
    await withHub({ ...FAST, scan: (root) => { scans++; return scanRepo(root); } }, async ({ root, connect }) => {
      await config(root);
      await intent(root, "one", "status: accepted");
      const p = page();
      await connect(p.send);
      expect(scans).toBe(1);

      withTrace(root, (trace) => trace.statusChange("one", "accepted", "designing"));
      await until(() => events(p).length > 0);
      const now = new Date().toISOString();
      writeHeartbeat(root, { pid: process.pid, startedAt: now, lastTickAt: now, lastBeatAt: now, current: null, stopping: false, stopped: false });
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "loop"));
      expect(scans).toBe(1);

      // Writing a file can be seen twice (the folder empty, then the file; size 0, then full), so
      // these wait for "read again" (more than before), never for an exact count.
      const readAgain = async (change: () => Promise<unknown>) => {
        await Bun.sleep(100); // a second look at the last change must not count for this one
        const before = scans;
        await change();
        await until(() => scans > before);
      };
      await readAgain(() => Bun.write(join(root, "intent", "one", "spec.md"), "# Spec\n"));
      await readAgain(() => intent(root, "two", "status: accepted"));
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
      await readAgain(() => Bun.write(join(root, "intent", "one", "plan.md"), "# Plan\n"));
      // The same files, but the plan says something else now (which files it touches, say).
      await readAgain(() => Bun.write(join(root, "intent", "one", "plan.md"), "# Plan\n\nTouches src/a.ts.\n"));
    });
  });

  test("a look that finds nothing new does not stop the next ones", async () => {
    await withHub(FAST, async ({ root, connect }) => {
      await config(root);
      const p = page();
      await connect(p.send);
      await Bun.sleep(200); // many idle looks
      await intent(root, "late", "status: accepted");
      await until(() => p.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
    });
  });

  test("more new events than one read holds all go out in the same look", async () => {
    await withHub({ ...FAST, intervalMs: 300 }, async ({ root, connect }) => {
      await config(root);
      const p = page();
      await connect(p.send);
      manyEvents(root, 1_200);
      await until(() => events(p).length > 0, 5_000);
      // Every look after the first that saw them comes at least 300ms later.
      await Bun.sleep(100);
      expect(events(p)).toHaveLength(1_200);
    });
  });

  test("a page that comes back gets the events it missed, then a snapshot", async () => {
    await withHub(FAST, async ({ root, connect }) => {
      await config(root);
      const trace = Trace.open(root);
      trace.event("_loop", "tick", {});
      const mark = trace.lastEventId();
      trace.phaseStart("one", "build", "agent");
      trace.event("_loop", "tick", {});
      trace.close();
      const p = page();
      await connect(p.send, mark);
      const msgs = p.messages();
      expect(msgs.map((m) => m.msg.type)).toEqual(["event", "snapshot"]);
      expect(msgs[0]!.msg).toMatchObject({ item: { text: "Started build." } });
      expect(msgs[1]!.id).toBe(String(mark + 2));
    });
  });

  test("a page that comes back gets no event twice, even one written while it is being caught up", async () => {
    const read = Trace.prototype.eventsAfter;
    let writeAfterRead = false;
    // Another process writes an event just after the hub's look has read the new ones.
    Trace.prototype.eventsAfter = function (this: Trace, afterId: number, limit: number) {
      const rows = read.call(this, afterId, limit);
      if (writeAfterRead) {
        writeAfterRead = false;
        this.statusChange("one", "designing", "spec-review");
      }
      return rows;
    };
    try {
      await withHub(FAST, async ({ root, connect }) => {
        await config(root);
        const mark = withTrace(root, (trace) => {
          trace.event("_loop", "tick", {});
          const before = trace.lastEventId();
          trace.statusChange("one", "accepted", "designing");
          return before;
        });
        const p = page();
        writeAfterRead = true;
        await connect(p.send, mark);
        await until(() => events(p).length >= 2);
        await Bun.sleep(150); // several more looks
        expect(events(p).map((m) => Number(m.id))).toEqual([mark + 1, mark + 2]);
      });
    } finally {
      Trace.prototype.eventsAfter = read;
    }
  });

  test("a page too far behind is told it missed some, then gets a snapshot", async () => {
    await withHub(FAST, async ({ root, connect }) => {
      await config(root);
      const mark = withTrace(root, (trace) => { trace.event("_loop", "tick", {}); return trace.lastEventId(); });
      manyEvents(root, 600);
      const p = page();
      await connect(p.send, mark);
      expect(p.messages().map((m) => m.msg.type)).toEqual(["gap", "snapshot"]);
      expect(p.messages()[1]!.id).toBe(String(mark + 600));
    });
  });

  test("a page that opens while the last one is leaving gets a snapshot, and later changes", async () => {
    let gate: Promise<void> | null = null;
    let release = () => {};
    let held = false;
    const scan = async (root: string): Promise<Scan> => {
      if (gate) { held = true; await gate; }
      return scanRepo(root);
    };
    await withHub({ ...FAST, scan }, async ({ root, hub, connect }) => {
      await config(root);
      await intent(root, "one", "status: accepted");
      const a = page();
      const offA = await hub.connect(a.send);
      gate = new Promise((r) => { release = r; });
      await intent(root, "two", "status: accepted");
      await until(() => held); // a look is now held in a slow read of the intent folder
      // The page reloads: the old one leaves while that look still runs, and the new one arrives.
      void offA();
      const b = page();
      const connecting = connect(b.send);
      gate = null;
      release();
      await connecting;
      const [first] = b.messages();
      if (first?.msg.type !== "snapshot") throw new Error("the new page got no snapshot");
      expect(first.msg.sections.changes.map((c) => c.slug)).toEqual(["one", "two"]);
      await intent(root, "three", "status: accepted");
      await until(() => b.messages().some((m) => m.msg.type === "section" && m.msg.name === "changes"));
    });
  });

  test("a problem is traced once while pages are open, and again once they have all left and one comes back", async () => {
    const broken = async () => ({ intents: null }) as unknown as Scan;
    await withHub({ ...FAST, scan: broken }, async ({ root, hub }) => {
      await config(root);
      const problems = () => withTrace(root, (trace) => trace.eventsAfter(0, 100).filter((e) => e.type === "error").length);
      const off = await hub.connect(page().send);
      await Bun.sleep(100); // several more looks, each failing the same way
      expect(problems()).toBe(1);
      await off();
      await hub.whenStopped();
      const again = await hub.connect(page().send);
      await again();
      await hub.whenStopped();
      expect(problems()).toBe(2);
    });
  });

  test("a page connected while the first rebuild failed gets a snapshot, not section diffs, from the first one that works", async () => {
    let calls = 0;
    // A read of the intent folder that cannot be used makes the model's build throw, once.
    const scan = async (root: string): Promise<Scan> => (calls++ === 0 ? ({ intents: null } as unknown as Scan) : scanRepo(root));
    await withHub({ ...FAST, scan }, async ({ root, connect }) => {
      await config(root);
      await intent(root, "one", "status: accepted");
      const p = page();
      await connect(p.send);
      expect(p.messages()).toEqual([]);
      // The folder changes, so the next look reads it again (the broken read is kept until then).
      await intent(root, "two", "status: accepted");
      await until(() => p.messages().length > 0);
      const [first] = p.messages();
      if (first?.msg.type !== "snapshot") throw new Error(`the first message is a ${first?.msg.type}, not a snapshot`);
      expect(first.id).toBe("0");
      expect(first.msg.sections.changes.map((c) => c.slug)).toEqual(["one", "two"]);
      expect(p.messages().some((m) => m.msg.type === "section")).toBe(false);
    });
  });

  test("a look still running when the last page leaves does not note its problem into the next start", async () => {
    let gate: Promise<void> | null = null;
    let release = () => {};
    let held = false;
    const scan = async (): Promise<Scan> => {
      if (gate) { held = true; await gate; }
      return { intents: null } as unknown as Scan;
    };
    await withHub({ ...FAST, scan }, async ({ root, hub }) => {
      await config(root);
      const problems = () => withTrace(root, (trace) => trace.eventsAfter(0, 100).filter((e) => e.type === "error").length);
      const off = await hub.connect(page().send);
      expect(problems()).toBe(1);
      gate = new Promise((r) => { release = r; });
      await intent(root, "one", "status: accepted"); // the folder changed, so the next look reads it again
      await until(() => held); // a look is held in that read
      const leaving = off();
      gate = null;
      release(); // it fails now, after the hub was stopped
      await leaving;
      await hub.whenStopped();
      const again = await hub.connect(page().send);
      await again();
      await hub.whenStopped();
      expect(problems()).toBe(2);
    });
  });

  test("the loop's pause and a request made show at once", async () => {
    await withHub(FAST, async ({ root, connect }) => {
      await config(root);
      await intent(root, "one", "status: building");
      const p = page();
      await connect(p.send);
      const sections = (name: string) => p.messages().map((m) => m.msg).filter((m) => m.type === "section" && m.name === name) as Array<Extract<StreamMessage, { type: "section" }>>;
      // Well inside the ten-second bucket that would rebuild the model anyway.
      holdLoop(root, "John");
      await until(() => sections("loop").some((m) => (m.value as Sections["loop"]).held?.by === "John"), 3_000);
      submitRequest(root, { by: "u", byName: "John", via: "the dashboard", transport: CONSOLE, thread: "", kind: "hold", slug: "one", expect: "building", reason: "" });
      await until(() => sections("requests").some((m) => (m.value as Sections["requests"]).length === 1), 3_000);
    });
  });

  test("pings keep a quiet stream alive", async () => {
    await withHub({ ...FAST, pingMs: 30 }, async ({ root, connect }) => {
      await config(root);
      const p = page();
      await connect(p.send);
      await until(() => p.frames.includes(PING));
    });
  });

  test("a page that cannot be written to is dropped, and with no page left the hub stops", async () => {
    await withHub({ ...FAST, pingMs: 30 }, async ({ root, hub, connect }) => {
      await config(root);
      const p = page();
      await connect(p.send);
      expect(hub.latest()).not.toBeNull();
      p.close();
      await until(() => hub.latest() === null);
      await hub.whenStopped();
    });
  });

  test("a page whose writes throw is dropped like one that is gone; one that throws while connecting leaves the hub stopped", async () => {
    await withHub({ ...FAST, pingMs: 30 }, async ({ root, hub, connect }) => {
      await config(root);
      let throws = false;
      const p = page();
      await connect((text) => { if (throws) throw new Error("the page is gone"); return p.send(text); });
      throws = true;
      await until(() => hub.latest() === null);
      await hub.whenStopped();

      await expect(hub.connect(() => { throw new Error("the page is gone"); })).rejects.toThrow("the page is gone");
      expect(hub.latest()).toBeNull();
      await hub.whenStopped();
    });
  });
});
