import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { configPath } from "../../src/config";
import { init } from "../../src/init";
import { commands, missingProgram } from "../../src/setup/sections/commands";
import { setupRepo, tempGitRepo } from "../helpers";
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

  test("a command left out with - stays out: its placeholder stays, and --defaults does not bring it back", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      expect(before).toContain('  install: "bun install"\n');
      // Order: test, install, lint, build, run.
      const left = await askSection(commands, repo.path, ["", "-", "", "", ""]);
      expect(left.text).toBe(before.replace('  install: "bun install"\n', "  # install:\n"));
      const again = await askSection(commands, repo.path, "defaults");
      expect(again.text).toBe(left.text);
      expect(again.shown).toContain("Installs dependencies in a fresh checkout (commands.install): (empty)");
    } finally { repo.cleanup(); }
  });

  test("a command added again takes its placeholder's place, quoted like init's", async () => {
    const repo = await tempGitRepo();
    try {
      await Bun.write(join(repo.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
      await init(repo.path);
      const before = readFileSync(configPath(repo.path), "utf8");
      await askSection(commands, repo.path, ["", "-", "", "", ""]);
      const { text } = await askSection(commands, repo.path, ["", "npm ci", "eslint .", "", ""]);
      expect(text).toBe(before.replace('  install: "bun install"\n', '  install: "npm ci"\n').replace("  # lint:\n", '  lint: "eslint ."\n'));
    } finally { repo.cleanup(); }
  });

  test("- on the test command asks again instead of saving it", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\n");
    try {
      const { text, shown } = await askSection(commands, r.root, ["-", "", "", "", "", ""]);
      expect(parse(text).commands).toEqual({ test: "echo ok" });
      expect(shown).toContain("An answer is needed.");
      expect(shown).toContain("Type - to leave out an optional one.");
    } finally { r.cleanup(); }
  });

  test("checks claude is found and the test command passes on main, in a throwaway checkout", async () => {
    const { repo, trace } = await setupRepo("draft");
    trace.close();
    try {
      const checks = await checkSection(commands, repo.path);
      expect(checks.map((c) => c.level)).toEqual(["ok", "ok"]);
      expect(checks[1]!.text).toBe("commands.test passes on main.");
      expect(existsSync(join(repo.path, ".loopstra", "setup-main"))).toBe(false);
      expect(existsSync(join(repo.path, ".loopstra", "setup"))).toBe(false);
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

  test("a test or install program that is not there fails, naming it", async () => {
    const cases: Record<string, string>[] = [{ test: "loopstra-no-such-program --run" }, { install: "loopstra-no-such-installer", test: "echo ok" }];
    for (const cmds of cases) {
      const { repo, trace } = await setupRepo("draft", { commands: cmds });
      trace.close();
      try {
        const [, check] = await checkSection(commands, repo.path);
        const which = "install" in cmds ? "install" : "test";
        const program = "install" in cmds ? "loopstra-no-such-installer" : "loopstra-no-such-program";
        expect(check).toEqual({ level: "fail", text: `\`${program}\` is not installed or not on PATH (commands.${which}).` });
      } finally { repo.cleanup(); }
    }
  });

  test("a missing program is told apart by what each shell says, not by a file the program could not find", () => {
    expect(missingProgram("pytest -q", "bash: line 1: pytest: command not found")).toBe("pytest");
    expect(missingProgram("pytest -q", "sh: 1: pytest: not found")).toBe("pytest");
    expect(missingProgram("pytest", "'pytest' is not recognized as an internal or external command,")).toBe("pytest");
    expect(missingProgram("./run-tests.sh", "bash: ./run-tests.sh: No such file or directory")).toBe("./run-tests.sh");
    expect(missingProgram("cat missing.txt", "cat: missing.txt: No such file or directory")).toBeUndefined();
    expect(missingProgram("make test", "make: *** No rule to make target 'test'.  Stop.")).toBeUndefined();
  });

  test("an install command that fails on main is a warning naming it, and the tests do not run", async () => {
    const { repo, trace } = await setupRepo("draft", { commands: { install: "exit 4", test: "echo ok" } });
    trace.close();
    try {
      const [, check] = await checkSection(commands, repo.path);
      expect(check!.level).toBe("warn");
      expect(check!.text).toStartWith("commands.install fails on main (exit 4)");
    } finally { repo.cleanup(); }
  });
});
