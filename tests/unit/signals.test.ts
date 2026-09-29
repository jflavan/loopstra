import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { Git } from "../../src/git";
import { localDate, mainHealthDue, markHealthPending, runMainHealth } from "../../src/signals";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

async function setup(commands: string) {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(repo.path), `version: 1\ncommands:\n${commands}`);
  await new Git(repo.path).commitAll("config");
  return { repo, cfg: await loadConfig(repo.path), trace: Trace.open(repo.path) };
}

/** Commits a new config (so the check on main sees it) and returns it loaded. */
async function recommit(repo: string, commands: string) {
  await Bun.write(configPath(repo), `version: 1\ncommands:\n${commands}`);
  await new Git(repo).commitAll("config change");
  return loadConfig(repo);
}

function intents(repo: string): string[] {
  return existsSync(join(repo, "intent")) ? readdirSync(join(repo, "intent")) : [];
}

describe("main_health", () => {
  test("the first result is only recorded, even when red: nothing is opened without a green baseline", async () => {
    const { repo, cfg, trace } = await setup("  test: exit 1\n");
    expect(await runMainHealth(repo.path, cfg, trace, null)).toBe("fail");
    expect(intents(repo.path)).toEqual([]);
    expect(await runMainHealth(repo.path, cfg, trace, null)).toBe("fail");
    expect(intents(repo.path)).toEqual([]);
    trace.close(); repo.cleanup();
  });

  test("green stays quiet; green then red opens one draft intent in plain language, with the output in the trace", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, "add-numbers");
    expect(trace.signals()[0]?.result).toBe("pass");
    expect(intents(repo.path)).toEqual([]);

    const red = await recommit(repo.path, "  test: echo the-failing-output && exit 1\n");
    await runMainHealth(repo.path, red, trace, "add-numbers");
    expect(trace.signals()[0]?.result).toBe("fail");
    expect(intents(repo.path)).toEqual(["fix-tests-after-add-numbers"]);
    const text = await Bun.file(join(repo.path, "intent", "fix-tests-after-add-numbers", "intent.md")).text();
    expect(text).toContain("status: draft");
    expect(text).toContain(`opened: ${localDate()}`);
    expect(text).toContain("## Problem");
    expect(text).toContain("add-numbers");
    expect(text).toContain("## Done when");
    expect(text).not.toContain("the-failing-output");
    expect(text).not.toContain("```");
    expect(trace.events("fix-tests-after-add-numbers").some((e) => e.payload.includes("the-failing-output"))).toBe(true);
    expect(await new Git(repo.path).isDirty()).toBe(false);

    // A second red run does not open a duplicate.
    await runMainHealth(repo.path, red, trace, "add-numbers");
    expect(intents(repo.path)).toHaveLength(1);
    trace.close(); repo.cleanup();
  });

  test("a failed install records an error, opens nothing, and does not count as the baseline", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, null);
    const broken = await recommit(repo.path, "  test: exit 1\n  install: exit 3\n");
    expect(await runMainHealth(repo.path, broken, trace, null)).toBe("error");
    expect(intents(repo.path)).toEqual([]);
    // The baseline is still the green run, so red now is a breach.
    const red = await recommit(repo.path, "  test: exit 1\n");
    expect(await runMainHealth(repo.path, red, trace, null)).toBe("fail");
    expect(intents(repo.path)).toEqual([`fix-tests-on-main-${localDate()}`]);
    trace.close(); repo.cleanup();
  });

  test("the check runs in its own worktree under .loopstra/health and leaves nothing behind", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, null);
    expect(existsSync(join(repo.path, ".loopstra", "health", "main"))).toBe(false);
    expect((await new Git(repo.path).run(["worktree", "list"])).out.trim().split("\n")).toHaveLength(1);
    trace.close(); repo.cleanup();
  });

  test("due comes from disk and the trace: never run, a merge pending, or the interval passed", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: true, afterSlug: null });
    await runMainHealth(repo.path, cfg, trace, null);
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: false, afterSlug: null });
    markHealthPending(repo.path, "add-numbers");
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: true, afterSlug: "add-numbers" });
    await runMainHealth(repo.path, cfg, trace, "add-numbers");
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: false, afterSlug: null });
    const soon = { ...cfg, signals: { main_health: { every_minutes: 0 } } };
    expect(mainHealthDue(repo.path, soon, trace).due).toBe(true);
    trace.close(); repo.cleanup();
  });
});
