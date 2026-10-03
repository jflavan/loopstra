import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { attention } from "../../src/attention";
import { CHAT_SLUG, loopDayNote } from "../../src/budget";
import { loadConfig } from "../../src/config";
import { readIntent } from "../../src/intents";
import { agentPhase } from "../../src/phases";
import { tick } from "../../src/scheduler";
import { LoopBudgetReached } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { setupRepo } from "../helpers";

function spent(trace: Trace, slug: string, usd: number): void {
  const seq = trace.phaseStart(slug, "build", "agent");
  trace.phaseEnd(slug, seq, { status: "success", costUsd: usd });
}

const INTAKE = { name: "intake", model: "cheap", permissionMode: "default", tools: "read", vars: {} } as const;

describe("the loop's daily budget", () => {
  test("a phase past it does not start; chat's spending does not count", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      spent(trace, CHAT_SLUG, 5);
      expect((await agentPhase(ctx, INTAKE)).ok).toBe(true);
      spent(trace, "other", 1);
      await expect(agentPhase(ctx, INTAKE)).rejects.toBeInstanceOf(LoopBudgetReached);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a session holds what is left of the day as its cap", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 3\n" });
    try {
      const argsFile = join(repo.path, ".loopstra", "args.json");
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      spent(trace, "other", 1);
      await agentPhase(ctx, { ...INTAKE, env: { LOOPSTRA_FAKE_ARGS: argsFile } });
      const args: string[] = (await Bun.file(argsFile).json()).args;
      expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
    } finally { trace.close(); repo.cleanup(); }
  });

  test("the tick waits without picking a change, and the attention list says why", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      spent(trace, "other", 1);
      const cfg = await loadConfig(repo.path);
      const out = await tick(repo.path);
      expect(out.paused).toBe(loopDayNote(cfg));
      expect(out.picked).toBeNull();
      expect((await readIntent(repo.path, "add-numbers")).file.frontmatter.status).toBe("accepted");
      const items = await attention(repo.path, cfg, trace);
      expect(items.find((i) => i.kind === "paused")?.what).toBe(loopDayNote(cfg));
    } finally { trace.close(); repo.cleanup(); }
  });

  test("a hold is not spending: the change's cost and the dashboard leave a running phase out", async () => {
    const { repo, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 5\n" });
    try {
      trace.upsertIntent("add-numbers", "building", "normal");
      spent(trace, "add-numbers", 1);
      trace.phaseStartWithin("add-numbers", "build", "agent", { since: new Date(Date.now() - 60_000).toISOString(), limitUsd: 5, capUsd: Infinity, floorUsd: 0.01, pool: { except: CHAT_SLUG } });
      expect(trace.intentSummary("add-numbers")!.costUsd).toBe(1);
    } finally { trace.close(); repo.cleanup(); }
  });

  test("tomorrow it starts again", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted", { config: "claude:\n  max_budget_usd_per_day: 1\n" });
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "x FIXTURE:simple-success");
      // Yesterday's spending: a phase that started before local midnight.
      const seq = trace.phaseStart("other", "build", "agent");
      trace.phaseEnd("other", seq, { status: "success", costUsd: 1 });
      const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
      (trace as unknown as { db: { run: (sql: string, args: unknown[]) => void } }).db.run("UPDATE phases SET started = ? WHERE slug = 'other'", [yesterday]);
      expect((await agentPhase(ctx, INTAKE)).ok).toBe(true);
    } finally { trace.close(); repo.cleanup(); }
  });
});
