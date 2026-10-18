import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { init, uncommittedSetup } from "../../src/init";
import { templatePath } from "../../src/package";
import { readStamp, textSha, writeStamp } from "../../src/stamp";
import { run, tempDir, tempGitRepo } from "../helpers";

describe("init", () => {
  test("stamps a bun repo with detected commands, the managed files and their stamp", async () => {
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
      for (const f of ["intent/README.md", "intent/queue.md", "REVIEW.md", ".claude/skills/loopstra/SKILL.md", "loopstra/stamp.json"]) {
        expect(existsSync(join(t.path, f))).toBe(true);
      }
      // Prompts and the test hook come from the installed package.
      expect(existsSync(join(t.path, "loopstra", "prompts"))).toBe(false);
      expect(existsSync(join(t.path, ".claude", "hooks"))).toBe(false);
      const shipped = (...p: string[]) => ({ base: textSha(readFileSync(templatePath(...p), "utf8")) });
      const stamp = readStamp(t.path)!;
      expect(stamp.loopstra).toMatch(/^0\.0\.0-dev/);
      expect(stamp.files).toEqual({
        ".claude/skills/loopstra/SKILL.md": shipped("skill", "SKILL.md"),
        "intent/README.md": shipped("intent-README.md"),
        "REVIEW.md": shipped("REVIEW.md"),
      });
      // The runtime runs its judges as fresh sessions itself; no subagent files.
      expect(existsSync(join(t.path, ".claude", "agents"))).toBe(false);
      // The workspaces only see what is committed on main.
      expect(report.next[1]).toBe("Commit the files init wrote (loopstra/, .claude/, intent/, REVIEW.md, CLAUDE.md, .gitignore) on main. The loop works in its own checkouts, which only see what is committed.");
      // The repository's own settings are not touched.
      const settings = JSON.parse(await Bun.file(join(t.path, ".claude", "settings.json")).text());
      expect(settings.permissions.allow).toEqual(["Bash(git *)"]);
      expect(settings.hooks.PreToolUse.length).toBe(1);
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
      expect(second.kept).toContain("loopstra/config.yaml");
      expect(await Bun.file(join(t.path, "loopstra", "prompts", "build.md")).text()).toBe("custom");
      expect((await loadConfig(t.path)).commands.test).toBe("make check");
      expect(await Bun.file(join(t.path, "CLAUDE.md")).text()).toBe(claudeBefore);
      expect(await Bun.file(join(t.path, ".gitignore")).text()).toBe(gitignoreBefore);
    } finally { t.cleanup(); }
  });

  test("a kept managed file gets the base of today's shipped text", async () => {
    const repo = await tempGitRepo();
    try {
      writeFileSync(join(repo.path, "REVIEW.md"), "our own review rules\n");
      await init(repo.path);
      const stamp = readStamp(repo.path)!;
      // Not a shipped text: recorded against today's shipped text, so later upgrades merge nothing into it.
      expect(stamp.files["REVIEW.md"]).toEqual({ base: textSha(readFileSync(templatePath("REVIEW.md"), "utf8")) });
      expect(readFileSync(join(repo.path, "REVIEW.md"), "utf8")).toBe("our own review rules\n");
    } finally { repo.cleanup(); }
  });

  test("an existing stamp is kept", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      writeStamp(repo.path, { loopstra: "0.3.0", files: {} });
      const r = await init(repo.path);
      expect(readStamp(repo.path)).toEqual({ loopstra: "0.3.0", files: {} });
      expect(r.kept).toContain("loopstra/stamp.json");
    } finally { repo.cleanup(); }
  });

  test("uncommittedSetup asks for the config, the stamp and overrides only", async () => {
    const repo = await tempGitRepo();
    try {
      await init(repo.path);
      expect(await uncommittedSetup(repo.path, "main")).toEqual(["loopstra/config.yaml", "loopstra/stamp.json"]);
      mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
      writeFileSync(join(repo.path, "loopstra", "prompts", "review.md"), "mine");
      expect(await uncommittedSetup(repo.path, "main")).toContain("loopstra/prompts/");
      await run(["git", "add", "-A"], repo.path);
      await run(["git", "commit", "-q", "-m", "set up"], repo.path);
      expect(await uncommittedSetup(repo.path, "main")).toEqual([]);
    } finally { repo.cleanup(); }
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
