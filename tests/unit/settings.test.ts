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

  test("agents paths are writable settings; others are not", () => {
    expect(settingPath("agents.steps.review.teams")).toEqual(["agents", "steps", "review", "teams"]);
    expect(settingPath("agents.all.mcp_tools")).toEqual(["agents", "all", "mcp_tools"]);
    expect(settingPath("agents.teams.reviewers.way")).toEqual(["agents", "teams", "reviewers", "way"]);
    expect(settingPath("agents.teams.reviewers")).toEqual(["agents", "teams", "reviewers"]);
    expect(settingPath("agents.sources")).toEqual(["agents", "sources"]);
    expect(settingPath("agents.steps.review")).toEqual(["agents", "steps", "review"]);
    for (const p of ["agents.steps.nope.agent", "agents.steps.review.model", "agents.teams.Bad.way", "agents.teams.reviewers.skills", "agents.all", "agents", "agents.sources.x", "agents.all.agent.x"]) {
      expect(settingPath(p)).toBeNull();
    }
  });

  test("list fields take lists, scalars take strings", () => {
    expect(settingProblem(["agents", "steps", "review", "skills"], "house")).toBe("agents.steps.review.skills takes a list of names.");
    expect(settingProblem(["agents", "steps", "review", "agent"], ["a"])).toBe("agents.steps.review.agent takes one name.");
    expect(settingProblem(["agents", "steps", "review", "skills"], ["a"])).toBeNull();
    expect(settingProblem(["agents", "teams", "r", "members"], ["a"])).toBeNull();
    // An empty list removes a step's list, but a team without members is not a team.
    expect(settingProblem(["agents", "teams", "r", "members"], [])).toBe("A team needs at least one member.");
    expect(settingProblem(["agents", "teams", "r", "way"], "pick")).toBeNull();
    expect(settingProblem(["agents", "steps", "review"], null)).toBeNull();
    expect(settingProblem(["agents", "steps", "review"], "x")).toBe("agents.steps.review can only be removed.");
    expect(settingProblem(["stages", "verify", "steps", "done-check"], ["max"])).not.toBeNull();
  });

  test("applySetting writes flow lists and prunes empty maps", () => {
    const base = "version: 1\ncommands:\n  test: bun test\n";
    const a = applySetting("c.yaml", base, ["agents", "steps", "review", "skills"], ["a", "b"]);
    expect(a.ok).toBe(true);
    const text = (a as { text: string }).text;
    expect(parse(text).agents.steps.review.skills).toEqual(["a", "b"]);
    expect(text).toMatch(/skills: \[.*a.*b.*\]/);
    const b = applySetting("c.yaml", text, ["agents", "steps", "review", "skills"], null);
    expect(b.ok && b.text).toBe(base);
    const c = applySetting("c.yaml", base, ["agents", "steps", "review", "tools"], ["Edit"]);
    expect(c).toEqual({ ok: false, problem: expect.stringContaining("review is read-only") });
    const d = applySetting("c.yaml", base, ["agents", "steps", "review", "agent"], "general-purpose");
    expect(d).toEqual({ ok: false, problem: expect.stringContaining("built-in agent") });
    const e = applySetting("c.yaml", base, ["agents", "steps", "review", "teams"], ["nope"]);
    expect(e).toEqual({ ok: false, problem: expect.stringContaining("there is no team nope") });
  });

  test("an empty list removes the key like null and prunes the maps", () => {
    const base = "version: 1\ncommands:\n  test: bun test\n";
    const a = applySetting("c.yaml", base, ["agents", "steps", "review", "skills"], ["x"]);
    const b = applySetting("c.yaml", (a as { text: string }).text, ["agents", "steps", "review", "skills"], []);
    expect(b.ok && b.text).toBe(base);
  });

  test("removing a team or step removes the maps it leaves empty", () => {
    const base = "version: 1\ncommands:\n  test: bun test\n";
    const a = applySetting("c.yaml", base, ["agents", "teams", "rs", "members"], ["lead"]);
    expect(a.ok).toBe(true);
    const b = applySetting("c.yaml", (a as { text: string }).text, ["agents", "teams", "rs"], null);
    expect(b.ok && b.text).toBe(base);
    const c = applySetting("c.yaml", base, ["agents", "sources"], "repo");
    const d = applySetting("c.yaml", (c as { text: string }).text, ["agents", "sources"], null);
    expect(d.ok && d.text).toBe(base);
  });
});
