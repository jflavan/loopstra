import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anythingToApply, applyingRequests, cancelRequest, claimedRequests, claimRequest, CONSOLE, drainOld, finishRequest, pendingRequests, pruneResults, requestState, requestsDir, submitRequest, takeResults, waitingIds } from "../../src/requests";
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

  test("the console reads only its own results by id: chat's are left for chat", () => {
    const t = tempDir();
    try {
      const c = submitRequest(t.path, { by: "u", byName: "Bo", via: "Slack", transport: "slack", thread: "T1", kind: "accept", slug: "c" });
      claimRequest(t.path, c.id);
      finishRequest(t.path, applyingRequests(t.path)[0]!, { ok: true, text: "done", status: "accepted" });
      expect(requestState(t.path, c.id)).toBeNull();
      expect(takeResults(t.path, new Set(["slack"])).map((r) => r.id)).toEqual([c.id]);
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

  test("a file not named for the id inside it is not a request", () => {
    const t = tempDir();
    try {
      const a = submitRequest(t.path, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      // A copy under another name would be claimed by one id and applied as another.
      writeFileSync(join(requestsDir(t.path), "copy.json"), JSON.stringify(a));
      writeFileSync(join(requestsDir(t.path), "000000000000001-1-0001.json"), JSON.stringify(a));
      expect(pendingRequests(t.path).map((r) => r.id)).toEqual([a.id]);
    } finally {
      t.cleanup();
    }
  });

  test("a file that is not a request is set aside in requests/bad/ once: nothing counts it, claims it, or says it is pending", () => {
    const t = tempDir();
    try {
      mkdirSync(join(requestsDir(t.path), "applying"), { recursive: true });
      writeFileSync(join(requestsDir(t.path), "copy.json"), "{ not json");
      writeFileSync(join(requestsDir(t.path), "000000000000001-1-0001.json"), JSON.stringify({ id: "000000000000001-1-0002", kind: "accept", slug: "a", transport: CONSOLE, thread: "" }));
      writeFileSync(join(requestsDir(t.path), "000000000000001-1-0004.json"), JSON.stringify({ id: "000000000000001-1-0004", kind: "accept", slug: "a" }));
      writeFileSync(join(requestsDir(t.path), "applying", "claimed.json"), "[]");
      expect(anythingToApply(t.path)).toBe(false);
      expect(pendingRequests(t.path)).toEqual([]);
      expect(waitingIds(t.path)).toEqual([]);
      expect(requestState(t.path, "000000000000001-1-0001")).toBeNull();
      expect(readdirSync(join(requestsDir(t.path), "bad")).sort()).toEqual(["000000000000001-1-0001.json", "000000000000001-1-0004.json", "claimed.json", "copy.json"]);
      expect(readdirSync(requestsDir(t.path)).filter((n) => n.endsWith(".json"))).toEqual([]);
      expect(readdirSync(join(requestsDir(t.path), "applying"))).toEqual([]);
      // One someone waits on (its id, transport and thread are right) whose body is not a request the loop knows is
      // claimed and gets a plain result from the pass (see src/apply.ts), so the page that asked hears back.
      writeFileSync(join(requestsDir(t.path), "000000000000001-1-0003.json"), JSON.stringify({ id: "000000000000001-1-0003", kind: "explode", slug: "a", by: "u", byName: "U", via: "chat", transport: CONSOLE, thread: "", at: "x" }));
      expect(anythingToApply(t.path)).toBe(true);
      expect(waitingIds(t.path)).toEqual(["000000000000001-1-0003"]);
      expect(requestState(t.path, "000000000000001-1-0003")).toEqual({ state: "pending" });
      expect(claimRequest(t.path, "000000000000001-1-0003")).toBe(true);
      expect(anythingToApply(t.path)).toBe(true);
      expect(claimedRequests(t.path)).toMatchObject({ requests: [], unreadable: [{ id: "000000000000001-1-0003", kind: "explode", slug: "a", transport: CONSOLE, thread: "" }] });
      expect(claimedRequests(t.path).unreadable[0]!.problem).toContain("kind");
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

  test("there is something to apply only with a request waiting or claimed, or an old chat folder to drain", () => {
    const t = tempDir();
    try {
      expect(anythingToApply(t.path)).toBe(false);
      // Results alone are not work for a pass.
      mkdirSync(join(requestsDir(t.path), "results"), { recursive: true });
      writeFileSync(join(requestsDir(t.path), "results", "000000000000003-1-0000.json"), "{}");
      expect(anythingToApply(t.path)).toBe(false);
      const q = submitRequest(t.path, { kind: "accept", slug: "a", by: "u", byName: "U", via: "chat", transport: "terminal", thread: "local" });
      expect(anythingToApply(t.path)).toBe(true);
      claimRequest(t.path, q.id);
      expect(anythingToApply(t.path)).toBe(true);
      rmSync(join(requestsDir(t.path), "applying", `${q.id}.json`));
      expect(anythingToApply(t.path)).toBe(false);
      mkdirSync(join(t.path, ".loopstra", "chat", "requests"), { recursive: true });
      expect(anythingToApply(t.path)).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
