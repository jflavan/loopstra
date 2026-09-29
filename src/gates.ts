import type { StepContext } from "./context";

export type CheckResult = { result: "pass" | "fail" | "waiting"; evidence: string };
export interface Check { name: string; run: () => Promise<CheckResult> }
export type GateName = "intent" | "spec" | "plan" | "merge" | "done";
export type GateOutcome = { result: "pass" } | { result: "fail" | "waiting"; check: string; evidence: string };

/** Runs checks in order. Stops at the first fail or waiting. Records every check that ran. */
export async function evaluateGate(ctx: StepContext, gate: GateName, checks: Check[]): Promise<GateOutcome> {
  for (const check of checks) {
    let r: CheckResult;
    try { r = await check.run(); } catch (e) { r = { result: "fail", evidence: `check crashed: ${(e as Error).message}` }; }
    ctx.trace.gate(ctx.slug, gate, check.name, r.result, r.evidence);
    if (r.result !== "pass") return { result: r.result, check: check.name, evidence: r.evidence };
  }
  return { result: "pass" };
}
