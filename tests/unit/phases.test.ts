import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { agentPhase, alongside, alongsideFirst, codePhase, commandsFor, CONTRACT_LINES, CONVERSATION_HEADING, disallowedFor, ownerNote, projectCommand, toolsFor, withContract } from "../../src/phases";
import { activePause, pauseAfterUnavailable, readPause } from "../../src/heartbeat";
import { onCheckout, oneMerge, realPathKey } from "../../src/lanes";
import { AssistantUnavailable, QuestionAsked, SessionStopped, StopRequested } from "../../src/stop";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE as FAKE, setEnv, tempGitRepo, TEMPLATES } from "../helpers";

const CONTRACT = CONTRACT_LINES.join("\n\n");

async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "Intent for {{slug}}:\n{{intent}}\n");
  mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("intent");
  const restoreEnv = setEnv({ LOOPSTRA_CLAUDE_EXECUTABLE: FAKE });
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const ctx = new StepContext(repo.path, cfg, trace, await readIntent(repo.path, "x"));
  return { repo: { path: repo.path, cleanup: () => { restoreEnv(); repo.cleanup(); } }, ctx, trace };
}

describe("agentPhase", () => {
  test("renders the prompt, runs claude, validates the envelope, persists files, and traces", async () => {
    const { repo, ctx, trace } = await setup();
    const r = await agentPhase(ctx, {
      name: "intake", model: "cheap", permissionMode: "default", tools: "read",
      vars: { intent: ctx.intent.file.body },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.priority).toBe("high");
      expect(r.sessionId).toBe("fake-intake");
    }
    const phaseDir = join(repo.path, ".loopstra", "runs", "x", "phases", "1-intake");
    expect(existsSync(join(phaseDir, "prompt.md"))).toBe(true);
    expect(existsSync(join(phaseDir, "raw.jsonl"))).toBe(true);
    expect(existsSync(join(phaseDir, "envelope.json"))).toBe(true);
    expect(await Bun.file(join(phaseDir, "prompt.md")).text()).toContain("Intent for x:");
    const phases = trace.phases("x");
    expect(phases[0]?.name).toBe("intake");
    expect(phases[0]?.status).toBe("success");
    expect(phases[0]?.cost_usd).toBeCloseTo(0.002);
    trace.close(); repo.cleanup();
  });

  test("a phase with no prompt of the repository's own uses the shipped one", async () => {
    const { repo, ctx, trace } = await setup();
    rmSync(join(repo.path, "loopstra", "prompts", "intake.md"), { force: true });
    const r = await agentPhase(ctx, { name: "intake", model: "strong", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(true);
    expect(await Bun.file(join(repo.path, ".loopstra", "runs", "x", "phases", "1-intake", "prompt.md")).text()).toContain("You are the intake step");
    trace.close(); repo.cleanup();
  });

  test("an envelope that fails validation is a failure with the phase recorded as fail", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "design.md"), "x FIXTURE:intake");
    const r = await agentPhase(ctx, { name: "design", model: "strong", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    expect(trace.phases("x")[0]?.status).toBe("fail");
    trace.close(); repo.cleanup();
  });
});

describe("agentPhase tools and prompt", () => {
  test("read-only phases get read tools and lose the write tools; read+commands allows configured commands with arguments, not install", async () => {
    const { repo, ctx, trace } = await setup();
    ctx.cfg.commands.run = "bun run start";
    ctx.cfg.commands.install = "bun install";
    expect(toolsFor(ctx, "read")).toEqual(["Read", "Glob", "Grep"]);
    const gitRead = ["Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"];
    expect(toolsFor(ctx, "read+commands")).toEqual(["Read", "Glob", "Grep", "Bash(echo ok *)", "Bash(bun run start *)", ...gitRead]);
    expect(toolsFor(ctx, "read+git")).toEqual(["Read", "Glob", "Grep", ...gitRead]);
    // PowerShell is removed everywhere, so shell commands go through Bash, which the allow rules cover.
    expect(disallowedFor("read")).toEqual(["Edit", "Write", "NotebookEdit", "PowerShell"]);
    expect(disallowedFor("read+git")).toEqual(["Edit", "Write", "NotebookEdit", "PowerShell"]);
    expect(disallowedFor("read+commands")).toEqual(["Edit", "Write", "NotebookEdit", "PowerShell"]);
    expect(disallowedFor("build")).toEqual(["PowerShell"]);
    const build = toolsFor(ctx, "build");
    build.push("Bash(rm *)");
    expect(ctx.cfg.claude.allowed_tools).not.toContain("Bash(rm *)");

    const argsFile = join(repo.path, "args.json");
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.args).toEqual(expect.arrayContaining(["--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Edit,Write,NotebookEdit,PowerShell"]));
    trace.close(); repo.cleanup();
  });

  test("build sessions may run the project's configured commands, install included, on top of claude.allowed_tools", async () => {
    const { repo, ctx, trace } = await setup();
    ctx.cfg.commands.test = "npm test";
    ctx.cfg.commands.install = "npm install";
    ctx.cfg.commands.lint = "bun"; // Bash(bun *) is in the default allowed_tools already: not repeated
    const tools = toolsFor(ctx, "build");
    expect(tools.slice(0, ctx.cfg.claude.allowed_tools.length)).toEqual(ctx.cfg.claude.allowed_tools);
    expect(tools).toEqual(expect.arrayContaining(["Bash(npm test *)", "Bash(npm install *)", "Bash(bun *)"]));
    expect(new Set(tools).size).toBe(tools.length);

    const argsFile = join(repo.path, "args.json");
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "acceptEdits", tools: "build", vars: {}, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
    const recorded = await Bun.file(argsFile).json();
    const allowed = (recorded.args[recorded.args.indexOf("--allowedTools") + 1] as string).split(",");
    expect(allowed).toContain("Bash(npm test *)");
    trace.close(); repo.cleanup();
  });

  test("a chained command also allows each of its parts, since Claude Code checks each part on its own", async () => {
    const { repo, ctx, trace } = await setup();
    ctx.cfg.commands.test = "dotnet test api/App.sln && npm --prefix web test || echo failed; npm --prefix e2e test";
    // A pipe is not split: its right side (tee) would let a read-only judge write files.
    ctx.cfg.commands.build = "npm run build 2>&1 | tee build.log";
    // Operators inside quotes, or escaped, are part of an argument, not a chain.
    ctx.cfg.commands.lint = `bun -e "a && b; c \\" ;" && echo 'x || y' && echo a\\;b`;
    const judge = toolsFor(ctx, "read+commands");
    expect(judge).toEqual(expect.arrayContaining([
      `Bash(${ctx.cfg.commands.test} *)`,
      "Bash(dotnet test api/App.sln *)", "Bash(npm --prefix web test *)", "Bash(echo failed *)", "Bash(npm --prefix e2e test *)",
      "Bash(npm run build 2>&1 | tee build.log *)",
      `Bash(bun -e "a && b; c \\" ;" *)`, "Bash(echo 'x || y' *)", "Bash(echo a\\;b *)",
    ]));
    expect(judge).not.toContain("Bash(b *)");
    expect(judge).not.toContain("Bash(tee build.log *)");
    expect(commandsFor(ctx, "read+commands")).toContain("`dotnet test api/App.sln`, `npm --prefix web test`, `echo failed`, `npm --prefix e2e test`");
    expect(new Set(judge).size).toBe(judge.length);
    expect(toolsFor(ctx, "build")).toEqual(expect.arrayContaining(["Bash(dotnet test api/App.sln *)", "Bash(npm --prefix e2e test *)"]));
    // A plain command gets just its one rule.
    ctx.cfg.commands.test = "echo ok";
    ctx.cfg.commands.build = undefined;
    ctx.cfg.commands.lint = undefined;
    expect(toolsFor(ctx, "read+commands")).toEqual(["Read", "Glob", "Grep", "Bash(echo ok *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)", "Bash(git status *)"]);
    trace.close(); repo.cleanup();
  });

  test("skills are prepended as one line; slug, main_branch and commands are always set; the contract ends every prompt", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "slug={{slug}} main={{main_branch}} commands={{commands}}\n");
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, skills: ["brand", "tone"] });
    const prompt = await Bun.file(join(repo.path, ".loopstra", "runs", "x", "phases", "1-intake", "prompt.md")).text();
    expect(prompt).toBe(`Use these skills: \`brand\`, \`tone\`.\n\nslug=x main=main commands=none\n\n${CONTRACT}\n`);
    trace.close(); repo.cleanup();
  });

  test("a user's prompt that still ends with the contract does not get it twice", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), `Do the thing.\n\n${CONTRACT}\n\n`);
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    const prompt = await Bun.file(join(repo.path, ".loopstra", "runs", "x", "phases", "1-intake", "prompt.md")).text();
    expect(prompt).toBe(`Do the thing.\n\n${CONTRACT}\n`);
    // Only the last line left: still one copy of each.
    expect(withContract("Do it.\n\nRespond only through the structured output.")).toBe(`Do it.\n\n${CONTRACT}\n`);
    // The words inside a sentence are not a copy.
    expect(withContract("Never say: Respond only through the structured output. Ok")).toStartWith("Never say: Respond only through the structured output. Ok\n\n");
    trace.close(); repo.cleanup();
  });

  test("commands lists exactly the shell commands the tool set allows", async () => {
    const { repo, ctx, trace } = await setup();
    ctx.cfg.commands.run = "bun run start";
    ctx.cfg.commands.install = "bun install";
    expect(commandsFor(ctx, "read")).toBe("none");
    expect(commandsFor(ctx, "read+git")).toBe("`git diff`, `git log`, `git show`, `git status`");
    expect(commandsFor(ctx, "read+commands")).toBe("`echo ok`, `bun run start`, `git diff`, `git log`, `git show`, `git status`");
    ctx.cfg.claude.allowed_tools = ["Read", "Edit", "Bash(npm run lint:*)"];
    expect(commandsFor(ctx, "build")).toBe("`npm run lint`, `echo ok`, `bun run start`, `bun install`");
    ctx.cfg.claude.allowed_tools = ["Read", "Bash"];
    expect(commandsFor(ctx, "build")).toBe("any command");
    trace.close(); repo.cleanup();
  });
});

