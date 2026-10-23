import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { validateConfig } from "../../src/config";
import { stepModel } from "../../src/models";
import { applySetting, configVersion, settingPath, settingProblem } from "../../src/settings";

/** The template as init stamps it. */
const TEMPLATE = readFileSync(join(import.meta.dir, "..", "..", "templates", "config.yaml"), "utf8")
  .replace("__MAIN_BRANCH__", "main").replace("__COMMANDS__", "  test: bun test");

describe("settings", () => {
  test("only the model settings are writable paths", () => {
    expect(settingPath("stages.verify.steps.done-check")).toEqual(["stages", "verify", "steps", "done-check"]);
    expect(settingPath("chat.steps.write-intent")).toEqual(["chat", "steps", "write-intent"]);
    expect(settingPath("claude.models.max")).toEqual(["claude", "models", "max"]);
    expect(settingPath("chat.model")).toEqual(["chat", "model"]);
    expect(settingPath("stages.build.model")).toEqual(["stages", "build", "model"]);
    // A step of another stage, the orchestrator (chat.model itself), and settings that are not models.
    for (const p of ["stages.verify.steps.intake", "chat.steps.orchestrator", "claude.timeout_minutes", "stages.build.max_fix_loops", "claude.models.huge", "stages.nope.model", "", "chat"]) {
      expect(settingPath(p)).toBeNull();
    }
  });

  test("a named model needs one word; the others need a named model, and only a step may be unset", () => {
    expect(settingProblem(["claude", "models", "strong"], "claude opus")).toBe("A model name has no spaces, like sonnet or claude-opus-5-5.");
    expect(settingProblem(["claude", "models", "strong"], "opus[1m]")).toBeNull();
    // Never a flag, a control character or an endless name: the name is passed to claude --model.
    expect(settingProblem(["claude", "models", "strong"], "--dangerously-skip-permissions")).toBe("A model name does not start with -, like sonnet or claude-opus-5-5.");
    expect(settingProblem(["claude", "models", "strong"], "opus\u0000")).toBe("A model name has only printable characters, like sonnet or claude-opus-5-5.");
    expect(settingProblem(["claude", "models", "strong"], "opus\u007f")).toBe("A model name has only printable characters, like sonnet or claude-opus-5-5.");
    expect(settingProblem(["claude", "models", "strong"], "o".repeat(201))).toBe("A model name is at most 200 characters long.");
    expect(settingProblem(["claude", "models", "strong"], "o".repeat(200))).toBeNull();
    expect(settingProblem(["claude", "models", "strong"], "claude-opus-5-5")).toBeNull();
    expect(settingProblem(["stages", "build", "model"], null)).not.toBeNull();
    expect(settingProblem(["claude", "models", "cheap"], null)).not.toBeNull();
    expect(settingProblem(["stages", "build", "model"], "opus")).not.toBeNull();
    expect(settingProblem(["stages", "build", "model"], "max")).toBeNull();
    expect(settingProblem(["stages", "verify", "steps", "done-check"], null)).toBeNull();
    expect(settingProblem(["chat", "steps", "write-intent"], "cheap")).toBeNull();
  });

  test("a step set in the template's flow-style stages loads, and every comment line stays", () => {
    const r = applySetting("loopstra/config.yaml", TEMPLATE, ["stages", "design", "steps", "intake"], "max");
    if (!r.ok) throw new Error(r.problem);
    expect(stepModel(validateConfig(parse(r.text)), "intake")).toBe("max");
    for (const line of TEMPLATE.split("\n").filter((l) => l.trim().startsWith("#"))) expect(r.text).toContain(line.trim());
    // Unset again, it loads with the built-in default.
    const back = applySetting("loopstra/config.yaml", r.text, ["stages", "design", "steps", "intake"], null);
    if (!back.ok) throw new Error(back.problem);
    expect(stepModel(validateConfig(parse(back.text)), "intake")).toBe("cheap");
  });

  test("a named model keeps the name as given", () => {
    const r = applySetting("loopstra/config.yaml", TEMPLATE, ["claude", "models", "strong"], "opus[1m]");
    if (!r.ok) throw new Error(r.problem);
    expect(validateConfig(parse(r.text)).claude.models.strong).toBe("opus[1m]");
  });

  test("a config that would not load is a problem, not text", () => {
    const r = applySetting("loopstra/config.yaml", "version: 1\ncommands: nope\n", ["chat", "model"], "strong");
    expect(r.ok).toBe(false);
    expect(applySetting("loopstra/config.yaml", "version: [\n", ["chat", "model"], "strong").ok).toBe(false);
  });

  test("the version is the file's sha256", () => {
    expect(configVersion("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });
});
