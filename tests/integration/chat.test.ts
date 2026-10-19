import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../../src/chat/orchestrator";
import { commitRecord } from "../../src/context";
import { pendingRequests, requestsDir, submitRequest, takeResults } from "../../src/requests";
import { ChatService, type OnMessage, type Transport } from "../../src/chat/service";
import { fetchJson } from "../../src/chat/transports/shared";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { requestStop, resetStop } from "../../src/stop";
import { Trace } from "../../src/trace";
import { chatRepo, draft, INTENT, message, sink, turn } from "../chat-helpers";
import { lastCommit, run, writeIntentOnDisk } from "../helpers";

const HANDOFF = { title: "CSV export", brief: "Readers export a report as CSV.", updates: [] };

/** A transport that only records what it is asked to send. */
function recorder(name = "terminal"): Transport & { sent: Array<[string, string]>; announced: string[] } {
  const sent: Array<[string, string]> = [];
  const announced: string[] = [];
  return {
    name, via: name, announceFrom: "now", sent, announced,
    start: async () => {}, stop: async () => {},
    send: async (thread, text) => { sent.push([thread, text]); },
    announce: async (text) => { announced.push(text); },
  };
}

describe("chat with the loop", () => {
  test("no remote: a confirmed hand-off is written, the loop adds the drafts, and chat says so", async () => {
    const r = await chatRepo({ intents: { auth: INTENT("merged") } });
    try {
      await r.answer("orchestrator", 1, turn("Agreed.", { handoff: HANDOFF }));
      await r.answer("write-intent", 1, { status: "success", summary: "Adds CSV export.", intents: [draft("csv-export", { depends_on: ["auth"] }), draft("csv-dates", { depends_on: ["csv-export"] })] });
      const o = new Orchestrator(r.root);
      const out = sink();
      await o.handle(message("let's write it up"), out.send);
      await o.handle(message("yes"), out.send);
      expect(out.sent.slice(-2)).toEqual(["Writing it up now. This can take a few minutes.", expect.stringContaining("Wrote csv-export, csv-dates. The loop is not running right now, so it adds them to the queue as drafts once someone runs loopstra start.")]);
      // Chat wrote nothing into the main checkout: only a request for the loop.
      expect(existsSync(join(r.root, "intent", "csv-export"))).toBe(false);
      expect(await new Git(r.root).isDirty()).toBe(false);
      expect(pendingRequests(r.root).map((q) => q.kind)).toEqual(["new"]);
      expect(o.store.get("terminal", "local").handoffs).toMatchObject([{ title: "CSV export", slugs: ["csv-export", "csv-dates"], pr: null, local: true, by: "Ana" }]);

      await tick(r.root);
      expect(pendingRequests(r.root)).toEqual([]);
      const added = await readIntent(r.root, "csv-dates");
      expect(added.file.frontmatter).toMatchObject({ status: "draft", depends_on: ["csv-export"], author: "Ana" });
      expect((await new Git(r.root).run(["log", "--format=%s", "-3"])).out).toContain("loopstra(csv-export): open intent from chat [skip ci]");
      // Only the generated queue is left unsaved, as after any tick.
      expect((await new Git(r.root).run(["status", "--porcelain"])).out.trim()).toBe("?? intent/queue.md");

      // The loop's result goes back to the thread it came from, once.
      const t = recorder();
      const service = new ChatService(r.root, [t], { announce: false });
      await service.poll();
      expect(t.sent).toEqual([["local", "Added to the queue as drafts: csv-export, csv-dates. Read them in intent/, then set status to accepted, or ask me to start one."]]);
      await service.poll();
      expect(t.sent.length).toBe(1);
      expect(o.store.get("terminal", "local").messages.at(-1)!.text).toContain("Added to the queue as drafts");
      // The agent hears of the yes and of the loop's answer on its next turn.
      expect(o.store.get("terminal", "local").since).toEqual([
        'Ana said yes: "CSV export" was written up as csv-export, csv-dates, and the loop was asked to add it to the queue.',
        "The loop answered: Added to the queue as drafts: csv-export, csv-dates. Read them in intent/, then set status to accepted, or ask me to start one.",
      ]);
    } finally { r.cleanup(); }
  });

  test("accept from chat: the loop starts the draft, commits it, and a person's edit meanwhile wins", async () => {
    const r = await chatRepo({ intents: { "csv-export": INTENT("draft"), other: INTENT("draft") } });
    try {
      await r.answer("orchestrator", 1, turn("OK.", { accept: { slug: "csv-export" } }));
      await r.answer("orchestrator", 2, turn("OK.", { accept: { slug: "other" } }));
      const o = new Orchestrator(r.root);
      const out = sink();
      await o.handle(message("start csv-export"), out.send);
      await o.handle(message("yes"), out.send);
      await o.handle(message("start other"), out.send);
      await o.handle(message("yes"), out.send);
      // A person closes "other" before the loop gets to the request.
      const other = await readIntent(r.root, "other");
      await writeIntentOnDisk(other, { status: "closed" });
      await new Git(r.root).commitAll("person closes other");
      // The loop's own step for the accepted intent fails without a design fixture; that is not under test.
      await tick(r.root).catch(() => {});
      const csv = await readIntent(r.root, "csv-export");
      expect(["accepted", "designing", "spec-approved", "blocked"]).toContain(csv.file.frontmatter.status);
      const log = (await new Git(r.root).run(["log", "--format=%s"])).out;
      expect(log).toContain("loopstra(csv-export): accepted by Ana from the terminal [skip ci]");
      expect((await readIntent(r.root, "other")).file.frontmatter.status).toBe("closed");
      const results = takeResults(r.root, new Set(["terminal"]));
      expect(results.map((x) => x.text)).toEqual([
        "Started csv-export. I will say here when it needs anyone, and when it is done.",
        "I did not start other: it is closed now, not a draft, so someone already changed it.",
      ]);
      const trace = Trace.open(r.root);
      try {
        const change = trace.events("csv-export").find((e) => e.type === "status_change");
        expect(JSON.parse(change!.payload)).toEqual({ from: "draft", to: "accepted", note: "accepted by Ana from the terminal" });
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });

  test("requests whose records landed before the loop was killed are finished on the next tick as applied, never written again", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft"), b: INTENT("draft") } });
    try {
      const { writeJson } = await import("../../src/fsutil");
      const accept = submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", via: "the terminal", transport: "terminal", thread: "local" });
      const added = submitRequest(r.root, { kind: "new", title: "t", intents: [{ slug: "c", text: INTENT("draft", "c"), update: false }], by: "u", byName: "U", via: "the terminal", transport: "terminal", thread: "local" });
      // As if the loop was killed after an earlier tick committed both records, each with its request's id.
      await commitRecord(r.root, "main", "a", "accepted by U from the terminal", async (d) => { await writeIntent(await readIntent(r.root, "a"), { status: "accepted" }, {}, d); }, { request: accept.id });
      await commitRecord(r.root, "main", "c", "open intent from chat", async (d) => { d.write("intent/c/intent.md", INTENT("draft", "c")); }, { request: added.id });
      // Claimed by an older loop, which kept what it wrote to put it back: those keys are read past.
      writeJson(join(requestsDir(r.root), "applying", `${accept.id}.json`), { ...accept, written: ["a"], writtenHash: { a: "0".repeat(64) } });
      writeJson(join(requestsDir(r.root), "applying", `${added.id}.json`), { ...added, written: ["c"], writtenHash: { c: "0".repeat(64) }, recordHash: "0".repeat(64) });
      rmSync(join(requestsDir(r.root), `${accept.id}.json`));
      rmSync(join(requestsDir(r.root), `${added.id}.json`));
      await tick(r.root).catch(() => {});
      expect(takeResults(r.root, new Set(["terminal"])).map((x) => x.text)).toEqual([
        "Started a. I will say here when it needs anyone, and when it is done.",
        "Added to the queue as drafts: c. Read them in intent/, then set status to accepted, or ask me to start one.",
      ]);
      const log = (await new Git(r.root).run(["log", "--format=%s"])).out.split("\n");
      expect(log.filter((l) => l.includes("loopstra(a): accepted by U from the terminal"))).toHaveLength(1);
      expect(log.filter((l) => l.includes("loopstra(c): open intent from chat"))).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test("stopping chat waits for a turn in progress, so its session ends interrupted rather than left running", async () => {
    const r = await chatRepo();
    // The orchestrator's session holds until a file that never appears exists.
    const lines = [
      { type: "system", subtype: "init", session_id: "s", cwd: "/", tools: [], model: "fake" },
      { type: "fake_action", wait_for: join(r.root, "never") },
      { type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0.01, usage: {}, structured_output: turn("Hi."), result: "ok" },
    ];
    await Bun.write(join(process.env.LOOPSTRA_FAKE_FIXTURE_DIR!, "orchestrator-1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const terminal = recorder();
    let onMessage: OnMessage | null = null;
    terminal.start = async (fn) => { onMessage = fn; };
    const service = new ChatService(r.root, [terminal], { announce: false, pollMs: 60_000 });
    const trace = Trace.open(r.root, () => {});
    try {
      await service.start();
      const { transport: _t, via: _v, ...m } = message("hello");
      void onMessage!(m);
      const end = Date.now() + 10_000;
      while (!trace.phases("_chat").some((p) => p.status === "running")) {
        if (Date.now() > end) throw new Error("the session did not start");
        await Bun.sleep(20);
      }
      requestStop();
      await service.stop();
      expect(trace.phases("_chat").map((p) => p.status)).toEqual(["interrupted"]);
    } finally {
      resetStop();
      trace.close();
      // A session left waiting (the test failed) ends, so the folder can be removed.
      await Bun.write(join(r.root, "never"), "");
      await service.stop();
      r.cleanup();
    }
  }, 30_000);

  test("a result whose delivery fails is kept for the next poll, and the thread sees it once", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft") } });
    try {
      submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", via: "the terminal", transport: "terminal", thread: "local" });
      await tick(r.root).catch(() => {});
      const t = recorder();
      let down = true;
      t.send = async (thread, text) => { if (down) throw new Error("the terminal is gone"); t.sent.push([thread, text]); };
      const service = new ChatService(r.root, [t], { announce: false, pollMs: 60_000 });
      await service.poll();
      expect(t.sent).toEqual([]);
      down = false;
      await service.poll();
      const started = "Started a. I will say here when it needs anyone, and when it is done.";
      expect(t.sent).toEqual([["local", started]]);
      await service.poll();
      expect(t.sent).toHaveLength(1);
      // The failed try left nothing in the thread: the message and the agent's line are there once.
      const thread = service.orchestrator.store.get("terminal", "local");
      expect(thread.messages.map((m) => m.text)).toEqual([started]);
      expect(thread.since).toEqual([`The loop answered: ${started}`]);
      expect(takeResults(r.root, new Set(["terminal"]))).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("a result that can never be posted (a thread gone) is traced once, and given up after the wait, not tried for ever", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft") } });
    try {
      submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", via: "the terminal", transport: "terminal", thread: "local" });
      await tick(r.root).catch(() => {});
      const t = recorder();
      t.send = async () => {};
      const never = async () => { throw new Error("channel_not_found"); };
      // Wide enough that the first two polls fall inside it on a slow runner under coverage (200 ms did not).
      const service = new ChatService(r.root, [Object.assign(t, { sendOrThrow: never })], { announce: false, pollMs: 60_000, resultGiveUpMs: 2_000 });
      const results = join(requestsDir(r.root), "results");
      const left = () => (existsSync(results) ? readdirSync(results).filter((n) => n.endsWith(".json")).length : 0);
      await service.poll();
      await service.poll();
      expect(left()).toBe(1);
      await Bun.sleep(2_100);
      await service.poll();
      expect(left()).toBe(0);
      await service.poll();
      const trace = Trace.open(r.root);
      try {
        const errors = trace.events("_chat").filter((e) => e.type === "error" && e.payload.includes("chat-result"));
        expect(errors).toHaveLength(2);
        expect(errors[1]!.payload).toContain("gave up");
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });

  test("a bot whose replies never throw still keeps a result it could not post: results go through sendOrThrow", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft") } });
    try {
      submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", via: "the terminal", transport: "terminal", thread: "local" });
      await tick(r.root).catch(() => {});
      const t = recorder();
      let down = true;
      // Like Slack's and Discord's: a reply's failure is logged, never thrown; the must-arrive variant throws.
      t.send = async () => {};
      const sure = async (thread: string, text: string) => { if (down) throw new Error("Slack is unreachable"); t.sent.push([thread, text]); };
      const service = new ChatService(r.root, [Object.assign(t, { sendOrThrow: sure })], { announce: false, pollMs: 60_000 });
      await service.poll();
      expect(t.sent).toEqual([]);
      down = false;
      await service.poll();
      expect(t.sent).toEqual([["local", "Started a. I will say here when it needs anyone, and when it is done."]]);
      expect(takeResults(r.root, new Set(["terminal"]))).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("results for another process's transport are left for it", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft") } });
    try {
      submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", via: "Slack", transport: "slack", thread: "C1:1.0" });
      await tick(r.root).catch(() => {});
      expect(takeResults(r.root, new Set(["terminal", "dashboard"]))).toEqual([]);
      expect(takeResults(r.root, new Set(["slack"])).map((x) => x.thread)).toEqual(["C1:1.0"]);
    } finally { r.cleanup(); }
  });

  test("with a remote: the intents go up as a pull request from a throwaway checkout, and its merge is told to the thread", async () => {
    const r = await chatRepo({ remote: true, intents: { auth: INTENT("merged") } });
    try {
      await run(["git", "push", "-q", "origin", "main"], r.root);
      await r.answer("orchestrator", 1, turn("Agreed.", { handoff: HANDOFF }));
      await r.answer("write-intent", 1, { status: "success", summary: "Adds CSV export.", intents: [draft("csv-export", { depends_on: ["auth"] })] });
      const o = new Orchestrator(r.root);
      const out = sink();
      await o.handle(message("write it up"), out.send);
      expect(out.sent.at(-1)).toContain("Shall I write this up as a pull request?");
      const before = await lastCommit(r.root);
      await o.handle(message("yes"), out.send);
      expect(out.sent.at(-1)).toBe("Opened a pull request with csv-export: https://example.test/pr/1\nOnce it is merged they are drafts in the queue; ask me to start one when you are ready.");
      // The main checkout and its branch are untouched; no throwaway checkout is left behind.
      expect(await lastCommit(r.root)).toBe(before);
      expect(await new Git(r.root).isDirty()).toBe(false);
      expect(existsSync(join(r.root, "intent", "csv-export"))).toBe(false);
      expect((await new Git(r.root).run(["worktree", "list"])).out.trim().split("\n").length).toBe(1);
      // The branch is on the remote with the intent, and the pull request says what it is.
      const show = await run(["git", "show", "intent-proposal/csv-export:intent/csv-export/intent.md"], r.remote!);
      expect(show.out).toContain("status: draft");
      expect((await run(["git", "log", "-1", "--format=%s", "intent-proposal/csv-export"], r.remote!)).out.trim()).toBe("intent(csv-export): propose Do csv-export");
      const pr = (await r.ghState()).prs["intent-proposal/csv-export"]!;
      expect(pr.title).toBe("CSV export");
      expect(pr.body).toContain("Adds CSV export.");
      expect(pr.body).toContain("- `csv-export`: Do csv-export");
      expect(pr.body).toContain("## Agreed brief\n\nReaders export a report as CSV.");
      expect(o.store.get("terminal", "local").handoffs[0]!.pr).toEqual({ number: 1, url: "https://example.test/pr/1", branch: "intent-proposal/csv-export", state: "OPEN" });

      // A second proposal with the same first slug gets its own branch.
      await r.answer("orchestrator", 2, turn("Again.", { handoff: HANDOFF }));
      await r.answer("write-intent", 2, { status: "success", summary: "s", intents: [draft("csv-export")] });
      await o.handle(message("again"), out.send);
      await o.handle(message("yes"), out.send);
      expect(Object.keys((await r.ghState()).prs).sort()).toEqual(["intent-proposal/csv-export", "intent-proposal/csv-export-2"]);

      // GitHub merges the first; the service notices and tells the thread once.
      const merge = Bun.spawn({ cmd: [process.execPath, process.env.LOOPSTRA_GH_EXECUTABLE!, "pr", "merge", "1", "--squash"], cwd: r.root, env: { ...process.env }, stdout: "ignore", stderr: "ignore" });
      expect(await merge.exited).toBe(0);
      const t = recorder();
      const service = new ChatService(r.root, [t], { announce: false });
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(t.sent).toEqual([["local", 'The pull request for "CSV export" was merged, so csv-export is in the queue as a draft. Ask me to start it when you are ready.']]);
      expect(o.store.get("terminal", "local").handoffs.map((h) => h.pr!.state)).toEqual(["MERGED", "OPEN"]);
      // The loop's next sync brings the draft into the main checkout.
      await tick(r.root);
      expect((await readIntent(r.root, "csv-export")).file.frontmatter.status).toBe("draft");
    } finally { r.cleanup(); }
  });

  test("with a remote: a branch that went up without its pull request is named, not reported as nothing opened", async () => {
    const r = await chatRepo({ remote: true });
    try {
      await r.answer("orchestrator", 1, turn("Agreed.", { handoff: HANDOFF }));
      await r.answer("write-intent", 1, { status: "success", summary: "s", intents: [draft("csv-export")] });
      const o = new Orchestrator(r.root);
      const out = sink();
      await o.handle(message("write it"), out.send);
      // gh is gone by the time the pull request is opened.
      process.env.LOOPSTRA_GH_EXECUTABLE = join(r.root, "no-such-gh");
      await o.handle(message("yes"), out.send);
      expect(out.sent.at(-1)).toMatch(/^I could not write that up: The intents were pushed to the branch intent-proposal\/csv-export, but the pull request could not be opened .*An engineer can open it from that branch, or delete the branch\.$/);
      expect(out.sent.at(-1)).not.toContain("Nothing was opened");
      expect((await run(["git", "branch", "--list", "intent-proposal/*"], r.remote!)).out.trim()).toBe("intent-proposal/csv-export");
    } finally { r.cleanup(); }
  });

  test("with a remote: a writer that fails twice opens nothing", async () => {
    const r = await chatRepo({ remote: true });
    try {
      await r.answer("orchestrator", 1, turn("Agreed.", { handoff: HANDOFF }));
      await r.answer("write-intent", 1, { status: "success", summary: "s", intents: [draft("BAD")] });
      await r.answer("write-intent", 2, { status: "success", summary: "s", intents: [draft("BAD")] });
      const o = new Orchestrator(r.root);
      const out = sink();
      await o.handle(message("write it"), out.send);
      await o.handle(message("yes"), out.send);
      expect(out.sent.at(-1)).toMatch(/^I could not write that up: What the writer returned had problems twice: "BAD" is not a valid slug.* Nothing was opened\.$/);
      expect((await r.ghState()).prs).toEqual({});
      expect((await run(["git", "branch", "--list", "intent-proposal/*"], r.remote!)).out.trim()).toBe("");
      expect(o.store.get("terminal", "local").handoffs).toEqual([]);
    } finally { r.cleanup(); }
  });
});

describe("the full review of #47", () => {
  const STARTED = "Started a. I will say here when it needs anyone, and when it is done.";
  /** A repository with one result waiting for the terminal's thread "local". */
  async function withResult() {
    const r = await chatRepo({ intents: { a: INTENT("draft") } });
    submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", via: "the terminal", transport: "terminal", thread: "local" });
    await tick(r.root).catch(() => {});
    return r;
  }
  const resultFiles = (root: string) => {
    const dir = join(requestsDir(root), "results");
    return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
  };

  test("a result posted whose thread cannot be saved is posted once, not on every poll", async () => {
    const r = await withResult();
    try {
      const t = recorder();
      const service = new ChatService(r.root, [t], { announce: false, pollMs: 60_000 });
      service.orchestrator.store.save = () => { throw new Error("EACCES: permission denied"); };
      await service.poll();
      await service.poll();
      await service.poll();
      expect(t.sent).toEqual([["local", STARTED]]);
      expect(resultFiles(r.root)).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("a result posted whose file cannot be removed is not posted again", async () => {
    const r = await withResult();
    try {
      const t = recorder();
      const service = new ChatService(r.root, [t], { announce: false, pollMs: 60_000 });
      const stuck = spyOn(fs, "rmSync").mockImplementation(() => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); });
      try {
        await service.poll();
        await service.poll();
      } finally { stuck.mockRestore(); }
      expect(resultFiles(r.root)).toHaveLength(1);
      await service.poll();
      expect(t.sent).toEqual([["local", STARTED]]);
      expect(resultFiles(r.root)).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("a result file that is not JSON is removed only by the process whose transport it names", async () => {
    const r = await chatRepo();
    try {
      const dir = join(requestsDir(r.root), "results");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "1-slack.json"), '{"id":"1","transport":"slack","thread":"C1:1.0","te');
      writeFileSync(join(dir, "2-terminal.json"), '{"id":"2","transport":"terminal","thread":"local","te');
      writeFileSync(join(dir, "3-unknown.json"), "{ not json");
      const service = new ChatService(r.root, [recorder()], { announce: false, pollMs: 60_000 });
      await service.poll();
      expect(resultFiles(r.root).sort()).toEqual(["1-slack.json", "3-unknown.json"]);
    } finally { r.cleanup(); }
  });

  test("a call to a bot's API that never answers fails that post, and the next poll goes on", async () => {
    const r = await withResult();
    let answering = false;
    const server = Bun.serve({ port: 0, fetch: () => (answering ? Response.json({ ok: true }) : new Promise<Response>(() => {})) });
    try {
      const t = recorder();
      const posted: string[] = [];
      const sure = async (_thread: string, text: string) => {
        const { json } = await fetchJson(`http://127.0.0.1:${server.port}/post`, { method: "POST", body: text }, () => 1, 200);
        if (json?.ok) posted.push(text);
      };
      const service = new ChatService(r.root, [Object.assign(t, { sendOrThrow: sure })], { announce: false, pollMs: 60_000 });
      const started = Date.now();
      await service.poll();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(posted).toEqual([]);
      answering = true;
      await service.poll();
      expect(posted).toEqual([STARTED]);
    } finally { void server.stop(true); r.cleanup(); }
  });

  /** A thread with one hand-off whose pull request (number 1) GitHub has as `state`. */
  async function handedOff(state: "MERGED" | "CLOSED") {
    const r = await chatRepo({ remote: true });
    await Bun.write(join(r.remote!, "fake-gh.json"), JSON.stringify({ next: 2, prs: { "intent-proposal/csv-export": { number: 1, state, reviewDecision: "", checks: "none", merged: state === "MERGED", comments: [] } } }));
    const o = new Orchestrator(r.root);
    const t = o.store.get("terminal", "local");
    t.handoffs.push({ title: "CSV export", slugs: ["csv-export"], at: new Date().toISOString(), by: "Ana", local: false, pr: { number: 1, url: "https://example.test/pr/1", branch: "intent-proposal/csv-export", state: "OPEN" } });
    o.store.save(t);
    return { r, o };
  }
  const MERGED = 'The pull request for "CSV export" was merged, so csv-export is in the queue as a draft. Ask me to start it when you are ready.';

  test("a merge notice whose post fails is tried again at the next check, and the new state saved only once it is posted", async () => {
    const { r, o } = await handedOff("MERGED");
    try {
      const t = recorder();
      let down = true;
      t.send = async () => {};
      const sure = async (thread: string, text: string) => { if (down) throw new Error("Slack is unreachable"); t.sent.push([thread, text]); };
      const service = new ChatService(r.root, [Object.assign(t, { sendOrThrow: sure })], { announce: false, pollMs: 60_000 });
      await service.checkPullRequests();
      expect(t.sent).toEqual([]);
      expect(o.store.get("terminal", "local").handoffs[0]!.pr!.state).toBe("OPEN");
      down = false;
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(t.sent).toEqual([["local", MERGED]]);
      expect(o.store.get("terminal", "local").handoffs[0]!.pr!.state).toBe("MERGED");
      expect(o.store.get("terminal", "local").messages.map((m) => m.text)).toEqual([MERGED]);
    } finally { r.cleanup(); }
  });

  test("a merge notice that can never be posted is given up after the wait: the state is saved and it is not tried again", async () => {
    const { r, o } = await handedOff("CLOSED");
    try {
      const t = recorder();
      let tries = 0;
      const never = async () => { tries++; throw new Error("channel_not_found"); };
      const service = new ChatService(r.root, [Object.assign(t, { sendOrThrow: never })], { announce: false, pollMs: 60_000, resultGiveUpMs: 2_000 });
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(o.store.get("terminal", "local").handoffs[0]!.pr!.state).toBe("OPEN");
      await Bun.sleep(2_100);
      await service.checkPullRequests();
      expect(o.store.get("terminal", "local").handoffs[0]!.pr!.state).toBe("CLOSED");
      await service.checkPullRequests();
      expect(tries).toBe(3);
      const trace = Trace.open(r.root);
      try {
        const errors = trace.events("_chat").filter((e) => e.type === "error" && e.payload.includes("chat-pr"));
        expect(errors).toHaveLength(2);
        expect(errors[1]!.payload).toContain("gave up");
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });
});
