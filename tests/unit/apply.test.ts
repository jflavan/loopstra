import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRequests, armApplier, betweenPasses, startApplier } from "../../src/apply";
import { loadConfig } from "../../src/config";
import { commitRecord } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { readQuestion } from "../../src/questions";
import { RecordDraft } from "../../src/record-draft";
import { applyingRequests, claimRequest, CONSOLE, pendingRequests, requestsDir, requestState, saveApplying, submitRequest, takeResults, type Request, type Submission } from "../../src/requests";
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

/** A lock on main's ref: a record's commit is made, but HEAD cannot move to it, so nothing lands. */
const lockMain = (root: string) => writeFileSync(join(root, ".git", "refs", "heads", "main.lock"), "");

/**
 * Claims the request and leaves what a pass the loop was killed in before its commit leaves: the
 * record's commit made, with the request's id, but never reached by HEAD, and the marker naming it
 * (see commitRecord). Nothing of it is in the checkout.
 */
async function killedBeforeCommit(root: string, req: Request, write: (d: RecordDraft) => void): Promise<void> {
  claimRequest(root, req.id);
  const slug = "slug" in req ? req.slug : "";
  const git = new Git(root);
  const parent = await git.headSha();
  const draft = new RecordDraft(root, slug);
  write(draft);
  const commit = (await git.commitFiles(parent, [`intent/${slug}`, "intent/queue.md"], draft.changes(), `loopstra(${slug}): killed [skip ci]\n\nLoopstra-Request: ${req.id}`))!;
  writeFileSync(join(root, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug, paths: draft.changes().map((c) => c.rel) }));
}

/** A hold's and a release's record of change a, as the applier writes it (see holdLine in src/apply.ts). */
const holdEdit = (d: RecordDraft) => d.write("intent/a/intent.md", d.read("intent/a/intent.md")!.replace("status: building", "status: building\nhold: legal (John, the dashboard)"));
const releaseEdit = (d: RecordDraft) => d.write("intent/a/intent.md", d.read("intent/a/intent.md")!.replace("\nhold: legal", ""));

/**
 * Claims the request and commits its record with the request's id (see commitRecord), as a pass the
 * loop was killed in after its commit and before it finished the request leaves it.
 */
async function landedBeforeKill(root: string, req: Request, what: string, write: (d: RecordDraft) => void, slug = "slug" in req ? req.slug : ""): Promise<void> {
  claimRequest(root, req.id);
  expect(await commitRecord(root, "main", slug, what, async (d) => { write(d); }, { request: req.id })).toBe(true);
}

/** How many commits HEAD has. */
async function commitCount(root: string): Promise<string> {
  return (await run(["git", "rev-list", "--count", "HEAD"], root)).out.trim();
}

