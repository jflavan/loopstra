import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { headingsPresent, filesExistOrNew, diffWithinPlan, parsePlanFiles } from "../../src/checks";
import { evaluateGate, type Check } from "../../src/gates";
import { configPath, loadConfig } from "../../src/config";
import { StepContext } from "../../src/context";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { Trace } from "../../src/trace";
import { tempGitRepo, tempDir } from "../helpers";

describe("checks", () => {
  test("headingsPresent names the missing headings", () => {
    expect(headingsPresent("# Spec\n## Overview\n## Areas of concern\n", ["Overview", "Areas of concern"])).toEqual({ ok: true });
    expect(headingsPresent("# Spec\n## Overview\n", ["Overview", "Risks"])).toEqual({ ok: false, missing: ["Risks"] });
  });

  test("parsePlanFiles reads the Files that change section", () => {
    const plan = "# Plan\n\n## Files that change\n- src/a.ts (new)\n- src/b.ts\n- `src/c.ts` (new)\n\n## Order of work\n1. x\n";
    expect(parsePlanFiles(plan)).toEqual([{ path: "src/a.ts", new: true }, { path: "src/b.ts", new: false }, { path: "src/c.ts", new: true }]);
  });

  test("parsePlanFiles tolerates heading case, a trailing colon, descriptions, bold, ./, backslashes, and (new) anywhere", () => {
    const plan = [
      "# Plan", "", "## Files That Change:", "",
      "- **src/a.ts** (new): the adder",
      "- `./src/b.ts` - existing, gets a call",
      "* src\\c.ts, updated",
      "- (new) tests/a.test.ts",
      "- `src/d.ts`: add export (New)",
      "", "## Order of work", "1. x", "",
    ].join("\n");
    expect(parsePlanFiles(plan)).toEqual([
      { path: "src/a.ts", new: true }, { path: "src/b.ts", new: false }, { path: "src/c.ts", new: false },
      { path: "tests/a.test.ts", new: true }, { path: "src/d.ts", new: true },
    ]);
  });

  test("parsePlanFiles returns null when there is no Files that change section", () => {
    expect(parsePlanFiles("# Plan\n\n## Order of work\n1. x\n")).toBeNull();
    expect(parsePlanFiles("# Plan\n\n## Files that change\n\n## Order of work\n")).toEqual([]);
  });

  test("filesExistOrNew reports missing files not marked new; an existing file marked new is harmless", async () => {
    const t = tempDir();
    mkdirSync(join(t.path, "src"), { recursive: true });
    await Bun.write(join(t.path, "src", "b.ts"), "");
    expect(filesExistOrNew(t.path, [{ path: "src/a.ts", new: true }, { path: "src/b.ts", new: false }, { path: "src/b.ts", new: true }])).toEqual({ ok: true });
    expect(filesExistOrNew(t.path, [{ path: "src/zzz.ts", new: false }])).toEqual({ ok: false, problems: ["src/zzz.ts is listed as an existing file but does not exist"] });
    t.cleanup();
  });

  test("diffWithinPlan exempts only the intent's own folder and lockfiles anywhere", () => {
    const changed = [
      "src/a.ts", "src/x.ts", "bun.lock", "web/package-lock.json", "crates/x/Cargo.lock", "go.sum",
      "intent/add/plan.md", "intent/other/plan.md", "loopstra/config.yaml", ".claude/settings.json", "CLAUDE.md",
    ];
    expect(diffWithinPlan(changed, [{ path: "./src/a.ts", new: false }], "add")).toEqual([
      "src/x.ts", "intent/other/plan.md", "loopstra/config.yaml", ".claude/settings.json", "CLAUDE.md",
    ]);
  });

  test("diffWithinPlan normalizes backslashes and ./ on both sides", () => {
    expect(diffWithinPlan(["./src/a.ts", "src\\b.ts"], [{ path: "src\\a.ts", new: false }, { path: "./src/b.ts", new: false }], "x")).toEqual([]);
  });
});

describe("evaluateGate", () => {
  async function setup() {
    const repo = await tempGitRepo();
    mkdirSync(join(repo.path, "loopstra"), { recursive: true });
    await Bun.write(configPath(repo.path), "version: 1\ncommands:\n  test: echo ok\n");
    mkdirSync(join(repo.path, "intent", "x"), { recursive: true });
    await Bun.write(join(repo.path, "intent", "x", "intent.md"), "---\nstatus: spec-review\n---\n# Intent: x\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n");
    await new Git(repo.path).commitAll("intent");
    const trace = Trace.open(repo.path);
    const ctx = new StepContext(repo.path, await loadConfig(repo.path), trace, await readIntent(repo.path, "x"));
    return { repo, ctx, trace };
  }

  test("passes when all checks pass and records each", async () => {
    const { repo, ctx, trace } = await setup();
    const checks: Check[] = [
      { name: "headings", run: async () => ({ result: "pass", evidence: "all present" }) },
      { name: "agent", run: async () => ({ result: "pass", evidence: "approved" }) },
    ];
    const r = await evaluateGate(ctx, "spec", checks);
    expect(r).toEqual({ result: "pass", payloads: [] });
    expect(trace.gates("x").map((g) => g.check)).toEqual(["headings", "agent"]);
    trace.close(); repo.cleanup();
  });

  test("stops at the first failure and returns its evidence", async () => {
    const { repo, ctx, trace } = await setup();
    let ran = 0;
    const checks: Check[] = [
      { name: "a", run: async () => ({ result: "fail", evidence: "Risks heading missing" }) },
      { name: "b", run: async () => { ran++; return { result: "pass", evidence: "" }; } },
    ];
    const r = await evaluateGate(ctx, "plan", checks);
    expect(r).toEqual({ result: "fail", check: "a", evidence: "Risks heading missing" });
    expect(ran).toBe(0);
    trace.close(); repo.cleanup();
  });

  test("waiting is returned when a check is waiting", async () => {
    const { repo, ctx, trace } = await setup();
    const r = await evaluateGate(ctx, "merge", [{ name: "pr", run: async () => ({ result: "waiting", evidence: "no approval yet" }) }]);
    expect(r).toEqual({ result: "waiting", check: "pr", evidence: "no approval yet" });
    trace.close(); repo.cleanup();
  });
});
