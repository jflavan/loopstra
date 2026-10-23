import { roomBeside } from "../budget";
import { filesExistOrNew, parsePlanFiles } from "../checks";
import type { Config } from "../config";
import { clearMarker, writeMarker, type StepContext, type StepResult } from "../context";
import { scanRepo, type Status } from "../intents";
import { agentPhase, phaseModel, phasePrompt, renderedThen, type AgentPhaseResult, type AgentPhaseSpec } from "../phases";
import { errorText } from "../shell";
import { notTheStepsFault } from "../stop";
import { EARLY } from "../trace";
import { runArtifactStep, writerPhase, type AheadWork, type ArtifactStage } from "./artifact";
import { codeDiffers, takeKept, type Artifacts, type Kept } from "./shared";

const PLAN: ArtifactStage<"plan", "plan-challenge"> = {
  stage: "plan", gate: "plan", artifact: "plan.md",
  entry: "spec-approved", working: "planning", review: "plan-review", approved: "plan-approved",
  marker: "replanned",
  take: takePlanAhead,
  vars: (a, concerns) => ({ intent: a.intent, spec: a.spec, concerns }),
  text: (e) => e.plan_markdown,
  headings: ["Files that change", "Order of work", "Risks", "Proof"],
  checks: (ctx, a) => [{
    name: "files",
    run: async () => {
      const files = parsePlanFiles(a.plan) ?? []; // no Files section: the headings check reports it
      // The files of the code the plan was written on (the step's snapshot of main).
      const tracked = (await ctx.git.run(["ls-tree", "-r", "-z", "--name-only", await ctx.readCommit()])).out.split("\0");
      const r = filesExistOrNew(tracked, files);
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

/**
 * Run-folder file: the first plan, written while spec-check judged the spec (see planAhead), as JSON:
 * what it was asked (`key`), and the commit whose code it read (`base`, the design step's snapshot).
 */
export const PLAN_AHEAD = "plan.ahead";

/** A full commit id (SHA-1, or SHA-256). */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * What a plan session is asked: its model (the CLI name it ran on, or would run on now) and the whole
 * prompt (intent, spec, concerns, skills, template).
 */
function planKey(model: string, prompt: string): string {
  return [model, prompt].join("\n");
}

/**
 * Why the config rules out a plan written ahead, for writing one and for using one; null when it does
 * not. Plan before commands would run between the gate and the plan, and the key cannot see what they change.
 */
function ruledOut(cfg: Config): string | null {
  if (!cfg.speed.plan_ahead) return "speed.plan_ahead is switched off";
  if (cfg.stages.plan.before.length) return "the plan stage has before commands";
  return null;
}

/**
 * Another change in this status may merge into main before this change's plan step: its code would
 * then not be the code the plan read. A pull request waiting for a person is not counted.
 */
function mayMergeFirst(cfg: Config, status: Status): boolean {
  return status === "reviewing" || status === "merge-approved" || (status === "merge-review" && cfg.gates.merge.human === "none");
}

/**
 * A plan is written ahead only when it is likely to be used and cannot starve the judge: the config
 * allows it (see ruledOut), no person is on the spec gate (they may take days and edit the spec), the
 * day has room for two sessions beside one for each other change running a step (see roomBeside),
 * and no other change may merge first (see mayMergeFirst).
 */
async function plansAhead(ctx: StepContext): Promise<boolean> {
  const cfg = ctx.cfg;
  if (ruledOut(cfg) !== null || cfg.gates.spec.human !== "none" || !roomBeside(cfg, ctx.trace, ctx.slug, 2)) return false;
  const others = (await scanRepo(ctx.root)).intents.filter((i) => i.slug !== ctx.slug);
  return !others.some((i) => mayMergeFirst(cfg, i.file.frontmatter.status));
}

/**
 * The first plan, written on the spec the judge was given, by the same session the plan step would
 * start (LOOPSTRA_PHASE stays plan), in the design step's snapshot of main. Returns what to keep if
 * the spec passes, or null when the session did not finish (the plan step then plans as usual).
 */
async function planAheadRun(ctx: StepContext, a: Artifacts): Promise<string | null> {
  // An early- row, as for all work run alongside: its failures are not the change's (see EARLY).
  const phase = { ...writerPhase(ctx, PLAN, a, ""), traceName: `${EARLY}plan` }; // the trace name is not part of the prompt
  // Keyed on the prompt the plan was written on: a retry's is rendered again, with what people told the crashed attempt.
  let sent = await phasePrompt(ctx, phase);
  const r = await agentPhase(ctx, phase, renderedThen(sent, async () => {
    const p = await phasePrompt(ctx, phase);
    if (p !== null) sent = p;
    return p;
  }));
  if (sent === null || !r.ok) return null;
  // The model the session ran on: one a person changed while it ran is not the one it was written by.
  return JSON.stringify({ key: planKey(r.model, sent), base: await ctx.readCommit(), envelope: r.envelope });
}

/** Keeps the plan written ahead for the plan step (see planAheadRun). */
function keepPlanAhead(ctx: StepContext, kept: string): void {
  writeMarker(ctx, PLAN_AHEAD, kept);
  ctx.trace.event(ctx.slug, "command", { command: "plan ahead", note: "kept for the plan step" });
}

/** The design step's spec-check runs this alongside (see ArtifactStage.ahead). */
export const planAhead: AheadWork = {
  what: "plan ahead", when: plansAhead, run: planAheadRun, keep: keepPlanAhead,
  discard: (ctx) => clearMarker(ctx, PLAN_AHEAD),
};

/**
 * The plan written ahead, in place of the plan session, when it asked exactly what that session
 * would ask (`prompt`), of the same code. It is used once, whatever happens: the file is cleared
 * before the checks. Null (the plan step plans as usual) when there is none, or with the reason in
 * the trace; trouble checking it is such a reason too, since it only saves a session.
 */
async function takePlanAhead(ctx: StepContext, phase: AgentPhaseSpec & { name: "plan" }, prompt: string | null): Promise<AgentPhaseResult<"plan"> | null> {
  const kept = takeKept(ctx, PLAN_AHEAD, "plan");
  if (kept === undefined) return null;
  let why: string | null;
  let model = "";
  try {
    model = (await phaseModel(ctx, phase)).name;
    why = await whyNotUsed(ctx, model, prompt, kept);
  } catch (e) {
    if (notTheStepsFault(e)) throw e;
    why = `it could not be checked: ${errorText(e)}`;
  }
  if (why !== null) {
    ctx.trace.event(ctx.slug, "command", { command: "plan ahead", note: `not used: ${why}` });
    return null;
  }
  ctx.trace.event(ctx.slug, "command", { command: "plan ahead", note: "the plan step uses the plan written while the spec was being checked" });
  // Plan sessions are never resumed, so a missing session id loses nothing.
  return { ok: true, envelope: kept!.envelope, sessionId: null, costUsd: 0, model };
}

/** In plain words, the first rule the kept plan breaks, for a plan step on `model`; null when it keeps them all. */
async function whyNotUsed(ctx: StepContext, model: string, prompt: string | null, kept: Kept<"plan"> | null): Promise<string | null> {
  const { base } = kept?.saved ?? {};
  if (!kept || typeof base !== "string" || !COMMIT.test(base)) return "it could not be read";
  const ruled = ruledOut(ctx.cfg);
  if (ruled !== null) return ruled;
  if (prompt === null) return "the plan prompt is missing";
  if (kept.key !== planKey(model, prompt)) return "the intent, the spec, the plan prompt or its model changed";
  // The code the plan read against the code this step reads; the loop's own commits (statuses,
  // artifacts, the queue) are all under intent/. A missing base commit counts as a change.
  if (await codeDiffers(ctx.git, base, await ctx.readCommit())) return "the code on main changed";
  return null;
}
