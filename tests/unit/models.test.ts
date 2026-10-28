import { expect, test } from "bun:test";
import { validateConfig } from "../../src/config";
import { Envelopes, type PhaseName } from "../../src/envelopes";
import { STAGE_NAMES, STEPS, STEP_KEYS, groupModel, ownStepModel, stepModel, stepsOf, withModels, type StepKey } from "../../src/models";
import { DEFAULTS } from "../../src/setup/defaults";

const BASE = { version: 1, commands: { test: "x" } };

test("every step's default is today's model", () => {
  const got = Object.fromEntries(STEP_KEYS.map((k) => [k, stepModel(DEFAULTS, k)]));
  expect(got).toEqual({
    intake: "cheap", design: "strong", "spec-check": "strong", plan: "strong", "plan-challenge": "strong",
    acceptance: "default", build: "default", reconcile: "default", fix: "default", review: "strong", revise: "default",
    verify: "default", "done-check": "strong", lessons: "cheap", orchestrator: "default", "write-intent": "strong",
  });
});

test("a step that follows a stage moves with it", () => {
  const cfg = validateConfig({ ...BASE, stages: { build: { model: "strong" } } });
  expect([stepModel(cfg, "acceptance"), stepModel(cfg, "reconcile"), stepModel(cfg, "fix"), stepModel(cfg, "revise")]).toEqual(["strong", "strong", "strong", "strong"]);
});

test("a step's own setting wins", () => {
  const cfg = validateConfig({ ...BASE, stages: { verify: { steps: { "done-check": "max" } } }, chat: { steps: { "write-intent": "cheap" } } });
  expect(stepModel(cfg, "done-check")).toBe("max");
  expect(stepModel(cfg, "write-intent")).toBe("cheap");
  expect(ownStepModel(cfg, "lessons")).toBeNull();
});

test("nothing is on max unless a person put it there", () => {
  expect(STEP_KEYS.map((k) => stepModel(DEFAULTS, k))).not.toContain("max");
  expect(STAGE_NAMES.map((s) => DEFAULTS.stages[s].model)).not.toContain("max");
  expect(DEFAULTS.chat.model).not.toBe("max");
  expect(DEFAULTS.claude.models.max).toBe("fable");
});

test("every agent phase name is a step key", () => {
  // Type-level: this assignment compiles only while every PhaseName is a StepKey. Runtime: every Envelopes key is in STEP_KEYS.
  const names: readonly StepKey[] = Object.keys(Envelopes) as PhaseName[];
  for (const name of names) expect(STEP_KEYS).toContain(name);
});

test("the table lists every step key once, and each stage its own steps", () => {
  expect(STEPS.map((s) => s.key)).toEqual([...STEP_KEYS]);
  expect(stepsOf("verify").map((s) => s.key)).toEqual(["verify", "done-check", "lessons"]);
  expect(stepsOf("chat").map((s) => s.key)).toEqual(["orchestrator", "write-intent"]);
  expect(stepsOf("build").map((s) => s.key)).toEqual(["acceptance", "build", "reconcile", "fix"]);
});

test("a group's model is its stage's, or chat's", () => {
  const cfg = validateConfig({ ...BASE, stages: { plan: { model: "cheap" } }, chat: { model: "strong" } });
  expect(groupModel(cfg, "plan")).toBe("cheap");
  expect(groupModel(cfg, "chat")).toBe("strong");
});

test("withModels takes the model settings and keeps the rest", () => {
  const base = validateConfig({ ...BASE, poll_seconds: 5, stages: { build: { max_fix_loops: 7 } } });
  const fresh = validateConfig({ ...BASE, agents: { all: { skills: ["house"] } }, claude: { models: { max: "x" } }, stages: { build: { model: "strong", steps: { fix: "max" } } }, chat: { model: "cheap", steps: { "write-intent": "max" } } });
  const got = withModels(base, fresh);
  expect(got.poll_seconds).toBe(5);
  expect(got.stages.build.max_fix_loops).toBe(7);
  expect(got.stages.build.model).toBe("strong");
  expect(got.stages.build.steps).toEqual({ fix: "max" });
  expect(got.claude.models.max).toBe("x");
  expect(got.chat).toMatchObject({ model: "cheap", steps: { "write-intent": "max" } });
  expect(got.agents).toBe(fresh.agents);
});
