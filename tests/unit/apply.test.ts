import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRequests, armApplier, startApplier } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { readIntent } from "../../src/intents";
import { applyingRequests, CONSOLE, pendingRequests, requestsDir, requestState, saveApplying, submitRequest, type Submission } from "../../src/requests";
import { Trace } from "../../src/trace";
import { chatRepo, INTENT } from "../chat-helpers";
import { until } from "../console-helpers";
import { lastCommit, run } from "../helpers";

const by = { by: "u1", byName: "John", via: "the dashboard", transport: CONSOLE, thread: "" };
/** A person on every gate, so approve and send back are theirs to give. */
const PEOPLE = "gates:\n  spec: { human: status }\n  plan: { human: status }\n  merge: { human: status }\n  done: { human: status }\n";
const withNote = (status: string, note: string) => INTENT(status, "x").replace(`status: ${status}`, `status: ${status}\nnote: ${JSON.stringify(note)}`);

/** Makes the claimed request look as if it had failed `tries` passes, the first of them 11 minutes ago. */
function failedLongAgo(root: string, tries: number): void {
  const req = applyingRequests(root)[0]!;
  saveApplying(root, { ...req, tries, firstFailedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
}

/** A lock on main's ref: commits fail, but files and the index can still be put back. */
const lockMain = (root: string) => writeFileSync(join(root, ".git", "refs", "heads", "main.lock"), "");

async function apply(root: string): Promise<number> {
  const trace = Trace.open(root);
  try { return await applyRequests(root, await loadConfig(root), trace); } finally { trace.close(); }
}

describe("applying requests", () => {
  test("approve: the status moves on, the note is cleared, the commit and the trace say who and where", async () => {
    const r = await chatRepo({ intents: { a: withNote("plan-review", "Read plan.md.") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      expect(await apply(r.root)).toBe(1);
      const i = await readIntent(r.root, "a");
      expect(i.file.frontmatter).toMatchObject({ status: "plan-approved", note: "", resume_from: "plan-approved" });
      expect(await lastCommit(r.root)).toContain("loopstra(a): plan approved by John from the dashboard");
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: true, status: "plan-approved", text: "Plan approved: a is now plan approved, waiting to build." });
      const trace = Trace.open(r.root);
      expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ kind: "approve", by: "John", via: "the dashboard", result: "applied", from: "plan-review", to: "plan-approved" });
      trace.close();
    } finally {
      r.cleanup();
    }
  });

  test("a change that moved on is left alone, and the result says so", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const q = submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("building");
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "a moved on to building; nothing changed." });
    } finally {
      r.cleanup();
    }
  });

  test("send back: back to the approved status before, the note says who and why, and the agent's note is kept", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      await apply(r.root);
      const fm = (await readIntent(r.root, "a")).file.frontmatter;
      expect(fm.status).toBe("spec-approved");
      expect(fm.note).toBe("Sent back by John from the dashboard: Split step 3.");
      expect(readFileSync(join(r.root, ".loopstra", "runs", "a", "sent-back.md"), "utf8")).toBe("Split step 3.");
    } finally {
      r.cleanup();
    }
  });

  test("undo of a send back restores the review and its note, and drops the kept note", async () => {
    const r = await chatRepo({ intents: { a: withNote("plan-review", "Read plan.md.") }, config: PEOPLE });
    try {
      submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      await apply(r.root);
      submitRequest(r.root, { ...by, kind: "undo", slug: "a", expect: "spec-approved", to: "plan-review", note: "Read plan.md." });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter).toMatchObject({ status: "plan-review", note: "Read plan.md." });
      expect(existsSync(join(r.root, ".loopstra", "runs", "a", "sent-back.md"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("retry only to a status the block names; close from any open status", async () => {
    const r = await chatRepo({ intents: { a: withNote("blocked", "The build broke. When that is sorted out, set status to plan-approved to try again."), b: INTENT("building", "y") } });
    try {
      const bad = submitRequest(r.root, { ...by, kind: "retry", slug: "a", expect: "blocked", to: "merged" });
      await apply(r.root);
      expect(requestState(r.root, bad.id)).toMatchObject({ ok: false, text: "a cannot be retried from merged; its note names plan-approved." });
      submitRequest(r.root, { ...by, kind: "retry", slug: "a", expect: "blocked", to: "plan-approved" });
      submitRequest(r.root, { ...by, kind: "close", slug: "b", expect: "building" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("plan-approved");
      expect((await readIntent(r.root, "b")).file.frontmatter).toMatchObject({ status: "closed", note: "Closed by John from the dashboard." });
    } finally {
      r.cleanup();
    }
  });

  test("hold, release and priority apply to any open change, even one whose status moved on", async () => {
    const r = await chatRepo({ intents: { a: INTENT("designing", "x"), d: INTENT("done", "z") } });
    try {
      submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "accepted", reason: "waiting for legal" });
      submitRequest(r.root, { ...by, kind: "priority", slug: "a", expect: "accepted", priority: "high" });
      const done = submitRequest(r.root, { ...by, kind: "hold", slug: "d", expect: "done", reason: "" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter).toMatchObject({ status: "designing", hold: "waiting for legal (John, the dashboard)", priority: "high" });
      expect(requestState(r.root, done.id)).toMatchObject({ ok: false, text: "d is done; nothing changed." });
      submitRequest(r.root, { ...by, kind: "release", slug: "a", expect: "designing" });
      await apply(r.root);
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8")).not.toContain("hold:");
    } finally {
      r.cleanup();
    }
  });

  test("an approve with nobody on the gate is refused: the loop does that review itself", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: "gates:\n  plan:\n    human: none\n" });
    try {
      const q = submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      await apply(r.root);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "a cannot be approved now: nobody reviews that step, so the loop goes on by itself." });
    } finally {
      r.cleanup();
    }
  });

  test("retry only from blocked, even when an old block named the status", async () => {
    const r = await chatRepo({ intents: { a: INTENT("spec-review", "x") }, config: PEOPLE });
    try {
      const t = Trace.open(r.root, () => {});
      t.statusChange("a", "merge-approved", "blocked", "n", { retry: "merge-approved" });
      t.close();
      const q = submitRequest(r.root, { ...by, kind: "retry", slug: "a", expect: "spec-review" as "blocked", to: "merge-approved" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("spec-review");
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, status: "spec-review", text: "a is not blocked, so there is nothing to retry." });
    } finally {
      r.cleanup();
    }
  });

  test("undo only takes back the step that happened last, never jumps forward", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-approved", "x") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "undo", slug: "a", expect: "plan-approved", to: "merge-review", note: "" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("plan-approved");
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "a cannot go back from plan-approved to merge-review." });
    } finally {
      r.cleanup();
    }
  });

  test("an empty send-back note is refused", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "  \n " });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("plan-review");
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "Say what should change, and send it back again." });
    } finally {
      r.cleanup();
    }
  });

  test("a request that cannot be read is finished at once, and traced as refused", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const bad = [
        submitRequest(r.root, { ...by, kind: "priority", slug: "a", expect: "building", priority: "bogus" as "high" }),
        submitRequest(r.root, { ...by, kind: "new", title: "t" } as unknown as Submission),
        submitRequest(r.root, { ...by, kind: "new", title: "t", intents: [{ slug: "b", text: 3, update: false }] } as unknown as Submission),
        submitRequest(r.root, { ...by, kind: "approve", slug: "../x", expect: "plan-review" }),
        submitRequest(r.root, { ...by, kind: "close", slug: "a", expect: "nowhere" as "building" }),
        submitRequest(r.root, { ...by, kind: "undo", slug: "a", expect: "building", to: "plan-review", note: 5 as unknown as string }),
        submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: {} as string }),
        submitRequest(r.root, { ...by, kind: "explode", slug: "a" } as unknown as Submission),
      ];
      expect(await apply(r.root)).toBe(bad.length);
      for (const q of bad) expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: false, status: null, text: "That request could not be read, so nothing changed." });
      expect(pendingRequests(r.root)).toEqual([]);
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ result: "refused" });
      trace.close();
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8")).toBe(INTENT("building", "x"));
    } finally {
      r.cleanup();
    }
  });

  test("a request that keeps failing is given up after five tries and ten minutes, with its write put back; a checkout off main only waits", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      // The checkout off main: not a try; the request waits however many passes it takes.
      await run(["git", "checkout", "-q", "-b", "elsewhere"], r.root);
      for (let i = 0; i < 6; i++) await apply(r.root);
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      expect(applyingRequests(r.root)[0]!.tries ?? 0).toBe(0);
      await run(["git", "checkout", "-q", "main"], r.root);
      // A commit git refuses every time: more than five tries within minutes are not enough to give up.
      const lock = join(r.root, ".git", "index.lock");
      writeFileSync(lock, "");
      for (let i = 0; i < 6; i++) {
        expect(await apply(r.root)).toBe(0);
        expect(applyingRequests(r.root)[0]!.tries).toBe(i + 1);
      }
      const first = applyingRequests(r.root)[0]!.firstFailedAt!;
      expect(Date.now() - Date.parse(first)).toBeLessThan(60_000);
      // Ten minutes on, but the hold it wrote cannot be put back either (the same lock): it stays claimed.
      failedLongAgo(r.root, 6);
      expect(await apply(r.root)).toBe(0);
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      expect((await readIntent(r.root, "a")).file.frontmatter.hold).not.toBe("");
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("_loop", "error")!.payload)).toMatchObject({ where: "request give-up", id: q.id });
      trace.close();
      // Now only the commit fails: the hold is put back as main has it, then a plain answer.
      rmSync(lock);
      lockMain(r.root);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: false, status: null, text: "The loop could not apply this request; an engineer can find the details in the trace." });
      // As git checks it out (its line endings may differ from the text written).
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8").replaceAll("\r\n", "\n")).toBe(INTENT("building", "x"));
      expect((await run(["git", "status", "--short", "--", "intent/a"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a send back given up on drops its kept note; a new intent given up on is removed", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      const lock = join(r.root, ".git", "index.lock");
      writeFileSync(lock, "");
      expect(await apply(r.root)).toBe(0);
      rmSync(lock);
      // Kept with the write, before the commit (a crash after the commit must not lose it).
      const kept = join(r.root, ".loopstra", "runs", "a", "sent-back.md");
      expect(readFileSync(kept, "utf8")).toBe("Split step 3.");
      failedLongAgo(r.root, 5);
      lockMain(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false });
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("plan-review");
      expect(existsSync(kept)).toBe(false);

      const n = submitRequest(r.root, { ...by, kind: "new", title: "t", intents: [{ slug: "b", text: INTENT("draft", "y"), update: false }] });
      expect(await apply(r.root)).toBe(0);
      expect(existsSync(join(r.root, "intent", "b", "intent.md"))).toBe(true);
      failedLongAgo(r.root, 5);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, n.id)).toMatchObject({ ok: false });
      expect(existsSync(join(r.root, "intent", "b", "intent.md"))).toBe(false);
      expect((await run(["git", "status", "--short", "--", "intent"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  for (const kind of ["hold", "release"] as const) {
    test(`a ${kind} whose commit failed is committed on the next pass, not refused as done already`, async () => {
      const start = kind === "release" ? INTENT("building", "x").replace("status: building", "status: building\nhold: legal") : INTENT("building", "x");
      const r = await chatRepo({ intents: { a: start } });
      try {
        const q = submitRequest(r.root, kind === "hold" ? { ...by, kind, slug: "a", expect: "building", reason: "legal" } : { ...by, kind, slug: "a", expect: "building" });
        const lock = join(r.root, ".git", "index.lock");
        writeFileSync(lock, "");
        expect(await apply(r.root)).toBe(0);
        rmSync(lock);
        expect(await apply(r.root)).toBe(1);
        expect(requestState(r.root, q.id)).toMatchObject({ ok: true });
        expect(await lastCommit(r.root)).toContain(`loopstra(a): ${kind === "hold" ? "held" : "released"} by John from the dashboard`);
        expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
      } finally {
        r.cleanup();
      }
    }, 60_000);
  }

  test("a hold of a held change, or a release of one not held, is refused and traced", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x").replace("status: building", "status: building\nhold: legal"), b: INTENT("building", "y") } });
    try {
      const h = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "again" });
      const l = submitRequest(r.root, { ...by, kind: "release", slug: "b", expect: "building" });
      await apply(r.root);
      expect(requestState(r.root, h.id)).toMatchObject({ ok: false, text: "a is held already; nothing changed." });
      expect(requestState(r.root, l.id)).toMatchObject({ ok: false, text: "b is not held; nothing changed." });
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ kind: "hold", result: "refused" });
      expect(JSON.parse(trace.lastEvent("b", "request")!.payload)).toMatchObject({ kind: "release", result: "refused" });
      trace.close();
    } finally {
      r.cleanup();
    }
  });

  test("start from the console answers in console words; chat keeps its own", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft", "x"), b: INTENT("building", "y"), c: INTENT("draft", "z") } });
    try {
      const started = submitRequest(r.root, { ...by, kind: "accept", slug: "a" });
      const moved = submitRequest(r.root, { ...by, kind: "accept", slug: "b" });
      const missing = submitRequest(r.root, { ...by, kind: "accept", slug: "nope" });
      const chat = submitRequest(r.root, { ...by, via: "Slack", transport: "slack", kind: "accept", slug: "c" });
      await apply(r.root);
      expect(requestState(r.root, started.id)).toMatchObject({ ok: true, text: "Accepted: a is now waiting to be designed." });
      expect(requestState(r.root, moved.id)).toMatchObject({ ok: false, text: "b is building now, not a draft; nothing changed." });
      expect(requestState(r.root, missing.id)).toMatchObject({ ok: false, text: "There is no change called nope in the main code." });
      expect(requestState(r.root, chat.id)).toMatchObject({ ok: true, text: "Started c. I will say here when it needs anyone, and when it is done." });
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("c", "chat-request")!.payload)).toMatchObject({ via: "Slack", result: "accepted" });
      trace.close();
    } finally {
      r.cleanup();
    }
  });

  test("a change that does not exist gets a plain answer", async () => {
    const r = await chatRepo({ intents: {} });
    try {
      const q = submitRequest(r.root, { ...by, kind: "close", slug: "nope", expect: "building" });
      await apply(r.root);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, status: null, text: "There is no change called nope in the main code." });
    } finally {
      r.cleanup();
    }
  });
});

