import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatePath } from "../../src/package";
import { promptPath, renderPrompt } from "../../src/prompts";
import { tempDir } from "../helpers";

describe("renderPrompt", () => {
  test("replaces known variables", () => {
    expect(renderPrompt("Slug: {{slug}}\n{{intent}}", { slug: "a-b", intent: "# I" })).toBe("Slug: a-b\n# I");
  });
  test("renders missing variables as (none)", () => {
    expect(renderPrompt("{{spec}}|{{plan}}", { spec: "S" })).toBe("S|(none)");
  });
  test("renders empty strings as (none)", () => {
    expect(renderPrompt("{{failure_output}}", { failure_output: "" })).toBe("(none)");
  });
  test("does not touch unknown braces", () => {
    expect(renderPrompt("{{ not a var }} {x}", {})).toBe("{{ not a var }} {x}");
  });
});

describe("promptPath", () => {
  test("the repository's override first, else the shipped prompt, else null", () => {
    const t = tempDir();
    try {
      expect(promptPath(t.path, "review")).toBe(templatePath("prompts", "review.md"));
      mkdirSync(join(t.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(t.path, "loopstra", "prompts", "review.md"), "mine");
      expect(promptPath(t.path, "review")).toBe(join(t.path, "loopstra", "prompts", "review.md"));
      expect(promptPath(t.path, "no-such-phase")).toBeNull();
    } finally { t.cleanup(); }
  });
});
