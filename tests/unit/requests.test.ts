import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyingRequests, cancelRequest, claimRequest, CONSOLE, drainOld, finishRequest, pendingRequests, pruneResults, requestState, requestsDir, submitRequest, takeResults } from "../../src/requests";
import { wakeStamp } from "../../src/wake";
import { tempDir } from "../helpers";

const by = { by: "u1", byName: "Ana", via: "the dashboard", transport: CONSOLE, thread: "" };

describe("request files", () => {
  test("submit writes a request in order and wakes the loop", () => {
    const t = tempDir();
    try {
      const before = wakeStamp(t.path);
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      const b = submitRequest(t.path, { ...by, kind: "hold", slug: "b", expect: "building", reason: "legal" });
      expect(wakeStamp(t.path)).not.toBe(before);
      expect(pendingRequests(t.path).map((r) => r.id)).toEqual([a.id, b.id]);
      expect(a.at).toBeTruthy();
    } finally {
      t.cleanup();
    }
  });

  test("a claimed request can no longer be cancelled; a pending one can, once", () => {
    const t = tempDir();
    try {
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      const b = submitRequest(t.path, { ...by, kind: "close", slug: "b", expect: "building" });
      expect(claimRequest(t.path, a.id)).toBe(true);
      expect(claimRequest(t.path, a.id)).toBe(false);
      expect(cancelRequest(t.path, a.id)).toBe(false);
      expect(applyingRequests(t.path).map((r) => r.id)).toEqual([a.id]);
      expect(requestState(t.path, a.id)).toEqual({ state: "pending" });
      expect(cancelRequest(t.path, b.id)).toBe(true);
      expect(cancelRequest(t.path, b.id)).toBe(false);
      expect(requestState(t.path, b.id)).toBeNull();
      expect(pendingRequests(t.path).map((r) => r.id)).toEqual([a.id]);
    } finally {
      t.cleanup();
    }
  });

  test("a finished request leaves a result the console takes once by id, and chat takes by transport", () => {
    const t = tempDir();
    try {
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      const c = submitRequest(t.path, { by: "u", byName: "Bo", via: "Slack", transport: "slack", thread: "T1", kind: "accept", slug: "c" });
      for (const r of [a, c]) { claimRequest(t.path, r.id); finishRequest(t.path, applyingRequests(t.path).find((x) => x.id === r.id)!, { ok: true, text: "done", status: "plan-approved" }); }
      expect(applyingRequests(t.path)).toEqual([]);
      // Chat never takes the console's results.
      expect(takeResults(t.path, new Set(["slack", CONSOLE])).map((r) => r.id)).toEqual([c.id]);
      expect(requestState(t.path, a.id)).toMatchObject({ state: "done", ok: true, text: "done", status: "plan-approved" });
      expect(requestState(t.path, a.id)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("ids that are not request ids are refused, not looked up as paths", () => {
    const t = tempDir();
    try {
      expect(cancelRequest(t.path, "../hold")).toBe(false);
      expect(requestState(t.path, "..\\x")).toBeNull();
      expect(claimRequest(t.path, "a/b")).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("the old chat folders are drained once; old results older than a day are pruned", () => {
    const t = tempDir();
    try {
      const old = join(t.path, ".loopstra", "chat");
      mkdirSync(join(old, "requests"), { recursive: true });
      mkdirSync(join(old, "results"), { recursive: true });
      writeFileSync(join(old, "requests", "000000000000001-1-0000.json"), JSON.stringify({ id: "000000000000001-1-0000", kind: "accept", slug: "a", by: "u", byName: "U", transport: "terminal", thread: "local", at: "x" }));
      writeFileSync(join(old, "results", "000000000000002-1-0000.json"), JSON.stringify({ id: "000000000000002-1-0000", transport: "terminal", thread: "local", text: "t", at: "x" }));
      drainOld(t.path);
      expect(existsSync(join(old, "requests"))).toBe(false);
      expect(pendingRequests(t.path).map((r) => [r.id, r.via])).toEqual([["000000000000001-1-0000", "chat"]]);
      expect(takeResults(t.path, new Set(["terminal"])).map((r) => r.id)).toEqual(["000000000000002-1-0000"]);
      const stale = join(requestsDir(t.path), "results", "000000000000003-1-0000.json");
      mkdirSync(join(requestsDir(t.path), "results"), { recursive: true });
      writeFileSync(stale, "{}");
      const twoDays = (Date.now() - 2 * 86_400_000) / 1000;
      utimesSync(stale, twoDays, twoDays);
      pruneResults(t.path);
      expect(readdirSync(join(requestsDir(t.path), "results"))).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
