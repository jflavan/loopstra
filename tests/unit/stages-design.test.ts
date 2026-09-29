import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { runDesignStep } from "../../src/stages/design";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

const FAKE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TEMPLATES = new URL("../../templates/prompts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export async function setupRepo(status: string, configExtra = "") {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\n${/^commands:/m.test(configExtra) ? "" : "commands:\n  test: echo ok\n"}${configExtra}`);
  mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), `---\nstatus: ${status}\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n`);
  await new Git(repo.path).commitAll("intent");
  process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;
  const trace = Trace.open(repo.path);
  const ctx = new StepContext(repo.path, await loadConfig(repo.path), trace, await readIntent(repo.path, "add-numbers"));
  return { repo, ctx, trace };
}

describe("design stage", () => {
  test("accepted → spec-review with spec.md written and committed; then agent gate → spec-approved", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await runDesignStep(ctx);
    let i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.priority).toBe("high");
    expect(i.artifacts.has("spec.md")).toBe(true);
    expect(await new Git(repo.path).isDirty()).toBe(false);

    await ctx.reload();
    await runDesignStep(ctx);
    i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-approved");
    expect(trace.gates("add-numbers").map((g) => `${g.check}:${g.result}`)).toEqual(["headings:pass", "spec-check:pass"]);
    trace.close(); repo.cleanup();
  });

  test("an owner's stated priority survives intake and is shown to the intake prompt", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    const path = join(repo.path, "intent", "add-numbers", "intent.md");
    await Bun.write(path, (await Bun.file(path).text()).replace("status: accepted\n", "status: accepted\npriority: urgent\n"));
    await new Git(repo.path).commitAll("owner priority");
    await ctx.reload();
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.priority).toBe("urgent");
    const intakePrompt = await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "phases", "1-intake", "prompt.md")).text();
    expect(intakePrompt).toContain("Priority the owner stated: urgent");
    trace.close(); repo.cleanup();
  });

  test("with no stated priority, intake's priority is written and the prompt says not stated", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await runDesignStep(ctx);
    const intakePrompt = await Bun.file(join(repo.path, ".loopstra", "runs", "add-numbers", "phases", "1-intake", "prompt.md")).text();
    expect(intakePrompt).toContain("Priority the owner stated: not stated");
    expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.priority).toBe("high");
    trace.close(); repo.cleanup();
  });

  test("spec-review with a human gate leaves a note and does not advance", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", "gates:\n  spec:\n    human: status\n");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("spec-review");
    expect(i.file.frontmatter.note).toContain("spec-approved");
    trace.close(); repo.cleanup();
  });

  test("intake with a question blocks the intent", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
    await runDesignStep(ctx);
    const i = await readIntent(repo.path, "add-numbers");
    expect(i.file.frontmatter.status).toBe("blocked");
    expect(i.file.frontmatter.note).toContain("Which portal page");
    trace.close(); repo.cleanup();
  });
});
