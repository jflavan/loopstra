import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { commands } from "../../src/setup/sections/commands";
import { setupRepo } from "../helpers";
import { askSection, checkSection, configRepo } from "../setup-helpers";

describe("the commands section", () => {
  test("suggests what is set, else what init detects; - leaves one out", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\n  lint: old-lint\n");
    try {
      await Bun.write(join(r.root, "package.json"), JSON.stringify({ scripts: { test: "bun test", lint: "eslint .", build: "tsc" } }));
      // Order: test, install, lint, build, run.
      const { text } = await askSection(commands, r.root, ["", "", "-", "", ""]);
      expect(parse(text).commands).toEqual({ test: "echo ok", install: "bun install", build: "bun run build" });
    } finally { r.cleanup(); }
  });

  test("checks claude is found and the test command passes on main, in a throwaway checkout", async () => {
    const { repo, trace } = await setupRepo("draft");
    trace.close();
    try {
      const checks = await checkSection(commands, repo.path);
      expect(checks.map((c) => c.level)).toEqual(["ok", "ok"]);
      expect(checks[1]!.text).toBe("commands.test passes on main.");
      expect(existsSync(join(repo.path, ".loopstra", "setup", "main"))).toBe(false);
    } finally { repo.cleanup(); }
  });

  test("a test command that fails on main is a warning with its exit code", async () => {
    const { repo, trace } = await setupRepo("draft", { commands: { test: "exit 3" } });
    trace.close();
    try {
      const [, test] = await checkSection(commands, repo.path);
      expect(test!.level).toBe("warn");
      expect(test!.text).toStartWith("commands.test fails on main (exit 3)");
    } finally { repo.cleanup(); }
  });
});
