import { block, clearMarker, writeArtifact, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { modelFor } from "../config";
import { passes, runJudge } from "../judges";
import { testLoop } from "./build";
import { catchUp, outOfDate, RESOLUTION, roundsAllowed } from "./catch-up";
import { reviewPhase, reviewPrompt, takeEarlyReview } from "./early-review";
import { artifacts, bullets, buildSession, KEEP_UNFINISHED, openBranchWorktree, readRound, REVIEW_ROUND, runHookCommands, saveWork, writeRound } from "./shared";

/** The review rounds ended with a review that had no important findings (and the after commands ran). */
export const REVIEW_PASSED = "review-passed";

/**
 * Stage 5 review rounds, run by the merge step for reviewing (see runMergeStep): review, and on
 * important findings revise and test again, until a review passes or the rounds run out (block).
 * The round in progress is kept in the run folder, so a restart continues it.
 */
export async function runReviewRounds(ctx: StepContext): Promise<StepResult | typeof REVIEW_PASSED> {
  const wt = new Git(ctx.worktreeDir);

  // The change must be on its branch, in a real worktree, before anyone reviews it.
  const open = await openBranchWorktree(ctx);
  if (!open.ok) {
    clearMarker(ctx, REVIEW_ROUND);
    return block(ctx, open.note, open);
  }
  // Stopped part-way through a revision: keep those edits on the branch so the review sees them.
  if (await wt.isDirty()) {
    const kept = await saveWork(ctx, wt, KEEP_UNFINISHED);
    if (!kept.ok) return block(ctx, kept.note, kept);
    ctx.trace.event(ctx.slug, "command", { command: "keep unfinished changes", note: "the worktree had uncommitted edits at review start" });
  }

  const resumed = readRound(ctx);
  if (resumed === null) {
    // Main gained code since the build: the review reads the change on top of it. A conflict is
    // resolved, and tested before anyone reviews it. Records alone leave the branch (and the early
    // review kept for its commit) as they are; the merge checks bring those in.
    if (await outOfDate(ctx.git, ctx.cfg.main_branch, ctx.branch)) {
      const up = await catchUp(ctx);
      if (!up.ok) return block(ctx, up.note, up);
      if (up.outcome === "resolved") {
        const tested = await testLoop(ctx, "resolve-test");
        if (!tested.ok) return block(ctx, tested.note, tested);
      }
    }
    const before = await runHookCommands(ctx, "before", "review", ctx.worktreeDir);
    if (!before.ok) return before;
  }

  const a = await artifacts(ctx);
  for (let round = resumed ?? 1; ; round++) {
    writeRound(ctx, round);
    const phase = await reviewPhase(ctx, round, a.spec, a.currentPlan);
    const prompt = await reviewPrompt(ctx, phase);
    const review = (await takeEarlyReview(ctx, phase, prompt)) ?? await runJudge(ctx, phase, { prompt });
    if (!review.ok) return block(ctx, review.note);
    // review.md, the gate row and the findings all come from the review that decided.
    await writeArtifact(ctx, "review.md", review.envelope.review_markdown);

    // The runtime decides: the change passes when there are no important findings. The
    // reviewer's own approved flag is kept in the trace only.
    const important = review.envelope.findings.filter((f) => f.severity === "important").map((f) => `${f.file}:${f.line} ${f.finding}`);
    const pass = passes("review", review.envelope);
    const by = review.decidedBy === "cheap" ? `; decided by the cheaper judge (${modelFor(ctx.cfg, "default")})` : "";
    const summary = `round ${round}; reviewer approved: ${review.envelope.approved}; ${pass ? "no important findings" : `important: ${important.join("; ")}`}${by}`;
    ctx.trace.gate(ctx.slug, "review", "findings", pass ? "pass" : "fail", summary);

    if (pass) {
      // Seen: a later review is not shown it again.
      clearMarker(ctx, RESOLUTION);
      const after = await runHookCommands(ctx, "after", "review", ctx.worktreeDir);
      return after.ok ? REVIEW_PASSED : after;
    }

    if (round > roundsAllowed(ctx)) {
      clearMarker(ctx, REVIEW_ROUND);
      return block(ctx, "The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change.", { detail: { rounds: round, important } });
    }
    const revise = await buildSession(ctx, {
      name: "revise", traceName: `revise-${round}`, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { findings: bullets(important), test_command: ctx.cfg.commands.test },
    });
    if (!revise.ok) return block(ctx, revise.note);
    const saved = await saveWork(ctx, wt, revise.envelope.commit_message || `loopstra(${ctx.slug}): revise`);
    if (!saved.ok) return block(ctx, saved.note, saved);
    // The revision is saved: a restart from here reviews it as the next round.
    writeRound(ctx, round + 1);
    const tested = await testLoop(ctx, "retest");
    if (!tested.ok) return block(ctx, tested.note, tested);
  }
}
