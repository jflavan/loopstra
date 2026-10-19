import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, configPath, loadConfig, validateConfig } from "../../src/config";
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
    expect(cfg.gates.spec.agent).toBe(true);
    // Build sessions may read git history but not change it: the runtime owns commits and branches.
    expect(cfg.claude.allowed_tools).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"]);
    expect(cfg.stages.build.max_fix_loops).toBe(3);
    expect(cfg.claude.models.cheap).toBe("haiku");
    // The cheap model often ends a verify session without calling the structured-output tool (#7).
    expect(cfg.stages.verify.model).toBe("default");
    expect(cfg.signals.main_health.every_minutes).toBe(30);
    // Judges overlap by default; project commands share folders in some projects, so they do not.
    // One change at a time unless the owner says the project's commands can run side by side.
    expect(cfg.speed).toEqual({ parallel_checks: false, overlap_judges: true, plan_ahead: true, cheap_judges: "off", think_ahead: true, max_parallel_changes: 1 });
    t.cleanup();
  });

  test("speed.max_parallel_changes takes 1 to 4, and says so in plain words otherwise", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\nspeed:\n  max_parallel_changes: 3\n");
    expect((await loadConfig(t.path)).speed.max_parallel_changes).toBe(3);
    for (const [value, error] of [["0", "must be 1 or more"], ["1.5", "must be a whole number"], ["5", "must be 4 or less"]]) {
      await writeConfig(t.path, `version: 1\ncommands:\n  test: x\nspeed:\n  max_parallel_changes: ${value}\n`);
      await expect(loadConfig(t.path)).rejects.toThrow(`speed.max_parallel_changes: ${error}`);
    }
    t.cleanup();
  });

  test("speed.plan_ahead can be switched off; an unknown speed key is still rejected", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\nspeed:\n  plan_ahead: false\n");
    expect((await loadConfig(t.path)).speed.plan_ahead).toBe(false);
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\nspeed:\n  plan_early: true\n");
    await expect(loadConfig(t.path)).rejects.toThrow(/plan_early/);
    t.cleanup();
  });

  test("speed.cheap_judges is off by default, takes shadow or first, and rejects anything else in plain words", async () => {
    const t = tempDir();
    for (const mode of ["shadow", "first", "off"]) {
      await writeConfig(t.path, `version: 1\ncommands:\n  test: x\nspeed:\n  cheap_judges: ${mode}\n`);
      expect((await loadConfig(t.path)).speed.cheap_judges).toBe(mode as "off");
    }
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\nspeed:\n  cheap_judges: sometimes\n");
    await expect(loadConfig(t.path)).rejects.toThrow("speed.cheap_judges: must be off, shadow or first");
    t.cleanup();
  });

  test("rejects a pull request as the done gate's surface, in plain words", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\ngates:\n  done:\n    human: pr\n");
    await expect(loadConfig(t.path)).rejects.toThrow("gates.done.human: must be status or none; a pull request cannot be used for this gate");
    t.cleanup();
  });

  test("rejects a pull request for the spec and plan gates, in plain words; there is none to approve", async () => {
    const t = tempDir();
    for (const gate of ["spec", "plan"]) {
      await writeConfig(t.path, `version: 1\ncommands:\n  test: x\ngates:\n  ${gate}:\n    human: pr\n`);
      await expect(loadConfig(t.path)).rejects.toThrow(`gates.${gate}.human: must be status or none; a pull request cannot be used for this gate`);
    }
    t.cleanup();
  });

  test("the intent gate is not a setting: a person always accepts a change", async () => {
    const t = tempDir();
    await writeConfig(t.path, "version: 1\ncommands:\n  test: x\ngates:\n  intent: { human: status }\n");
    await expect(loadConfig(t.path)).rejects.toThrow("gates.intent: remove this line; a person always accepts a change by setting its status to accepted.");
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

  test("a problem whose words already start with its path does not repeat it", () => {
    let problems: ConfigError["problems"] = [];
    try { validateConfig({ version: 1, commands: { test: "" } }); } catch (e) { problems = (e as ConfigError).problems; }
    expect(problems.map((p) => p.text)).toEqual(["commands.test is required: the single command that runs your tests"]);
  });

  test("an empty optional command reads as none, as it did before the blank-name rule", () => {
    const cfg = validateConfig({ version: 1, commands: { test: "bun test", lint: "", build: "", run: "", install: "" } });
    expect([cfg.commands.lint, cfg.commands.build, cfg.commands.run, cfg.commands.install]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("a value of only spaces is as blank as an empty one: a branch, a model name, or a command", () => {
    const problems = (raw: unknown) => {
      try { validateConfig(raw); } catch (e) { return (e as ConfigError).problems.map((p) => p.text); }
      return [];
    };
    const ok = { version: 1, commands: { test: "bun test" } };
    expect(problems({ ...ok, main_branch: " " })).toEqual(["main_branch: must be a branch name, like main"]);
    expect(problems({ ...ok, claude: { models: { default: "  ", cheap: "\t", strong: " " } } })).toEqual([
      "claude.models.default: must be a model name", "claude.models.cheap: must be a model name", "claude.models.strong: must be a model name",
    ]);
    expect(problems({ ...ok, commands: { test: "bun test", lint: "  " } })).toEqual(["commands.lint: must be a command, or the line removed"]);
    expect(problems({ version: 1, commands: { test: "   " } })).toEqual(["commands.test is required: the single command that runs your tests"]);
    // A name around spaces is the name.
    expect(validateConfig({ ...ok, main_branch: " trunk " }).main_branch).toBe("trunk");
  });

  test("a blank branch, model or command, a version that is not 1, and a missing channel are each refused in plain words", () => {
    const problems = (raw: unknown) => {
      try { validateConfig(raw); } catch (e) { return (e as ConfigError).problems.map((p) => p.text); }
      return [];
    };
    const ok = { version: 1, commands: { test: "bun test" } };
    expect(problems({ ...ok, main_branch: "" })).toEqual(["main_branch: must be a branch name, like main"]);
    expect(problems({ ...ok, claude: { models: { default: "", cheap: "", strong: "" } } })).toEqual([
      "claude.models.default: must be a model name", "claude.models.cheap: must be a model name", "claude.models.strong: must be a model name",
    ]);
    expect(problems({ ...ok, commands: { test: "bun test", lint: " ", build: " ", run: " ", install: " " } })).toEqual([
      "commands.lint: must be a command, or the line removed", "commands.build: must be a command, or the line removed",
      "commands.run: must be a command, or the line removed", "commands.install: must be a command, or the line removed",
    ]);
    expect(problems({ commands: { test: "bun test" } })).toEqual(["version: must be 1"]);
    expect(problems({ ...ok, version: 2 })).toEqual(["version: must be 1"]);
    const id = "must be a user or channel id; put long numeric ids in quotes";
    expect(problems({ ...ok, chat: { transports: { slack: {} } } })).toEqual([`chat.transports.slack.channel: ${id}`]);
    expect(problems({ ...ok, chat: { transports: { discord: { channel: "", allow: [12345678901234567890] } } } })).toEqual([
      `chat.transports.discord.channel: ${id}`, `chat.transports.discord.allow.0: ${id}`,
    ]);
    // Quoted long ids, and short numbers, read as the same text either way.
    const cfg = validateConfig({ ...ok, chat: { transports: { discord: { channel: "12345678901234567890", allow: [42] } } } });
    expect(cfg.chat.transports.discord).toMatchObject({ channel: "12345678901234567890", allow: ["42"] });
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
