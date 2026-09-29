import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { init } from "../../src/init";
import { tempDir } from "../helpers";

describe("init", () => {
  test("stamps a bun repo with detected commands and all files, and merges settings.json", async () => {
    const t = tempDir();
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
      expect(cfg.gates.intent.human).toBe("status");
      expect(cfg.gates.spec).toEqual({ human: "none", agent: true });
      expect(cfg.gates.merge).toEqual({ human: "none", method: "squash" });
      for (const f of ["loopstra/prompts/build.md", "intent/README.md", "intent/queue.md", "REVIEW.md", ".claude/agents/verifier.md", ".claude/agents/reviewer.md", ".claude/skills/loopstra/SKILL.md", ".claude/hooks/loopstra-protect-tests.ts"]) {
        expect(existsSync(join(t.path, f))).toBe(true);
      }
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
    const t = tempDir();
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
    const t = tempDir();
    try {
      const report = await init(t.path);
      expect(report.warnings.join(" ")).toMatch(/commands\.test/);
      await expect(loadConfig(t.path)).rejects.toThrow(/commands\.test/);
    } finally { t.cleanup(); }
  });
});
