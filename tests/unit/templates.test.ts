import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Envelopes } from "../../src/envelopes";
import { parseIntentFile, patchFrontmatter } from "../../src/intents";
import { CONTRACT_LINES, withContract } from "../../src/phases";
import { PROMPT_VARS, renderPrompt } from "../../src/prompts";

const ROOT = fileURLToPath(new URL("../../templates/prompts/", import.meta.url));

describe("prompt templates", () => {
  test("one template per phase; the shared contract is not repeated in them, and the rendered prompt ends with it", async () => {
    for (const name of Object.keys(Envelopes)) {
      const p = join(ROOT, `${name}.md`);
      expect(existsSync(p)).toBe(true);
      const text = await Bun.file(p).text();
      expect(text).toContain("{{");
      for (const line of CONTRACT_LINES) expect({ name, repeats: text.includes(line) }).toEqual({ name, repeats: false });
      const rendered = withContract(renderPrompt(text, {}));
      expect(rendered.trimEnd().endsWith(CONTRACT_LINES.join("\n\n"))).toBe(true);
      expect(rendered.split(CONTRACT_LINES[1]!).length - 1).toBe(1);
    }
  });

  test("judges are told exactly which commands they may run; code-writing sessions too", async () => {
    for (const name of ["verify", "done-check", "review", "build", "fix", "revise"]) {
      expect({ name, text: await Bun.file(join(ROOT, `${name}.md`)).text() }).toEqual({ name, text: expect.stringContaining("{{commands}}") });
    }
  });

  test("the spec's owner sections are written for the owner, and the spec check holds it to that", async () => {
    const owner = "Summary, Requirements, Out of scope, Open questions, and Areas of concern";
    const design = await Bun.file(join(ROOT, "design.md")).text();
    expect(design).toContain(owner);
    expect(design).toMatch(/no code, regular expressions, file paths, or function names/);
    expect(design).toContain("Design and Affected code are for engineers");
    const check = await Bun.file(join(ROOT, "spec-check.md")).text();
    expect(check).toContain(owner);
    expect(check).toMatch(/blocking/i);
    const guide = await Bun.file(join(ROOT, "..", "intent-README.md")).text();
    expect(guide).toContain("`plan.md` is written for the engineers");
    expect(guide).toContain("Design and Affected code");
  });

  test("the done-check asks for the outcome's exact headings and plain-words evidence", async () => {
    const text = await Bun.file(join(ROOT, "done-check.md")).text();
    expect(text).toContain("`## Outcome`");
    expect(text).toContain("`## Evidence`");
    expect(text).toMatch(/no test names, commands, file paths, or line numbers/);
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

  test("the owner guide's template leaves priority out, parses, and takes the priority Loopstra fills in", async () => {
    const guide = await Bun.file(join(ROOT, "..", "intent-README.md")).text();
    const example = /```markdown\n([\s\S]*?)```/.exec(guide)![1]!;
    expect(example).not.toMatch(/^priority:/m);
    const file = parseIntentFile(example);
    expect(file.frontmatter.status).toBe("draft");
    expect(file.frontmatter.priority).toBeUndefined();
    const filled = parseIntentFile(patchFrontmatter(example, { priority: "high" }));
    expect(filled.frontmatter.priority).toBe("high");
    expect(filled.sections["Done when"]).toContain("A short list");
  });

  test("skills reach the prompt only through the prepended line; every prompt variable is used by some template", async () => {
    expect(PROMPT_VARS as readonly string[]).not.toContain("skills");
    const all = (await Promise.all(Object.keys(Envelopes).map((n) => Bun.file(join(ROOT, `${n}.md`)).text()))).join("\n");
    for (const v of PROMPT_VARS) expect({ v, used: all.includes(`{{${v}}}`) }).toEqual({ v, used: true });
  });
});