describe("conversation.md in the prompt", () => {
  const RECORD = "# Conversation\n\n## 2026-10-17 09:00 · John (the dashboard) → build\nUse the CSV parser.\n";
  const design = { name: "design" as const, model: "default" as const, permissionMode: "default" as const, tools: "read" as const, vars: { intent: "i" } };
  const prompt = (repo: { path: string }, dir: string) => Bun.file(join(repo.path, ".loopstra", "runs", "x", "phases", dir, "prompt.md")).text();
  const shipped = (repo: { path: string }, name: string) => copyFileSync(join(TEMPLATES, `${name}.md`), join(repo.path, "loopstra", "prompts", `${name}.md`));

  test("a work session's prompt has what people told earlier sessions; a check's does not", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      shipped(repo, "design");
      shipped(repo, "spec-check");
      await Bun.write(join(repo.path, "intent", "x", "conversation.md"), RECORD);
      await agentPhase(ctx, design);
      await agentPhase(ctx, { ...design, name: "spec-check", vars: { intent: "i", spec: "s" } });
      const work = await prompt(repo, "1-design");
      expect(work).toContain(`${CONVERSATION_HEADING}\n\n${RECORD}`);
      expect(work.split("Use the CSV parser.")).toHaveLength(2);
      const judged = await prompt(repo, "2-spec-check");
      expect(judged).not.toContain("Use the CSV parser.");
      expect(judged).not.toContain(CONVERSATION_HEADING);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("with no record, the prompt says (none) there", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      shipped(repo, "design");
      await agentPhase(ctx, design);
      expect(await prompt(repo, "1-design")).toContain(`${CONVERSATION_HEADING}\n\n(none)\n`);
    } finally {
      trace.close(); repo.cleanup();
    }
  });

  test("a repository prompt without {{conversation}} gets the record at its end, and nothing when there is none", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "design.md"), "Write the spec for {{slug}}.\n");
      await agentPhase(ctx, design);
      expect(await prompt(repo, "1-design")).toBe(`Write the spec for x.\n\n${CONTRACT}\n`);
      await Bun.write(join(repo.path, "intent", "x", "conversation.md"), RECORD);
      await agentPhase(ctx, design);
      expect(await prompt(repo, "2-design")).toBe(`Write the spec for x.\n\n${CONVERSATION_HEADING}\n\n${RECORD}\n${CONTRACT}\n`);
    } finally {
      trace.close(); repo.cleanup();
    }
  });
});

