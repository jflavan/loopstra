import { expect, test } from "bun:test";
import { CHAT_STEPS, CONTINUES_BUILD, READ_ONLY_STEPS, toolProblem, type TeamWay } from "../../src/agents";
import { validateConfig, type StepAgents } from "../../src/config";

test("the step sets", () => {
  expect([...READ_ONLY_STEPS].some((k) => ["build", "reconcile", "fix", "revise"].includes(k))).toBe(false);
  expect(READ_ONLY_STEPS.has("review")).toBe(true);
  expect([...CONTINUES_BUILD]).toEqual(["fix", "reconcile", "revise"]);
  expect([...CHAT_STEPS]).toEqual(["orchestrator", "write-intent"]);
});

test("toolProblem names why a rule is refused", () => {
  expect(toolProblem("Bash(git)", false)).toBe("only Loopstra commits, branches, merges and pushes; git is not allowed");
  expect(toolProblem("Bash(git *)", false)).toBe("only Loopstra commits, branches, merges and pushes; git is not allowed");
  expect(toolProblem("Bash(git status *)", true)).toBeNull();
  expect(toolProblem("Write(src/*)", true)).toBe("Write would let it change files");
  expect(toolProblem("Bash(*)", true)).toBe("a bare Bash rule would let it run anything");
  expect(toolProblem("Edit", false)).toBeNull();
});

test("a team keeps its way", () => {
  const way: TeamWay = "pick";
  const cfg = validateConfig({ version: 1, commands: { test: "bun test" }, agents: { teams: { r: { members: ["a"], way } } } });
  const all: StepAgents = cfg.agents.all;
  expect(cfg.agents.teams.r).toEqual({ members: ["a"], way: "pick" });
  expect(all.tools).toEqual([]);
});
