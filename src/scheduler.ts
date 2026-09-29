import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { StepContext, block, type StepResult } from "./context";
import { Git } from "./git";
import { checkConsistency, isRunnable, orderQueue, renderQueue, scanIntents } from "./intents";
import { runMainHealth } from "./signals";
import { runBuildStep } from "./stages/build";
import { runDesignStep } from "./stages/design";
import { runMergeStep } from "./stages/merge";
import { runPlanStep } from "./stages/plan";
import { runReviewStep } from "./stages/review";
import { runVerifyStep } from "./stages/verify";
import { Trace } from "./trace";

export interface TickResult { picked: string | null; result?: StepResult; error?: string; signal?: string }

let lastMainHealth = 0;
let lastMergedSlug: string | null = null;

export async function tick(root: string): Promise<TickResult> {
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch (e) { return { picked: null, error: (e as Error).message }; }
  const trace = Trace.open(root);
  try {
    trace.event("_loop", "tick", {});
    const out: TickResult = { picked: null };

    // Signals: after a merge, or on the interval.
    const due = Date.now() - lastMainHealth > cfg.signals.main_health.every_minutes * 60_000;
    if (lastMergedSlug || due) {
      out.signal = await runMainHealth(root, cfg, trace, lastMergedSlug);
      lastMainHealth = Date.now();
      lastMergedSlug = null;
    }

    // Scan, check, render queue.
    const intents = await scanIntents(root);
    for (const i of intents) {
      trace.upsertIntent(i.slug, i.file.frontmatter.status, i.file.frontmatter.priority);
      const problem = checkConsistency(i);
      if (problem && i.file.frontmatter.status !== "blocked") {
        const ctx = new StepContext(root, cfg, trace, i);
        await block(ctx, problem);
      }
    }
    const ordered = orderQueue(await scanIntents(root));
    await Bun.write(join(root, "intent", "queue.md"), renderQueue(ordered)).catch(() => {});
    await new Git(root).commitPaths(["intent/queue.md"], "loopstra: update queue").catch(() => {});

    // Pick and run one step.
    const human = { spec: cfg.gates.spec.human, plan: cfg.gates.plan.human, merge: cfg.gates.merge.human, done: cfg.gates.done.human };
    const next = ordered.find((i) => isRunnable(i, human));
    if (!next) return out;
    out.picked = next.slug;
    const ctx = new StepContext(root, cfg, trace, next);
    try {
      out.result = await runStep(ctx);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      trace.event(next.slug, "error", { error: msg, stack: (e as Error).stack });
      out.result = await block(ctx, `Something unexpected went wrong: ${msg.split("\n")[0]}. Details are in the trace.`);
    }
    if (ctx.intent.file.frontmatter.status === "merged") lastMergedSlug = ctx.slug;
    return out;
  } finally {
    trace.close();
  }
}

async function runStep(ctx: StepContext): Promise<StepResult> {
  switch (ctx.intent.file.frontmatter.status) {
    case "accepted": case "designing": case "spec-review": return runDesignStep(ctx);
    case "spec-approved": case "planning": case "plan-review": return runPlanStep(ctx);
    case "plan-approved": case "building": return runBuildStep(ctx);
    case "reviewing": return runReviewStep(ctx);
    case "merge-review": return runMergeStep(ctx);
    case "merged": case "verifying": return runVerifyStep(ctx);
    default: return { ok: true };
  }
}

export async function start(root: string, opts: { once: boolean }): Promise<void> {
  const cfg = await loadConfig(root);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; console.log("\nStopping after this step."); });
  do {
    const r = await tick(root);
    if (r.error) console.error(`Config problem, will retry next tick:\n${r.error}`);
    else if (r.picked) console.log(`${new Date().toISOString()} ${r.picked}: ${r.result?.ok ? "step done" : r.result?.note}`);
    else console.log(`${new Date().toISOString()} idle`);
    if (opts.once || stopping) break;
    await Bun.sleep(cfg.poll_seconds * 1000);
  } while (!stopping);
}
