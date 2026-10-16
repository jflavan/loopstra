import { headingsPresent } from "../checks";
import { block, clearMarker, onceMarker, readArtifact, readMarker, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import type { Envelope } from "../envelopes";
import { modelFor } from "../config";
import { evaluateGate, type Check } from "../gates";
import type { Status } from "../intents";
import { passes, runJudge } from "../judges";
import { agentPhase, optional, together, type AgentPhaseResult, type AgentPhaseSpec } from "../phases";
import type { PromptVars } from "../prompts";
import { artifacts, bullets, humanNote, runHookCommands, type Artifacts } from "./shared";

/**
 * Design and plan are mirror images: an agent writes an artifact (spec.md, plan.md), and the gate's
 * automated checks run in the step that wrote it (the gate timing rule). Each stage is described
 * once; runArtifactStep runs either.
 */
type Writer = "design" | "plan";
type Judge = "spec-check" | "plan-challenge";

/**
 * Work run alongside a judge (see ArtifactStage.ahead). `what` names it in the trace; `when` says
 * whether it runs now; `run` gives what to keep, or null; `keep` stores it once the whole gate passed.
 */
export interface AheadWork {
  what: string;
  when: (ctx: StepContext) => boolean;
  run: (ctx: StepContext, a: Artifacts) => Promise<string | null>;
  keep: (ctx: StepContext, kept: string) => void;
}

export interface ArtifactStage<W extends Writer, J extends Judge> {
  /** The stage in config (model, skills, before and after commands), and the phase that writes the artifact. */
  stage: W;
  gate: "spec" | "plan";
  artifact: string;
  /** The approved status the stage starts from, then its in-progress, waiting, and approved statuses. */
  entry: Status;
  working: Status;
  review: Status;
  approved: Status;
  /** Once-only run-folder marker for the automatic rewrite; it holds the findings it was sent with. */
  marker: string;
  /** Runs after the before commands, before the artifact is written (design's intake). */
  prepare?: (ctx: StepContext) => Promise<StepResult>;
  /** The writing session's prompt variables, told the findings of a failed check ("" at first). */
  vars: (a: Artifacts, findings: string) => PromptVars;
  text: (e: Envelope<W>) => string;
  headings: string[];
  /** Checks of the stage's own, run between the headings and the judge. */
  checks?: (ctx: StepContext, a: Artifacts) => Check[];
  /** The agent judge: its phase, prompt variables, what it found, and what the evidence calls it. */
  judge: { name: J; vars: (a: Artifacts) => PromptVars; findings: (e: Envelope<J>) => string[]; who: string };
  /** Work for the next stage, run alongside the judge and kept only if the whole gate passes (design: planAhead in plan.ts). */
  ahead?: AheadWork;
  /** An answer written earlier, used in place of the writing session when it would ask the same (plan: takePlanAhead). */
  take?: (ctx: StepContext, phase: AgentPhaseSpec & { name: W }) => Promise<AgentPhaseResult<W> | null>;
  rewritingNote: string;
  /** The note when the rewrite did not pass either; it says what a person can set. */
  failedNote: string;
}

/**
 * The entry and in-progress statuses write the artifact and run the checks in one step. The review
 * status means the checks passed and a person is deciding; it never advances here, unless no person
 * is on the gate (config changed, or the status was set by hand): then the checks run now.
 */
export async function runArtifactStep<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>): Promise<StepResult> {
  const status = ctx.intent.file.frontmatter.status;
  if (status === s.entry) clearMarker(ctx, s.marker);
  if (status === s.entry || status === s.working) {
    if (status !== s.working) await setStatus(ctx, s.working);
    const before = await runHookCommands(ctx, "before", s.stage);
    if (!before.ok) return before;
    if (s.prepare) {
      const ready = await s.prepare(ctx);
      if (!ready.ok) return ready;
    }
    // Restarted during the automatic rewrite: send the same findings again.
    const written = await write(ctx, s, readMarker(ctx, s.marker) ?? "");
    if (!written.ok) return written;
    return settle(ctx, s);
  }
  if (status === s.review && ctx.cfg.gates[s.gate].human === "none") return settle(ctx, s);
  return { ok: true };
}

/**
 * The writing session, told the findings of a failed check ("" at first). Work written ahead for this
 * stage builds its session here too, so it asks exactly what the writing session would.
 */
export function writerPhase<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>, a: Artifacts, findings: string): AgentPhaseSpec & { name: W } {
  const cfg = ctx.cfg.stages[s.stage];
  // Read-only sessions in plan mode: it returns the structured output normally (verified live).
  return { name: s.stage, model: cfg.model, permissionMode: "plan", tools: "read", vars: s.vars(a, findings), skills: cfg.skills };
}

