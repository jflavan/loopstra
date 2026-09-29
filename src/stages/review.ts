import { block, blockWith, blockWithDetail, clearMarker, writeArtifact, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase } from "../phases";
import { testLoop } from "./build";
import { artifacts, bullets, buildSession, openBranchWorktree, readRound, REVIEW_ROUND, runHookCommands, saveWork, writeRound } from "./shared";

/** The review rounds ended with a review that had no important findings (and the after commands ran). */
export const REVIEW_PASSED = "review-passed";

/**
 * Stage 5 review rounds, run by the merge step for reviewing (see runMergeStep): review, and on
 * important findings revise and test again, until a review passes or the rounds run out (block).
 * The round in progress is kept in the run folder, so a restart continues it.
 */
export async function runReviewRounds(ctx: StepContext): Promise<StepResult | typeof REVIEW_PASSED> {
  const stage = ctx.cfg.stages.review;
  const wt = new Git(ctx.worktreeDir);

  // The change must be on its branch, in a real worktree, before anyone reviews it.
  const open = await openBranchWorktree(ctx);
  if (!open.ok) {
    clearMarker(ctx, REVIEW_ROUND);
    return blockWith(ctx, open);
  }
  // Stopped part-way through a revision: keep those edits on the branch so the review sees them.
  if (await wt.isDirty()) {
    const kept = await saveWork(ctx, wt, "chore: keep unfinished changes");
    if (!kept.ok) return blockWith(ctx, kept);
    ctx.trace.event(ctx.slug, "command", { command: "keep unfinished changes", note: "the worktree had uncommitted edits at review start" });
  }

  const resumed = readRound(ctx);
  if (resumed === null) {
    const before = await runHookCommands(ctx, "before", "review", ctx.worktreeDir);
    if (!before.ok) return before;
  }

  const a = await artifacts(ctx);
  for (let round = resumed ?? 1; ; round++) {
    writeRound(ctx, round);
    const review = await agentPhase(ctx, {
      name: "review", traceName: `review-${round}`, model: stage.model, permissionMode: "default", tools: "read+git", cwd: ctx.worktreeDir,
      vars: { spec: a.spec, plan: a.currentPlan }, skills: stage.skills,
    });
    if (!review.ok) return block(ctx, review.note);
    await writeArtifact(ctx, "review.md", review.envelope.review_markdown);

    // The runtime decides: the change passes when there are no important findings. The
    // reviewer's own approved flag is kept in the trace only.
    const important = review.envelope.findings.filter((f) => f.severity === "important").map((f) => `${f.file}:${f.line} ${f.finding}`);
    const pass = important.length === 0;
    const summary = `round ${round}; reviewer approved: ${review.envelope.approved}; ${pass ? "no important findings" : `important: ${important.join("; ")}`}`;
    ctx.trace.gate(ctx.slug, "review", "findings", pass ? "pass" : "fail", summary);

    if (pass) {
      const after = await runHookCommands(ctx, "after", "review", ctx.worktreeDir);
      return after.ok ? REVIEW_PASSED : after;
    }

    if (round > stage.max_rounds) {
      clearMarker(ctx, REVIEW_ROUND);
      return blockWithDetail(ctx, "The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change.", { rounds: round, important });
    }
    const revise = await buildSession(ctx, {
      name: "revise", traceName: `revise-${round}`, model: ctx.cfg.stages.build.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { findings: bullets(important), test_command: ctx.cfg.commands.test },
    });
    if (!revise.ok) return block(ctx, revise.note);
    const saved = await saveWork(ctx, wt, revise.envelope.commit_message || `loopstra(${ctx.slug}): revise`);
    if (!saved.ok) return blockWith(ctx, saved);
    // The revision is saved: a restart from here reviews it as the next round.
    writeRound(ctx, round + 1);
    const tested = await testLoop(ctx, "retest");
    if (!tested.ok) return blockWith(ctx, tested);
  }
}
