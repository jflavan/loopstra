import { describe, expect, test } from "bun:test";
import { renderPrompt } from "../../src/prompts";

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
