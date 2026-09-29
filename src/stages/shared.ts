import { commandTimeoutMs, runCommand } from "../shell";
import {
  blockWithDetail, clearMarker, clearSession, loadSessions, onceMarker, readArtifact, saveSession, setStatus,
  type Failure, type StepContext, type StepResult,
} from "../context";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git, passOn } from "../git";
import { agentPhase, codePhase, type AgentPhaseResult, type AgentPhaseSpec } from "../phases";
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
  /** The note when the rewrite did not pass either; it says what a person can set. */
  failedNote: string;
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
    if (v.result === "error") return blockWithDetail(ctx, v.note, v.detail);
    if (!onceMarker(ctx, flow.marker, v.findings)) return blockWithDetail(ctx, flow.failedNote, v.detail);
    await setStatus(ctx, flow.working, flow.rewritingNote);
    const again = await flow.rewrite(v.findings);
    if (!again.ok) return again;
  }
}

/**
 * Commits everything in the worktree, but only after confirming it is on the intent branch:
 * a commit anywhere else could put unreviewed work on another branch.
 */
export async function saveWork(ctx: StepContext, wt: Git, message: string): Promise<{ ok: true } | Failure> {
  try {
    await wt.assertBranch(ctx.branch);
    await wt.commitAll(message);
    return { ok: true };
  } catch (e) {
    passOn(e);
    return {
      ok: false,
      note: "The work could not be saved to this change's own branch. An engineer needs to look at it.",
      detail: `commit in ${wt.cwd}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Build-session continuations: they resume the build session. */
type Continuation = "fix" | "reconcile" | "revise";

/**
 * Runs a continuation of the build session. If the saved session cannot be resumed, it runs
 * once more in a fresh session (traced as `<name>-fresh`). Saves the session it ends with.
 */
export async function buildSession<N extends Continuation>(ctx: StepContext, spec: Omit<AgentPhaseSpec, "resume" | "name"> & { name: N }): Promise<AgentPhaseResult<N>> {
  const resume = loadSessions(ctx).build;
  let r = await agentPhase(ctx, { ...spec, resume });
  if (!r.ok && r.reason === "no-session" && resume) {
    clearSession(ctx, "build");
    r = await agentPhase(ctx, { ...spec, traceName: `${spec.traceName ?? spec.name}-fresh` });
  }
  if (r.ok && r.sessionId) saveSession(ctx, "build", r.sessionId);
  return r;
}

/**
 * Run-folder file holding the review round in progress. It stays after a review passes, until the
 * change merges, so a round added later (fixes made after the review) continues the count.
 */
export const REVIEW_ROUND = "review-round";

/** Run-folder marker written just before merging (holds main's commit before the merge). */
export const MERGING = "merging";

/** The review round in progress, kept in the run folder so a restart continues it. Null when none. */
export function readRound(ctx: StepContext): number | null {
  const p = join(ctx.runDir, REVIEW_ROUND);
  if (!existsSync(p)) return null;
  const n = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function writeRound(ctx: StepContext, round: number): void {
  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, REVIEW_ROUND), String(round));
}

/**
 * Makes sure the intent branch exists and has its own worktree checked out on it. Returns a
 * failure for the caller to record; it never blocks by itself.
 */
export async function openBranchWorktree(ctx: StepContext): Promise<{ ok: true } | Failure> {
  if (!(await ctx.git.branchExists(ctx.branch))) {
    return { ok: false, note: "The work for this change is missing. To build it again, set status to plan-approved.", detail: `branch ${ctx.branch} does not exist` };
  }
  try {
    await ctx.git.ensureWorktree(ctx.worktreeDir, ctx.branch);
    await new Git(ctx.worktreeDir).assertBranch(ctx.branch);
  } catch (e) {
    passOn(e);
    return { ok: false, note: "The workspace for this change could not be prepared. An engineer needs to look at it.", detail: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

/** Markdown bullets, one per item. */
export function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

export { setStatus };
