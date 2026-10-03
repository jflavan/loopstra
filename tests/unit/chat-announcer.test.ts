import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AnnouncementLog, announce, holdAnnouncerLock } from "../../src/chat/announcer";
import { ChatService, type Transport } from "../../src/chat/service";
import { chatDir, writeJson } from "../../src/chat/threads";
import { readIntent, writeIntent } from "../../src/intents";
import { chatRepo, INTENT } from "../chat-helpers";
import { tempDir } from "../helpers";

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
      await writeIntent(going, { status: "merged" });
      mkdirSync(join(r.root, "intent", "new-one"), { recursive: true });
      await Bun.write(join(r.root, "intent", "new-one", "intent.md"), INTENT("draft", "new one"));
      const second = (await announce(r.root, log)).map((a) => a.text);
      expect(second).toContain("Merged: going one. It is in the main code now.");
      expect(second.some((t) => t.startsWith("Waiting for you: new one."))).toBe(true);
      await writeIntent(going, { status: "done" });
      expect((await announce(r.root, log)).map((a) => a.text)).toEqual(["Done: going one. It is finished and checked."]);
      // An item that goes away and comes back is news again.
      const stuck = await readIntent(r.root, "stuck");
      await writeIntent(stuck, { status: "closed" });
      expect(await announce(r.root, log)).toEqual([]);
      await writeIntent(stuck, { status: "blocked" });
      expect((await announce(r.root, log)).map((a) => a.slug)).toEqual(["stuck"]);
      expect(log.all().map((a) => a.id)).toEqual(log.all().map((_, i) => i + 1));
    } finally { r.cleanup(); }
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
