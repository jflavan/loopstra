import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { run, tempDir, tempGitRepo } from "../helpers";

describe("init", () => {
  test("stamps a bun repo with detected commands and all files, and merges settings.json", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test", lint: "eslint .", build: "tsc", start: "bun run src/main.ts" } }));
      mkdirSync(join(t.path, ".claude"), { recursive: true });
      await Bun.write(join(t.path, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git *)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
      await Bun.write(join(t.path, "CLAUDE.md"), "# Project\n\nNotes.\n");
      const report = await init(t.path);
      expect(report.written).toContain("loopstra/config.yaml");
      const cfg = await loadConfig(t.path);
      expect(cfg.commands.test).toBe("bun test");
      expect(cfg.commands.install).toBe("bun install");
      expect(cfg.commands.lint).toBe("bun run lint");
      expect(cfg.commands.build).toBe("bun run build");
      expect(cfg.commands.run).toBe("bun run start");
      expect(cfg.gates.spec).toEqual({ human: "none", agent: true });
      expect(cfg.gates.merge).toEqual({ human: "none", method: "squash" });
      for (const f of ["loopstra/prompts/build.md", "intent/README.md", "intent/queue.md", "REVIEW.md", ".claude/skills/loopstra/SKILL.md", ".claude/hooks/loopstra-protect-tests.ts"]) {
        expect(existsSync(join(t.path, f))).toBe(true);
      }
      // The runtime runs its judges as fresh sessions itself; no subagent files.
      expect(existsSync(join(t.path, ".claude", "agents"))).toBe(false);
      // The workspaces only see what is committed on main.
      expect(report.next[1]).toBe("Commit the files init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore) on main. The loop works in its own checkouts, which only see what is committed.");
      const settings = JSON.parse(await Bun.file(join(t.path, ".claude", "settings.json")).text());
      expect(settings.permissions.allow).toEqual(["Bash(git *)"]);
      expect(settings.hooks.PreToolUse.length).toBe(2);
      expect(JSON.stringify(settings.hooks.PreToolUse[1])).toContain("loopstra-protect-tests");
      const claude = await Bun.file(join(t.path, "CLAUDE.md")).text();
      expect(claude).toContain("## Commands");
      expect(claude).toContain("bun test");
      expect(await Bun.file(join(t.path, ".gitignore")).text()).toContain(".loopstra/");
    } finally { t.cleanup(); }
  });

  test("is idempotent and keeps any file a person has edited", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      await init(t.path);
      await Bun.write(join(t.path, "loopstra", "prompts", "build.md"), "custom");
      await Bun.write(join(t.path, "loopstra", "config.yaml"), "version: 1\ncommands:\n  test: make check\n");
      const claudeBefore = await Bun.file(join(t.path, "CLAUDE.md")).text();
      const gitignoreBefore = await Bun.file(join(t.path, ".gitignore")).text();
      const second = await init(t.path);
      expect(second.written).toEqual([]);
      expect(second.kept).toContain("loopstra/prompts/build.md");
      expect(second.kept).toContain("loopstra/config.yaml");
      expect(await Bun.file(join(t.path, "loopstra", "prompts", "build.md")).text()).toBe("custom");
      expect((await loadConfig(t.path)).commands.test).toBe("make check");
      expect(await Bun.file(join(t.path, "CLAUDE.md")).text()).toBe(claudeBefore);
      expect(await Bun.file(join(t.path, ".gitignore")).text()).toBe(gitignoreBefore);
      const settings = JSON.parse(await Bun.file(join(t.path, ".claude", "settings.json")).text());
      expect(settings.hooks.PreToolUse.length).toBe(1);
    } finally { t.cleanup(); }
  });

  test("with no detectable test command, leaves a placeholder that loadConfig rejects", async () => {
    const t = await tempGitRepo();
    try {
      const report = await init(t.path);
      expect(report.warnings.join(" ")).toMatch(/commands\.test/);
      await expect(loadConfig(t.path)).rejects.toThrow(/commands\.test/);
    } finally { t.cleanup(); }
  });

  test("main_branch is the branch the repository is on", async () => {
    const t = await tempGitRepo();
    try {
      await run(["git", "branch", "-m", "master"], t.path);
      await Bun.write(join(t.path, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
      const report = await init(t.path);
      expect(await Bun.file(join(t.path, "loopstra", "config.yaml")).text()).toContain("\nmain_branch: master\n");
      expect((await loadConfig(t.path)).main_branch).toBe("master");
      expect(report.next[1]).toContain(" on master.");
    } finally { t.cleanup(); }
  });

  test("the next steps point to loopstra setup", async () => {
    const repo = await tempGitRepo();
    try {
      const report = await init(repo.path);
      // Setup first, then commit what it saved with the rest, then start.
      expect(report.next[0]).toBe("Walk through the settings with `loopstra setup` (budgets, commands, gates, GitHub, chat, models), or edit loopstra/config.yaml.");
      expect(report.next.join(" ")).not.toContain("gates.*.human");
    } finally { repo.cleanup(); }
  });

  test("a repository with no commits yet gets its unborn branch", async () => {
    const t = tempDir();
    try {
      await run(["git", "init", "-q", "-b", "trunk"], t.path);
      await init(t.path);
      expect(await Bun.file(join(t.path, "loopstra", "config.yaml")).text()).toContain("\nmain_branch: trunk\n");
    } finally { t.cleanup(); }
  });

  test("file names are matched exactly: makefile is detected, claude.md is left alone with a warning", async () => {
    const t = await tempGitRepo();
    try {
      await Bun.write(join(t.path, "makefile"), "test:\n\techo ok\n");
      await Bun.write(join(t.path, "claude.md"), "# Mine\n");
      const report = await init(t.path);
      expect((await loadConfig(t.path)).commands.test).toBe("make test");
      expect(report.kept).toContain("claude.md");
      expect(report.warnings.join(" ")).toContain("There is a claude.md but no CLAUDE.md.");
      expect(readdirSync(t.path)).not.toContain("CLAUDE.md");
      expect(await Bun.file(join(t.path, "claude.md")).text()).toBe("# Mine\n");
    } finally { t.cleanup(); }
  });

  test("in a folder that is not a git repository, warns and writes nothing", async () => {
    const t = tempDir();
    try {
      const report = await init(t.path);
      expect(report).toMatchObject({ stopped: true, written: [], kept: [], next: [], warnings: ["This folder is not a git repository; run git init first."] });
      expect(existsSync(join(t.path, "loopstra"))).toBe(false);
      expect(existsSync(join(t.path, ".loopstra"))).toBe(false);
    } finally { t.cleanup(); }
  });
});
