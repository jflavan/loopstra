import { headingsPresent } from "../checks";
import { block, clearMarker, onceMarker, readArtifact, readMarker, setStatus, writeArtifact, type StepContext, type StepResult } from "../context";
import type { Envelope } from "../envelopes";
import { evaluateGate, type Check } from "../gates";
import type { Status } from "../intents";
import { agentPhase } from "../phases";
import type { PromptVars } from "../prompts";
import { artifacts, bullets, humanNote, runHookCommands, type Artifacts } from "./shared";

/**
 * Design and plan are mirror images: an agent writes an artifact (spec.md, plan.md), and the gate's
 * automated checks run in the step that wrote it (the gate timing rule). Each stage is described
 * once; runArtifactStep runs either.
 */
type Writer = "design" | "plan";
type Judge = "spec-check" | "plan-challenge";

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

/** One writing session: the artifact is written, then the after commands run. */
async function write<W extends Writer, J extends Judge>(ctx: StepContext, s: ArtifactStage<W, J>, findings: string): Promise<StepResult> {
  const cfg = ctx.cfg.stages[s.stage];
  // Read-only sessions in plan mode: it returns the structured output normally (verified live).
  const r = await agentPhase(ctx, { name: s.stage, model: cfg.model, permissionMode: "plan", tools: "read", vars: s.vars(await artifacts(ctx), findings), skills: cfg.skills });
  if (!r.ok) return block(ctx, r.note);
  await writeArtifact(ctx, s.artifact, s.text(r.envelope));
  return runHookCommands(ctx, "after", s.stage);
}

/** What a failed check hands back through the gate: the judge could not run, or what it found. */
type JudgePayload = { broken: { note: string; detail: string } } | { findings: string[] };

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
      const human = ctx.cfg.gates[s.gate].human;
      if (human === "none") await setStatus(ctx, s.approved);
      else await setStatus(ctx, s.review, humanNote(s.artifact, s.approved, human));
      return { ok: true };
    }
    const p = outcome.payload;
    // The judge could not run at all (its agent failed): no point rewriting; a person decides.
    if (p && "broken" in p) return block(ctx, p.broken.note, { detail: p.broken.detail });
    // The findings go back to the writer: the judge's, else the failing check's evidence.
    const findings = bullets(p?.findings.length ? p.findings : [outcome.evidence]);
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
      const r = await agentPhase(ctx, { name: s.judge.name, model: "strong", permissionMode: "default", tools: "read", vars: s.judge.vars(a) });
      if (!r.ok) {
        return { result: "fail", evidence: `the ${s.judge.who} failed: ${r.reason}`, payload: { broken: { note: `The ${s.gate} could not be checked. ${r.note}`, detail: `${s.judge.name} failed: ${r.reason}` } } };
      }
      const e: { approved: boolean; summary: string } = r.envelope;
      const findings = s.judge.findings(r.envelope);
      if (e.approved) return { result: "pass", evidence: e.summary };
      return { result: "fail", evidence: findings.join("; ") || e.summary, payload: { findings } };
    },
  });
  return list;
}
