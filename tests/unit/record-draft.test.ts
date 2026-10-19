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
    // An empty, `.` or `..` segment anywhere inside the folder is refused: each names a path two ways, or none.
    for (const rel of ["intent/a/", "intent/a//x.md", "intent/a/./x.md", "intent/a/sub/../x.md", "intent/a/x.md/", "intent/a/.."]) {
      expect(() => d.write(rel, "x")).toThrow(`a record of a cannot write ${rel}`);
    }
    expect(() => d.write("intent/a/sub/x.md", "x")).not.toThrow();
    expect(() => d.write("intent/queue.md", "q")).not.toThrow();
  });

  test("remembers what a file held on disk when first read there, and nothing for one never read", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "a"), { recursive: true });
      writeFileSync(join(t.path, "intent", "a", "intent.md"), "first\n");
      const d = new RecordDraft(t.path, "a");
      d.read("intent/a/intent.md");
      writeFileSync(join(t.path, "intent", "a", "intent.md"), "second\n");
      expect(d.read("intent/a/intent.md")).toBe("second\n");
      expect(d.readFromDisk("intent/a/intent.md")?.toString()).toBe("first\n");
      d.read("intent/a/spec.md");
      expect(d.readFromDisk("intent/a/spec.md")).toBeNull();
      d.write("intent/a/plan.md", "# Plan\n");
      expect(d.readFromDisk("intent/a/plan.md")).toBeUndefined();
    } finally { t.cleanup(); }
  });
});
