import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnnouncementLog, announce, holdAnnouncerLock } from "../../src/chat/announcer";
import { ChatService, type Transport } from "../../src/chat/service";
import { writeJson } from "../../src/fsutil";
import { chatDir } from "../../src/chat/threads";
import { readIntent } from "../../src/intents";
import { chatRepo, INTENT } from "../chat-helpers";
import { tempDir, writeIntentOnDisk } from "../helpers";
import { Trace } from "../../src/trace";

function bot(name: string, from: "now" | "kept"): Transport & { announced: string[] } {
  const announced: string[] = [];
  return { name, via: name, announceFrom: from, announced, start: async () => {}, stop: async () => {}, send: async () => {}, announce: async (t) => { announced.push(t); } };
}

describe("announcements", () => {
  test("each new attention item once, merges and finished changes, never the same again", async () => {
    const r = await chatRepo({ intents: { stuck: "---\nstatus: blocked\nnote: The tests failed three times. When that is sorted out, set status to plan-approved.\n---\n# Intent: stuck one\n\n## Problem\nP\n", going: INTENT("reviewing", "going one") } });
    try {
      const log = new AnnouncementLog(r.root);
      const first = await announce(r.root, log);
      expect(first.map((a) => a.text)).toEqual(["Blocked: stuck one. The tests failed three times. When that is sorted out, set status to plan-approved."]);
      expect(await announce(r.root, log)).toEqual([]);
      // going merges, then is done; a draft appears and waits for a person.
      const going = await readIntent(r.root, "going");
      await writeIntentOnDisk(going, { status: "merged" });
      mkdirSync(join(r.root, "intent", "new-one"), { recursive: true });
      await Bun.write(join(r.root, "intent", "new-one", "intent.md"), INTENT("draft", "new one"));
      const second = (await announce(r.root, log)).map((a) => a.text);
      expect(second).toContain("Merged: going one. It is in the main code now.");
      expect(second.some((t) => t.startsWith("Waiting for you: new one."))).toBe(true);
      await writeIntentOnDisk(going, { status: "done" });
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual(["Done: going one. It is finished and checked."]);
      // An item that goes away and comes back is news again.
      const stuck = await readIntent(r.root, "stuck");
      await writeIntentOnDisk(stuck, { status: "closed" });
      expect(await announce(r.root, log)).toEqual([]);
      await writeIntentOnDisk(stuck, { status: "blocked" });
      expect((await announce(r.root, log)).map((a) => a.slug)).toEqual(["stuck"]);
      expect(log.all().map((a) => a.id)).toEqual(log.all().map((_, i) => i + 1));
    } finally { r.cleanup(); }
  });

  test("a change blocked after it merged, then tried again, is not announced as merged a second time", async () => {
    const r = await chatRepo({ intents: { going: INTENT("reviewing", "going one") } });
    try {
      const log = new AnnouncementLog(r.root);
      await announce(r.root, log);
      const going = await readIntent(r.root, "going");
      await writeIntentOnDisk(going, { status: "merged" });
      await announce(r.root, log);
      await writeIntentOnDisk(going, { status: "verifying" });
      await announce(r.root, log);
      // The done-check blocks it; its code stays in main (resume_from says so), and a person retries.
      await writeIntentOnDisk(going, { status: "blocked", resume_from: "merged", note: "Not done yet. When that is sorted out, set status to merged." });
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual(["Blocked: going one. Not done yet. When that is sorted out, set status to merged."]);
      await writeIntentOnDisk(going, { status: "verifying", note: "" });
      expect(await announce(r.root, log)).toEqual([]);
      expect(log.all().filter((a) => a.text.startsWith("Merged:"))).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test("a red main is announced once while it lasts, though its time since the check changes", async () => {
    const r = await chatRepo({ intents: { going: INTENT("reviewing", "going one") } });
    const trace = Trace.open(r.root, () => {});
    try {
      const log = new AnnouncementLog(r.root);
      await announce(r.root, log);
      trace.signal("main_health", "pass", "ok");
      trace.signal("main_health", "fail", "1 test failed");
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual([expect.stringContaining("Main branch: Main branch. The tests on main are failing (checked ")]);
      await Bun.sleep(1100); // "checked 0s ago" becomes "1s ago"
      expect(await announce(r.root, log)).toEqual([]);
      // Gone, then back: news again.
      trace.signal("main_health", "pass", "ok");
      expect(await announce(r.root, log)).toEqual([]);
      trace.signal("main_health", "fail", "1 test failed");
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual([expect.stringContaining("The tests on main are failing")]);
    } finally { trace.close(); r.cleanup(); }
  });

  test("only the lock holder writes; a dead holder's lock is taken over", () => {
    const t = tempDir();
    try {
      expect(holdAnnouncerLock(t.path, process.pid)).toBe(true);
      // Another live process (this one's parent stands in) cannot take it.
      expect(holdAnnouncerLock(t.path, process.ppid)).toBe(false);
      // A holder whose process is gone loses it.
      writeJson(join(chatDir(t.path), "announcer.lock"), { pid: 2 ** 22 + 12345, at: new Date().toISOString() });
      expect(holdAnnouncerLock(t.path, process.ppid)).toBe(true);
      // So does one that stopped polling.
      writeJson(join(chatDir(t.path), "announcer.lock"), { pid: process.ppid, at: new Date(Date.now() - 10 * 60_000).toISOString() });
      expect(holdAnnouncerLock(t.path, process.pid)).toBe(true);
    } finally { t.cleanup(); }
  });

  test("bots post new announcements once, across restarts; open-only surfaces start from now", async () => {
    const r = await chatRepo();
    try {
      const log = new AnnouncementLog(r.root);
      log.append("old news", null);
      const slack = bot("slack", "kept");
      const term = bot("terminal", "now");
      const s1 = new ChatService(r.root, [slack, term], { announce: false, pollMs: 60_000 });
      await s1.start();
      await s1.stop();
      expect(slack.announced).toEqual([]);
      log.append("first", null);
      log.append("second", null);
      const s2 = new ChatService(r.root, [slack], { announce: false, pollMs: 60_000 });
      await s2.start();
      await s2.poll();
      await s2.poll();
      await s2.stop();
      expect(slack.announced).toEqual(["first", "second"]);
      // A bot that restarts carries on from where it got to.
      log.append("third", null);
      const again = bot("slack", "kept");
      const s3 = new ChatService(r.root, [again, term], { announce: false, pollMs: 60_000 });
      await s3.start();
      await s3.poll();
      await s3.stop();
      expect(again.announced).toEqual(["third"]);
      expect(term.announced).toEqual([]);
    } finally { r.cleanup(); }
  });
});

describe("announcements that fail to post (Copilot review)", () => {
  test("are tried again next poll, in order, and the kept cursor only moves past what was posted", async () => {
    const r = await chatRepo();
    try {
      const log = new AnnouncementLog(r.root);
      const posted: string[] = [];
      let down = true;
      const flaky: Transport = {
        name: "slack", via: "Slack", announceFrom: "kept", start: async () => {}, stop: async () => {}, send: async () => {},
        announce: async (t) => { if (down && t === "second") throw new Error("Slack is down"); posted.push(t); },
      };
      const s = new ChatService(r.root, [flaky], { announce: false, pollMs: 60_000 });
      await s.start();
      log.append("first", null);
      log.append("second", null);
      log.append("third", null);
      await s.poll();
      expect(posted).toEqual(["first"]);
      down = false;
      await s.poll();
      await s.stop();
      expect(posted).toEqual(["first", "second", "third"]);
    } finally { r.cleanup(); }
  });
});

describe("the announcer's state (hardening review)", () => {
  test("what was seen is written before it is announced: a kill between the two loses that batch, never repeats everything", async () => {
    const r = await chatRepo({ intents: { stuck: "---\nstatus: blocked\nnote: The tests failed. When that is sorted out, set status to plan-approved.\n---\n# Intent: stuck one\n\n## Problem\nP\n" } });
    try {
      const log = new AnnouncementLog(r.root);
      // A process killed as it posts: the log never gets the line.
      const killed = new AnnouncementLog(r.root);
      killed.append = () => { throw new Error("killed before the post"); };
      await expect(announce(r.root, killed)).rejects.toThrow("killed before the post");
      expect(log.all()).toEqual([]);
      expect(existsSync(join(chatDir(r.root), "announcer.json"))).toBe(true);
      // The next poll has nothing new: that one batch is lost, nothing is announced twice.
      expect(await announce(r.root, log)).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("a damaged announcer.json is moved aside and a fresh one starts, not read as empty and written over", async () => {
    const r = await chatRepo({ intents: { going: INTENT("reviewing", "going one") } });
    try {
      const log = new AnnouncementLog(r.root);
      await announce(r.root, log);
      const path = join(chatDir(r.root), "announcer.json");
      writeFileSync(path, "{ not json");
      await announce(r.root, log);
      expect(readdirSync(chatDir(r.root)).filter((n) => n.startsWith("announcer.json.bad-"))).toHaveLength(1);
      // A fresh state: the first poll after it compares nothing, so a merge noticed then is not news.
      const going = await readIntent(r.root, "going");
      await writeIntentOnDisk(going, { status: "merged" });
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual(["Merged: going one. It is in the main code now."]);
    } finally { r.cleanup(); }
  });
});

describe("the full review of #47", () => {
  test("a change named constructor that appears done is not news, as any other new change", async () => {
    const r = await chatRepo({ intents: { going: INTENT("reviewing", "going one") } });
    try {
      const log = new AnnouncementLog(r.root);
      await announce(r.root, log);
      mkdirSync(join(r.root, "intent", "constructor"), { recursive: true });
      await Bun.write(join(r.root, "intent", "constructor", "intent.md"), INTENT("done", "built in"));
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("a bot's cursor file that cannot be read is said in the trace and left, not silently started again", async () => {
    const r = await chatRepo();
    try {
      const log = new AnnouncementLog(r.root);
      log.append("old news", null);
      const path = join(chatDir(r.root), "announced-slack.json");
      writeFileSync(path, '{"id":"7"}');
      const slack = bot("slack", "kept");
      const s = new ChatService(r.root, [slack], { announce: false, pollMs: 60_000 });
      await s.start();
      await s.poll();
      await s.stop();
      // From the end of the log, so nothing is posted twice; the file is a person's to look at.
      expect(slack.announced).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe('{"id":"7"}');
      const trace = Trace.open(r.root);
      try {
        expect(trace.events("_chat").filter((e) => e.type === "error").map((e) => e.payload).join("\n")).toContain("announced-slack.json");
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });
});

describe("cleanup after the full review", () => {
  test("a failure that lasts over several polls is traced once, not once per poll", async () => {
    const r = await chatRepo();
    try {
      const slack = bot("slack", "now");
      slack.announce = async () => { throw new Error("Slack is unreachable"); };
      const s = new ChatService(r.root, [slack], { announce: false, pollMs: 60_000 });
      await s.start();
      // After the start, so every poll tries to post it.
      new AnnouncementLog(r.root).append("news", null);
      for (let i = 0; i < 4; i++) await s.poll();
      await s.stop();
      const trace = Trace.open(r.root);
      try {
        const errors = trace.events("_chat").filter((e) => e.type === "error" && e.payload.includes('"where":"announce-slack"'));
        expect(errors.map((e) => JSON.parse(e.payload) as unknown)).toEqual([{ where: "announce-slack", error: "Slack is unreachable" }]);
      } finally { trace.close(); }
    } finally { r.cleanup(); }
  });
});
