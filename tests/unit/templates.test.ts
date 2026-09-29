import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Envelopes } from "../../src/envelopes";
import { PROMPT_VARS } from "../../src/prompts";

const ROOT = fileURLToPath(new URL("../../templates/prompts/", import.meta.url));
const FAIL_RULE = "Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.";

describe("prompt templates", () => {
  test("one template per phase, each ending with the structured-output line and stating when to fail", async () => {
    for (const name of Object.keys(Envelopes)) {
      const p = join(ROOT, `${name}.md`);
      expect(existsSync(p)).toBe(true);
      const text = await Bun.file(p).text();
      expect(text).toContain("{{");
      expect(text.trimEnd().split("\n").pop()).toBe("Respond only through the structured output.");
      expect(text).toContain(FAIL_RULE);
    }
  });

  test("every {{variable}} is a known prompt variable", async () => {
    const known = new Set<string>(PROMPT_VARS);
    for (const name of Object.keys(Envelopes)) {
      const text = await Bun.file(join(ROOT, `${name}.md`)).text();
      for (const m of text.matchAll(/\{\{([a-z_]+)\}\}/g)) {
        expect({ template: name, variable: m[1], known: known.has(m[1]!) }).toEqual({ template: name, variable: m[1], known: true });
      }
    }
  });

  test("skills reach the prompt only through the prepended line", async () => {
    for (const name of Object.keys(Envelopes)) {
      expect(await Bun.file(join(ROOT, `${name}.md`)).text()).not.toContain("{{skills}}");
    }
  });
});
