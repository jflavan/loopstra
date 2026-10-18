import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      const dry = await adoptLegacy(t.path, INDEX, fetchText, { write: false });
      expect(dry.removed).toContain("loopstra/prompts/review.md");
      expect(existsSync(join(t.path, "loopstra", "prompts", "review.md"))).toBe(true);
      await adoptLegacy(t.path, INDEX, fetchText, { write: true });
      expect(existsSync(join(t.path, ".claude", "settings.json"))).toBe(false);
    } finally { t.cleanup(); }
  });
});
