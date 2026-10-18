import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedFiles, readStamp, STAMP_FILE, textSha, writeStamp } from "../../src/stamp";
import { templatePath } from "../../src/package";
import { tempDir } from "../helpers";

describe("stamp", () => {
  test("textSha ignores line endings", () => {
    expect(textSha("a\r\nb\r\n")).toBe(textSha("a\nb\n"));
    expect(textSha("a\nb\n")).not.toBe(textSha("a\nc\n"));
  });

  test("the managed files: the skill, the owner guide, REVIEW.md, and each prompt override", () => {
    const t = tempDir();
    try {
      expect(managedFiles(t.path)).toEqual([
        { path: ".claude/skills/loopstra/SKILL.md", template: "templates/skill/SKILL.md", shipped: templatePath("skill", "SKILL.md") },
        { path: "intent/README.md", template: "templates/intent-README.md", shipped: templatePath("intent-README.md") },
        { path: "REVIEW.md", template: "templates/REVIEW.md", shipped: templatePath("REVIEW.md") },
      ]);
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(t.path, "loopstra", "prompts", "review.md"), "x");
      writeFileSync(join(t.path, "loopstra", "prompts", "notes.txt"), "x");
      expect(managedFiles(t.path).at(-1)).toEqual({ path: "loopstra/prompts/review.md", template: "templates/prompts/review.md", shipped: templatePath("prompts", "review.md") });
      expect(managedFiles(t.path)).toHaveLength(4);
    } finally { t.cleanup(); }
  });

  test("a prompt the stamp records stays managed after it is deleted", () => {
    const t = tempDir();
    try {
      const stamp = { loopstra: "0.1.0", files: { "loopstra/prompts/plan.md": { base: "abc", deleted: true as const } } };
      expect(managedFiles(t.path, stamp).map((f) => f.path)).toContain("loopstra/prompts/plan.md");
    } finally { t.cleanup(); }
  });

  test("reads back what it writes; a missing or unreadable stamp is null", () => {
    const t = tempDir();
    try {
      expect(readStamp(t.path)).toBeNull();
      writeStamp(t.path, { loopstra: "0.2.0", files: { "REVIEW.md": { base: "abc" } } });
      expect(readStamp(t.path)).toEqual({ loopstra: "0.2.0", files: { "REVIEW.md": { base: "abc" } } });
      writeFileSync(join(t.path, STAMP_FILE), "{nope");
      expect(readStamp(t.path)).toBeNull();
    } finally { t.cleanup(); }
  });
});
