import { block, loadSessions, saveSession, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase } from "../phases";
import { runChecks } from "./build";
import { artifacts, runHookCommands } from "./shared";

/** Stage 5 review rounds. Called for reviewing. Ends at merge-review or blocked. */
export async function runReviewStep(ctx: StepContext): Promise<StepResult> {
  const a = await artifacts(ctx);
  const stage = ctx.cfg.stages.review;
  const wt = new Git(ctx.worktreeDir);
  let lastImportant: string[] = [];

  for (let round = 1; round <= stage.max_rounds + 1; round++) {
    const review = await agentPhase(ctx, {
      name: "review", traceName: `review-${round}`, model: stage.model, permissionMode: "default", tools: "read", cwd: ctx.worktreeDir,
      vars: { spec: a.spec, plan: a.plan, skills: stage.skills.join(", ") }, skills: stage.skills,
    });
    if (!review.ok) return block(ctx, review.note);
    await writeArtifact(ctx, "review.md", review.envelope.review_markdown);
    ctx.trace.event(ctx.slug, "gate_check", { gate: "review", round, approved: review.envelope.approved, findings: review.envelope.findings.length });
    lastImportant = review.envelope.findings.filter((f) => f.severity === "important").map((f) => `${f.file}:${f.line} ${f.finding}`);
    if (review.envelope.approved && !lastImportant.length) break;
    if (round > stage.max_rounds) {
      return block(ctx, `Review still found important problems after ${stage.max_rounds} revision round${stage.max_rounds === 1 ? "" : "s"}: ${lastImportant.join("; ")}. An engineer should look at branch ${ctx.branch}.`);
    }
    const revise = await agentPhase(ctx, {
      name: "revise", traceName: `revise-${round}`, model: ctx.cfg.stages.build.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      resume: loadSessions(ctx).build, vars: { findings: lastImportant.map((f) => `- ${f}`).join("\n") },
    });
    if (!revise.ok) return block(ctx, revise.note);
    if (revise.sessionId) saveSession(ctx, "build", revise.sessionId);
    await wt.commitAll(revise.envelope.commit_message || `loopstra(${ctx.slug}): revise`);
    const failure = await runChecks(ctx, `retest-${round}`);
    if (failure) return block(ctx, `After revising for review, the tests failed: ${failure.lastLine}. An engineer should look at branch ${ctx.branch}.`);
  }

  const after = await runHookCommands(ctx, "after", "build", ctx.worktreeDir);
  if (!after.ok) return after;
  await setStatus(ctx, "merge-review");
  return { ok: true };
}
