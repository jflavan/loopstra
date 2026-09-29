import { existsSync } from "node:fs";
import { block, setStatus, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { Git } from "../git";
import { codePhase } from "../phases";
import { testLoop } from "./build";

/** Merge gate and merge. Called for merge-review. Local path only; GitHub path is added in Plan 3. */
export async function runMergeStep(ctx: StepContext): Promise<StepResult> {
  const wt = new Git(ctx.worktreeDir);
  if (!existsSync(ctx.worktreeDir)) return block(ctx, `The work for this change is missing from .loopstra/worktrees. Set status to plan-approved to rebuild.`);

  const checks: Check[] = [
    {
      name: "up-to-date",
      run: async () => {
        if (await ctx.git.isAncestor(ctx.cfg.main_branch, ctx.branch)) return { result: "pass", evidence: "branch contains main" };
        const ok = await wt.rebaseOnto(ctx.cfg.main_branch);
        return ok ? { result: "pass", evidence: "rebased onto main" } : { result: "fail", evidence: "rebase onto main hit conflicts" };
      },
    },
    {
      name: "tests",
      run: async () => {
        // After a rebase the tests may need fixing: the same test loop as build, with its fix budget.
        const tested = await testLoop(ctx, "merge-test");
        return tested.ok ? { result: "pass", evidence: "all commands exit 0" } : { result: "fail", evidence: tested.detail };
      },
    },
    {
      name: "findings",
      run: async () => {
        // The review step records its verdict as a gate row; only the newest one counts.
        const last = ctx.trace.lastGate(ctx.slug, "review", "findings");
        return last?.result === "pass" ? { result: "pass", evidence: "the last review had no important findings" } : { result: "fail", evidence: last ? last.evidence : "no review recorded" };
      },
    },
  ];
  if (ctx.cfg.gates.merge.human === "status") {
    checks.push({ name: "human", run: async () => ({ result: "waiting", evidence: "waiting for a person to set status to merged" }) });
  }

  const outcome = await evaluateGate(ctx, "merge", checks);
  if (outcome.result === "waiting") return { ok: true };
  if (outcome.result === "fail") return block(ctx, `The change is not ready to merge (${outcome.check}): ${outcome.evidence}. An engineer should look at branch ${ctx.branch}.`);

  const merged = await codePhase(ctx, "merge", async () => {
    const title = ctx.intent.file.title || ctx.slug;
    try {
      await ctx.git.merge(ctx.branch, ctx.cfg.gates.merge.method, `${ctx.slug}: ${title}`);
    } catch (e) {
      // git.merge has already aborted, so main is clean. Keep the technical detail in the trace.
      ctx.trace.event(ctx.slug, "error", { where: "merge", error: (e as Error).message });
      return { ok: true as const, conflict: true };
    }
    await ctx.git.worktreeRemove(ctx.worktreeDir);
    await ctx.git.deleteBranch(ctx.branch);
    return { ok: true as const, conflict: false };
  });
  if (!merged.ok) return block(ctx, `Merging failed. ${merged.note}`);
  if (merged.conflict) return block(ctx, `The change could not be merged into ${ctx.cfg.main_branch} because it overlaps with other recent changes. Main was left untouched. An engineer should look at branch ${ctx.branch}.`);
  await setStatus(ctx, "merged");
  return { ok: true };
}
