import { block, clearMarker, readMarker, writeArtifact, writeMarker, type StepContext, type StepResult } from "../context";
import { modelFor } from "../config";
import { Envelopes } from "../envelopes";
import { Git } from "../git";
import { cheapMayDecide, passes, runJudge, type JudgeResult } from "../judges";
import { phasePrompt, type AgentPhaseSpec } from "../phases";
import { testLoop } from "./build";
import { artifacts, bullets, buildSession, openBranchWorktree, readRound, REVIEW_ROUND, runHookCommands, saveWork, testResult, writeRound } from "./shared";

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
    return block(ctx, open.note, open);
  }
  // Stopped part-way through a revision: keep those edits on the branch so the review sees them.
  if (await wt.isDirty()) {
    const kept = await saveWork(ctx, wt, "chore: keep unfinished changes");
    if (!kept.ok) return block(ctx, kept.note, kept);
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
    const phase = await reviewPhase(ctx, round, a.spec, a.currentPlan);
    const review = (await takeEarlyReview(ctx, phase)) ?? await runJudge(ctx, phase);
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
      const after = await runHookCommands(ctx, "after", "review", ctx.worktreeDir);
      return after.ok ? REVIEW_PASSED : after;
    }

    if (round > stage.max_rounds) {
      clearMarker(ctx, REVIEW_ROUND);
      return block(ctx, "The reviewer still found important problems after the change was revised. The details are in review.md. An engineer needs to look at the change.", { detail: { rounds: round, important } });
    }
    const revise = await buildSession(ctx, {
      name: "revise", traceName: `revise-${round}`, model: ctx.cfg.stages.build.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
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

/** A round's review session. The early review uses the same, so it asks exactly what round 1 would. */
async function reviewPhase(ctx: StepContext, round: number, spec: string, plan: string): Promise<AgentPhaseSpec & { name: "review" }> {
  const stage = ctx.cfg.stages.review;
  return {
    name: "review", traceName: `review-${round}`, model: stage.model, permissionMode: "default", tools: "read+git", cwd: ctx.worktreeDir,
    vars: { spec, plan, test_result: await testResult(ctx, new Git(ctx.worktreeDir)) }, skills: stage.skills,
  };
}

/**
 * Run-folder file: a review that ran alongside the verifier (see reviewAhead), with what it was
 * asked about. Round 1 uses it, once, when it would ask the same; a new build clears it.
 */
export const EARLY_REVIEW = "review.early";

/** What a review is asked about: the commit, the model, and the whole prompt. */
async function reviewKey(ctx: StepContext, phase: AgentPhaseSpec): Promise<string | null> {
  const prompt = await phasePrompt(ctx, phase);
  return prompt === null ? null : [await new Git(ctx.worktreeDir).headSha(), modelFor(ctx.cfg, phase.model), prompt].join("\n");
}

/**
 * Round 1's review, run by the build step at the same time as the verifier (the tests have passed,
 * so both judge the same commit). Returns what to keep if the verifier passes, or null when the
 * review did not finish (round 1 then runs as usual). The build step runs it as optional work.
 */
export async function reviewAhead(ctx: StepContext, spec: string, plan: string): Promise<string | null> {
  const phase = await reviewPhase(ctx, 1, spec, plan);
  const key = await reviewKey(ctx, phase);
  // The verifier is already running beside it, so a cheaper judge in shadow needs room for a third
  // session. Its comparison is recorded even if the verifier fails: it was the same question.
  const r = await runJudge(ctx, phase, { alongside: 1 });
  return key !== null && r.ok ? JSON.stringify({ key, envelope: r.envelope, decidedBy: r.decidedBy }) : null;
}

/** Keeps an early review for round 1 (see reviewAhead). */
export function keepEarlyReview(ctx: StepContext, kept: string): void {
  writeMarker(ctx, EARLY_REVIEW, kept);
}

/**
 * The early review, when it was asked exactly what `phase` would ask; it is used up either way. Not
 * once review before commands are set: what they changed may be left uncommitted, so the key misses it.
 */
async function takeEarlyReview(ctx: StepContext, phase: AgentPhaseSpec & { name: "review" }): Promise<JudgeResult<"review"> | null> {
  const kept = readMarker(ctx, EARLY_REVIEW);
  if (kept === null) return null;
  clearMarker(ctx, EARLY_REVIEW);
  let saved: { key?: unknown; envelope?: unknown; decidedBy?: unknown };
  try { saved = JSON.parse(kept); } catch { return null; }
  const envelope = Envelopes.review.safeParse(saved.envelope);
  if (!envelope.success || ctx.cfg.stages.review.before.length || saved.key !== (await reviewKey(ctx, phase))) {
    ctx.trace.event(ctx.slug, "command", { command: "early review", note: "not used: the change, its plan, the review prompt or its commands moved on since it ran" });
    return null;
  }
  // One the cheaper judge decided stands only if it is still trusted now: since the build step, an
  // audit may have found a miss, or the setting may have moved. A marker without decidedBy is older, and strong.
  const decidedBy = saved.decidedBy === "cheap" ? "cheap" : "strong";
  if (decidedBy === "cheap" && !(await cheapMayDecide(ctx, phase))) {
    ctx.trace.event(ctx.slug, "command", { command: "early review", note: "not used: it was decided by the cheaper judge, which is no longer trusted to decide alone" });
    return null;
  }
  ctx.trace.event(ctx.slug, "command", { command: "early review", note: `${phase.traceName} uses the review that ran alongside the verifier` });
  return { ok: true, envelope: envelope.data, sessionId: null, costUsd: 0, decidedBy };
}
