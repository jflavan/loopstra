import { expect, test } from "bun:test";
import { BUILTIN_AGENTS, CONTINUES_BUILD, inlineName, type Team, type TeamWay, CHAT_STEPS, READ_ONLY_STEPS, isEmptySetup, resolveSetup, setupLines, toolProblem, type AgentSetup } from "../../src/agents";
import { validateConfig } from "../../src/config";

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

test("toolProblem sees a wildcard in git's or its subcommand's place, and the words before git", () => {
  const why = (r: string) => toolProblem(r, false);
  expect(why("Bash(git c*)")).toBe("only Loopstra commits, branches, merges and pushes; git commit is not allowed");
  expect(why("Bash(git st*)")).toBe("only Loopstra commits, branches, merges and pushes; git stash is not allowed");
  expect(why("Bash(git * *)")).toBe("only Loopstra commits, branches, merges and pushes; git is not allowed");
  expect(why("Bash(g* push *)")).toBe("only Loopstra commits, branches, merges and pushes; git push is not allowed");
  expect(why("Bash(env git push *)")).toBe("only Loopstra commits, branches, merges and pushes; git push is not allowed");
  for (const r of ["Bash(env -i git push *)", "Bash(GIT_DIR=. git reset *)", "Bash(command git tag *)", "Bash(A=1 B=2 git checkout *)"]) {
    expect(why(r)).toMatch(/^only Loopstra commits/);
  }
  // A wildcard that matches no history-changing subcommand is a reading rule.
  for (const r of ["Bash(git d*)", "Bash(git l*)", "Bash(env FOO=1 bun test *)"]) expect(why(r)).toBeNull();
});

test("toolProblem: a read-only step refuses every Bash rule that matches anything, and MultiEdit", () => {
  for (const r of ["Bash", "Bash()", "Bash(*)", "Bash(:*)", "Bash(**)", "Bash( * )"]) {
    expect(toolProblem(r, true)).toBe("a bare Bash rule would let it run anything");
    // A writing step may run anything, as before; only git is held back.
    expect(toolProblem(r, false)).toBeNull();
  }
  expect(toolProblem("MultiEdit", true)).toBe("MultiEdit would let it change files");
  expect(toolProblem("Bash(gh issue view *)", true)).toBeNull();
});

const agents = (over: object = {}) => validateConfig({ version: 1, commands: { test: "t" }, agents: over }).agents;

test("all, then stage skills, then the step's own; each name once", () => {
  const a = agents({ all: { skills: ["house"], mcp_tools: ["mcp__docs"] }, steps: { review: { skills: ["threat", "house"], subagents: ["Explore"], agent: "lead" } } });
  expect(resolveSetup(a, "review", ["stage-skill"])).toEqual({ sources: "all", agent: "lead", subagents: ["Explore"], teams: [], skills: ["house", "stage-skill", "threat"], tools: [], mcpTools: ["mcp__docs"] });
});

test("fix, reconcile and revise run as the build's agent; chat steps never get all", () => {
  const a = agents({ all: { skills: ["house"], tools: ["WebFetch"] }, steps: { build: { agent: "senior" }, orchestrator: { skills: ["chat-tone"] } } });
  expect(resolveSetup(a, "fix", []).agent).toBe("senior");
  expect(resolveSetup(a, "revise", []).skills).toEqual(["house"]);
  expect(resolveSetup(a, "orchestrator", [])).toMatchObject({ agent: null, skills: ["chat-tone"], tools: [] });
});

test("the step's own agent wins over all's; build's agent falls back to all's; chat steps ignore all's", () => {
  const a = agents({ all: { agent: "general" }, steps: { review: { agent: "lead" } } });
  expect(resolveSetup(a, "review", []).agent).toBe("lead");
  expect(resolveSetup(a, "plan", []).agent).toBe("general");
  expect(resolveSetup(a, "fix", []).agent).toBe("general");
  expect(resolveSetup(a, "orchestrator", []).agent).toBeNull();
});

test("teams resolve to their members; an empty setup is empty", () => {
  const a = agents({ teams: { reviewers: { members: ["sec", "perf"], way: "parallel" } }, steps: { review: { teams: ["reviewers"] } } });
  expect(resolveSetup(a, "review", []).teams).toEqual([{ name: "reviewers", members: ["sec", "perf"], way: "parallel" }]);
  expect(isEmptySetup(resolveSetup(agents(), "build", []))).toBe(true);
  expect(isEmptySetup(resolveSetup(agents({ sources: "repo" }), "build", []))).toBe(false);
});

test("prompt lines: skills as today, then subagents and teams by their inline names", () => {
  const s = { sources: "all", agent: null, subagents: ["Explore", "test-writer"], teams: [{ name: "reviewers", members: ["sec", "perf"], way: "parallel" }], skills: ["a", "b"], tools: [], mcpTools: [] } as AgentSetup;
  const lines = setupLines(s, (n) => (n === "test-writer" ? "Writes tests" : null));
  expect(lines).toStartWith("Use these skills: `a`, `b`.\n\n");
  expect(lines).toContain("`Explore`");
  expect(lines).toContain("`loopstra-test-writer` (Writes tests)");
  expect(lines).toContain("`loopstra-sec`, `loopstra-perf`");
  expect(lines).toContain("same task");
  expect(lines).toContain("structured output");
  expect(lines).toEndWith("\n\n");
  expect(setupLines({ ...s, subagents: [], teams: [] }, () => null)).toBe("Use these skills: `a`, `b`.\n\n");
  expect(setupLines({ ...s, skills: [], subagents: [], teams: [] }, () => null)).toBe("");
  const pick = setupLines({ ...s, subagents: [], teams: [{ name: "t", members: ["x"], way: "pick" }] }, () => null);
  expect(pick).toContain("fits");
});

test("inline names: built-ins keep theirs, others get the loopstra prefix", () => {
  const way: TeamWay = "pick";
  const team: Team = { name: "t", members: ["x"], way };
  expect(team.way).toBe("pick");
  expect(inlineName("a:b")).toBe("loopstra-a-b");
  expect(BUILTIN_AGENTS.has("Explore")).toBe(true);
  expect(BUILTIN_AGENTS.has("test-writer")).toBe(false);
});
