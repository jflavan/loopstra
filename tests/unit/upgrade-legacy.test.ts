import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "../../src/package";
import { adoptLegacy } from "../../src/upgrade/legacy";
import { textSha } from "../../src/stamp";
import type { ShippedIndex } from "../../src/shipped";
import { tempDir } from "../helpers";

const OLD_REVIEW = "old review prompt\n";
const OLD_PLAN = "old plan prompt\nline 2\n";

function legacyRepo() {
  const t = tempDir();
  const p = join(t.path, "loopstra", "prompts");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "review.md"), OLD_REVIEW);
  writeFileSync(join(p, "plan.md"), "old plan prompt\nline 2\nmy rule\n");
  mkdirSync(join(t.path, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(t.path, ".claude", "hooks", "loopstra-protect-tests.ts"), "// hook");
  writeFileSync(join(t.path, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/loopstra-protect-tests.ts"' }] }] } }, null, 2));
  writeFileSync(join(t.path, "REVIEW.md"), "a review guide\n");
  return t;
}

const INDEX: ShippedIndex = {
  "templates/prompts/review.md": [{ sha: textSha(OLD_REVIEW), commit: "c1" }],
  "templates/prompts/plan.md": [{ sha: textSha(OLD_PLAN), commit: "c1" }],
  "templates/REVIEW.md": [{ sha: textSha("a review guide\n"), commit: "c1" }],
};
const fetchText = async (template: string) => (template.endsWith("plan.md") ? OLD_PLAN : null);

describe("adoptLegacy", () => {
  test("drops unedited prompt copies, keeps overrides with their closest base, removes the old hook", async () => {
    const t = legacyRepo();
    try {
      const r = await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(existsSync(join(t.path, "loopstra", "prompts", "plan.md"))).toBe(true);
      expect(r.removed).toEqual(["loopstra/prompts/review.md", ".claude/hooks/loopstra-protect-tests.ts"]);
      expect(r.stamp.files["loopstra/prompts/plan.md"]).toEqual({ base: textSha(OLD_PLAN) });
      expect(r.notes).toEqual(["loopstra/prompts/plan.md is your own; it is merged from the shipped version of commit c1."]);
      expect(r.stamp.files["REVIEW.md"]).toEqual({ base: textSha("a review guide\n") });
      expect(JSON.parse(readFileSync(join(t.path, ".claude", "settings.json"), "utf8"))).toEqual({ model: "x" });
      expect(r.changed).toContain(".claude/settings.json");
    } finally { t.cleanup(); }
  });

  test("a settings file left empty is deleted; with write false nothing changes", async () => {
    const t = legacyRepo();
    try {
      writeFileSync(join(t.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "bun loopstra-protect-tests.ts" }] }] } }));
      const settingsBefore = readFileSync(join(t.path, ".claude", "settings.json"), "utf8");
      const dry = await adoptLegacy(t.path, INDEX, fetchText, { write: false });
      expect(dry.removed).toEqual(["loopstra/prompts/review.md", ".claude/hooks/loopstra-protect-tests.ts", ".claude/settings.json"]);
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(true);
      expect(existsSync(join(t.path, ".claude", "hooks", "loopstra-protect-tests.ts"))).toBe(true);
      expect(readFileSync(join(t.path, ".claude", "settings.json"), "utf8")).toBe(settingsBefore);
      await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(existsSync(join(t.path, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(t.path, ".claude", "hooks"))).toBe(false);
    } finally { t.cleanup(); }
  });

  test("with write false, apply makes the writes later, once", async () => {
    const t = legacyRepo();
    try {
      const dry = await adoptLegacy(t.path, INDEX, fetchText, { write: false });
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(true);
      dry.apply();
      dry.apply();
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(false);
      expect(existsSync(join(t.path, ".claude", "hooks", "loopstra-protect-tests.ts"))).toBe(false);
      expect(JSON.parse(readFileSync(join(t.path, ".claude", "settings.json"), "utf8"))).toEqual({ model: "x" });
    } finally { t.cleanup(); }
  });

  test("the hooks folder stays when it holds other files", async () => {
    const t = legacyRepo();
    try {
      writeFileSync(join(t.path, ".claude", "hooks", "mine.ts"), "// mine");
      await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(existsSync(join(t.path, ".claude", "hooks", "loopstra-protect-tests.ts"))).toBe(false);
      expect(existsSync(join(t.path, ".claude", "hooks", "mine.ts"))).toBe(true);
    } finally { t.cleanup(); }
  });

  test("settings that are not JSON are left alone, with a note", async () => {
    const t = legacyRepo();
    try {
      writeFileSync(join(t.path, ".claude", "settings.json"), "{ not json loopstra-protect-tests");
      const r = await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(readFileSync(join(t.path, ".claude", "settings.json"), "utf8")).toBe("{ not json loopstra-protect-tests");
      expect(r.changed).toEqual([]);
      expect(r.removed).not.toContain(".claude/settings.json");
      expect(r.notes).toContain(".claude/settings.json is not valid JSON, so the old test-hook entry was not removed; remove it by hand.");
    } finally { t.cleanup(); }
  });

  test("settings that are not JSON and never had the old hook get no note", async () => {
    const t = legacyRepo();
    try {
      writeFileSync(join(t.path, ".claude", "settings.json"), "{ not json, ours");
      const r = await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(readFileSync(join(t.path, ".claude", "settings.json"), "utf8")).toBe("{ not json, ours");
      expect(r.changed).toEqual([]);
      expect(r.notes.some((n) => n.includes("settings.json"))).toBe(false);
    } finally { t.cleanup(); }
  });

  test("an edited REVIEW.md gets the closest shipped version as its base, and a note", async () => {
    const t = legacyRepo();
    try {
      const v1 = "guide\nrule 1\n";
      const v2 = "guide\nrule 1\nrule 2\n";
      writeFileSync(join(t.path, "REVIEW.md"), "guide\nrule 1\nrule 2\nmy rule\n");
      const index: ShippedIndex = { ...INDEX, "templates/REVIEW.md": [{ sha: textSha(v1), commit: "aaaaaaaaaa1" }, { sha: textSha(v2), commit: "bbbbbbbbbb2" }] };
      const texts: Record<string, string> = { aaaaaaaaaa1: v1, bbbbbbbbbb2: v2 };
      const r = await adoptLegacy(t.path, index, async (template, commit) => (template === "templates/REVIEW.md" ? texts[commit] ?? null : fetchText(template)), { write: true });
      expect(r.stamp.files["REVIEW.md"]).toEqual({ base: textSha(v2) });
      expect(r.notes).toContain("REVIEW.md is your own; it is merged from the shipped version of commit bbbbbbb.");
    } finally { t.cleanup(); }
  });

  test("an edited file with no known shipped version takes today's text as its base", async () => {
    const t = legacyRepo();
    try {
      writeFileSync(join(t.path, "REVIEW.md"), "entirely my own\n");
      const { "templates/REVIEW.md": _, ...index } = INDEX;
      const r = await adoptLegacy(t.path, index, fetchText, { write: true });
      expect(r.stamp.files["REVIEW.md"]).toEqual({ base: textSha(readFileSync(templatePath("REVIEW.md"), "utf8")) });
      expect(r.notes).toContain("REVIEW.md is your own; Loopstra knows no earlier version of it, so it is left as it is.");
    } finally { t.cleanup(); }
  });

  test("offline: an edited file whose shipped versions cannot be read stops the adoption before anything is written", async () => {
    const t = legacyRepo();
    try {
      const settingsBefore = readFileSync(join(t.path, ".claude", "settings.json"), "utf8");
      await expect(adoptLegacy(t.path, INDEX, async () => null, { write: true })).rejects.toThrow(
        "Loopstra's shipped versions of loopstra/prompts/plan.md could not be read to merge from; check the connection and run loopstra upgrade again.",
      );
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(true);
      expect(existsSync(join(t.path, ".claude", "hooks", "loopstra-protect-tests.ts"))).toBe(true);
      expect(readFileSync(join(t.path, ".claude", "settings.json"), "utf8")).toBe(settingsBefore);
    } finally { t.cleanup(); }
  });
});
