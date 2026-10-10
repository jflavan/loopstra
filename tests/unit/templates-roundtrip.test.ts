import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { configPath } from "../../src/config";
import { init } from "../../src/init";
import { tempGitRepo } from "../helpers";

describe("the stamped config", () => {
  for (const [name, scripts] of [["with a test command", { test: "bun test", lint: "eslint ." }], ["without one", {}]] as const) {
    test(`reads back exactly, ${name}, and one edit changes one place`, async () => {
      const repo = await tempGitRepo();
      try {
        if (Object.keys(scripts).length) await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts }));
        await init(repo.path);
        const text = readFileSync(configPath(repo.path), "utf8");
        expect(String(parseDocument(text))).toBe(text);

        const scalar = parseDocument(text);
        scalar.setIn(["claude", "timeout_minutes"], 45);
        expect(String(scalar)).toBe(text.replace("  timeout_minutes: 30\n", "  timeout_minutes: 45\n"));

        const added = parseDocument(text);
        added.setIn(["claude", "max_budget_usd"], 9);
        expect(String(added).replace("  max_budget_usd: 9\n", "")).toBe(text);

        const bot = parseDocument(text);
        bot.setIn(["chat", "transports"], bot.createNode({ slack: { channel: "C1" } }));
        expect(String(bot).replace("  transports:\n    slack:\n      channel: C1\n", "")).toBe(text);
      } finally { repo.cleanup(); }
    });
  }
});
