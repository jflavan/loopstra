import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { configPath, loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { STEPS, stepModel } from "../../src/models";
import { tempGitRepo } from "../helpers";
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
      expect(rendered.split(CONTRACT_LINES[1] ?? "").length - 1).toBe(1);
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

  test("the plan says generated files are new too, and that a wrong path fails the files check", async () => {
    const text = await Bun.file(join(ROOT, "plan.md")).text();
    expect(text).toContain("Every path that does not exist in the repository yet must carry `(new)`");
    expect(text).toMatch(/generated files \(migrations and their designer files, lockfiles\)/);
    expect(text).toMatch(/fails the plan's files check/);
  });

  test("the done-check asks for the outcome's exact headings and plain-words evidence", async () => {
    const text = await Bun.file(join(ROOT, "done-check.md")).text();
    expect(text).toContain("`## Outcome`");
    expect(text).toContain("`## Evidence`");
    expect(text).toMatch(/no test names, commands, file paths, or line numbers/);
  });

  test("the acceptance prompt has the Done when list, the spec, the plan, the test command and what people said; it writes only tests", async () => {
    const text = await Bun.file(join(ROOT, "acceptance.md")).text();
    for (const v of ["done_when", "spec", "plan", "test_command", "conversation", "commands"]) expect({ v, used: text.includes(`{{${v}}}`) }).toEqual({ v, used: true });
    const rendered = renderPrompt(text, { done_when: "- add(1, 2) returns 3.", spec: "SPEC", plan: "PLAN", test_command: "bun test", conversation: "SAID", commands: "`bun test`" });
    expect(rendered).not.toMatch(/\{\{[a-z_]+\}\}/);
    for (const part of ["- add(1, 2) returns 3.", "SPEC", "PLAN", "`bun test`", "SAID"]) expect(rendered).toContain(part);
    expect(text).toMatch(/only tests and test fixtures/);
    expect(text).toContain("`not_testable`");
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

  test("the config template names all four models, and no step starts on max", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      expect(parseDocument(await Bun.file(configPath(repo.path)).text()).getIn(["claude", "models", "max"])).toBe("fable");
      const cfg = await loadConfig(repo.path);
      expect(cfg.claude.models).toEqual({ cheap: "haiku", default: "sonnet", strong: "opus", max: "fable" });
      for (const s of STEPS) expect({ step: s.key, model: stepModel(cfg, s.key) }).not.toEqual({ step: s.key, model: "max" });
      // New repos write acceptance tests from Done when; the schema's default keeps upgraded repos as they were.
      expect(cfg.stages.build.acceptance_tests).toBe(true);
    } finally { repo.cleanup(); }
  });
});
