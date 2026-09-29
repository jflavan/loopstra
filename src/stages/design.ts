import { block, setStatus, writeArtifact, writeIntentPriority, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, headingsCheck, humanNote, runHookCommands, SPEC_HEADINGS } from "./shared";

/** One step of Stage 1 and 2. Called when status is accepted, designing, or spec-review. */
export async function runDesignStep(ctx: StepContext): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === "accepted" || status === "designing") return design(ctx);
  if (status === "spec-review") return specGate(ctx);
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
  if (intake.envelope.question || intake.envelope.missing_sections.length) {
    const missing = intake.envelope.missing_sections.length ? ` Missing sections: ${intake.envelope.missing_sections.join(", ")}.` : "";
    return block(ctx, `${intake.envelope.question || "The intent needs more detail before it can be designed."}${missing} Update intent.md, then set status to accepted.`);
  }
  await writeIntentPriority(ctx, intake.envelope.priority);

  const design = await agentPhase(ctx, {
    name: "design", model: ctx.cfg.stages.design.model, permissionMode: "default", tools: "read",
    vars: { intent: a.intent }, skills: ctx.cfg.stages.design.skills,
  });
  if (!design.ok) return block(ctx, design.note);
  await writeArtifact(ctx, "spec.md", design.envelope.spec_markdown);

  const after = await runHookCommands(ctx, "after", "design");
  if (!after.ok) return after;
  await setStatus(ctx, "spec-review", ctx.cfg.gates.spec.human === "none" ? "" : humanNote("spec.md", "spec-approved"));
  return { ok: true };
}

async function specGate(ctx: StepContext): Promise<StepResult> {
  const a = await artifacts(ctx);
  const checks: Check[] = [headingsCheck("headings", a.spec, SPEC_HEADINGS)];
  if (ctx.cfg.gates.spec.agent) {
    checks.push({
      name: "spec-check",
      run: async () => {
        const r = await agentPhase(ctx, { name: "spec-check", model: "strong", permissionMode: "default", tools: "read", vars: { intent: a.intent, spec: a.spec } });
        if (!r.ok) return { result: "fail", evidence: r.note };
        const unmet = r.envelope.findings.filter((f) => !f.met).map((f) => `${f.requirement}: ${f.evidence}`);
        return r.envelope.approved ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: unmet.join("; ") || r.envelope.summary };
      },
    });
  }
  const outcome = await evaluateGate(ctx, "spec", checks);
  if (outcome.result === "pass") { await setStatus(ctx, "spec-approved"); return { ok: true }; }
  return block(ctx, `The spec did not pass its check (${outcome.check}): ${outcome.evidence}. Fix spec.md or the intent, then set status to accepted to redesign.`);
}
