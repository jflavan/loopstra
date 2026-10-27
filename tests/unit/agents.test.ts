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

test("toolProblem sees through git spellings, and leaves other tools alone", () => {
  const why = (r: string) => toolProblem(r, false);
  for (const r of ["Bash(git push:*)", "Bash(git push*)", "Bash(git commit*)", "Bash(git reset:*)", "Bash(git -C . push *)", "Bash(git -c k=v commit *)", "Bash( git push *)", "Bash(git --git-dir=x push)", "Bash(git --no-pager stash *)"]) {
    expect(why(r)).toMatch(/^only Loopstra commits/);
  }
  expect(why("Bash(git -C . push *)")).toBe("only Loopstra commits, branches, merges and pushes; git push is not allowed");
  for (const r of ["Bash(git:*)", "Bash(git*)", "Bash(git -C .)", "Bash(git -P *)"]) {
    expect(why(r)).toBe("only Loopstra commits, branches, merges and pushes; git is not allowed");
  }
  for (const r of ["Bash(gitk *)", "Bash(gitleaks detect)", "Bash(git diff *)", "Bash(git -C . log *)", "Bash(git status:*)"]) {
    expect(why(r)).toBeNull();
  }
});
