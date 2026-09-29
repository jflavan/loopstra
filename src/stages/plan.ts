import { filesExistOrNew, parsePlanFiles } from "../checks";
import type { StepContext, StepResult } from "../context";
import { runArtifactStep, type ArtifactStage } from "./artifact";

const PLAN: ArtifactStage<"plan", "plan-challenge"> = {
  stage: "plan", gate: "plan", artifact: "plan.md",
  entry: "spec-approved", working: "planning", review: "plan-review", approved: "plan-approved",
  marker: "replanned",
  vars: (a, concerns) => ({ intent: a.intent, spec: a.spec, concerns }),
  text: (e) => e.plan_markdown,
  headings: ["Files that change", "Order of work", "Risks", "Proof"],
  checks: (ctx, a) => [{
    name: "files",
    run: async () => {
      const files = parsePlanFiles(a.plan) ?? []; // no Files section: the headings check reports it
      const r = filesExistOrNew(ctx.root, files);
      return r.ok ? { result: "pass", evidence: `${files.length} files listed` } : { result: "fail", evidence: r.problems.join("; ") };
    },
  }],
  judge: {
    name: "plan-challenge", who: "challenger",
    vars: (a) => ({ spec: a.spec, plan: a.plan }),
    findings: (e) => e.concerns.filter((c) => c.blocking).map((c) => c.concern),
  },
  rewritingNote: "The first plan did not pass its automatic check, so it is being written again.",
  // A decision for a person rather than a retry: two ways on.
  failedNote: "The plan did not pass its automatic check, even after being written a second time. Set status to plan-approved to accept the plan as it is, or to spec-approved to write it again.",
};

/**
 * The plan half of Stage 3. spec-approved/planning: plan and the plan gate's checks in one step.
 * plan-review means the checks passed and a person is deciding; it never advances here.
 */
export function runPlanStep(ctx: StepContext): Promise<StepResult> {
  return runArtifactStep(ctx, PLAN);
}
