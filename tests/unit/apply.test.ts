import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRequests } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { readIntent } from "../../src/intents";
import { CONSOLE, requestState, submitRequest } from "../../src/requests";
import { Trace } from "../../src/trace";
import { chatRepo, INTENT } from "../chat-helpers";
import { lastCommit } from "../helpers";

const by = { by: "u1", byName: "John", via: "the dashboard", transport: CONSOLE, thread: "" };
/** A person on every gate, so approve and send back are theirs to give. */
const PEOPLE = "gates:\n  spec: { human: status }\n  plan: { human: status }\n  merge: { human: status }\n  done: { human: status }\n";
const withNote = (status: string, note: string) => INTENT(status, "x").replace(`status: ${status}`, `status: ${status}\nnote: ${JSON.stringify(note)}`);

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
