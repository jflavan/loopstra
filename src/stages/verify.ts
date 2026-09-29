import { block, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { agentPhase } from "../phases";
import { artifacts, humanNote } from "./shared";

/** Stage 6 for one intent. Called for merged and verifying. Ends at done or blocked. */
export async function runVerifyStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "verifying") await setStatus(ctx, "verifying");
  const a = await artifacts(ctx);
  const doneWhen = ctx.intent.file.sections["Done when"] ?? "";

  let outcomeMd = "";
  let unmet: string[] = [];
  const checks: Check[] = [];
  if (ctx.cfg.gates.done.agent) {
    checks.push({
      name: "done-check",
      run: async () => {
        const r = await agentPhase(ctx, { name: "done-check", model: "strong", permissionMode: "default", tools: "read+commands", vars: { done_when: doneWhen, spec: a.spec, review: a.review } });
        if (!r.ok) return { result: "fail", evidence: r.note };
        outcomeMd = r.envelope.outcome_markdown;
        unmet = r.envelope.evidence.filter((e) => !e.met).map((e) => `${e.criterion} (${e.evidence})`);
        return r.envelope.met ? { result: "pass", evidence: r.envelope.summary } : { result: "fail", evidence: unmet.join("; ") };
      },
    });
  }
  if (ctx.cfg.gates.done.human === "status") {
    checks.push({ name: "human", run: async () => ({ result: "waiting", evidence: "waiting for a person to confirm" }) });
  }

  const outcome = await evaluateGate(ctx, "done", checks);
  if (outcomeMd) await writeArtifact(ctx, "outcome.md", outcomeMd);
  if (outcome.result === "waiting") {
    if (!ctx.intent.file.frontmatter.note) await setStatus(ctx, "verifying", humanNote("outcome.md", "done", ctx.cfg.gates.done.human));
    return { ok: true };
  }
  if (outcome.result === "fail") {
    return block(ctx, `The change merged but its Done when criteria are not all met: ${outcome.evidence}. Decide whether to open a follow-up intent, then set this one to done or closed.`);
  }

  const lessons = await agentPhase(ctx, { name: "lessons", model: "cheap", permissionMode: "default", tools: "read", vars: { review: a.review, previous: ctx.trace.phases(ctx.slug).filter((p) => p.status === "fail").map((p) => `${p.name}: ${p.error ?? ""}`).join("\n") } });
  const body = (outcomeMd || "# Outcome\n\n## Outcome\nDone.\n\n## Evidence\n(no automated check configured)\n").trimEnd();
  const lessonsMd = lessons.ok
    ? `\n\n## Lessons\n${lessons.envelope.lessons.map((l) => `- ${l}`).join("\n") || "- None recorded."}\n\n## Proposed CLAUDE.md additions\n${lessons.envelope.claude_md_additions.trim() || "None."}\n`
    : `\n\n## Lessons\n- The lessons step did not finish: ${lessons.note}\n`;
  await writeArtifact(ctx, "outcome.md", body + lessonsMd);
  await setStatus(ctx, "done");
  return { ok: true };
}
