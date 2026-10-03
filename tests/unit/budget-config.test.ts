import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configPath, loadConfig, validateConfig } from "../../src/config";
import { init } from "../../src/init";
import { tempDir, tempGitRepo } from "../helpers";

async function configWith(text: string) {
  const t = tempDir();
  mkdirSync(join(t.path, "loopstra"), { recursive: true });
  await Bun.write(configPath(t.path), `version: 1\ncommands:\n  test: bun test\n${text}`);
  try { return await loadConfig(t.path); } finally { t.cleanup(); }
}

describe("budgets", () => {
  test("are optional: unset means no limit", async () => {
    const cfg = await configWith("");
    expect(cfg.claude.max_budget_usd).toBeUndefined();
    expect(cfg.claude.max_budget_usd_per_day).toBeUndefined();
    expect(cfg.chat.max_budget_usd_per_session).toBeUndefined();
    expect(cfg.chat.max_budget_usd_per_day).toBeUndefined();
  });

  test("take positive amounts, including the loop's new daily cap", async () => {
    const cfg = await configWith("claude:\n  max_budget_usd: 9\n  max_budget_usd_per_day: 50\nchat:\n  max_budget_usd_per_session: 4\n  max_budget_usd_per_day: 36\n");
    expect([cfg.claude.max_budget_usd, cfg.claude.max_budget_usd_per_day, cfg.chat.max_budget_usd_per_session, cfg.chat.max_budget_usd_per_day]).toEqual([9, 50, 4, 36]);
    expect(() => validateConfig({ version: 1, commands: { test: "x" }, claude: { max_budget_usd: 0 } })).toThrow(ConfigError);
  });

  test("init writes them only as comments", async () => {
    const repo = await tempGitRepo();
    try {
      // A detected test command, so the stamped config is valid and loads.
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const text = readFileSync(configPath(repo.path), "utf8");
      expect(text).not.toMatch(/^\s*max_budget_usd/m);
      expect(text).toContain("max_budget_usd_per_day: what the loop's sessions may spend together in a day");
      const cfg = await loadConfig(repo.path);
      expect(cfg.claude.max_budget_usd).toBeUndefined();
      expect(cfg.claude.max_budget_usd_per_day).toBeUndefined();
      expect(cfg.chat.max_budget_usd_per_session).toBeUndefined();
      expect(cfg.chat.max_budget_usd_per_day).toBeUndefined();
    } finally { repo.cleanup(); }
  });
});