/** One writing session (or an answer written earlier, see take): the artifact is written, then the after commands run. */
async function write<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>, findings: string): Promise<StepResult> {
  const phase = writerPhase(ctx, s, await artifacts(ctx), findings);
  const r = (await s.take?.(ctx, phase)) ?? await agentPhase(ctx, phase);
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, s.artifact, s.text(r.envelope));
  return runHookCommands(ctx, "after", s.stage);
}

/**
 * What a check hands back through the gate: the judge could not run, or what it found; or, from a
 * judge that passed, the work written alongside it (see ahead), kept only if the whole gate passes.
 */
type JudgePayload = { broken: { note: string; detail: string } } | { findings: string[] } | { ahead: string };

/**
 * The gate timing rule. Pass with no person on the gate → approved; pass with a person → the
 * review status with a note (so a review status always means "checks passed, waiting for a
 * person"). Fail → one automatic rewrite with the findings, then block. A judge that cannot run
 * blocks at once.
 */
async function settle<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>): Promise<StepResult> {
  for (;;) {
    const outcome = await evaluateGate(ctx, s.gate, await checks(ctx, s));
    if (outcome.result === "pass") {
      clearMarker(ctx, s.marker);
      // Kept before the status commit, so a crash right after it does not lose the work.
      for (const p of outcome.payloads) if ("ahead" in p) s.ahead?.keep(ctx, p.ahead);
      const human = ctx.cfg.gates[s.gate].human;
      if (human === "none") await setStatus(ctx, s.approved);
      else await setStatus(ctx, s.review, humanNote(s.artifact, s.approved, human));
      return { ok: true };
    }
    const p = outcome.payload;
    // The judge could not run at all (its agent failed): no point rewriting; a person decides.
    if (p && "broken" in p) return block(ctx, p.broken.note, { detail: p.broken.detail });
    // The findings go back to the writer: the judge's, else the failing check's evidence.
    const found = p && "findings" in p ? p.findings : [];
    const findings = bullets(found.length ? found : [outcome.evidence]);
    const detail = `${outcome.check}: ${outcome.evidence}`;
    if (!onceMarker(ctx, s.marker, findings)) return block(ctx, s.failedNote, { detail });
    await setStatus(ctx, s.working, s.rewritingNote);
    const again = await write(ctx, s, findings);
    if (!again.ok) return again;
  }
}

/** The headings, the stage's own checks, and the judge when the gate has one. */
async function checks<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>): Promise<Check<JudgePayload>[]> {
  const a = await artifacts(ctx);
  const text = (await readArtifact(ctx, s.artifact)) ?? "";
  const list: Check<JudgePayload>[] = [
    {
      name: "headings",
      run: async () => {
        const r = headingsPresent(text, s.headings);
        return r.ok ? { result: "pass", evidence: "all headings present" } : { result: "fail", evidence: `missing headings: ${r.missing.join(", ")}` };
      },
    },
    ...(s.checks?.(ctx, a) ?? []),
  ];
  if (!ctx.cfg.gates[s.gate].agent) return list;
  list.push({
    name: s.judge.name,
    run: async () => {
      // Work for the next stage runs alongside on the same artifact the judge reads; it is optional,
      // so an outage or the day's budget drops it and the judge meets the same trouble on its own.
      const ahead = s.ahead?.when(ctx) ? s.ahead : undefined;
      // A cheaper judge in shadow then needs room beside both.
      const judge = () => runJudge(ctx, { name: s.judge.name, model: "strong", permissionMode: "default", tools: "read", vars: s.judge.vars(a) }, { alongside: ahead ? 1 : 0 });
      const [r, early] = ahead
        ? await together(ctx, [judge, () => optional(ctx, ahead.what, () => ahead.run(ctx, a))] as const)
        : [await judge(), null];
      const notKept = (why: string) => { if (ahead && early) ctx.trace.event(ctx.slug, "command", { command: ahead.what, note: `not kept: ${why}` }); };
      if (!r.ok) {
        notKept(`the ${s.gate} could not be checked`);
        return { result: "fail", evidence: `the ${s.judge.who} failed: ${r.reason}`, payload: { broken: { note: `The ${s.gate} could not be checked. ${r.note}`, detail: `${s.judge.name} failed: ${r.reason}` } } };
      }
      // Findings always come from the envelope that decided: the strong judge's whenever it is a reject.
      const findings = s.judge.findings(r.envelope);
      if (passes(s.judge.name, r.envelope)) {
        const by = r.decidedBy === "cheap" ? ` (decided by the cheaper judge, ${modelFor(ctx.cfg, "default")})` : "";
        return { result: "pass", evidence: `${r.envelope.summary}${by}`, payload: early ? { ahead: early } : undefined };
      }
      notKept(`the ${s.gate} did not pass its check`);
      return { result: "fail", evidence: findings.join("; ") || r.envelope.summary, payload: { findings } };
    },
  });
  return list;
}
