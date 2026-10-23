import { block, writeIntentPriority, type StepContext, type StepResult } from "../context";
import { agentPhase } from "../phases";
import { runArtifactStep, type ArtifactStage } from "./artifact";
import { planAhead } from "./plan";

const DESIGN: ArtifactStage<"design", "spec-check"> = {
  stage: "design", gate: "spec", artifact: "spec.md",
  entry: "accepted", working: "designing", review: "spec-review", approved: "spec-approved",
  marker: "redesigned",
  prepare: intake,
  vars: (a, findings) => ({ intent: a.intent, findings }),
  text: (e) => e.spec_markdown,
  headings: ["Summary", "Requirements", "Design", "Affected code", "Out of scope", "Open questions", "Areas of concern"],
  judge: {
    name: "spec-check", who: "checker",
    vars: (a) => ({ intent: a.intent, spec: a.spec }),
    findings: (e) => e.findings.filter((f) => !f.met).map((f) => `${f.requirement}: ${f.evidence}`),
  },
  ahead: planAhead,
  rewritingNote: "The first spec did not pass its automatic check, so it is being written again.",
  // A decision for a person rather than a retry: two ways on.
  failedNote: "The spec did not pass its automatic check, even after being written a second time. Set status to spec-approved to accept the spec as it is, or to accepted to write it again.",
};

/**
 * Stage 1 and 2. accepted/designing: intake, design, and the spec gate's checks in one step.
 * spec-review means the checks passed and a person is deciding; it never advances here. With
 * speed.plan_ahead, the first plan may be written alongside spec-check (see planAhead).
 */
export function runDesignStep(ctx: StepContext): Promise<StepResult> {
  return runArtifactStep(ctx, DESIGN);
}

/** Intake, before the spec is written: the priority is recorded when the owner stated none. A question for the owner asks it (see agentPhase). */
async function intake(ctx: StepContext): Promise<StepResult> {
  const r = await agentPhase(ctx, {
    name: "intake", permissionMode: "default", tools: "read",
    vars: { intent: ctx.intent.file.body, priority: ctx.intent.file.frontmatter.priority ?? "not stated" },
  });
  if (!r.ok) return block(ctx, r.note);
  // Missing sections never get here: the scan's consistency check blocks on them first.
  await writeIntentPriority(ctx, r.envelope.priority);
  return { ok: true };
}
