import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filesExistOrNew, parsePlanFiles } from "../checks";
import { block, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, headingsCheck, humanNote, PLAN_HEADINGS, runHookCommands } from "./shared";

/** One step of the plan half of Stage 3. Called for spec-approved, planning, plan-review. */
export async function runPlanStep(ctx: StepContext): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === "spec-approved") rmSync(replannedMarker(ctx), { force: true });
  if (status === "spec-approved" || status === "planning") return plan(ctx, "");
  if (status === "plan-review") return planGate(ctx);
  return { ok: true };
}

/** Runtime marker (never in intent/): an automatic replan already happened for this intent. */
function replannedMarker(ctx: StepContext): string { return join(ctx.runDir, "replanned"); }

async function plan(ctx: StepContext, concerns: string): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "planning") await setStatus(ctx, "planning");
  const before = await runHookCommands(ctx, "before", "plan");
  if (!before.ok) return before;
  const a = await artifacts(ctx);
  const r = await agentPhase(ctx, {
    name: "plan", model: ctx.cfg.stages.plan.model, permissionMode: "plan", tools: "read",
    vars: { intent: a.intent, spec: a.spec, skills: ctx.cfg.stages.plan.skills.join(", "), concerns }, skills: ctx.cfg.stages.plan.skills,
  });
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, "plan.md", r.envelope.plan_markdown);
  const after = await runHookCommands(ctx, "after", "plan");
  if (!after.ok) return after;
  const note = ctx.cfg.gates.plan.human === "none" ? (concerns ? "replanned once after review concerns" : "") : humanNote("plan.md", "plan-approved");
  await setStatus(ctx, "plan-review", note);
  return { ok: true };
}

async function planGate(ctx: StepContext): Promise<StepResult> {
  const a = await artifacts(ctx);
  const files = parsePlanFiles(a.plan);
  const checks: Check[] = [
    headingsCheck("headings", a.plan, PLAN_HEADINGS),
    { name: "files", run: async () => { const r = filesExistOrNew(ctx.root, files); return r.ok ? { result: "pass", evidence: `${files.length} files listed` } : { result: "fail", evidence: r.problems.join("; ") }; } },
  ];
  let blockingConcerns: string[] = [];
  if (ctx.cfg.gates.plan.agent) {
    checks.push({
      name: "plan-challenge",
      run: async () => {
        const r = await agentPhase(ctx, { name: "plan-challenge", model: "strong", permissionMode: "default", tools: "read", vars: { spec: a.spec, plan: a.plan } });
        if (!r.ok) return { result: "fail", evidence: r.note };
        blockingConcerns = r.envelope.concerns.filter((c) => c.blocking).map((c) => c.concern);
        return r.envelope.approved ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: blockingConcerns.join("; ") || r.envelope.summary };
      },
    });
  }
  const outcome = await evaluateGate(ctx, "plan", checks);
  if (outcome.result === "pass") { rmSync(replannedMarker(ctx), { force: true }); await setStatus(ctx, "plan-approved"); return { ok: true }; }
  if (outcome.check === "plan-challenge" && !existsSync(replannedMarker(ctx))) {
    // One resend of the plan with the concerns, then block if it fails again.
    mkdirSync(ctx.runDir, { recursive: true });
    writeFileSync(replannedMarker(ctx), "");
    await setStatus(ctx, "planning", "replanned once after review concerns");
    const again = await plan(ctx, blockingConcerns.join("\n") || outcome.evidence);
    if (!again.ok) return again;
    await ctx.reload();
    return { ok: true };
  }
  return block(ctx, `The plan did not pass its check (${outcome.check}): ${outcome.evidence}. Fix plan.md, then set status to spec-approved to replan.`);
}
