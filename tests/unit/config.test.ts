import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configPath, loadConfig } from "../../src/config";
import { tempDir } from "../helpers";

async function writeConfig(root: string, text: string) {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  await Bun.write(configPath(root), text);
}

describe("loadConfig", () => {
  test("fills defaults around a minimal config", async () => {
    const t = tempDir();
    await Bun.write(configPath(t.path), "");
    await writeConfig(t.path, "version: 1\ncommands:\n  test: bun test\n");
    const cfg = await loadConfig(t.path);
    expect(cfg.main_branch).toBe("main");
    expect(cfg.poll_seconds).toBe(60);
    expect(cfg.gates.intent.human).toBe("status");
    expect(cfg.gates.spec.agent).toBe(true);
    expect(cfg.stages.build.max_fix_loops).toBe(3);
    expect(cfg.claude.models.cheap).toBe("haiku");
    expect(cfg.signals.main_health.every_minutes).toBe(30);
    t.cleanup();
  });

  test("rejects a pull request as the done gate's surface, in plain words", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\ngates:\n  done:\n    human: pr\n");
    await expect(loadConfig(t.path)).rejects.toThrow("gates.done.human: must be status or none; a pull request cannot be used for this gate");
    t.cleanup();
  });

  test("rejects unknown keys with a plain message", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\nbogus: 1\n");
    await expect(loadConfig(t.path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(t.path)).rejects.toThrow(/bogus/);
    t.cleanup();
  });

  test("requires commands.test", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\n");
    await expect(loadConfig(t.path)).rejects.toThrow(/commands\.test/);
    t.cleanup();
  });

  test("reports a missing file plainly", async () => {
    const t = tempDir();
    await expect(loadConfig(t.path)).rejects.toThrow(/loopstra\/config\.yaml/);
    t.cleanup();
  });

  test("accepts an optional install command", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: bun test\n  install: bun install\n");
    const cfg = await loadConfig(t.path);
    expect(cfg.commands.install).toBe("bun install");
    t.cleanup();
  });
});
