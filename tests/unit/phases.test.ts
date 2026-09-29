import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { agentPhase, codePhase } from "../../src/phases";
import { Trace } from "../../src/trace";
import { tempGitRepo } from "../helpers";

const FAKE = new URL("../fake-claude/claude.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

async function setup() {
  const repo = await tempGitRepo();
  mkdirSync(join(repo.path, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
  await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "Intent for {{slug}}:\n{{intent}}\nSkills: {{skills}}");
  mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
  await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: accepted\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
  await new Git(repo.path).commitAll("intent");
  process.env.LOOPSTRA_CLAUDE_EXECUTABLE = FAKE;
  const cfg = await loadConfig(repo.path);
  const trace = Trace.open(repo.path);
  const ctx = new StepContext(repo.path, cfg, trace, await readIntent(repo.path, "x"));
  return { repo, ctx, trace };
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
    if (!r.ok) expect(r.note).toMatch(/loopstra\/prompts\/design\.md/);
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
    trace.close(); repo.cleanup();
  });
});