describe("agentPhase failures", () => {
  test("passes LOOPSTRA_PHASE and LOOPSTRA_SLUG to the session", async () => {
    const { repo, ctx, trace } = await setup();
    const argsFile = join(repo.path, "args.json");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
    expect(r.ok).toBe(true);
    const recorded = await Bun.file(argsFile).json();
    expect(recorded.env.LOOPSTRA_PHASE).toBe("intake");
    trace.close(); repo.cleanup();
  });

  test("an envelope with status fail is an agent-fail with a plain note; the agent's summary goes to the trace", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:agent-fail");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("agent-fail");
      expect(r.note).toBe("The assistant reported it could not finish this step.");
    }
    expect(trace.phases("x").map((p) => p.name)).toEqual(["intake"]);
    expect(trace.phases("x")[0]?.error).toContain("The intent folder could not be read");
    trace.close(); repo.cleanup();
  });

  test("a crash is retried once as a separate traced attempt, then reported plainly", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:crash");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("crash");
      expect(r.note).toBe("The assistant stopped unexpectedly.");
    }
    const phases = trace.phases("x");
    expect(phases.map((p) => `${p.name}:${p.status}`)).toEqual(["intake:fail", "intake-retry:fail"]);
    expect(phases[0]?.error).toMatch(/^crash: /);
    expect(existsSync(join(repo.path, ".loopstra", "runs", "x", "phases", "2-intake-retry", "prompt.md"))).toBe(true);
    trace.close(); repo.cleanup();
  });

  test("with retry: false, a crash or a timeout is not retried", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:crash");
      const crashed = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, retry: false });
      expect(crashed.ok || crashed.reason).toBe("crash");
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:hang");
      ctx.cfg.claude.timeout_minutes = 0.02;
      const timedOut = await agentPhase(ctx, { name: "intake", traceName: "intake-2", model: "cheap", permissionMode: "default", tools: "read", vars: {}, retry: false });
      expect(timedOut.ok || timedOut.reason).toBe("timeout");
      expect(trace.phases("x").map((p) => `${p.name}:${p.status}`)).toEqual(["intake:fail", "intake-2:fail"]);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a budget failure is not retried", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:budget");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("budget");
      expect(r.note).toBe("This step hit its spending limit (claude.max_budget_usd). An engineer can raise or remove it with `loopstra setup budgets`.");
    }
    expect(trace.phases("x").map((p) => p.name)).toEqual(["intake"]);
    trace.close(); repo.cleanup();
  });

  test("the timeout note names the setting", () => {
    expect(ownerNote("timeout")).toBe("The assistant took too long on this step. An engineer can allow longer with claude.timeout_minutes in loopstra/config.yaml.");
  });

  test("with no claude.max_budget_usd, a session gets no --max-budget-usd", async () => {
    const { repo, ctx, trace } = await setup();
    const argsFile = join(repo.path, ".loopstra", "args.json");
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
    expect((await Bun.file(argsFile).json()).args).not.toContain("--max-budget-usd");
    trace.close(); repo.cleanup();
  });

  test("commands the session was not allowed to run are recorded on the phase", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:denied");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(true);
    const end = trace.events("x").find((e) => e.type === "phase_end")!;
    expect(JSON.parse(end.payload).denied).toEqual(["Bash(git tag v1)", "Write(/repo/notes.txt)"]);
    expect(trace.deniedCommands("x").get(1)).toEqual(["Bash(git tag v1)", "Write(/repo/notes.txt)"]);
    trace.close(); repo.cleanup();
  });

  test("a failed phase with denied commands keeps the owner note plain and names them in the trace", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:denied-fail");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.note).toBe("The assistant reported it could not finish this step.");
    expect(trace.phases("x")[0]?.error).toContain("not allowed: Bash(git push origin main)");
    trace.close(); repo.cleanup();
  });

  test("a failed fix names the test files it was not allowed to edit", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "fix.md"), "x FIXTURE:fix-refused");
    const r = await agentPhase(ctx, { name: "fix", model: "default", permissionMode: "acceptEdits", tools: "build", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("agent-fail");
      expect(r.note).toBe(`The assistant reported it could not finish this step. It was not allowed to edit this test file, which this branch did not add or edit: \`tests/old.test.ts\`. If the test is wrong, an engineer can fix it on the branch ${ctx.branch}.`);
    }
    trace.close(); repo.cleanup();
  });

  test("an unavailable assistant is not the phase's failure: the phase is interrupted, not retried, and the step is told", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:outage");
    let thrown: unknown;
    try {
      await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(AssistantUnavailable);
    expect((thrown as AssistantUnavailable).detail).toContain("Please run /login");
    expect(trace.phases("x").map((p) => `${p.name}:${p.status}`)).toEqual(["intake:interrupted"]);
    expect(trace.phases("x")[0]?.error).toMatch(/^environment: /);
    trace.close(); repo.cleanup();
  });

  test("a successful phase ends a pause's backoff", async () => {
    const { repo, ctx, trace } = await setup();
    pauseAfterUnavailable(repo.path);
    expect(readPause(repo.path)?.failures).toBe(1);
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(true);
    expect(readPause(repo.path)).toBeNull();
    trace.close(); repo.cleanup();
  });

  test("a phase of another change getting through ends the wait but keeps the paused change's cause and repeats", async () => {
    const { repo, ctx, trace } = await setup();
    const cause = { slug: "other", phase: "build", line: "Claude usage limit reached" };
    pauseAfterUnavailable(repo.path, new Date(), cause);
    pauseAfterUnavailable(repo.path, new Date(), cause);
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(true);
    expect(readPause(repo.path)).toMatchObject({ ...cause, repeats: 2, failures: 0 });
    expect(activePause(repo.path)).toBeNull();
    // The paused change's own success clears it completely.
    pauseAfterUnavailable(repo.path, new Date(), { ...cause, slug: "x" });
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(readPause(repo.path)).toBeNull();
    trace.close(); repo.cleanup();
  });

  test("a runtime error inside the phase never leaves the phase running", async () => {
    const { repo, ctx, trace } = await setup();
    mkdirSync(join(repo.path, ".loopstra", "runs", "x"), { recursive: true });
    await Bun.write(join(repo.path, ".loopstra", "runs", "x", "phases"), "not a directory");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("crash");
    expect(trace.phases("x").map((p) => p.status)).toEqual(["fail", "fail"]);
    trace.close(); repo.cleanup();
  });
});

