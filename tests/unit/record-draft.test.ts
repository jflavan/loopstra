import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecordDraft } from "../../src/record-draft";
import { tempDir } from "../helpers";

describe("RecordDraft", () => {
  test("reads fall through to disk until written; writes and removals are the changes, in order", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "a"), { recursive: true });
      writeFileSync(join(t.path, "intent", "a", "intent.md"), "on disk\n");
      const d = new RecordDraft(t.path, "a");
      expect(d.read("intent/a/intent.md")).toBe("on disk\n");
      expect(d.read("intent/a/spec.md")).toBeNull();
      d.write("intent/a/intent.md", "drafted\n");
      d.write("intent/a/spec.md", "# Spec\n");
      d.remove("intent/a/old.md");
      expect(d.read("intent/a/intent.md")).toBe("drafted\n");
      expect(d.read("intent/a/old.md")).toBeNull();
      expect(d.changes()).toEqual([
        { rel: "intent/a/intent.md", text: "drafted\n" },
        { rel: "intent/a/spec.md", text: "# Spec\n" },
        { rel: "intent/a/old.md", text: null },
      ]);
    } finally { t.cleanup(); }
  });

  test("a path outside the change's folder (and queue.md) is refused", () => {
    const d = new RecordDraft("/r", "a");
    expect(() => d.write("intent/b/intent.md", "x")).toThrow("a record of a cannot write intent/b/intent.md");
    expect(() => d.write("intent/a/../b/intent.md", "x")).toThrow();
    expect(() => d.write("intent/a\\x.md", "x")).toThrow();
    expect(() => d.read("src/index.ts")).toThrow();
    expect(() => d.write("intent/queue.md", "q")).not.toThrow();
  });
});
