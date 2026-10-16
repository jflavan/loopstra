import { roomForTwo } from "../budget";
import { filesExistOrNew, parsePlanFiles } from "../checks";
import { modelFor } from "../config";
import { clearMarker, readMarker, writeMarker, type StepContext, type StepResult } from "../context";
import { Envelopes, type Envelope } from "../envelopes";
import { agentPhase, phasePrompt, type AgentPhaseResult, type AgentPhaseSpec } from "../phases";
import { runArtifactStep, writerPhase, type AheadWork, type ArtifactStage } from "./artifact";
import type { Artifacts } from "./shared";

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
      const tracked = (await ctx.git.run(["ls-files", "-z"])).out.split("\0");
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
 * Run-folder file: the first plan, written while spec-check judged the spec (see planAhead), with what
 * it was asked (`key`) and the commit main was on when it started (`base`), as JSON.
 */
export const PLAN_AHEAD = "plan.ahead";

/** What a plan session is asked: its model and the whole prompt (intent, spec, concerns, skills, template). Null without a prompt file. */
async function planKey(ctx: StepContext, phase: AgentPhaseSpec): Promise<string | null> {
  const prompt = await phasePrompt(ctx, phase);
  return prompt === null ? null : [modelFor(ctx.cfg, phase.model), prompt].join("\n");
}

/**
 * A plan is written ahead only when it is likely to be used and cannot starve the judge: the switch is
 * on, no person is on the spec gate (they may take days and edit the spec), no plan before commands
 * would run between the gate and the plan (the key cannot see what they change), and the day has room
 * for two sessions.
 */
function plansAhead(ctx: StepContext): boolean {
  const cfg = ctx.cfg;
  return cfg.speed.plan_ahead && cfg.gates.spec.human === "none" && cfg.stages.plan.before.length === 0 && roomForTwo(cfg, ctx.trace);
}

/**
 * The first plan, written on the spec the judge was given, by the same session the plan step would
 * start (LOOPSTRA_PHASE stays plan). Returns what to keep if the spec passes, or null when the session
 * did not finish (the plan step then plans as usual).
 */
async function planAheadRun(ctx: StepContext, a: Artifacts): Promise<string | null> {
  const phase = { ...writerPhase(ctx, PLAN, a, ""), traceName: "plan-ahead" }; // traceName is not part of the prompt
  const key = await planKey(ctx, phase);
  const base = await ctx.git.headSha(); // taken before the session starts, so any change after it counts
  const r = await agentPhase(ctx, phase);
  return key !== null && r.ok ? JSON.stringify({ key, base, envelope: r.envelope }) : null;
}

/** Keeps the plan written ahead for the plan step (see planAheadRun). */
function keepPlanAhead(ctx: StepContext, kept: string): void {
  writeMarker(ctx, PLAN_AHEAD, kept);
  ctx.trace.event(ctx.slug, "command", { command: "plan ahead", note: "kept for the plan step" });
}

/** The design step's spec-check runs this alongside (see ArtifactStage.ahead). */
export const planAhead: AheadWork = { what: "plan ahead", when: plansAhead, run: planAheadRun, keep: keepPlanAhead };

/**
 * The plan written ahead, in place of the plan session, when it asked exactly what that session
 * would ask, of the same code. It is used once, whatever happens: the file is cleared before the
 * checks. Null (the plan step plans as usual) when there is none, or with the reason in the trace.
 */
async function takePlanAhead(ctx: StepContext, phase: AgentPhaseSpec & { name: "plan" }): Promise<AgentPhaseResult<"plan"> | null> {
  const saved = readMarker(ctx, PLAN_AHEAD);
  if (saved === null) return null;
  clearMarker(ctx, PLAN_AHEAD);
  const r = await checkKept(ctx, phase, saved);
  if ("why" in r) {
    ctx.trace.event(ctx.slug, "command", { command: "plan ahead", note: `not used: ${r.why}` });
    return null;
  }
  ctx.trace.event(ctx.slug, "command", { command: "plan ahead", note: "the plan step uses the plan written while the spec was being checked" });
  // Plan sessions are never resumed, so a missing session id loses nothing.
  return { ok: true, envelope: r.envelope, sessionId: null, costUsd: 0 };
}

/** The kept plan's report when every rule holds; otherwise, in plain words, the first rule that does not. */
async function checkKept(ctx: StepContext, phase: AgentPhaseSpec, saved: string): Promise<{ envelope: Envelope<"plan"> } | { why: string }> {
  const kept = readKept(saved);
  if (!kept) return { why: "it could not be read" };
  if (!ctx.cfg.speed.plan_ahead) return { why: "speed.plan_ahead is switched off" };
  if (ctx.cfg.stages.plan.before.length) return { why: "the plan stage has before commands" };
  if (kept.key !== await planKey(ctx, phase)) return { why: "the intent, the spec, the plan prompt or its model changed" };
  // The main checkout's tracked files against the commit it started from. The loop's own commits
  // (statuses, artifacts, the queue) are all under intent/; a missing base commit fails too.
  const diff = await ctx.git.run(["diff", "--quiet", kept.base, "--", ".", ":(exclude)intent"], true);
  if (diff.code !== 0) return { why: "the code on main changed" };
  return { envelope: kept.envelope };
}

/** The plan.ahead file's contents, or null when it is not what planAheadRun wrote (corrupt, or from another Loopstra version). */
function readKept(saved: string): { key: string; base: string; envelope: Envelope<"plan"> } | null {
  let raw: { key?: unknown; base?: unknown; envelope?: unknown };
  try {
    raw = JSON.parse(saved) as typeof raw;
  } catch {
    return null;
  }
  const envelope = Envelopes.plan.safeParse(raw?.envelope);
  if (!envelope.success || typeof raw.key !== "string" || typeof raw.base !== "string") return null;
  return { key: raw.key, base: raw.base, envelope: envelope.data };
}