describe("codePhase", () => {
  test("runs a function inside a traced phase and reports failure without throwing", async () => {
    const { repo, ctx, trace } = await setup();
    const ok = await codePhase(ctx, "tests", async () => ({ ok: true as const, value: 42 }));
    expect(ok).toEqual({ ok: true, value: 42 });
    const bad = await codePhase(ctx, "boom", async () => { throw new Error("kaboom"); });
    expect(bad.ok).toBe(false);
    const phases = trace.phases("x");
    expect(phases.map((p) => p.status)).toEqual(["success", "fail"]);
    expect(phases[1]?.error).toContain("kaboom");
    const odd = await codePhase(ctx, "odd", async () => { throw null; });
    expect(odd.ok).toBe(false);
    if (!odd.ok) expect(odd.detail).toContain("null");
    trace.close(); repo.cleanup();
  });

  test("a stopped session or a question inside passes on: the row ends interrupted, and the step ends quietly", async () => {
    const { repo, ctx, trace } = await setup();
    try {
      await expect(codePhase(ctx, "merge", async () => { throw new SessionStopped("John"); })).rejects.toBeInstanceOf(SessionStopped);
      await expect(codePhase(ctx, "checks", async () => { throw new QuestionAsked("fix", "Keep the old API?"); })).rejects.toBeInstanceOf(QuestionAsked);
      const phases = trace.phases("x");
      expect(phases.map((p) => p.status)).toEqual(["interrupted", "interrupted"]);
      expect(phases[0]?.error).toBe("stopped by John");
      expect(phases[1]?.error).toBe("the fix session asked: Keep the old API?");
    } finally {
      trace.close(); repo.cleanup();
    }
  });
});

