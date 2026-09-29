import { block, clearMarker, readMarker, setStatus, writeArtifact, writeIntentPriority, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, bullets, headingsCheck, runHookCommands, settleGate, SPEC_HEADINGS, type GateFlow, type Verdict } from "./shared";

const REDESIGNED = "redesigned";

/**
 * Stage 1 and 2. accepted/designing: intake, design, and the spec gate's checks in one step.
 * spec-review means the checks passed and a person is deciding; it never advances here.
 */
export async function runDesignStep(ctx: StepContext): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === "accepted") clearMarker(ctx, REDESIGNED);
  if (status === "accepted" || status === "designing") return design(ctx);
  if (status === "spec-review") {
    if (ctx.cfg.gates.spec.human !== "none") return { ok: true };
    // No person on this gate (config changed, or the status was set by hand): run the checks now.
    return settleGate(ctx, specFlow(ctx));
  }
  return { ok: true };
}

async function design(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "designing") await setStatus(ctx, "designing");
  const before = await runHookCommands(ctx, "before", "design");
  if (!before.ok) return before;

  const a = await artifacts(ctx);
  const intake = await agentPhase(ctx, {
    name: "intake", model: "cheap", permissionMode: "default", tools: "read",
    vars: { intent: a.intent, priority: ctx.intent.file.frontmatter.priority ?? "not stated" },
  });
  if (!intake.ok) return block(ctx, intake.note);
  // Missing sections never get here: the scan's consistency check blocks on them first.
  if (intake.envelope.question.trim()) return block(ctx, `${intake.envelope.question.trim()} Update intent.md, then set status to accepted.`);
  await writeIntentPriority(ctx, intake.envelope.priority);

  // Restarted during the automatic rewrite: send the same findings again.
  const written = await writeSpec(ctx, readMarker(ctx, REDESIGNED) ?? "");
  if (!written.ok) return written;
  return settleGate(ctx, specFlow(ctx));
}

/** One design session: writes spec.md and runs the after commands. */
async function writeSpec(ctx: StepContext, findings: string): Promise<StepResult> {
  const a = await artifacts(ctx);
  const r = await agentPhase(ctx, {
    // Read-only like plan, so the same mode: plan mode returns the structured output normally (verified live).
    name: "design", model: ctx.cfg.stages.design.model, permissionMode: "plan", tools: "read",
    vars: { intent: a.intent, findings }, skills: ctx.cfg.stages.design.skills,
  });
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, "spec.md", r.envelope.spec_markdown);
  return runHookCommands(ctx, "after", "design");
}

function specFlow(ctx: StepContext): GateFlow {
  return {
    gate: "spec", artifact: "spec.md", working: "designing", review: "spec-review", approved: "spec-approved",
    marker: REDESIGNED,
    check: () => checkSpec(ctx),
    rewrite: (findings) => writeSpec(ctx, findings),
    rewritingNote: "The first spec did not pass its automatic check, so it is being written again.",
    // A decision for a person rather than a retry: two ways on.
    failedNote: "The spec did not pass its automatic check, even after being written a second time. Set status to spec-approved to accept the spec as it is, or to accepted to write it again.",
  };
}

async function checkSpec(ctx: StepContext): Promise<Verdict> {
  const a = await artifacts(ctx);
  const judge: { broken?: { note: string; detail: string }; unmet: string[] } = { unmet: [] };
  const checks: Check[] = [headingsCheck("headings", a.spec, SPEC_HEADINGS)];
  if (ctx.cfg.gates.spec.agent) {
    checks.push({
      name: "spec-check",
      run: async () => {
        const r = await agentPhase(ctx, { name: "spec-check", model: "strong", permissionMode: "default", tools: "read", vars: { intent: a.intent, spec: a.spec } });
        if (!r.ok) {
          judge.broken = { note: `The spec could not be checked. ${r.note}`, detail: `spec-check failed: ${r.reason}` };
          return { result: "fail", evidence: `the checker failed: ${r.reason}` };
        }
        judge.unmet = r.envelope.findings.filter((f) => !f.met).map((f) => `${f.requirement}: ${f.evidence}`);
        return r.envelope.approved ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: judge.unmet.join("; ") || r.envelope.summary };
      },
    });
  }
  const outcome = await evaluateGate(ctx, "spec", checks);
  if (outcome.result === "pass") return { result: "pass" };
  if (judge.broken) return { result: "error", ...judge.broken };
  return { result: "fail", findings: bullets(judge.unmet.length ? judge.unmet : [outcome.evidence]), detail: `${outcome.check}: ${outcome.evidence}` };
}
