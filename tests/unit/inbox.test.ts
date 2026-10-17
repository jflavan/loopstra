import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxFor, markDone, sendToSession, waitingIn } from "../../src/inbox";
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

  test("a file that is not a message, or an id that is not one, is ignored", () => {
    const t = tempDir();
    try {
      sendToSession(t.path, "x", { seq: 1, kind: "message", text: "ok", by: "J", via: "v" });
      writeFileSync(join(t.path, ".loopstra", "runs", "x", "inbox", "junk.json"), "{}");
      writeFileSync(join(t.path, ".loopstra", "runs", "x", "inbox", "000000000000001-1-0001.json"), JSON.stringify({ id: "elsewhere", seq: 1, kind: "message", text: "no", by: "J", via: "v", at: "" }));
      expect(inboxFor(t.path, "x", 1)).toHaveLength(1);
      expect(existsSync(join(t.path, ".loopstra", "runs", "x", "inbox"))).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