describe("alongside", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const intake = (ctx: StepContext, intent = "") => agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: { intent } });
  /** A command that runs far longer than any test waits, so a test that ends in time saw it cancelled. */
  const LONG = `bun -e "setTimeout(() => {}, 30000)"`;

  test("starts both before either finishes", async () => {
    const { repo, ctx, trace } = await setup();
    const log: string[] = [];
    let bStarted = () => {};
    const started = new Promise<void>((r) => { bStarted = r; });
    const r = await alongside(
      ctx,
      () => codePhase(ctx, "a", async () => { log.push("a start"); await started; log.push("a end"); return { ok: true as const, v: 1 }; }),
      { what: "b", run: () => codePhase(ctx, "b", async () => { log.push("b start"); bStarted(); log.push("b end"); return { ok: true as const, v: 2 }; }), wanted: () => true },
    );
    expect(r.map((x) => x && x.ok && x.v)).toEqual([1, 2]);
    expect(log.indexOf("b start")).toBeLessThan(log.indexOf("a end"));
    trace.close(); repo.cleanup();
  });

  test("extra work that throws is dropped and traced; main's error is thrown once the extra settled; a stop request wins", async () => {
    const { repo, ctx, trace } = await setup();
    const [m, x] = await alongside(ctx, async () => 7, { what: "early review", run: async () => { throw new AssistantUnavailable("down"); }, wanted: () => true });
    expect([m, x]).toEqual([7, null]);
    expect(trace.events("x").some((e) => e.payload.includes("dropped") && e.payload.includes("down"))).toBe(true);
    let slowEnded = false;
    const err = await alongside(ctx, async () => { throw new AssistantUnavailable("down"); }, { what: "x", run: async () => { await tick(30); slowEnded = true; return 1; }, wanted: () => true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantUnavailable);
    expect(slowEnded).toBe(true);
    // A stop request from either wins, so the loop stops instead of pausing.
    const stop = await alongside(ctx, async () => { throw new AssistantUnavailable("down"); }, { what: "x", run: async () => { throw new StopRequested(); }, wanted: () => true }).catch((e: unknown) => e);
    expect(stop).toBeInstanceOf(StopRequested);
    trace.close(); repo.cleanup();
  });

  test("a person's stop of extra work ends the step quietly once both settled; a stop request still wins; a question from it is dropped", async () => {
    const { repo, ctx, trace } = await setup();
    let mainEnded = false;
    const stopped = await alongside(ctx, async () => { await tick(30); mainEnded = true; return 7; }, { what: "plan ahead", run: async () => { throw new SessionStopped("John"); }, wanted: () => true }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(SessionStopped);
    expect((stopped as SessionStopped).by).toBe("John");
    expect(mainEnded).toBe(true);
    const stop = await alongside(ctx, async () => { throw new StopRequested(); }, { what: "x", run: async () => { throw new SessionStopped("John"); }, wanted: () => true }).catch((e: unknown) => e);
    expect(stop).toBeInstanceOf(StopRequested);
    const later = await alongsideFirst(ctx, async () => "pass", { what: "plan ahead", run: async () => { await tick(20); throw new SessionStopped("Ana"); }, wanted: () => true });
    expect(await later.rest().catch((e: unknown) => e)).toBeInstanceOf(SessionStopped);
    // A question from work run alongside is not recorded: that work is just not used (decision 7).
    const [m, x] = await alongside(ctx, async () => 7, { what: "plan ahead", run: async () => { throw new QuestionAsked("plan", "Which?"); }, wanted: () => true });
    expect([m, x]).toEqual([7, null]);
    trace.close(); repo.cleanup();
  });

  test("alongsideFirst returns once main wants the extra, while the extra still runs; rest waits for it", async () => {
    const { repo, ctx, trace } = await setup();
    const log: string[] = [];
    let mayFinish: () => void = () => {};
    const finish = new Promise<void>((r) => { mayFinish = r; });
    const b = await alongsideFirst(ctx, async () => "pass", {
      what: "b", wanted: (m) => m === "pass",
      run: async () => {
        await codePhase(ctx, "b", async () => { log.push("b"); return { ok: true as const }; });
        await finish; // still running when main's result is recorded
        await codePhase(ctx, "b2", async () => { log.push("b2"); return { ok: true as const }; });
        return 2;
      },
    });
    expect(b.result).toBe("pass");
    log.push("main recorded");
    mayFinish();
    expect(await b.rest()).toBe(2);
    expect(log).toEqual(["b", "main recorded", "b2"]);
    trace.close(); repo.cleanup();
  });

  test("alongsideFirst waits for both when main's result does not want the extra, or throws; rest throws a stop that ended the extra", async () => {
    const { repo, ctx, trace } = await setup();
    const extra = { what: "slow", run: () => codePhase(ctx, "slow", async () => { await projectCommand(ctx, LONG, repo.path); return { ok: true as const }; }) };
    const started = Date.now();
    const notWanted = await alongsideFirst(ctx, async () => "failed", { ...extra, wanted: (m) => m !== "failed" });
    expect(await notWanted.rest()).toBeNull();
    expect(await alongsideFirst(ctx, async () => { throw new Error("main broke"); }, { ...extra, wanted: () => true }).catch((e: unknown) => e)).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(trace.phases("x").filter((p) => p.name === "slow").map((p) => p.status)).toEqual(["interrupted", "interrupted"]);
    const stopped = await alongsideFirst(ctx, async () => 1, { what: "x", run: async () => { await tick(20); throw new StopRequested(); }, wanted: () => true });
    expect(stopped.result).toBe(1);
    expect(await stopped.rest().catch((e: unknown) => e)).toBeInstanceOf(StopRequested);
    trace.close(); repo.cleanup();
  });

  test("extra work is cancelled as soon as main's result does not want it, or main throws: its command is killed", async () => {
    const { repo, ctx, trace } = await setup();
    const started = Date.now();
    const extra = { what: "slow", run: () => codePhase(ctx, "slow", async () => { await projectCommand(ctx, LONG, repo.path); return { ok: true as const }; }) };
    expect(await alongside(ctx, async () => { await tick(300); return "failed"; }, { ...extra, wanted: (m) => m !== "failed" })).toEqual(["failed", null]);
    expect(await alongside(ctx, async () => { await tick(300); throw new Error("main broke"); }, { ...extra, wanted: () => true }).catch((e: unknown) => e)).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(20_000);
    const slow = trace.phases("x").filter((p) => p.name === "slow");
    expect(slow.map((p) => [p.status, p.error])).toEqual([["interrupted", "cancelled: its result was no longer needed"], ["interrupted", "cancelled: its result was no longer needed"]]);
    expect(trace.events("x").filter((e) => e.payload.includes("cancelled")).length).toBeGreaterThanOrEqual(2);
    trace.close(); repo.cleanup();
  });

  test("a session that succeeds alongside never ends the pause while main finds the assistant unavailable", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}}\n");
    pauseAfterUnavailable(repo.path);
    pauseAfterUnavailable(repo.path);
    // Main fails only once the extra succeeded (a main that throws first cancels the extra).
    let extraEnded = () => {};
    const ended = new Promise<void>((r) => { extraEnded = r; });
    const err = await alongside(
      ctx,
      async () => { await ended; return intake(ctx, "FIXTURE:usage-limit"); },
      { what: "lessons", run: () => intake(ctx).finally(extraEnded), wanted: () => true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantUnavailable);
    expect(trace.phases("x").map((p) => p.status).sort()).toEqual(["interrupted", "success"]);
    // The scheduler counts this outage on top of the two before it.
    expect(readPause(repo.path)?.failures).toBe(2);
    // Main reached the assistant: the pause ends.
    await alongside(ctx, () => intake(ctx), { what: "lessons", run: () => intake(ctx, "FIXTURE:usage-limit"), wanted: () => true });
    expect(readPause(repo.path)).toBeNull();
    trace.close(); repo.cleanup();
  });

  test("cancelling outer extra work cancels both pieces of the alongside work inside it", async () => {
    const { repo, ctx, trace } = await setup();
    const started = Date.now();
    const slow = (name: string) => () => codePhase(ctx, name, async () => { await projectCommand(ctx, LONG, repo.path); return { ok: true as const }; });
    const [m, x] = await alongside(ctx, async () => { await tick(300); return "failed"; }, {
      what: "early review", wanted: (r) => r !== "failed",
      run: () => alongside(ctx, slow("strong"), { what: "cheap", run: slow("cheap"), wanted: () => true }),
    });
    expect([m, x]).toEqual(["failed", null]);
    expect(Date.now() - started).toBeLessThan(20_000);
    const rows = trace.phases("x").map((p) => `${p.name}:${p.status}`).sort();
    expect(rows).toEqual(["cheap:interrupted", "strong:interrupted"]);
    trace.close(); repo.cleanup();
  });

  test("a success inside nested alongside work counts for the outer group: the pause survives the outer main's outage", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}}\n");
    pauseAfterUnavailable(repo.path);
    pauseAfterUnavailable(repo.path);
    let innerEnded = () => {};
    const ended = new Promise<void>((r) => { innerEnded = r; });
    const err = await alongside(
      ctx,
      async () => { await ended; return intake(ctx, "FIXTURE:usage-limit"); },
      { what: "early review", wanted: () => true, run: () => alongside(ctx, () => intake(ctx), { what: "cheap", run: () => intake(ctx), wanted: () => true }).finally(innerEnded) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantUnavailable);
    expect(readPause(repo.path)?.failures).toBe(2);
    trace.close(); repo.cleanup();
  });

  test("a strong judge that throws inside alongsideFirst's main cancels its cheaper judge and the plan beside it", async () => {
    const { repo, ctx, trace } = await setup();
    const started = Date.now();
    const slow = (name: string) => () => codePhase(ctx, name, async () => { await projectCommand(ctx, LONG, repo.path); return { ok: true as const }; });
    const err = await alongsideFirst(
      ctx,
      () => alongside(ctx, async () => { await tick(300); throw new Error("strong broke"); }, { what: "cheap", run: slow("cheap"), wanted: () => true }),
      { what: "plan ahead", run: slow("plan"), wanted: () => true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("strong broke");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(trace.phases("x").map((p) => `${p.name}:${p.status}`).sort()).toEqual(["cheap:interrupted", "plan:interrupted"]);
    trace.close(); repo.cleanup();
  });

  test("inside alongsideFirst's main, a success counts for the outer group, which alone decides about the pause", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}}\n");
    pauseAfterUnavailable(repo.path);
    pauseAfterUnavailable(repo.path);
    // The cheaper judge got through, then the strong judge found the assistant unavailable.
    let cheapEnded = () => {};
    const ended = new Promise<void>((r) => { cheapEnded = r; });
    const err = await alongsideFirst(
      ctx,
      () => alongside(ctx, async () => { await ended; return intake(ctx, "FIXTURE:usage-limit"); }, { what: "cheap", run: () => intake(ctx).finally(cheapEnded), wanted: () => true }),
      { what: "plan ahead", run: () => intake(ctx), wanted: () => true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantUnavailable);
    expect(readPause(repo.path)?.failures).toBe(2);
    // Both judges got through, then main met an outage: the pause survives, as the outer main decides.
    const later = await alongsideFirst(
      ctx,
      async () => { await alongside(ctx, () => intake(ctx), { what: "cheap", run: () => intake(ctx), wanted: () => true }); return intake(ctx, "FIXTURE:usage-limit"); },
      { what: "plan ahead", run: async () => null, wanted: () => true },
    ).catch((e: unknown) => e);
    expect(later).toBeInstanceOf(AssistantUnavailable);
    expect(readPause(repo.path)?.failures).toBe(2);
    // The strong judge got through: once the plan is waited for, the pause ends.
    const b = await alongsideFirst(ctx, () => alongside(ctx, () => intake(ctx), { what: "cheap", run: () => intake(ctx), wanted: () => true }), { what: "plan ahead", run: () => intake(ctx), wanted: () => true });
    await b.rest();
    expect(readPause(repo.path)).toBeNull();
    trace.close(); repo.cleanup();
  });

  test("a shadow whose comparison ends after the group it ran in decided still ends the pause when its judge got through", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}}\n");
    pauseAfterUnavailable(repo.path);
    // A rejected spec: the strong judge answers, the plan beside it is called off, and the cheaper
    // judge ends only after that group decided.
    let cheapMayEnd = () => {};
    const cheapEnds = new Promise<void>((r) => { cheapMayEnd = r; });
    let shadow: { rest: () => Promise<unknown> } | null = null;
    await alongside(ctx, async () => {
      shadow = await alongsideFirst(ctx, () => intake(ctx), { what: "cheap", run: () => cheapEnds.then(() => null), wanted: () => true });
      return "rejected";
    }, { what: "plan ahead", run: async () => null, wanted: (m) => m !== "rejected" });
    expect(readPause(repo.path)).not.toBeNull();
    cheapMayEnd();
    await shadow!.rest();
    expect(readPause(repo.path)).toBeNull();
    trace.close(); repo.cleanup();
  });

  test("alongside under a lock, or a session under a checkout lock, is a programming error", async () => {
    const { repo, ctx, trace } = await setup();
    const pair = () => alongside(ctx, async () => 1, { what: "two", run: async () => 2, wanted: () => true });
    expect(String(await oneMerge.run(pair, ctx.slug).catch((e: unknown) => e))).toContain("programming error");
    expect(String(await onCheckout(repo.path, pair).catch((e: unknown) => e))).toContain("programming error");
    const first = () => alongsideFirst(ctx, async () => 1, { what: "two", run: async () => 2, wanted: () => true });
    expect(String(await onCheckout(repo.path, first).catch((e: unknown) => e))).toContain("programming error");
    expect(String(await onCheckout(repo.path, () => intake(ctx)).catch((e: unknown) => e))).toContain("programming error");
    expect(trace.phases("x")).toEqual([]);
    // Sessions may run under the merge lock (the merge checks run fix sessions).
    expect((await oneMerge.run(() => intake(ctx), ctx.slug)).ok).toBe(true);
    trace.close(); repo.cleanup();
  });
});

