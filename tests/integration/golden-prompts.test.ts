import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { FAKE_CLAUDE as FAKE, tempDir, tempGitRepo, withEnv } from "../helpers";

/** The prompts of a repository without standards, as rendered before standards existed. Run with LOOPSTRA_UPDATE_GOLDEN=1 to write them again. */
const GOLDEN = join(import.meta.dir, "..", "fixtures", "golden-prompts");
const PHASES = ["design", "spec-check", "plan", "plan-challenge", "build", "review", "done-check"] as const;

const INTENT = "---\nstatus: accepted\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n";

/** A repository with the shipped prompts (no overrides) and no standards, and one accepted change. */
async function targetRepo() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: bun test\n");
  await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
  await Bun.write(join(repo.path, "tests", "smoke.test.ts"), 'import { expect, test } from "bun:test";\ntest("smoke", () => { expect(1 + 1).toBe(2); });\n');
  mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), INTENT);
  await new Git(repo.path).commitAll("setup");
  return repo;
}

/** Each phase's first prompt, with the temporary folders put as <repo> and <tmp>. */
async function prompts(): Promise<Map<string, string>> {
  const repo = await targetRepo();
  const log = tempDir();
  const file = join(log.path, "prompts.jsonl");
  try {
    await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE, LOOPSTRA_FAKE_PROMPTS: file }, async () => {
      for (let i = 0; i < 12; i++) {
        await tick(repo.path);
        if ((await readIntent(repo.path, "add-numbers")).file.frontmatter.status === "done") break;
      }
    });
    const out = new Map<string, string>();
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const { phase, prompt } = JSON.parse(line) as { phase: string; prompt: string };
      if (!out.has(phase)) out.set(phase, prompt.replaceAll(repo.path, "<repo>"));
    }
    return out;
  } finally {
    log.cleanup();
    repo.cleanup();
  }
}

describe("a repository without standards", () => {
  test("renders the same prompts", async () => {
    const got = await prompts();
    for (const phase of PHASES) {
      const path = join(GOLDEN, `${phase}.md`);
      const prompt = got.get(phase);
      expect(prompt, phase).toBeDefined();
      if (process.env.LOOPSTRA_UPDATE_GOLDEN === "1") {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(path, prompt ?? "");
      }
      expect(prompt, phase).toBe(readFileSync(path, "utf8"));
    }
  }, 60_000);
});
