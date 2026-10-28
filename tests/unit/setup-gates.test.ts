import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configPath, loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { gates } from "../../src/setup/sections/gates";
import { tempGitRepo } from "../helpers";
import { askSection, configRepo } from "../setup-helpers";

describe("the gates section", () => {
  test("sets a person and the agent reviewer on spec, plan and done, in the template's own lines", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/package.json`, JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      // spec: a person, no agent; plan: as is; done: a person, as is; acceptance tests: as is.
      const { shown } = await askSection(gates, repo.path, ["y", "n", "", "", "yes", "", ""]);
      expect(shown).toContain("each step can wait for a person or go on by itself.");
      expect(shown).toContain("Should a person approve the spec (what will be built) before work goes on? (yes: they set its status in intent/<change>/intent.md; no: it goes on by itself)");
      expect(shown).toContain("Should a person confirm the result after merging? (yes: they set its status in intent/<change>/intent.md; no: it is done by itself)");
      expect(shown).not.toContain("result after merging before work goes on");
      const cfg = await loadConfig(repo.path);
      expect(cfg.gates.spec).toEqual({ human: "status", agent: false });
      expect(cfg.gates.plan).toEqual({ human: "none", agent: true });
      expect(cfg.gates.done).toEqual({ human: "status", agent: true });
      const text = readFileSync(configPath(repo.path), "utf8");
      expect(text).toContain("# Gates between stages.");
      expect(text).toContain("  spec: { human: status, agent: false }\n");
    } finally { repo.cleanup(); }
  });

  test("on a config without gates, the defaults add nothing but the suggested acceptance tests", async () => {
    const base = "version: 1\ncommands:\n  test: echo ok\n";
    const r = configRepo(base);
    try {
      expect((await askSection(gates, r.root, "defaults")).text).toBe(`${base}stages:\n  build:\n    acceptance_tests: true\n`);
    } finally { r.cleanup(); }
  });

  test("asks whether to write tests from Done when before each build, suggesting yes, and writes stages.build.acceptance_tests", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(`${repo.path}/package.json`, JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const { shown } = await askSection(gates, repo.path, ["", "", "", "", "", "", "n"]);
      expect(shown).toContain("Write tests from Done when before each build? [Y/n]");
      expect((await loadConfig(repo.path)).stages.build.acceptance_tests).toBe(false);
      expect(readFileSync(configPath(repo.path), "utf8")).toContain("acceptance_tests: false");
      await askSection(gates, repo.path, ["", "", "", "", "", "", "y"]);
      expect((await loadConfig(repo.path)).stages.build.acceptance_tests).toBe(true);
    } finally { repo.cleanup(); }
    // A person's own no is the suggestion next time.
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\nstages:\n  build:\n    acceptance_tests: false\n");
    try {
      expect((await askSection(gates, r.root, ["", "", "", "", "", "", ""])).shown).toContain("Write tests from Done when before each build? [y/N]");
      expect(r.text()).toContain("acceptance_tests: false");
    } finally { r.cleanup(); }
  });
});
