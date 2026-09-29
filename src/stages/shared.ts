import { commandTimeoutMs, runCommand } from "../shell";
import { blockWithDetail, clearMarker, onceMarker, readArtifact, setStatus, type StepContext, type StepResult } from "../context";
import { codePhase } from "../phases";
import type { Check } from "../gates";
import { headingsPresent } from "../checks";
import type { Status } from "../intents";

/** Runs a stage's before/after commands as one code phase. Any failure blocks with a plain note; the command and its output go to the trace. */
export async function runHookCommands(ctx: StepContext, which: "before" | "after", stage: keyof StepContext["cfg"]["stages"], cwd = ctx.root): Promise<StepResult> {
  const cmds = ctx.cfg.stages[stage][which];
  if (!cmds.length) return { ok: true };
  let timedOut = false;
  const r = await codePhase(ctx, `${stage}-${which}`, async () => {
    for (const cmd of cmds) {
      const res = await runCommand(cmd, cwd, { env: { LOOPSTRA_SLUG: ctx.slug, LOOPSTRA_STAGE: stage }, timeoutMs: commandTimeoutMs(ctx.cfg) });
      ctx.trace.event(ctx.slug, "command", { command: cmd, code: res.code, lastLine: res.lastLine, durationMs: res.durationMs });
      if (res.code !== 0) { timedOut = res.timedOut; throw new Error(`\`${cmd}\` failed: ${res.lastLine || `exit ${res.code}`}`); }
    }
    return { ok: true as const };
  });
  if (r.ok) return { ok: true };
  const what = timedOut ? "did not finish in time" : "failed";
  return blockWithDetail(ctx, `A project command that runs ${which} the ${stage} stage ${what}. An engineer needs to look at it.`, r.note);
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

/** The note written when a human gate is waiting. The wording follows the gate's surface. */
export function humanNote(artifact: string, approvedStatus: Status, surface: "status" | "pr" | "none" = "status"): string {
  if (surface === "pr") {
    return `Read ${artifact}. When you are happy with it, approve its pull request or change the status line to ${approvedStatus}. To stop this change, set the status line to closed.`;
  }
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

/** What a gate's automated checks concluded about an artifact. */
export type Verdict =
  | { result: "pass" }
  /** The artifact needs work: `findings` go back to the agent that writes it. */
  | { result: "fail"; findings: string; detail: string }
  /** A checker could not run at all (its agent failed): no point rewriting; a person decides. */
  | { result: "error"; note: string; detail: string };

export interface GateFlow {
  gate: "spec" | "plan";
  artifact: string;
  /** The in-progress, waiting, and approved statuses of this gate. */
  working: Status;
  review: Status;
  approved: Status;
  /** Once-only marker for the automatic rewrite. */
  marker: string;
  check: () => Promise<Verdict>;
  /** Writes the artifact again, told the findings. */
  rewrite: (findings: string) => Promise<StepResult>;
  rewritingNote: string;
  failedNote: string;
  /** How a person retries, appended to every block note. */
  retry: string;
}

/**
 * The gate timing rule: the automated checks run in the step that wrote the artifact.
 * Pass with no person on the gate → approved; pass with a person → the review status with a
 * note (so a review status always means "checks passed, waiting for a person"). Fail → one
 * automatic rewrite with the findings, then block. A checker that cannot run blocks at once.
 */
export async function settleGate(ctx: StepContext, flow: GateFlow): Promise<StepResult> {
  for (;;) {
    const v = await flow.check();
    if (v.result === "pass") {
      clearMarker(ctx, flow.marker);
      const human = ctx.cfg.gates[flow.gate].human;
      if (human === "none") await setStatus(ctx, flow.approved);
      else await setStatus(ctx, flow.review, humanNote(flow.artifact, flow.approved, human));
      return { ok: true };
    }
    if (v.result === "error") return blockWithDetail(ctx, `${v.note} ${flow.retry}`, v.detail);
    if (!onceMarker(ctx, flow.marker)) return blockWithDetail(ctx, `${flow.failedNote} ${flow.retry}`, v.detail);
    await setStatus(ctx, flow.working, flow.rewritingNote);
    const again = await flow.rewrite(v.findings);
    if (!again.ok) return again;
  }
}

/** Markdown bullets, one per item. */
export function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

export { setStatus };
