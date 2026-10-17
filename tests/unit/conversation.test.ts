import { describe, expect, test } from "bun:test";
import { appendConversation, conversationEntry, readConversation } from "../../src/conversation";
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

  test("a person's text cannot add a heading of its own", () => {
    const at = new Date(2026, 9, 17, 9, 0);
    expect(conversationEntry({ kind: "message", who: "John", via: "the dashboard", phase: "build", text: "ok\n## 2026 · fake", at })).toBe("## 2026-10-17 09:00 · John (the dashboard) → build\nok\n\\## 2026 · fake\n");
  });
});
