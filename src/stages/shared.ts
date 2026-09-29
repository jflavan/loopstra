import { commandTimeoutMs, runCommand } from "../shell";
import { block, readArtifact, setStatus, type StepContext, type StepResult } from "../context";
import { codePhase } from "../phases";
import type { Check } from "../gates";
import { headingsPresent } from "../checks";
import type { Status } from "../intents";

/** Runs a stage's before/after commands as one code phase. Any failure blocks. */
export async function runHookCommands(ctx: StepContext, which: "before" | "after", stage: keyof StepContext["cfg"]["stages"], cwd = ctx.root): Promise<StepResult> {
  const cmds = ctx.cfg.stages[stage][which];
  if (!cmds.length) return { ok: true };
  const r = await codePhase(ctx, `${stage}-${which}`, async () => {
    for (const cmd of cmds) {
      const res = await runCommand(cmd, cwd, { env: { LOOPSTRA_SLUG: ctx.slug, LOOPSTRA_STAGE: stage }, timeoutMs: commandTimeoutMs(ctx.cfg) });
      ctx.trace.event(ctx.slug, "command", { command: cmd, code: res.code, lastLine: res.lastLine, durationMs: res.durationMs });
      if (res.code !== 0) throw new Error(`\`${cmd}\` failed: ${res.lastLine || `exit ${res.code}`}`);
    }
    return { ok: true as const };
  });
  return r.ok ? { ok: true } : block(ctx, `A ${which} command for the ${stage} stage failed. ${r.note}`);
}

export function headingsCheck(name: string, text: string, headings: string[]): Check {
  return {
    name,
    run: async () => {
      const r = headingsPresent(text, headings);
      return r.ok ? { result: "pass", evidence: "all headings present" } : { result: "fail", evidence: `missing headings: ${r.missing.join(", ")}` };
    },
  };
}

export const SPEC_HEADINGS = ["Summary", "Requirements", "Design", "Affected code", "Out of scope", "Open questions", "Areas of concern"];
export const PLAN_HEADINGS = ["Files that change", "Order of work", "Risks", "Proof"];

/** The note written when a human gate is waiting. */
export function humanNote(artifact: string, approvedStatus: Status): string {
  return `Read ${artifact}. When you are happy with it, change the status line to ${approvedStatus}. To stop this change, set it to closed.`;
}

export async function artifacts(ctx: StepContext): Promise<{ intent: string; spec: string; plan: string; review: string }> {
  return {
    intent: ctx.intent.file.body,
    spec: (await readArtifact(ctx, "spec.md")) ?? "",
    plan: (await readArtifact(ctx, "plan.md")) ?? "",
    review: (await readArtifact(ctx, "review.md")) ?? "",
  };
}

export { setStatus };
