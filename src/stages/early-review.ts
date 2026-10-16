import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeMarker, type StepContext } from "../context";
import { modelFor } from "../config";
import { Git, withDetachedWorktree } from "../git";
import { cheapMayDecide, judgeModel, runJudge, type JudgeResult } from "../judges";
import { phasePrompt, type AgentPhaseSpec } from "../phases";
import { EARLY, type NewJudgeRow } from "../trace";
import { takeKept, testResult } from "./shared";

/**
 * Run-folder file: a review that ran alongside the verifier (see reviewAhead), with a key for what
 * it was asked. Round 1 uses it, once, when it would ask the same; a new build clears it.
 */
export const EARLY_REVIEW = "review.early";

/** A round's review session. The early review asks the same, so round 1 can use it. */
export async function reviewPhase(ctx: StepContext, round: number, spec: string, plan: string): Promise<AgentPhaseSpec & { name: "review" }> {
  const stage = ctx.cfg.stages.review;
  return {
    name: "review", traceName: `review-${round}`, model: judgeModel(ctx.cfg, "review"), permissionMode: "default", tools: "read+git", cwd: ctx.worktreeDir,
    vars: { spec, plan, test_result: await testResult(ctx, new Git(ctx.worktreeDir)) }, skills: stage.skills,
  };
}

/** What a review is asked about, hashed: the commit, the model, and the whole rendered prompt. */
function reviewKey(ctx: StepContext, sha: string, phase: AgentPhaseSpec, prompt: string): string {
  return createHash("sha256").update([sha, modelFor(ctx.cfg, phase.model), prompt].join("\n")).digest("hex");
}

/**
 * Round 1's review, run by the build step alongside the verifier once the tests pass. It reads a
 * throwaway copy of the tested commit, not the worktree: the verifier runs project commands there,
 * which may change files while the review reads them. Returns what to keep if the verifier passes,
 * or null when the review did not finish (round 1 then runs as usual). `room`: whether a cheaper judge
 * in shadow has room beside the verifier (see shadowRoom), asked by the build step before either starts.
 */
export async function reviewAhead(ctx: StepContext, spec: string, plan: string, room: boolean): Promise<string | null> {
  const phase = { ...(await reviewPhase(ctx, 1, spec, plan)), traceName: `${EARLY}review` };
  const prompt = await phasePrompt(ctx, phase);
  if (prompt === null) return null;
  const sha = await new Git(ctx.worktreeDir).headSha();
  const dir = join(ctx.root, ".loopstra", "review", ctx.slug);
  // A comparison is recorded even if the verifier fails: it was the same question. A pass the cheaper
  // judge decided alone is not: its row is kept with the review and written only if round 1 uses it.
  const r = await withDetachedWorktree(ctx.git, dir, sha, (cwd) => runJudge(ctx, { ...phase, cwd }, { rendered: prompt, room, commit: sha, keepAlone: true }));
  return r.ok ? JSON.stringify({ key: reviewKey(ctx, sha, phase, prompt), envelope: r.envelope, decidedBy: r.decidedBy, alone: r.alone }) : null;
}

/** Keeps an early review for round 1 (see reviewAhead). */
export function keepEarlyReview(ctx: StepContext, kept: string): void {
  writeMarker(ctx, EARLY_REVIEW, kept);
}

/**
 * The early review, when it was asked exactly what `phase` would ask with `prompt` (its phasePrompt);
 * it is used up either way. It read the commit alone, so it stands for round 1 only while the
 * worktree has nothing uncommitted. Never once review before commands are set: what they do may not
 * show in git (an ignored file, a running service).
 */
export async function takeEarlyReview(ctx: StepContext, phase: AgentPhaseSpec & { name: "review" }, prompt: string | null): Promise<JudgeResult<"review"> | null> {
  const kept = takeKept(ctx, EARLY_REVIEW, "review");
  if (kept === undefined) return null;
  const notUsed = (why: string) => { ctx.trace.event(ctx.slug, "command", { command: "early review", note: `not used: ${why}` }); return null; };
  if (kept === null) return notUsed("it could not be read");
  const wt = new Git(ctx.worktreeDir);
  const sha = prompt !== null && !ctx.cfg.stages.review.before.length && !(await wt.isDirty()) ? await wt.headSha() : null;
  if (sha === null || prompt === null || kept.key !== reviewKey(ctx, sha, phase, prompt)) return notUsed("the change, its plan, the review prompt or its commands moved on since it ran");
  // One the cheaper judge decided stands only if it is still trusted now: since the build step, an
  // audit may have found a miss, or the setting may have moved. A file without decidedBy is older, and strong.
  const decidedBy = kept.saved.decidedBy === "cheap" ? "cheap" : "strong";
  if (decidedBy === "cheap" && !(await cheapMayDecide(ctx, phase, { rendered: prompt, commit: sha }))) {
    return notUsed("it was decided by the cheaper judge, which is no longer trusted to decide alone");
  }
  // Only now does the cheaper judge's pass stand, so only now is it one it decided alone.
  if (decidedBy === "cheap" && kept.saved.alone) ctx.trace.judge(ctx.slug, kept.saved.alone as NewJudgeRow);
  ctx.trace.event(ctx.slug, "command", { command: "early review", note: `${phase.traceName} uses the review that ran alongside the verifier` });
  return { ok: true, envelope: kept.envelope, sessionId: null, costUsd: 0, decidedBy };
}