/** A change whose design asked a question, and the question.json the loop keeps for it. */
const ASKING = INTENT("designing", "x").replace("status: designing", "status: designing\nquestion: open");
function asked(root: string): void {
  mkdirSync(join(root, ".loopstra", "runs", "a"), { recursive: true });
  writeFileSync(join(root, ".loopstra", "runs", "a", "question.json"), JSON.stringify({
    status: "designing", count: 1,
    open: { phase: "design", traceName: "design", seq: 3, sessionId: "s1", text: "Archived too?", why: "", options: [], at: "2026-10-17T12:00:00.000Z" },
  }));
}

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

  test("a request whose record landed but whose pass was killed before it finished is finished as applied, with no second commit", async () => {
    const r = await chatRepo({ intents: { x: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const req = submitRequest(r.root, { ...by, kind: "approve", slug: "x", expect: "plan-review" });
      // The record landed with the request's id, as a pass the loop was killed in would leave it.
      await landedBeforeKill(r.root, req, "plan approved by John from the dashboard", (d) => {
        const rel = "intent/x/intent.md";
        d.write(rel, d.read(rel)!.replace("status: plan-review", "status: plan-approved"));
      });
      const commits = await commitCount(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, req.id)).toMatchObject({ state: "done", ok: true, status: "plan-approved", text: "Plan approved: x is now plan approved, waiting to build." });
      expect(await commitCount(r.root)).toBe(commits);
      const trace = Trace.open(r.root, () => {});
      try {
        expect(JSON.parse(trace.lastEvent("x", "request")!.payload)).toMatchObject({ kind: "approve", result: "applied", from: "plan-review", to: "plan-approved" });
        expect(trace.events("x").filter((e) => e.type === "status_change")).toHaveLength(1);
      } finally { trace.close(); }
    } finally {
      r.cleanup();
    }
  });

  /** Each status and field request, killed after its record landed: the change as it then is, the request, and its record's write. */
  const KILLED_AFTER = [
    { kind: "priority", start: INTENT("building", "x"), submit: { kind: "priority", slug: "a", expect: "building", priority: "high" }, from: "status: building", to: "status: building\npriority: high", status: "building" },
    { kind: "retry", start: withNote("blocked", "The build broke. When that is sorted out, set status to plan-approved to try again."), submit: { kind: "retry", slug: "a", expect: "blocked", to: "plan-approved" }, from: "status: blocked", to: "status: plan-approved", status: "plan-approved" },
    { kind: "close", start: INTENT("building", "x"), submit: { kind: "close", slug: "a", expect: "building" }, from: "status: building", to: "status: closed", status: "closed" },
    // An undo of a send back: the record moved the change back to the review, so it no longer is where the request expects.
    { kind: "undo", start: INTENT("spec-approved", "x"), submit: { kind: "undo", slug: "a", expect: "spec-approved", to: "plan-review", note: "" }, from: "status: spec-approved", to: "status: plan-review", status: "plan-review" },
  ] as const;
  for (const k of KILLED_AFTER) test(`a ${k.kind} whose record landed before the loop was killed is finished as applied, with no second commit`, async () => {
    const r = await chatRepo({ intents: { a: k.start }, config: PEOPLE });
    try {
      const req = submitRequest(r.root, { ...by, ...k.submit });
      await landedBeforeKill(r.root, req, "landed", (d) => {
        const rel = "intent/a/intent.md";
        d.write(rel, d.read(rel)!.replace(k.from, k.to));
      });
      const commits = await commitCount(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, req.id)).toMatchObject({ state: "done", ok: true, status: k.status });
      expect(await commitCount(r.root)).toBe(commits);
      const trace = Trace.open(r.root, () => {});
      try {
        expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ kind: k.kind, result: "applied" });
      } finally { trace.close(); }
    } finally {
      r.cleanup();
    }
  });

  test("a new request with two drafts, the loop killed after the first landed: the next pass adds only the second", async () => {
    const r = await chatRepo({ intents: {} });
    try {
      const req = submitRequest(r.root, { ...by, kind: "new", title: "t", intents: [{ slug: "b", text: INTENT("draft", "b"), update: false }, { slug: "c", text: INTENT("draft", "c"), update: false }] });
      await landedBeforeKill(r.root, req, "open intent from chat", (d) => { d.write("intent/b/intent.md", INTENT("draft", "b")); }, "b");
      const commits = Number(await commitCount(r.root));
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, req.id)).toMatchObject({ ok: true, text: "Added to the queue as drafts: b, c. Read them in intent/, then set status to accepted, or ask me to start one." });
      expect(Number(await commitCount(r.root))).toBe(commits + 1);
      expect(await lastCommit(r.root)).toContain("loopstra(c): open intent from chat");
      expect(readFileSync(join(r.root, "intent", "c", "intent.md"), "utf8")).toBe(INTENT("draft", "c"));
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

  test("send back writes its note into conversation.md, in the same commit as the status", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3.\n" });
      await apply(r.root);
      const show = (path: string) => run(["git", "show", `HEAD:${path}`], r.root);
      expect((await show("intent/a/intent.md")).out).toContain("status: spec-approved");
      expect((await show("intent/a/conversation.md")).out).toMatch(/^# Conversation\n\n## \d{4}-\d\d-\d\d \d\d:\d\d · John \(the dashboard\) sent it back\nSplit step 3\.\n$/);
      expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
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

  test("undo of a send back says in conversation.md, in the undo's own commit, that its note no longer stands", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x"), b: INTENT("plan-review", "y") }, config: PEOPLE });
    try {
      submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      submitRequest(r.root, { ...by, kind: "approve", slug: "b", expect: "plan-review" });
      await apply(r.root);
      submitRequest(r.root, { ...by, kind: "undo", slug: "a", expect: "spec-approved", to: "plan-review", note: "" });
      submitRequest(r.root, { ...by, kind: "undo", slug: "b", expect: "plan-approved", to: "plan-review", note: "" });
      await apply(r.root);
      const show = (path: string) => run(["git", "show", `HEAD~1:${path}`], r.root);
      // The undo of a's send back is the commit before b's undo.
      expect((await run(["git", "log", "-1", "--format=%s", "HEAD~1"], r.root)).out).toContain("loopstra(a): undone, back to plan-review by John from the dashboard");
      expect((await show("intent/a/intent.md")).out).toContain("status: plan-review");
      expect((await show("intent/a/conversation.md")).out).toMatch(/sent it back\nSplit step 3\.\n\n## \d{4}-\d\d-\d\d \d\d:\d\d · John \(the dashboard\) took back the send back\nThe note above no longer stands\.\n$/);
      expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
      // An approve's undo has nothing to take back.
      expect(existsSync(join(r.root, "intent", "b", "conversation.md"))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("undo of an approve takes resume_from back to the approved status before the review", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x"), m: INTENT("merge-review", "y") }, config: PEOPLE });
    try {
      submitRequest(r.root, { ...by, kind: "approve", slug: "a", expect: "plan-review" });
      submitRequest(r.root, { ...by, kind: "approve", slug: "m", expect: "merge-review" });
      await apply(r.root);
      expect((await readIntent(r.root, "a")).file.frontmatter.resume_from).toBe("plan-approved");
      submitRequest(r.root, { ...by, kind: "undo", slug: "a", expect: "plan-approved", to: "plan-review", note: "" });
      submitRequest(r.root, { ...by, kind: "undo", slug: "m", expect: "merge-approved", to: "merge-review", note: "" });
      await apply(r.root);
      // A later block offers to retry from here, not from the approval taken back.
      expect((await readIntent(r.root, "a")).file.frontmatter).toMatchObject({ status: "plan-review", resume_from: "spec-approved" });
      expect((await readIntent(r.root, "m")).file.frontmatter).toMatchObject({ status: "merge-review", resume_from: "plan-approved" });
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
      // No stated priority, as an undo puts back on a change that had none: the line is taken out.
      const none = submitRequest(r.root, { ...by, kind: "priority", slug: "a", expect: "designing", priority: null });
      await apply(r.root);
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8")).not.toContain("priority:");
      expect(requestState(r.root, none.id)).toMatchObject({ ok: true, text: "a now has priority normal." });
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

  test("a request that keeps failing is given up after five tries and ten minutes; a failed commit leaves nothing written; a checkout off main only waits", async () => {
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
      lockMain(r.root);
      for (let i = 0; i < 6; i++) {
        expect(await apply(r.root)).toBe(0);
        expect(applyingRequests(r.root)[0]!.tries).toBe(i + 1);
        expect((await readIntent(r.root, "a")).file.frontmatter.hold).toBe("");
      }
      const first = applyingRequests(r.root)[0]!.firstFailedAt!;
      expect(Date.now() - Date.parse(first)).toBeLessThan(60_000);
      // Ten minutes on it is given up, the lock still held: nothing it tried was written, so nothing is put back.
      failedLongAgo(r.root, 6);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: false, status: null, text: "The loop could not apply this request; an engineer can find the details in the trace." });
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8").replaceAll("\r\n", "\n")).toBe(INTENT("building", "x"));
      expect((await run(["git", "status", "--short", "--", "intent/a"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a request whose record landed but whose follow-up failed stays claimed before the give-up point; once it works, the next pass finishes it as applied", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    const kept = join(r.root, ".loopstra", "runs", "a", "sent-back.md");
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      // The record lands, then keeping the note fails: a folder stands where it goes.
      mkdirSync(join(kept, "x"), { recursive: true });
      expect(await apply(r.root)).toBe(0);
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      expect((await run(["git", "show", "HEAD:intent/a/intent.md"], r.root)).out).toContain("status: spec-approved");
      rmSync(kept, { recursive: true });
      const commits = await commitCount(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: true, status: "spec-approved" });
      expect(await commitCount(r.root)).toBe(commits);
      expect(readFileSync(kept, "utf8")).toBe("Split step 3.");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a request whose record landed but whose follow-up never works is finished as applied at the give-up point, saying what could not be kept, and not tried again", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    const kept = join(r.root, ".loopstra", "runs", "a", "sent-back.md");
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      claimRequest(r.root, q.id);
      failedLongAgo(r.root, 5);
      // The folder where the note goes is never taken away.
      mkdirSync(join(kept, "x"), { recursive: true });
      expect(await apply(r.root)).toBe(1);
      const state = requestState(r.root, q.id);
      expect(state).toMatchObject({ state: "done", ok: true, status: "spec-approved" });
      expect(state && "text" in state ? state.text : "").toEndWith("Its note for the next session could not be kept; an engineer can find why in the trace.");
      expect(applyingRequests(r.root)).toEqual([]);
      expect(await apply(r.root)).toBe(0);
      expect((await run(["git", "show", "HEAD:intent/a/intent.md"], r.root)).out).toContain("status: spec-approved");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a new request whose first draft landed and whose second never can be written is finished at the give-up point, naming both", async () => {
    const r = await chatRepo({ intents: {} });
    const commitFiles = Git.prototype.commitFiles;
    try {
      const req = submitRequest(r.root, { ...by, kind: "new", title: "t", intents: [{ slug: "b", text: INTENT("draft", "b"), update: false }, { slug: "c", text: INTENT("draft", "c"), update: false }] });
      await landedBeforeKill(r.root, req, "open intent from chat", (d) => { d.write("intent/b/intent.md", INTENT("draft", "b")); }, "b");
      failedLongAgo(r.root, 5);
      // Every commit of the second draft is refused.
      Git.prototype.commitFiles = async function (this: Git, parent, paths, changes, message) {
        if (changes.some((c) => c.rel.startsWith("intent/c/"))) throw new Error("refused");
        return commitFiles.call(this, parent, paths, changes, message);
      };
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, req.id)).toMatchObject({ state: "done", ok: true, text: "Added to the queue as drafts: b. Read them in intent/, then set status to accepted, or ask me to start one. Could not be written: c; an engineer can find why in the trace." });
      expect(existsSync(join(r.root, "intent", "c", "intent.md"))).toBe(false);
      expect(await apply(r.root)).toBe(0);
    } finally {
      Git.prototype.commitFiles = commitFiles;
      r.cleanup();
    }
  }, 60_000);

  test("a request whose record meets a record a kill cut short that cannot be finished yet only waits: not a try, never given up", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const lock = join(r.root, ".git", "index.lock");
    try {
      // A record a kill cut short after main moved, and a person's git holding the index: it cannot be finished yet.
      const git = new Git(r.root);
      const parent = await git.headSha();
      const rel = "intent/a/note.md";
      const commit = (await git.commitFiles(parent, ["intent/a"], [{ rel, text: "n\n" }], "loopstra(a): killed [skip ci]"))!;
      mkdirSync(join(r.root, ".loopstra"), { recursive: true });
      writeFileSync(join(r.root, ".loopstra", "recording.json"), JSON.stringify({ parent, commit, slug: "a", paths: [rel] }));
      expect(await git.moveRef("refs/heads/main", parent, commit)).toBe(true);
      writeFileSync(lock, "");
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      claimRequest(r.root, q.id);
      // Due to be given up on, were it a try.
      failedLongAgo(r.root, 5);
      for (let i = 0; i < 6; i++) expect(await apply(r.root)).toBe(0);
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      expect(applyingRequests(r.root)[0]!.tries).toBe(5);
      const trace = Trace.open(r.root, () => {});
      try {
        expect(trace.events("_loop").filter((e) => e.type === "error" && e.payload.includes(`"id":"${q.id}"`))).toHaveLength(1);
      } finally { trace.close(); }
      rmSync(lock);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: true });
      expect((await readIntent(r.root, "a")).file.frontmatter.hold).toContain("wait");
    } finally {
      rmSync(lock, { force: true });
      r.cleanup();
    }
  }, 60_000);

  test("a request the loop was killed in before its commit, then given up on, leaves the change as HEAD has it", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      await killedBeforeCommit(r.root, q, holdEdit);
      expect((await readIntent(r.root, "a")).file.frontmatter.hold).toBe("");
      failedLongAgo(r.root, 6);
      lockMain(r.root);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: false, status: null, text: "The loop could not apply this request; an engineer can find the details in the trace." });
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8").replaceAll("\r\n", "\n")).toBe(INTENT("building", "x"));
      expect((await run(["git", "status", "--short", "--", "intent/a"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a send back given up on keeps no note and no record; a new intent whose commit fails is written nowhere", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      // Kept only once the send back lands: one that never did must not steer the next session.
      const kept = join(r.root, ".loopstra", "runs", "a", "sent-back.md");
      expect(existsSync(kept)).toBe(false);
      failedLongAgo(r.root, 5);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false });
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("plan-review");
      expect(existsSync(kept)).toBe(false);
      expect(existsSync(join(r.root, "intent", "a", "conversation.md"))).toBe(false);

      const n = submitRequest(r.root, { ...by, kind: "new", title: "t", intents: [{ slug: "b", text: INTENT("draft", "y"), update: false }] });
      expect(await apply(r.root)).toBe(0);
      expect(existsSync(join(r.root, "intent", "b", "intent.md"))).toBe(false);
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

  test("a start whose record landed before the loop was killed is finished as started, and a person's edit since is left as it is", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft", "x") } });
    try {
      const q = submitRequest(r.root, { ...by, kind: "accept", slug: "a" });
      await landedBeforeKill(r.root, q, "accepted by John from the dashboard", (d) => {
        const rel = "intent/a/intent.md";
        d.write(rel, d.read(rel)!.replace("status: draft", "status: accepted"));
      });
      // The person edits the body since; the next pass must neither refuse the start nor write over them.
      const path = join(r.root, "intent", "a", "intent.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("x", "x, and also y"));
      const commits = await commitCount(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: true, status: "accepted", text: "Accepted: a is now waiting to be designed." });
      expect(await commitCount(r.root)).toBe(commits);
      expect(readFileSync(path, "utf8")).toContain("x, and also y");
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("accepted");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a request given up on never undoes a person's edit made before its write", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      // A person's edit, not committed, before the request writes.
      const path = join(r.root, "intent", "a", "intent.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("x", "x, and also y"));
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      failedLongAgo(r.root, 5);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: false, status: null, text: "The loop could not apply this request; an engineer can find the details in the trace." });
      expect(readFileSync(path, "utf8")).toContain("x, and also y");
      expect((await readIntent(r.root, "a")).file.frontmatter.hold).toBe("");
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ result: "failed" });
      trace.close();
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a send back whose commit failed keeps no note and no entry, and is refused as moved on once the change has", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      const kept = join(r.root, ".loopstra", "runs", "a", "sent-back.md");
      expect(existsSync(kept)).toBe(false);
      // A person sets another status meanwhile.
      const path = join(r.root, "intent", "a", "intent.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("status: plan-review", "status: closed"));
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "a moved on to closed; nothing changed." });
      expect(existsSync(kept)).toBe(false);
      expect(existsSync(join(r.root, "intent", "a", "conversation.md"))).toBe(false);
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("a send back whose record landed before the loop was killed is finished as applied: its note is kept, and conversation.md stays as a person edited it since", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const q = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      await landedBeforeKill(r.root, q, "sent back by John from the dashboard", (d) => {
        const rel = "intent/a/intent.md";
        d.write(rel, d.read(rel)!.replace("status: plan-review", "status: spec-approved"));
        d.write("intent/a/conversation.md", "# Conversation\n\n## 2026-10-19 12:00 · John (the dashboard) sent it back\nSplit step 3.\n");
      });
      const record = join(r.root, "intent", "a", "conversation.md");
      writeFileSync(record, `${readFileSync(record, "utf8")}\nA person's own line.\n`);
      const commits = await commitCount(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: true, status: "spec-approved" });
      expect(await commitCount(r.root)).toBe(commits);
      expect(readFileSync(join(r.root, ".loopstra", "runs", "a", "sent-back.md"), "utf8")).toBe("Split step 3.");
      const text = readFileSync(record, "utf8");
      expect(text).toContain("A person's own line.");
      expect(text.match(/sent it back\n/g)).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("an answer given up on leaves conversation.md as it is when it held a person's uncommitted edit before the write", async () => {
    const r = await chatRepo({ intents: { a: ASKING } });
    try {
      asked(r.root);
      const record = join(r.root, "intent", "a", "conversation.md");
      writeFileSync(record, "# Conversation\n\n## 2026-10-17 12:00 · design asks\nArchived too?\n");
      await run(["git", "add", "intent/a/conversation.md"], r.root);
      await run(["git", "commit", "-q", "-m", "the question"], r.root);
      writeFileSync(record, `${readFileSync(record, "utf8")}\nA person's own line.\n`);
      const q = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Leave them out." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      failedLongAgo(r.root, 5);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false });
      expect(readFileSync(record, "utf8")).toContain("A person's own line.");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  for (const kind of ["hold", "release"] as const) for (const how of ["whose commit failed", "the loop was killed in before its commit", "whose record landed before the loop was killed"]) {
    test(`a ${kind} ${how} is ${how.startsWith("whose record") ? "finished as applied with no second commit" : "committed on the next pass"}, not refused as done already`, async () => {
      const start = kind === "release" ? INTENT("building", "x").replace("status: building", "status: building\nhold: legal") : INTENT("building", "x");
      const r = await chatRepo({ intents: { a: start } });
      try {
        const q = submitRequest(r.root, kind === "hold" ? { ...by, kind, slug: "a", expect: "building", reason: "legal" } : { ...by, kind, slug: "a", expect: "building" });
        const edit = kind === "hold" ? holdEdit : releaseEdit;
        const what = `${kind === "hold" ? "held" : "released"} by John from the dashboard`;
        let commits = "";
        if (how === "whose commit failed") {
          lockMain(r.root);
          expect(await apply(r.root)).toBe(0);
          rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
        } else if (how === "the loop was killed in before its commit") await killedBeforeCommit(r.root, q, edit);
        else {
          await landedBeforeKill(r.root, q, what, edit);
          commits = await commitCount(r.root);
        }
        expect(await apply(r.root)).toBe(1);
        expect(requestState(r.root, q.id)).toMatchObject({ ok: true });
        expect(await lastCommit(r.root)).toContain(`loopstra(a): ${what}`);
        if (commits) expect(await commitCount(r.root)).toBe(commits);
        expect((await readIntent(r.root, "a")).file.frontmatter.hold).toBe(kind === "hold" ? "legal (John, the dashboard)" : "");
        expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
        expect(existsSync(join(r.root, ".loopstra", "recording.json"))).toBe(false);
      } finally {
        r.cleanup();
      }
    }, 60_000);
  }

  test("an answer removes the question line, records the answer in conversation.md, and stores it for the asking session", async () => {
    const r = await chatRepo({ intents: { a: ASKING } });
    try {
      asked(r.root);
      const q = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: " Leave them out. " });
      expect(await apply(r.root)).toBe(1);
      expect(readFileSync(join(r.root, "intent", "a", "intent.md"), "utf8")).not.toContain("question:");
      expect((await readIntent(r.root, "a")).file.frontmatter.status).toBe("designing");
      expect(readFileSync(join(r.root, "intent", "a", "conversation.md"), "utf8")).toMatch(/## [0-9-]+ [0-9:]+ · John \(the dashboard\) answers\nLeave them out\.\n/);
      expect(await lastCommit(r.root)).toContain("loopstra(a): question answered by John from the dashboard");
      expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
      expect(readQuestion(r.root, "a")!.open!.answer).toMatchObject({ text: "Leave them out.", by: "John", via: "the dashboard" });
      expect(requestState(r.root, q.id)).toMatchObject({ state: "done", ok: true, status: "designing", text: "a has its answer; the loop goes on with it." });
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("a", "request")!.payload)).toMatchObject({ kind: "answer", by: "John", result: "applied", what: "question answered" });
      trace.close();
    } finally {
      r.cleanup();
    }
  });

  test("an answer naming the question it answers lands while that one waits, and changes nothing once another does", async () => {
    const r = await chatRepo({ intents: { a: ASKING, b: ASKING } });
    try {
      asked(r.root);
      mkdirSync(join(r.root, ".loopstra", "runs", "b"), { recursive: true });
      writeFileSync(join(r.root, ".loopstra", "runs", "b", "question.json"), readFileSync(join(r.root, ".loopstra", "runs", "a", "question.json")));
      const seen = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Leave them out.", question: "2026-10-17T12:00:00.000Z" });
      // b's session asked another question since the person read theirs.
      const stale = submitRequest(r.root, { ...by, kind: "answer", slug: "b", text: "Leave them out.", question: "2026-10-17T11:00:00.000Z" });
      const bad = submitRequest(r.root, { ...by, kind: "answer", slug: "b", text: "Leave them out.", question: 5 as unknown as string });
      await apply(r.root);
      expect(requestState(r.root, seen.id)).toMatchObject({ ok: true, text: "a has its answer; the loop goes on with it." });
      expect(requestState(r.root, stale.id)).toMatchObject({ ok: false, status: "designing", text: "b's question changed since; nothing changed. Read the new one." });
      expect(requestState(r.root, bad.id)).toMatchObject({ ok: false, text: "That request could not be read, so nothing changed." });
      expect((await readIntent(r.root, "b")).file.frontmatter.question).toBe("open");
      expect(existsSync(join(r.root, "intent", "b", "conversation.md"))).toBe(false);
      expect(readQuestion(r.root, "b")!.open).not.toHaveProperty("answer");
      const trace = Trace.open(r.root, () => {});
      try {
        expect(trace.events("b").filter((e) => e.type === "request").map((e) => JSON.parse(e.payload))).toContainEqual(expect.objectContaining({ id: stale.id, kind: "answer", result: "refused", why: "question changed" }));
      } finally { trace.close(); }
    } finally {
      r.cleanup();
    }
  });

  test("an answer to a change with no question waiting, or a finished one, changes nothing; one that cannot be read is refused", async () => {
    const r = await chatRepo({ intents: { a: INTENT("designing", "x"), c: ASKING.replace("status: designing", "status: closed") } });
    try {
      const none = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Leave them out." });
      const closed = submitRequest(r.root, { ...by, kind: "answer", slug: "c", text: "Leave them out." });
      const blank = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "  " });
      const long = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "x".repeat(20_001) });
      await apply(r.root);
      expect(requestState(r.root, none.id)).toMatchObject({ ok: false, text: "a has no question waiting; nothing changed." });
      expect(requestState(r.root, closed.id)).toMatchObject({ ok: false, text: "c is closed; nothing changed." });
      for (const q of [blank, long]) expect(requestState(r.root, q.id)).toMatchObject({ ok: false, text: "That request could not be read, so nothing changed." });
      expect(existsSync(join(r.root, "intent", "a", "conversation.md"))).toBe(false);
      const trace = Trace.open(r.root, () => {});
      expect(JSON.parse(trace.lastEvent("c", "request")!.payload)).toMatchObject({ kind: "answer", result: "refused" });
      // The refusal says who asked, from where, as every other request's event does.
      const refused = trace.lastEvent("a", "request", long.id)?.payload ?? "";
      trace.close();
      expect(JSON.parse(refused)).toMatchObject({ id: long.id, result: "refused", by: by.byName, byId: by.by, via: by.via });
    } finally {
      r.cleanup();
    }
  });

  test("an answer whose commit failed is committed on the next pass, its entry written once", async () => {
    const r = await chatRepo({ intents: { a: ASKING } });
    try {
      asked(r.root);
      const q = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Leave them out." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: true });
      expect(await lastCommit(r.root)).toContain("loopstra(a): question answered by John from the dashboard");
      expect(readFileSync(join(r.root, "intent", "a", "conversation.md"), "utf8").match(/answers\n/g)).toHaveLength(1);
      expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("an answer whose commit failed, given up on, leaves the question line, no record and no stored answer", async () => {
    const r = await chatRepo({ intents: { a: ASKING } });
    try {
      asked(r.root);
      const q = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Leave them out." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      // Stored only once the answer lands: one that never did must not resume the session.
      expect(readQuestion(r.root, "a")!.open).not.toHaveProperty("answer");
      failedLongAgo(r.root, 5);
      expect(await apply(r.root)).toBe(1);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(requestState(r.root, q.id)).toMatchObject({ ok: false });
      expect((await readIntent(r.root, "a")).file.frontmatter.question).toBe("open");
      expect(existsSync(join(r.root, "intent", "a", "conversation.md"))).toBe(false);
      expect(readQuestion(r.root, "a")!.open).not.toHaveProperty("answer");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("an answer whose record landed before the loop was killed is finished as applied, and its answer stored for the asking session", async () => {
    const r = await chatRepo({ intents: { a: ASKING } });
    try {
      asked(r.root);
      const q = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Leave them out." });
      await landedBeforeKill(r.root, q, "question answered by John from the dashboard", (d) => {
        const rel = "intent/a/intent.md";
        d.write(rel, d.read(rel)!.replace("\nquestion: open", ""));
        d.write("intent/a/conversation.md", "# Conversation\n\n## 2026-10-19 12:00 · John (the dashboard) answers\nLeave them out.\n");
      });
      const commits = await commitCount(r.root);
      expect(await apply(r.root)).toBe(1);
      expect(requestState(r.root, q.id)).toMatchObject({ ok: true, text: "a has its answer; the loop goes on with it." });
      expect(await commitCount(r.root)).toBe(commits);
      expect(readQuestion(r.root, "a")!.open!.answer).toMatchObject({ text: "Leave them out.", by: "John", via: "the dashboard" });
      expect(readFileSync(join(r.root, "intent", "a", "conversation.md"), "utf8").match(/answers\n/g)).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("two answers whose commits both failed: the first lands on the next pass, the second is refused, and record and stored answer agree", async () => {
    const r = await chatRepo({ intents: { a: ASKING } });
    try {
      asked(r.root);
      const first = submitRequest(r.root, { ...by, kind: "answer", slug: "a", text: "Archive them." });
      const second = submitRequest(r.root, { ...by, by: "u2", byName: "Bob", kind: "answer", slug: "a", text: "Leave them out." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(await apply(r.root)).toBe(2);
      expect(requestState(r.root, first.id)).toMatchObject({ ok: true });
      expect(requestState(r.root, second.id)).toMatchObject({ ok: false, text: "a has no question waiting; nothing changed." });
      expect(await lastCommit(r.root)).toContain("loopstra(a): question answered by John from the dashboard");
      const record = readFileSync(join(r.root, "intent", "a", "conversation.md"), "utf8");
      expect(record).toContain("John (the dashboard) answers\nArchive them.\n");
      expect(record).not.toContain("Leave them out.");
      expect(readQuestion(r.root, "a")!.open!.answer).toMatchObject({ text: "Archive them.", by: "John" });
      expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

  test("two send backs whose commits both failed: the first lands on the next pass, the second moved on, and the kept note stays the first's", async () => {
    const r = await chatRepo({ intents: { a: INTENT("plan-review", "x") }, config: PEOPLE });
    try {
      const first = submitRequest(r.root, { ...by, kind: "send-back", slug: "a", expect: "plan-review", note: "Split step 3." });
      const second = submitRequest(r.root, { ...by, by: "u2", byName: "Bob", kind: "send-back", slug: "a", expect: "plan-review", note: "Drop step 4." });
      lockMain(r.root);
      expect(await apply(r.root)).toBe(0);
      rmSync(join(r.root, ".git", "refs", "heads", "main.lock"));
      expect(await apply(r.root)).toBe(2);
      expect(requestState(r.root, first.id)).toMatchObject({ ok: true, status: "spec-approved" });
      expect(requestState(r.root, second.id)).toMatchObject({ ok: false, text: "a moved on to spec-approved; nothing changed." });
      expect((await readIntent(r.root, "a")).file.frontmatter.note).toBe("Sent back by John from the dashboard: Split step 3.");
      expect(readFileSync(join(r.root, ".loopstra", "runs", "a", "sent-back.md"), "utf8")).toBe("Split step 3.");
      const record = readFileSync(join(r.root, "intent", "a", "conversation.md"), "utf8");
      expect(record).toContain("Split step 3.");
      expect(record).not.toContain("Drop step 4.");
      expect((await run(["git", "status", "--short"], r.root)).out.trim()).toBe("");
    } finally {
      r.cleanup();
    }
  }, 60_000);

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
      // Read the way chat reads it: the console never takes it.
      expect(requestState(r.root, chat.id)).toBeNull();
      expect(takeResults(r.root, new Set(["slack"])).find((x) => x.id === chat.id)).toMatchObject({ ok: true, text: "Started c. I will say here when it needs anyone, and when it is done." });
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
      lockMain(r.root);
      // macOS's file events start a moment after the watch does: one sooner may never be reported.
      await Bun.sleep(500);
      submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      await until(() => (applyingRequests(r.root)[0]?.tries ?? 0) >= 1, 10_000);
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

  test("a pass asked for while the tick packs the repository waits until it is done", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const trace = Trace.open(r.root, () => {});
    try {
      const cfg = await loadConfig(r.root);
      let done!: () => void;
      const packing = betweenPasses(r.root, () => new Promise<string>((resolve) => { done = () => resolve("packed"); }));
      const q = submitRequest(r.root, { ...by, kind: "hold", slug: "a", expect: "building", reason: "wait" });
      const pass = applyRequests(r.root, cfg, trace);
      await Bun.sleep(300);
      expect(requestState(r.root, q.id)).toEqual({ state: "pending" });
      // Not even claimed: the pass has not started.
      expect(applyingRequests(r.root)).toEqual([]);
      done();
      expect(await packing).toBe("packed");
      expect(await pass).toBe(1);
      expect((await readIntent(r.root, "a")).file.frontmatter.hold).not.toBe("");
    } finally {
      trace.close();
      r.cleanup();
    }
  });
});
