import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator } from "../../src/chat/orchestrator";
import { pendingRequests, takeResults } from "../../src/chat/requests";
import { ChatService, type Transport } from "../../src/chat/service";
import { Git } from "../../src/git";
import { readIntent, writeIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { Trace } from "../../src/trace";
import { chatRepo, draft, INTENT, message, sink, turn } from "../chat-helpers";
import { lastCommit, run } from "../helpers";

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
      await writeIntent(other, { status: "closed" });
      await new Git(r.root).commitAll("person closes other");
      // The loop's own step for the accepted intent fails without a design fixture; that is not under test.
      await tick(r.root).catch(() => {});
      const csv = await readIntent(r.root, "csv-export");
      expect(["accepted", "designing", "spec-approved", "blocked"]).toContain(csv.file.frontmatter.status);
      const log = (await new Git(r.root).run(["log", "--format=%s"])).out;
      expect(log).toContain("loopstra(csv-export): accepted by Ana from chat [skip ci]");
      expect((await readIntent(r.root, "other")).file.frontmatter.status).toBe("closed");
      const results = takeResults(r.root, new Set(["terminal"]));
      expect(results.map((x) => x.text)).toEqual([
        "Started csv-export. I will say here when it needs anyone, and when it is done.",
        "I did not start other: it is closed now, not a draft, so someone already changed it.",
      ]);
      const trace = Trace.open(r.root);
      try {
        const change = trace.events("csv-export").find((e) => e.type === "status_change");
        expect(JSON.parse(change!.payload)).toEqual({ from: "draft", to: "accepted", note: "accepted by Ana from chat" });
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });

  test("results for another process's transport are left for it", async () => {
    const r = await chatRepo({ intents: { a: INTENT("draft") } });
    try {
      const { submitRequest } = await import("../../src/chat/requests");
      submitRequest(r.root, { kind: "accept", slug: "a", by: "u", byName: "U", transport: "slack", thread: "C1:1.0" });
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
