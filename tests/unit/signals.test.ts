import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { runMainHealth } from "../../src/signals";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

async function setup(testCmd: string) {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n  test: ${testCmd}\n`);
  await new Git(repo.path).commitAll("config");
  return { repo, cfg: await loadConfig(repo.path), trace: Trace.open(repo.path) };
}

describe("main_health", () => {
  test("green stays quiet; green then red opens a draft intent in plain language", async () => {
    const { repo, cfg, trace } = await setup("echo ok");
    await runMainHealth(repo.path, cfg, trace, "add-numbers");
    expect(trace.signals()[0]?.result).toBe("pass");
    expect(existsSync(join(repo.path, "intent"))).toBe(false);

    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: exit 1\n");
    await new Git(repo.path).commitAll("break");
    const cfg2 = await loadConfig(repo.path);
    await runMainHealth(repo.path, cfg2, trace, "add-numbers");
    expect(trace.signals()[0]?.result).toBe("fail");
    const dirs = readdirSync(join(repo.path, "intent"));
    expect(dirs).toEqual(["fix-tests-after-add-numbers"]);
    const text = await Bun.file(join(repo.path, "intent", "fix-tests-after-add-numbers", "intent.md")).text();
    expect(text).toContain("status: draft");
    expect(text).toContain("## Problem");
    expect(text).toContain("add-numbers");
    expect(text).toContain("## Done when");

    // A second red run does not open a duplicate.
    await runMainHealth(repo.path, cfg2, trace, "add-numbers");
    expect(readdirSync(join(repo.path, "intent")).length).toBe(1);
    trace.close(); repo.cleanup();
  });
});
