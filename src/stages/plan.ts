import { filesExistOrNew, parsePlanFiles } from "../checks";
import { block, clearMarker, readMarker, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, headingsCheck, PLAN_HEADINGS, runHookCommands, settleGate, verdictOf, type GateFlow, type JudgePayload, type Verdict } from "./shared";

const REPLANNED = "replanned";

/**
 * The plan half of Stage 3. spec-approved/planning: plan and the plan gate's checks in one step.
 * plan-review means the checks passed and a person is deciding; it never advances here.
 */
export async function runPlanStep(ctx: StepContext): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === "spec-approved") clearMarker(ctx, REPLANNED);
  if (status === "spec-approved" || status === "planning") return plan(ctx);
  if (status === "plan-review") {
    if (ctx.cfg.gates.plan.human !== "none") return { ok: true };
    // No person on this gate (config changed, or the status was set by hand): run the checks now.
    return settleGate(ctx, planFlow(ctx));
  }
  return { ok: true };
}

async function plan(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "planning") await setStatus(ctx, "planning");
  const before = await runHookCommands(ctx, "before", "plan");
  if (!before.ok) return before;
  // Restarted during the automatic rewrite: send the same concerns again.
  const written = await writePlan(ctx, readMarker(ctx, REPLANNED) ?? "");
  if (!written.ok) return written;
  return settleGate(ctx, planFlow(ctx));
}

/** One plan session: writes plan.md and runs the after commands. */
async function writePlan(ctx: StepContext, concerns: string): Promise<StepResult> {
  const a = await artifacts(ctx);
  const r = await agentPhase(ctx, {
    name: "plan", model: ctx.cfg.stages.plan.model, permissionMode: "plan", tools: "read",
    vars: { intent: a.intent, spec: a.spec, concerns }, skills: ctx.cfg.stages.plan.skills,
  });
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, "plan.md", r.envelope.plan_markdown);
  return runHookCommands(ctx, "after", "plan");
}

function planFlow(ctx: StepContext): GateFlow {
  return {
    gate: "plan", artifact: "plan.md", working: "planning", review: "plan-review", approved: "plan-approved",
    marker: REPLANNED,
    check: () => checkPlan(ctx),
    rewrite: (concerns) => writePlan(ctx, concerns),
    rewritingNote: "The first plan did not pass its automatic check, so it is being written again.",
    // A decision for a person rather than a retry: two ways on.
    failedNote: "The plan did not pass its automatic check, even after being written a second time. Set status to plan-approved to accept the plan as it is, or to spec-approved to write it again.",
  };
}

async function checkPlan(ctx: StepContext): Promise<Verdict> {
  const a = await artifacts(ctx);
  const files = parsePlanFiles(a.plan) ?? []; // no Files section: the headings check reports it
  const checks: Check<JudgePayload>[] = [
    headingsCheck("headings", a.plan, PLAN_HEADINGS),
    { name: "files", run: async () => { const r = filesExistOrNew(ctx.root, files); return r.ok ? { result: "pass", evidence: `${files.length} files listed` } : { result: "fail", evidence: r.problems.join("; ") }; } },
  ];
  if (ctx.cfg.gates.plan.agent) {
    checks.push({
      name: "plan-challenge",
      run: async () => {
        const r = await agentPhase(ctx, { name: "plan-challenge", model: "strong", permissionMode: "default", tools: "read", vars: { spec: a.spec, plan: a.plan } });
        if (!r.ok) {
          return { result: "fail", evidence: `the challenger failed: ${r.reason}`, payload: { broken: { note: `The plan could not be checked. ${r.note}`, detail: `plan-challenge failed: ${r.reason}` } } };
        }
        const concerns = r.envelope.concerns.filter((c) => c.blocking).map((c) => c.concern);
        return r.envelope.approved ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: concerns.join("; ") || r.envelope.summary, payload: { findings: concerns } };
      },
    });
  }
  return verdictOf(await evaluateGate(ctx, "plan", checks));
}
