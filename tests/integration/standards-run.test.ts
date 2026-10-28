import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../../src/config";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { tick } from "../../src/scheduler";
import { readOutcomeStandards } from "../../src/standards";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE as FAKE, fixture, fixtureDir, TEMPLATES, tempGitRepo, withEnv } from "../helpers";

const INTENT = "---\nstatus: accepted\n---\n# Intent: add numbers\n\n## Problem\nNo add.\n\n## Proposed outcome\nAn add function.\n\n## Done when\n- add(1, 2) returns 3.\n";
const EVERY = "# Reviewed changes\n\n## Rules\n- REV-1: every change is reviewed before it merges\n";
const SOURCE = "---\napplies_to:\n  - src/**\n---\n# Source code\n\n## Rules\n- SRC-1: source files have tests\n";

/** The shipped fixture for `phase` with `from` replaced by `to` (both as they stand in the JSON). */
const changed = (phase: string, from: string, to: string): string => {
  const text = fixture(phase);
  if (!text.includes(from)) throw new Error(`${phase} fixture has no ${from}`);
  return text.replace(from, to);
};

describe("a whole run under standards", () => {
  test("one change runs from accepted to done under a standard for every change and a scoped one", async () => {
    const repo = await tempGitRepo();
    const dir = fixtureDir({
      design: changed("design", "## Areas of concern\\nNone.\\n", "## Areas of concern\\nNone.\\n\\n## Standards\\n- REV-1: the change goes through review like any other.\\n"),
      plan: changed("plan", "covering add(1, 2).\\n", "covering add(1, 2).\\n\\n## Standards\\n- REV-1: the review step covers it.\\n- SRC-1: tests/add.test.ts tests src/add.ts, listed under Proof.\\n"),
      "done-check": changed("done-check", '"outcome_markdown"', '"standards":[{"label":"REV-1","result":"met","evidence":"the review passed"},{"label":"SRC-1","result":"met","evidence":"tests/add.test.ts covers src/add.ts"}],"outcome_markdown"'),
    });
    try {
      mkdirSync(join(repo.path, "loopstra", "standards"), { recursive: true });
      cpSync(TEMPLATES, join(repo.path, "loopstra", "prompts"), { recursive: true });
      await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: bun test\n");
      await Bun.write(join(repo.path, "loopstra", "standards", "reviewed.md"), EVERY);
      await Bun.write(join(repo.path, "loopstra", "standards", "source.md"), SOURCE);
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ name: "target", type: "module" }));
      await Bun.write(join(repo.path, "tests", "smoke.test.ts"), 'import { expect, test } from "bun:test";\ntest("smoke", () => { expect(1 + 1).toBe(2); });\n');
      mkdirSync(join(repo.path, "intent", "add-numbers"), { recursive: true });
      await Bun.write(join(repo.path, "intent", "add-numbers", "intent.md"), INTENT);
      await new Git(repo.path).commitAll("setup");

      await withEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE, LOOPSTRA_FAKE_FIXTURE_DIR: dir.path }, async () => {
        for (let i = 0; i < 12; i++) {
          await tick(repo.path);
          if ((await readIntent(repo.path, "add-numbers")).file.frontmatter.status === "done") break;
        }
      });

      const intent = await readIntent(repo.path, "add-numbers");
      expect(intent.file.frontmatter.status).toBe("done");
      const outcome = await Bun.file(join(repo.path, "intent", "add-numbers", "outcome.md")).text();
      expect(outcome).toMatch(/\n## Standards\nThe engineering rules this change was checked against \(the standards as of commit [0-9a-f]{7}\):\n/);
      expect(readOutcomeStandards(outcome)).toEqual([
        { label: "REV-1", title: "Reviewed changes", result: "met", evidence: "the review passed" },
        { label: "SRC-1", title: "Source code", result: "met", evidence: "tests/add.test.ts covers src/add.ts" },
      ]);
      const trace = Trace.open(repo.path);
      try {
        const rows = trace.gates("add-numbers").filter((g) => g.check === "standards");
        expect(rows.map((g) => `${g.gate}:${g.result}`)).toEqual(expect.arrayContaining(["spec:pass", "plan:pass", "merge:pass", "done:pass"]));
        expect(trace.lastGate("add-numbers", "merge", "standards")?.evidence).toBe("applying Reviewed changes (REV-1); Source code (SRC-1)");
      } finally {
        trace.close();
      }
    } finally {
      dir.cleanup();
      repo.cleanup();
    }
  }, 120_000);
});
