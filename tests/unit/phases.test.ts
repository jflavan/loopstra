import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { agentPhase, codePhase, disallowedFor, toolsFor } from "../../src/phases";
import { pauseAfterUnavailable, readPause } from "../../src/heartbeat";
import { AssistantUnavailable } from "../../src/stop";
import { Trace } from "../../src/trace";
import { FAKE_CLAUDE as FAKE, setEnv, tempGitRepo } from "../helpers";


async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "Intent for {{slug}}:\n{{intent}}\nSkills: {{skills}}");
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
      vars: { intent: ctx.intent.file.body, skills: "" },
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

  test("a missing prompt file is a plain failure", async () => {
    const { repo, ctx, trace } = await setup();
    const r = await agentPhase(ctx, { name: "design", model: "strong", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("missing-prompt");
      expect(r.note).toBe("A prompt file for this step is missing. An engineer needs to restore it.");
    }
    expect(trace.events("x").some((e) => e.type === "error" && e.payload.includes("loopstra/prompts/design.md"))).toBe(true);
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

  test("skills are prepended as one line and also fill {{skills}}; slug and main_branch are always set", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "slug={{slug}} main={{main_branch}} skills={{skills}}");
    await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {}, skills: ["brand", "tone"] });
    const prompt = await Bun.file(join(repo.path, ".loopstra", "runs", "x", "phases", "1-intake", "prompt.md")).text();
    expect(prompt).toBe("Use these skills: `brand`, `tone`.\n\nslug=x main=main skills=brand, tone");
    trace.close(); repo.cleanup();
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

  test("a budget failure is not retried", async () => {
    const { repo, ctx, trace } = await setup();
    await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:budget");
    const r = await agentPhase(ctx, { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("budget");
      expect(r.note).toBe("This step hit its spending limit. An engineer may need to raise the limit.");
    }
    expect(trace.phases("x").map((p) => p.name)).toEqual(["intake"]);
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
    if (!odd.ok) expect(odd.note).toContain("null");
    trace.close(); repo.cleanup();
  });
});
