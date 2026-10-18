import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from "node:fs";
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
    expect(await runMainHealth(repo.path, cfg, trace, [])).toBe("fail");
    expect(intents(repo.path)).toEqual([]);
    expect(await runMainHealth(repo.path, cfg, trace, [])).toBe("fail");
    expect(intents(repo.path)).toEqual([]);
    trace.close(); repo.cleanup();
  });

  test("green stays quiet; green then red opens one draft intent in plain language, with the output in the trace", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, ["add-numbers"]);
    expect(trace.signals()[0]?.result).toBe("pass");
    expect(intents(repo.path)).toEqual([]);

    const red = await recommit(repo.path, "  test: echo the-failing-output && exit 1\n");
    await runMainHealth(repo.path, red, trace, ["add-numbers"]);
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
    await runMainHealth(repo.path, red, trace, ["add-numbers"]);
    expect(intents(repo.path)).toHaveLength(1);
    trace.close(); repo.cleanup();
  });

  test("two merges leave both changes pending, once each, and a failing check opens one draft that names both", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, []);
    markHealthPending(repo.path, "add-numbers");
    markHealthPending(repo.path, "say-goodbye");
    markHealthPending(repo.path, "add-numbers");
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: true, afterSlugs: ["add-numbers", "say-goodbye"] });

    const red = await recommit(repo.path, "  test: exit 1\n");
    await runMainHealth(repo.path, red, trace, ["add-numbers", "say-goodbye"]);
    expect(intents(repo.path)).toEqual(["fix-tests-after-add-numbers"]);
    const text = await Bun.file(join(repo.path, "intent", "fix-tests-after-add-numbers", "intent.md")).text();
    expect(text).toContain(`# Intent: tests broke after the changes "add-numbers" and "say-goodbye" merged`);
    expect(trace.events("fix-tests-after-add-numbers").find((e) => e.type === "signal")?.payload).toContain(`"after":["add-numbers","say-goodbye"]`);
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: false, afterSlugs: [] });
    expect(await new Git(repo.path).isDirty()).toBe(false);
    trace.close(); repo.cleanup();
  });

  test("a failed install records an error, opens nothing, and does not count as the baseline", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, []);
    const broken = await recommit(repo.path, "  test: exit 1\n  install: exit 3\n");
    expect(await runMainHealth(repo.path, broken, trace, [])).toBe("error");
    expect(intents(repo.path)).toEqual([]);
    // The baseline is still the green run, so red now is a breach.
    const red = await recommit(repo.path, "  test: exit 1\n");
    expect(await runMainHealth(repo.path, red, trace, [])).toBe("fail");
    expect(intents(repo.path)).toEqual([`fix-tests-on-main-${localDate()}`]);
    trace.close(); repo.cleanup();
  });

  test("the check runs in its own worktree under .loopstra/health and leaves nothing behind", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, []);
    expect(existsSync(join(repo.path, ".loopstra", "health", "main"))).toBe(false);
    expect((await new Git(repo.path).run(["worktree", "list"])).out.trim().split("\n")).toHaveLength(1);
    trace.close(); repo.cleanup();
  });

  test("due comes from disk and the trace: never run, a merge pending, or the interval passed", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: true, afterSlugs: [] });
    await runMainHealth(repo.path, cfg, trace, []);
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: false, afterSlugs: [] });
    markHealthPending(repo.path, "add-numbers");
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: true, afterSlugs: ["add-numbers"] });
    await runMainHealth(repo.path, cfg, trace, ["add-numbers"]);
    expect(mainHealthDue(repo.path, cfg, trace)).toEqual({ due: false, afterSlugs: [] });
    const soon = { ...cfg, signals: { main_health: { every_minutes: 0 } } };
    expect(mainHealthDue(repo.path, soon, trace).due).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("a check that errors keeps the merged changes pending, tries again after the interval, and a red check then names them", async () => {
    const { repo, cfg, trace } = await setup("  test: echo ok\n");
    await runMainHealth(repo.path, cfg, trace, []);
    markHealthPending(repo.path, "a");
    const broken = await recommit(repo.path, "  test: exit 1\n  install: exit 3\n");
    expect(await runMainHealth(repo.path, broken, trace, mainHealthDue(repo.path, broken, trace).afterSlugs)).toBe("error");
    // Not at once (an install that keeps failing would run every tick), and not forgotten.
    expect(mainHealthDue(repo.path, broken, trace)).toEqual({ due: false, afterSlugs: ["a"] });
    const red = await recommit(repo.path, "  test: exit 1\n");
    const later = { ...red, signals: { main_health: { every_minutes: 0 } } };
    const due = mainHealthDue(repo.path, later, trace);
    expect(due).toEqual({ due: true, afterSlugs: ["a"] });
    expect(await runMainHealth(repo.path, later, trace, due.afterSlugs)).toBe("fail");
    expect(intents(repo.path)).toEqual(["fix-tests-after-a"]);
    expect(mainHealthDue(repo.path, red, trace)).toEqual({ due: false, afterSlugs: [] });
    trace.close(); repo.cleanup();
  });

  test("a merge after a check that errored asks for a check at once", async () => {
    const { repo, trace } = await setup("  test: echo ok\n");
    markHealthPending(repo.path, "a");
    const broken = await recommit(repo.path, "  test: echo ok\n  install: exit 3\n");
    expect(await runMainHealth(repo.path, broken, trace, ["a"])).toBe("error");
    expect(mainHealthDue(repo.path, broken, trace).due).toBe(false);
    markHealthPending(repo.path, "b");
    // A file time is coarser than the trace's clock and can read earlier than the error was recorded.
    const early = new Date(Date.parse(trace.lastSignal("main_health")!.ts) - 5);
    utimesSync(join(repo.path, ".loopstra", "health-pending"), early, early);
    expect(mainHealthDue(repo.path, broken, trace)).toEqual({ due: true, afterSlugs: ["a", "b"] });
    trace.close(); repo.cleanup();
  });

  test("after a check that errored, a missing record of when a merge asked waits for the interval", async () => {
    const { repo, trace } = await setup("  test: echo ok\n");
    markHealthPending(repo.path, "a");
    const broken = await recommit(repo.path, "  test: echo ok\n  install: exit 3\n");
    expect(await runMainHealth(repo.path, broken, trace, ["a"])).toBe("error");
    // An upgrade from before health-asked, or a kill between writing health-pending and it.
    rmSync(join(repo.path, ".loopstra", "health-asked"));
    expect(mainHealthDue(repo.path, broken, trace)).toEqual({ due: false, afterSlugs: ["a"] });
    expect(mainHealthDue(repo.path, { ...broken, signals: { main_health: { every_minutes: 0 } } }, trace)).toEqual({ due: true, afterSlugs: ["a"] });
    trace.close(); repo.cleanup();
  });
});
