import { describe, expect, spyOn, test } from "bun:test";
import type { Trace } from "../../src/trace";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anythingToApply, applyingRequests, cancelRequest, claimedRequests, claimRequest, CONSOLE, drainOld, finishRequest, pendingRequests, pruneResults, requestState, requestsDir, submitRequest, waitingResults, waitingIds } from "../../src/requests";
import { wakeStamp } from "../../src/wake";
import { CHANGE_ACTIONS } from "../../src/actions";
import { ProposedAction } from "../../src/chat/schemas";
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
      expect(waitingResults(t.path, new Set(["slack", CONSOLE])).map((w) => w.result.id)).toEqual([c.id]);
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
      expect(waitingResults(t.path, new Set(["slack"])).map((w) => w.result.id)).toEqual([c.id]);
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

  test("an answer as long as chat may send (up to 20,000 characters) is a request; a longer one is not", () => {
    const t = tempDir();
    try {
      const long = submitRequest(t.path, { ...by, kind: "answer", slug: "a", text: "x".repeat(5000) });
      const longest = submitRequest(t.path, { ...by, kind: "answer", slug: "a", text: "x".repeat(20_000) });
      const over = submitRequest(t.path, { ...by, kind: "answer", slug: "a", text: "x".repeat(20_001) });
      expect(pendingRequests(t.path).map((r) => r.id)).toEqual([long.id, longest.id]);
      expect(waitingIds(t.path)).toContain(over.id);
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
      // Old files, first found unreadable now: they may be held open for a moment, so every reader passes them over and none is moved yet.
      const old = new Date(Date.now() - 60_000);
      for (const n of ["copy.json", "000000000000001-1-0001.json", "000000000000001-1-0004.json"]) utimesSync(join(requestsDir(t.path), n), old, old);
      expect(anythingToApply(t.path)).toBe(false);
      expect(readdirSync(requestsDir(t.path)).filter((n) => n.endsWith(".json")).length).toBe(3);
      // Still unreadable once the wait has passed (none here): the applier's look starts a pass for them, and the
      // pass, which has the trace, sets them aside and traces each once; the console's reads never do.
      expect(pendingRequests(t.path)).toEqual([]);
      expect(existsSync(join(requestsDir(t.path), "bad"))).toBe(false);
      expect(anythingToApply(t.path, 0)).toBe(true);
      expect(existsSync(join(requestsDir(t.path), "bad"))).toBe(false);
      const traced: unknown[] = [];
      const trace = { event: (...args: unknown[]) => { traced.push(args); } } as unknown as Trace;
      expect(waitingIds(t.path, { trace, badAfterMs: 0 })).toEqual([]);
      expect(claimedRequests(t.path, { trace, badAfterMs: 0 }).requests).toEqual([]);
      expect(traced).toHaveLength(4);
      expect(anythingToApply(t.path, 0)).toBe(false);
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

  test("a file that cannot be set aside does not start a pass on every look: it waits a minute, or until it changes", () => {
    const t = tempDir();
    const clock = spyOn(Date, "now");
    try {
      mkdirSync(requestsDir(t.path), { recursive: true });
      // A file where requests/bad/ would go: every move into it fails, as for a file Windows holds open.
      writeFileSync(join(requestsDir(t.path), "bad"), "");
      const copy = join(requestsDir(t.path), "copy.json");
      writeFileSync(copy, "{ not json");
      const traced: unknown[] = [];
      const trace = { event: (...args: unknown[]) => { traced.push(args); } } as unknown as Trace;
      const start = Date.now();
      clock.mockImplementation(() => start);
      expect(anythingToApply(t.path, 0)).toBe(true);
      expect(waitingIds(t.path, { trace, badAfterMs: 0 })).toEqual([]);
      expect(existsSync(copy)).toBe(true);
      expect(traced).toEqual([]);
      // The failed move is remembered: the next looks start no pass for it.
      expect(anythingToApply(t.path, 0)).toBe(false);
      clock.mockImplementation(() => start + 30_000);
      expect(anythingToApply(t.path, 0)).toBe(false);
      // A minute on, it is tried again.
      clock.mockImplementation(() => start + 61_000);
      expect(anythingToApply(t.path, 0)).toBe(true);
      expect(waitingIds(t.path, { trace, badAfterMs: 0 })).toEqual([]);
      expect(anythingToApply(t.path, 0)).toBe(false);
      // So is a file that changed since.
      const later = new Date(start + 5 * 60_000);
      utimesSync(copy, later, later);
      expect(anythingToApply(t.path, 0)).toBe(true);
    } finally {
      clock.mockRestore();
      t.cleanup();
    }
  });

  test("only the applier's looks start a bad file's wait, and a file that is gone is forgotten", () => {
    const t = tempDir();
    const clock = spyOn(Date, "now");
    try {
      mkdirSync(requestsDir(t.path), { recursive: true });
      const copy = join(requestsDir(t.path), "copy.json");
      const start = Date.now();
      clock.mockImplementation(() => start);
      // The console's reads pass the file over without starting its wait.
      writeFileSync(copy, "{ not json");
      expect(pendingRequests(t.path)).toEqual([]);
      clock.mockImplementation(() => start + 40_000);
      expect(anythingToApply(t.path)).toBe(false);
      // The applier's first look started it: the wait is up 30 s on.
      clock.mockImplementation(() => start + 71_000);
      expect(anythingToApply(t.path)).toBe(true);
      // Gone at the next look, then a new bad file of that name: its wait starts afresh.
      rmSync(copy);
      clock.mockImplementation(() => start + 72_000);
      expect(anythingToApply(t.path)).toBe(false);
      writeFileSync(copy, "{ not json");
      clock.mockImplementation(() => start + 73_000);
      expect(anythingToApply(t.path)).toBe(false);
    } finally {
      clock.mockRestore();
      t.cleanup();
    }
  });

  test("a file unreadable for a moment and then readable is never set aside, however old it is", () => {
    const t = tempDir();
    try {
      mkdirSync(requestsDir(t.path), { recursive: true });
      const id = "000000000000001-1-0007";
      const path = join(requestsDir(t.path), `${id}.json`);
      // Held open (or half written) at the first look: unreadable, though written long ago.
      writeFileSync(path, "{");
      const old = new Date(Date.now() - 600_000);
      utimesSync(path, old, old);
      expect(anythingToApply(t.path)).toBe(false);
      // It reads at the next look: the first failure is forgotten, so a later moment's failure starts the wait again.
      writeFileSync(path, JSON.stringify({ id, kind: "accept", slug: "a", by: "u", byName: "U", via: "chat", transport: CONSOLE, thread: "", at: "x" }));
      utimesSync(path, old, old);
      expect(anythingToApply(t.path)).toBe(true);
      writeFileSync(path, "{");
      expect(anythingToApply(t.path, 10_000)).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(requestsDir(t.path), "bad"))).toBe(false);
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
      expect(waitingResults(t.path, new Set(["terminal"])).map((w) => w.result.id)).toEqual(["000000000000002-1-0000"]);
      const stale = join(requestsDir(t.path), "results", "000000000000003-1-0000.json");
      mkdirSync(join(requestsDir(t.path), "results"), { recursive: true });
      writeFileSync(stale, "{}");
      const twoDays = (Date.now() - 2 * 86_400_000) / 1000;
      utimesSync(stale, twoDays, twoDays);
      pruneResults(t.path);
      // The stale one only: the drained result is left until chat passes it on.
      expect(readdirSync(join(requestsDir(t.path), "results"))).toEqual(["000000000000002-1-0000.json"]);
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

describe("standards-scope requests", () => {
  test("is a request with an action, a standard and a note (which defaults to none)", () => {
    const t = tempDir();
    try {
      const q = submitRequest(t.path, { ...by, kind: "standards-scope", slug: "a", expect: "building", action: "add", name: "payments", note: "why" });
      expect(pendingRequests(t.path)[0]).toMatchObject({ id: q.id, kind: "standards-scope", action: "add", name: "payments", note: "why" });
      const raw = { ...q, id: "x" };
      writeFileSync(join(requestsDir(t.path), `${q.id}.json`), JSON.stringify({ ...raw, id: q.id, note: undefined }));
      expect(pendingRequests(t.path)[0]).toMatchObject({ kind: "standards-scope", note: "" });
      writeFileSync(join(requestsDir(t.path), `${q.id}.json`), JSON.stringify({ ...q, action: "swap" }));
      expect(pendingRequests(t.path)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("chat never proposes it: not in its actions, and a proposed action of that kind does not parse", () => {
    expect((CHANGE_ACTIONS as readonly string[]).includes("standards-scope")).toBe(false);
    expect(ProposedAction.safeParse({ kind: "standards-scope", slug: "a", note: "", priority: null }).success).toBe(false);
    expect(ProposedAction.safeParse({ kind: "hold", slug: "a", note: "", priority: null }).success).toBe(true);
  });
});

describe("cleanup after the full review", () => {
  test("the console's results are read with the same schema as chat's: a file that is not a result is no answer", () => {
    const t = tempDir();
    try {
      const dir = join(requestsDir(t.path), "results");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "000000000000001-1-0000.json"), JSON.stringify({ transport: CONSOLE }));
      writeFileSync(join(dir, "000000000000002-1-0000.json"), JSON.stringify({ id: "000000000000002-1-0000", kind: "close", slug: "a", transport: CONSOLE, thread: "", text: "Closed.", ok: true, status: "no-such-status", at: "x" }));
      expect(requestState(t.path, "000000000000001-1-0000")).toBeNull();
      // A status this loop does not know reads as none, not as a result that is not one.
      expect(requestState(t.path, "000000000000002-1-0000")).toMatchObject({ state: "done", ok: true, text: "Closed.", status: null });
    } finally {
      t.cleanup();
    }
  });
});
