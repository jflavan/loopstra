import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelopes } from "../../src/envelopes";

const ROOT = new URL("../../templates/prompts/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("prompt templates", () => {
  test("one template per phase, each mentioning its variables and structured output", async () => {
    for (const name of Object.keys(Envelopes)) {
      const p = join(ROOT, `${name}.md`);
      expect(existsSync(p)).toBe(true);
      const text = await Bun.file(p).text();
      expect(text).toContain("{{");
      expect(text.toLowerCase()).toContain("structured output");
    }
  });
});
