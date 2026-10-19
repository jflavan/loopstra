import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendConversation, conversationEntry, conversationPath, readConversation, recordedAs, withEntry, withEntryOnce } from "../../src/conversation";
import { writeJson } from "../../src/fsutil";
import { Git } from "../../src/git";
import { lastCommit } from "../helpers";
import { chatRepo, INTENT } from "../chat-helpers";

describe("conversation.md", () => {
  test("entries in the spec's format: a message, a question, an answer, a note for the next session", () => {
    const at = new Date(2026, 9, 17, 14, 2);
    expect(conversationEntry({ kind: "message", who: "John", via: "the dashboard", phase: "build", text: "Use the CSV parser.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) → build\nUse the CSV parser.\n");
    expect(conversationEntry({ kind: "question", phase: "build", text: "Archived too?", why: "The list hides them.", options: ["include them", "leave them out"], at })).toBe("## 2026-10-17 14:02 · build asks\nArchived too?\nWhy: The list hides them.\nOptions: include them · leave them out\n");
    expect(conversationEntry({ kind: "answer", who: "John", via: "Slack", text: "Leave them out.", at })).toBe("## 2026-10-17 14:02 · John (Slack) answers\nLeave them out.\n");
    expect(conversationEntry({ kind: "later", who: "John", via: "the dashboard", text: "Also zero.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) → the next session\nAlso zero.\n");
    expect(conversationEntry({ kind: "redirect", who: "John", via: "the dashboard", phase: "plan", text: "Use two steps.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) redirects plan\nUse two steps.\n");
    expect(conversationEntry({ kind: "sent-back", who: "John", via: "the dashboard", text: "Split step 3.", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) sent it back\nSplit step 3.\n");
    expect(conversationEntry({ kind: "took-back", who: "John", via: "the dashboard", at })).toBe("## 2026-10-17 14:02 · John (the dashboard) took back the send back\nThe note above no longer stands.\n");
  });

  test("appending makes the file with its heading, adds after what is there, and commits it", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      expect(readConversation(r.root, "a")).toBe("");
      await appendConversation(r.root, "main", "a", { kind: "message", who: "John", via: "the dashboard", phase: "build", text: "One.", at: new Date(2026, 9, 17, 9, 0) });
      await appendConversation(r.root, "main", "a", { kind: "answer", who: "Ana", via: "Slack", text: "Two.", at: new Date(2026, 9, 17, 9, 5) });
      expect(readConversation(r.root, "a")).toBe("# Conversation\n\n## 2026-10-17 09:00 · John (the dashboard) → build\nOne.\n\n## 2026-10-17 09:05 · Ana (Slack) answers\nTwo.\n");
      expect(await lastCommit(r.root)).toContain("loopstra(a): conversation");
    } finally {
      r.cleanup();
    }
  });

  test("an inbox message's entry is written once, though another entry follows it, until its text leaves the record", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const m = { kind: "message" as const, who: "John", via: "the dashboard", phase: "build", text: "Cover negatives.", at: new Date(2026, 9, 17, 9, 0) };
      // Its first record wrote it; a later message's commit took it along; then its own record is tried again.
      await appendConversation(r.root, "main", "a", m, { id: "000000000000001-1-0001" });
      await appendConversation(r.root, "main", "a", { ...m, text: "And zero.", at: new Date(2026, 9, 17, 9, 1) }, { id: "000000000000001-1-0002" });
      await appendConversation(r.root, "main", "a", { ...m, at: new Date(2026, 9, 17, 9, 2) }, { id: "000000000000001-1-0001" });
      // Kept for the next session after it reached its session: written once all the same, as what it was.
      await appendConversation(r.root, "main", "a", { kind: "later", who: "John", via: "the dashboard", text: "Cover negatives.", at: new Date(2026, 9, 17, 9, 3) }, { id: "000000000000001-1-0001" });
      expect(readConversation(r.root, "a").match(/Cover negatives/g)).toHaveLength(1);
      expect(recordedAs(r.root, "a", "000000000000001-1-0001", m)).toBe("message");
      // The same words from another message are its own entry.
      await appendConversation(r.root, "main", "a", { ...m, at: new Date(2026, 9, 17, 9, 4) }, { id: "000000000000001-1-0003" });
      expect(readConversation(r.root, "a").match(/Cover negatives/g)).toHaveLength(2);
      // Its text gone from the record (a person took it out): written again.
      await Bun.write(conversationPath(r.root, "a"), "# Conversation\n");
      expect(recordedAs(r.root, "a", "000000000000001-1-0001", m)).toBeNull();
      await appendConversation(r.root, "main", "a", m, { id: "000000000000001-1-0001" });
      expect(readConversation(r.root, "a").match(/Cover negatives/g)).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  });

  test("a message whose words are already in the record, in another entry, is still written when its first commit failed", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const at = new Date(2026, 9, 17, 9, 0);
      await appendConversation(r.root, "main", "a", { kind: "message", who: "John", via: "the dashboard", phase: "build", text: "use bun, ok", at }, { id: "000000000000001-1-0001" });
      // recorded.json names a second message whose entry is not in the record (a person took it out).
      writeJson(join(r.root, ".loopstra", "runs", "a", "recorded.json"), { "000000000000001-1-0001": "message", "000000000000001-1-0002": "message" });
      const m = { who: "Ana", via: "Slack", text: "ok" };
      expect(recordedAs(r.root, "a", "000000000000001-1-0002", m)).toBeNull();
      await appendConversation(r.root, "main", "a", { kind: "message", phase: "build", at, ...m }, { id: "000000000000001-1-0002" });
      expect(readConversation(r.root, "a")).toContain("· Ana (Slack) → build\nok\n");
      // With its entry there it is written no more, whether it is looked for as delivered or as kept for the next session.
      expect(recordedAs(r.root, "a", "000000000000001-1-0002", m)).toBe("message");
      await appendConversation(r.root, "main", "a", { kind: "later", at, ...m }, { id: "000000000000001-1-0002" });
      expect(readConversation(r.root, "a").match(/\nok\n/g)).toHaveLength(1);
      // The same words by someone else, or from somewhere else, are not its entry.
      expect(recordedAs(r.root, "a", "000000000000001-1-0002", { ...m, who: "John" })).toBeNull();
      expect(recordedAs(r.root, "a", "000000000000001-1-0002", { ...m, via: "the dashboard" })).toBeNull();
      // A recorded.json that is not the shape reads as nothing recorded.
      writeJson(join(r.root, ".loopstra", "runs", "a", "recorded.json"), { "000000000000001-1-0002": 7 });
      expect(recordedAs(r.root, "a", "000000000000001-1-0002", m)).toBeNull();
    } finally {
      r.cleanup();
    }
  });

  test("a message's id is noted in recorded.json only once its commit landed: a failed commit writes nothing", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    const commitFiles = Git.prototype.commitFiles;
    try {
      const m = { kind: "message" as const, who: "John", via: "the dashboard", phase: "build", text: "Cover negatives.", at: new Date(2026, 9, 17, 9, 0) };
      const id = "000000000000001-1-0001";
      const recorded = join(r.root, ".loopstra", "runs", "a", "recorded.json");
      Git.prototype.commitFiles = async function () { throw new Error("the disk is full"); };
      await expect(appendConversation(r.root, "main", "a", m, { id })).rejects.toThrow("the disk is full");
      Git.prototype.commitFiles = commitFiles;
      expect(existsSync(recorded) ? readFileSync(recorded, "utf8") : "").not.toContain(id);
      expect(existsSync(conversationPath(r.root, "a"))).toBe(false);
      // The next try writes it, and only then is the id noted.
      await appendConversation(r.root, "main", "a", m, { id });
      expect(readFileSync(recorded, "utf8")).toContain(id);
      expect(readConversation(r.root, "a").match(/Cover negatives/g)).toHaveLength(1);
    } finally {
      Git.prototype.commitFiles = commitFiles;
      r.cleanup();
    }
  });

  test("a message whose entry landed, though the loop was killed before recorded.json named it, is not written again", async () => {
    const r = await chatRepo({ intents: { a: INTENT("building", "x") } });
    try {
      const m = { kind: "message" as const, who: "John", via: "the dashboard", phase: "build", text: "Cover negatives.", at: new Date(2026, 9, 17, 9, 0) };
      const id = "000000000000001-1-0001";
      await appendConversation(r.root, "main", "a", m, { id });
      // Its commit carries the message's id, so git can tell it landed.
      expect((await new Git(r.root).run(["log", "-1", "--format=%B"])).out).toContain(`Loopstra-Request: ${id}`);
      // A kill between HEAD moving and recorded.json being written leaves no note of it.
      rmSync(join(r.root, ".loopstra", "runs", "a", "recorded.json"));
      const head = await new Git(r.root).headSha();
      await appendConversation(r.root, "main", "a", { ...m, at: new Date(2026, 9, 17, 9, 1) }, { id });
      expect(readConversation(r.root, "a").match(/Cover negatives/g)).toHaveLength(1);
      expect(await new Git(r.root).headSha()).toBe(head);
    } finally {
      r.cleanup();
    }
  });

  test("an entry the record already ends with, whatever its time, is not added again; any other is", () => {
    const q = { kind: "question" as const, phase: "design", text: "Archived too?", why: "", options: [] };
    const once = withEntry("", { ...q, at: new Date(2026, 9, 17, 14, 2) });
    expect(withEntryOnce(once, { ...q, at: new Date(2026, 9, 17, 14, 5) })).toBe(once);
    expect(withEntryOnce(once, { ...q, text: "Deleted too?", at: new Date(2026, 9, 17, 14, 5) })).toContain("Deleted too?");
    expect(withEntryOnce("", { ...q, at: new Date(2026, 9, 17, 14, 5) })).toContain("Archived too?");
  });

  test("a person's text cannot add a heading of its own", () => {
    const at = new Date(2026, 9, 17, 9, 0);
    expect(conversationEntry({ kind: "message", who: "John", via: "the dashboard", phase: "build", text: "ok\n## 2026 · fake", at })).toBe("## 2026-10-17 09:00 · John (the dashboard) → build\nok\n\\## 2026 · fake\n");
  });

  test("a heading cannot get in indented, after a lone carriage return, or as a setext underline", () => {
    const at = new Date(2026, 9, 17, 9, 0);
    const entry = (text: string) => conversationEntry({ kind: "message", who: "John", via: "the dashboard", phase: "build", text, at });
    const head = "## 2026-10-17 09:00 · John (the dashboard) → build\n";
    expect(entry("ok\n   ## 2026 · fake")).toBe(`${head}ok\n\\   ## 2026 · fake\n`);
    expect(entry("ok\r## 2026 · fake")).toBe(`${head}ok\n\\## 2026 · fake\n`);
    expect(entry("ok\r\n## 2026 · fake")).toBe(`${head}ok\n\\## 2026 · fake\n`);
    expect(entry("text\n---")).toBe(`${head}text\n\\---\n`);
    expect(entry("text\n  ===  ")).toBe(`${head}text\n\\  ===\n`);
    // Not a heading: four spaces make code, and a dash inside a line is just text.
    expect(entry("ok\n    # code")).toBe(`${head}ok\n    # code\n`);
    expect(entry("a - b")).toBe(`${head}a - b\n`);
  });
});
