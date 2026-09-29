import type { StepContext } from "./context";
import { passOn } from "./git";
import { errorText } from "./shell";

/** One check's verdict. `payload` carries what the gate's caller needs back from the check (findings, a failure to record). */
export type CheckResult<P = never> = { result: "pass" | "fail" | "waiting"; evidence: string; payload?: P };
export interface Check<P = never> { name: string; run: () => Promise<CheckResult<P>> }
export type GateName = "spec" | "plan" | "merge" | "done";
/** Pass, with the payloads the passing checks returned; or the first check that did not pass, as it returned. */
export type GateOutcome<P = never> = { result: "pass"; payloads: P[] } | (CheckResult<P> & { result: "fail" | "waiting"; check: string });

/** Runs checks in order. Stops at the first fail or waiting. Records every check that ran. */
export async function evaluateGate<P = never>(ctx: StepContext, gate: GateName, checks: Check<P>[]): Promise<GateOutcome<P>> {
  const payloads: P[] = [];
  for (const check of checks) {
    let r: CheckResult<P>;
    try {
      r = await check.run();
    } catch (e) {
      passOn(e);
      r = { result: "fail", evidence: `check crashed: ${errorText(e)}` };
    }
    ctx.trace.gate(ctx.slug, gate, check.name, r.result, r.evidence);
    if (r.result !== "pass") return { ...r, result: r.result, check: check.name };
    if (r.payload !== undefined) payloads.push(r.payload);
  }
  return { result: "pass", payloads };
}
