import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeStoppedBy, clearChangeStop, inboxFor, leaveDelivered, markDone, sendToSession, waitingIn, writeChangeStop } from "../../src/inbox";
import { tempDir } from "../helpers";

describe("the inbox", () => {
  test("what is sent waits for its session, in order; marking it done moves it, once", () => {
    const t = tempDir();
    try {
      const a = sendToSession(t.path, "x", { seq: 3, kind: "message", text: "one", by: "John", via: "the dashboard" });
      const b = sendToSession(t.path, "x", { seq: 4, kind: "stop", text: "", by: "John", via: "the dashboard" });
      const c = sendToSession(t.path, "x", { seq: 3, kind: "redirect", text: "two", by: "John", via: "the dashboard" });
      expect(inboxFor(t.path, "x", 3).map((m) => m.id)).toEqual([a.id, c.id]);
      expect(waitingIn(t.path, "x").map((m) => m.id)).toEqual([a.id, b.id, c.id]);
      expect(markDone(t.path, "x", a, "delivered")).toBe(true);
      expect(markDone(t.path, "x", a, "delivered")).toBe(false);
      expect(inboxFor(t.path, "x", 3).map((m) => m.id)).toEqual([c.id]);
      const kept = readdirSync(join(t.path, ".loopstra", "runs", "x", "inbox", "delivered"));
      expect(kept).toEqual([`${a.id}.json`]);
    } finally {
      t.cleanup();
    }
  });

  test("a message whose delivered copy is left (its move failed) no longer waits, and its stale original goes", () => {
    const t = tempDir();
    try {
      const a = sendToSession(t.path, "x", { seq: 3, kind: "message", text: "one", by: "John", via: "the dashboard" });
      const b = sendToSession(t.path, "x", { seq: 3, kind: "message", text: "two", by: "John", via: "the dashboard" });
      const inbox = join(t.path, ".loopstra", "runs", "x", "inbox");
      leaveDelivered(t.path, "x", a, "delivered");
      expect(JSON.parse(readFileSync(join(inbox, "delivered", `${a.id}.json`), "utf8"))).toMatchObject({ id: a.id, text: "one", how: "delivered" });
      // The original could not be removed then (held open): it is passed over, and removed by a later look.
      writeFileSync(join(inbox, `${a.id}.json`), JSON.stringify(a));
      expect(waitingIn(t.path, "x").map((m) => m.id)).toEqual([b.id]);
      expect(existsSync(join(inbox, `${a.id}.json`))).toBe(false);
      // A folder in delivered/ is not a copy.
      mkdirSync(join(inbox, "delivered", `${b.id}.json`));
      expect(inboxFor(t.path, "x", 3).map((m) => m.id)).toEqual([b.id]);
    } finally {
      t.cleanup();
    }
  });

  test("a file that is not a message, or an id that is not one, is ignored", () => {
    const t = tempDir();
    try {
      const m = sendToSession(t.path, "x", { seq: 1, kind: "message", text: "ok", by: "J", via: "v" });
      const inbox = join(t.path, ".loopstra", "runs", "x", "inbox");
      writeFileSync(join(inbox, "junk.json"), "{}");
      writeFileSync(join(inbox, "000000000000001-1-0001.json"), JSON.stringify({ id: "elsewhere", seq: 1, kind: "message", text: "no", by: "J", via: "v", at: "" }));
      // One with no one named as its sender would read "undefined, who is watching this work" to the session.
      writeFileSync(join(inbox, "000000000000001-1-0002.json"), JSON.stringify({ id: "000000000000001-1-0002", seq: 1, kind: "message", text: "no", by: 7, via: "v", at: "" }));
      writeFileSync(join(inbox, "000000000000001-1-0003.json"), JSON.stringify({ id: "000000000000001-1-0003", seq: 1, kind: "message", text: "no", by: "J", at: "" }));
      writeFileSync(join(inbox, "000000000000001-1-0004.json"), JSON.stringify({ id: "000000000000001-1-0004", seq: "1", kind: "message", text: "no", by: "J", via: "v", at: "" }));
      writeFileSync(join(inbox, "000000000000001-1-0005.json"), JSON.stringify({ id: "000000000000001-1-0005", seq: 1, kind: "shout", text: "no", by: "J", via: "v", at: "" }));
      expect(inboxFor(t.path, "x", 1).map((x) => x.id)).toEqual([m.id]);
      expect(existsSync(inbox)).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("a change's stop says who stopped it; one that does not say reads as a person's", () => {
    const t = tempDir();
    try {
      expect(changeStoppedBy(t.path, "x")).toBeNull();
      writeChangeStop(t.path, "x", "John");
      expect(changeStoppedBy(t.path, "x")).toBe("John");
      const path = join(t.path, ".loopstra", "runs", "x", "stop.json");
      writeFileSync(path, JSON.stringify({ by: 7, at: "" }));
      expect(changeStoppedBy(t.path, "x")).toBe("a person");
      writeFileSync(path, JSON.stringify({ by: "  ", at: "" }));
      expect(changeStoppedBy(t.path, "x")).toBe("a person");
      writeFileSync(path, "not json");
      expect(changeStoppedBy(t.path, "x")).toBe("a person");
      clearChangeStop(t.path, "x");
      expect(changeStoppedBy(t.path, "x")).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});