describe("the step's snapshot of main", () => {
  test("a read-only session runs in a snapshot of main's last commit, never the main checkout or its uncommitted files", async () => {
    const { repo, ctx, trace } = await setup();
    const args = join(repo.path, "..", `args-${Date.now()}.json`);
    const restore = setEnv({ LOOPSTRA_FAKE_ARGS: args });
    try {
      await Bun.write(join(repo.path, "uncommitted.md"), "a person's work in progress\n");
      const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: { intent: "" } });
      expect(r.ok).toBe(true);
      const snapshot = join(repo.path, ".loopstra", "snapshots", "x");
      expect(realPathKey((await Bun.file(args).json() as { cwd: string }).cwd)).toBe(realPathKey(snapshot));
      expect(existsSync(join(snapshot, "intent", "x", "intent.md"))).toBe(true);
      expect(existsSync(join(snapshot, "uncommitted.md"))).toBe(false);
      expect((await new Git(snapshot).run(["rev-parse", "HEAD"])).out.trim()).toBe(await ctx.readCommit());
      // Every session of the step reads the same commit, however main moves meanwhile.
      const commit = await ctx.readCommit();
      await Bun.write(join(repo.path, "later.md"), "later\n");
      await new Git(repo.path).commitAll("main moves on");
      await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: { intent: "" } });
      expect(await ctx.readCommit()).toBe(commit);
      expect(existsSync(join(snapshot, "later.md"))).toBe(false);
      await ctx.dropSnapshot();
      expect(existsSync(snapshot)).toBe(false);
      expect((await new Git(repo.path).run(["worktree", "list", "--porcelain"])).out.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      restore();
      rmSync(args, { force: true });
      trace.close(); repo.cleanup();
    }
  });

  test("two sessions asking for the snapshot at once share one; a session with a cwd of its own makes none", async () => {
    const { repo, ctx, trace } = await setup();
    const intake = (c: StepContext) => agentPhase(c, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: { intent: "" } });
    try {
      const own = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: { intent: "" }, cwd: repo.path });
      expect(own.ok).toBe(true);
      expect(existsSync(join(repo.path, ".loopstra", "snapshots", "x"))).toBe(false);
      const [a, b] = await alongside(ctx, () => intake(ctx), { what: "two", run: () => intake(ctx), wanted: () => true });
      expect(a.ok && b?.ok).toBe(true);
      expect(existsSync(join(repo.path, ".loopstra", "snapshots", "x", "intent", "x", "intent.md"))).toBe(true);
      await ctx.dropSnapshot();
    } finally { trace.close(); repo.cleanup(); }
  });
});