describe("the applier", () => {
  test("once armed, it applies a request within a couple of seconds and stops cleanly", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const applier = startApplier(r.root, { everyMs: 50 });
    try {
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      await Bun.sleep(200);
      // Not armed yet: the first tick has not put a cut-short move of main back.
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      armApplier(r.root);
      await until(async () => (await readIntent(r.root, "a")).file.frontmatter.hold !== "", 5_000);
    } finally {
      await applier.stop();
      r.cleanup();
    }
  });

  test("a failed pass starts no other at once: only a new request file does", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    // The timer far off: every pass here is started by the watcher.
    const applier = startApplier(r.root, { everyMs: 60_000 });
    try {
      armApplier(r.root);
      writeFileSync(join(r.root, ".git", "index.lock"), "");
      submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      await until(() => (applyingRequests(r.root)[0]?.tries ?? 0) >= 1, 5_000);
      // The failed pass rewrote applying/<id>.json; that must not start the next pass.
      await Bun.sleep(1_000);
      expect(applyingRequests(r.root)[0]!.tries).toBe(1);
    } finally {
      await applier.stop();
      r.cleanup();
    }
  }, 30_000);

  test("the requests folder deleted while it runs is made and watched again", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const applier = startApplier(r.root, { everyMs: 100 });
    try {
      armApplier(r.root);
      rmSync(requestsDir(r.root), { recursive: true, force: true });
      await until(() => existsSync(requestsDir(r.root)), 5_000);
      submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      await until(async () => (await readIntent(r.root, "a")).file.frontmatter.hold !== "", 5_000);
    } finally {
      await applier.stop();
      r.cleanup();
    }
  }, 30_000);

  test("passes do not pile up: one runs, and every caller meanwhile shares the one queued behind it", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const trace = Trace.open(r.root, () => {});
    try {
      const cfg = await loadConfig(r.root);
      submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      const first = applyRequests(r.root, cfg, trace);
      // The first pass is running now (committing the hold).
      await Bun.sleep(0);
      const second = applyRequests(r.root, cfg, trace);
      const third = applyRequests(r.root, cfg, trace);
      expect(second).not.toBe(first);
      expect(third).toBe(second);
      expect(await first).toBe(1);
      expect(await second).toBe(0);
      // Once the queued pass has started, a new call queues a new one.
      const later = applyRequests(r.root, cfg, trace);
      expect(later).not.toBe(second);
      expect(await later).toBe(0);
    } finally {
      trace.close();
      r.cleanup();
    }
  });
});
