import { readFileSync } from "node:fs";
import { join } from "node:path";
import { block, clearMarker, clearSession, loadSessions, readArtifact, readMarker, saveSession, writeMarker, type Failure, type StepContext, type StepResult } from "../context";
import { Envelopes, type Envelope, type PhaseName } from "../envelopes";
import { Git, NO_AUTO_MAINTENANCE, passOn } from "../git";
import { onCheckout } from "../lanes";
import { changeEnv } from "../resources";
import { agentPhase, codePhase, projectCommand, type AgentPhaseResult, type AgentPhaseSpec } from "../phases";
import { WATCHING_PR, type Intent, type Status } from "../intents";
import { runDir } from "../paths";
import { isRiskNote } from "../risk";
import { errorText } from "../shell";

/**
 * Runs a stage's before/after commands as one code phase. Any failure blocks with a plain note; the
 * command and its output go to the trace. In the main checkout (the design, plan and verify stages)
 * they run under its checkout lock, inside the phase: they may write files or run git there, and
 * must never run alongside a record's commit, a sync or a merge. The command time limit bounds the wait.
 */
export async function runHookCommands(ctx: StepContext, which: "before" | "after", stage: keyof StepContext["cfg"]["stages"], cwd = ctx.root): Promise<StepResult> {
  const cmds = ctx.cfg.stages[stage][which];
  if (!cmds.length) return { ok: true };
  let timedOut = false;
  const runAll = async () => {
    for (const cmd of cmds) {
      const res = await projectCommand(ctx, cmd, cwd, { env: { LOOPSTRA_SLUG: ctx.slug, LOOPSTRA_STAGE: stage, ...(await changeEnv(ctx)) } });
      if (res.code !== 0) { timedOut = res.timedOut; throw new Error(`\`${cmd}\` failed: ${res.lastLine || `exit ${res.code}`}`); }
    }
    return { ok: true as const };
  };
  const r = await codePhase(ctx, `${stage}-${which}`, () => (cwd === ctx.root ? onCheckout(ctx.root, runAll) : runAll()));
  if (r.ok) return { ok: true };
  const what = timedOut ? "did not finish in time" : "failed";
  return block(ctx, `A project command that runs ${which} the ${stage} stage ${what}. An engineer needs to look at it.`, { detail: r.detail });
}

/** The note written when a human gate is waiting. The wording follows the gate's surface. */
export function humanNote(artifact: string, approvedStatus: Status, surface: "status" | "pr" | "none" = "status"): string {
  if (surface === "pr") {
    return `Read ${artifact}. When you are happy with it, approve its pull request or change the status line to ${approvedStatus}. To stop this change, set the status line to closed.`;
  }
  return `Read ${artifact}. When you are happy with it, change the status line to ${approvedStatus}. To stop this change, set it to closed.`;
}

/** The notes the merge gate leaves as a change starts waiting in merge-review, by who decides the merge (see passMergeGate). */
export const MERGE_WAIT_NOTE = "Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.";
export const PR_CHECKS_NOTE = "Waiting for the automatic checks on GitHub.";
export const PR_APPROVE_NOTE = "A pull request is open. Approve it on GitHub to merge, or close it to stop.";
const GATE_NOTES: ReadonlySet<string> = new Set([MERGE_WAIT_NOTE, PR_CHECKS_NOTE, PR_APPROVE_NOTE]);

/** Run-folder file: the plan as reconciled with what the current build changed. Cleared when a new build starts. */
export const RECONCILED_PLAN = "plan.reconciled.md";

export type Artifacts = { intent: string; spec: string; plan: string; currentPlan: string; review: string };

/** The artifacts, from main. `plan` is main's plan.md; `currentPlan` is the plan reconciled for this build if there is one, else the same. */
export async function artifacts(ctx: StepContext): Promise<Artifacts> {
  const plan = (await readArtifact(ctx, "plan.md")) ?? "";
  return {
    intent: ctx.intent.file.body,
    spec: (await readArtifact(ctx, "spec.md")) ?? "",
    plan,
    currentPlan: readMarker(ctx, RECONCILED_PLAN) ?? plan,
    review: (await readArtifact(ctx, "review.md")) ?? "",
  };
}

/** The commit message for edits nobody reviewed, kept on the branch so the next review sees them. */
export const KEEP_UNFINISHED = "chore: keep unfinished changes";

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
      detail: `commit in ${wt.cwd}: ${errorText(e)}`,
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

/** Run-folder marker: the branch commit on which the test commands last passed, and those commands. */
export const TESTED = "tested";

/** The TESTED marker's content: the commit, then the commands that passed on it (a changed command must run again). */
export function testedMarker(ctx: StepContext, sha: string): string {
  const { test, lint, build } = ctx.cfg.commands;
  return [sha, test, lint ?? "", build ?? ""].join("\n");
}

/** The commit the current test commands last passed on, or null. */
function lastTested(ctx: StepContext): string | null {
  const marker = readMarker(ctx, TESTED);
  const sha = marker?.split("\n")[0];
  return sha && marker === testedMarker(ctx, sha) ? sha : null;
}

/**
 * The current test commands already passed on the worktree's commit: the same commit, or one that
 * differs only in records under intent/ (a rebase that brought in main's bookkeeping).
 */
export async function alreadyTested(ctx: StepContext, wt: Git): Promise<boolean> {
  const passedAt = lastTested(ctx);
  return !!passedAt && (await wt.run(["diff", "--quiet", passedAt, "HEAD", "--", ".", ":(exclude)intent"], true)).code === 0;
}

/** An answer kept by work run ahead (see reviewAhead, planAhead): what it was asked (`key`), its report, and the whole file. */
export type Kept<N extends PhaseName> = { key: string; envelope: Envelope<N>; saved: Record<string, unknown> };

/**
 * The answer kept in a run-folder file by work run ahead. It is used up at once, whatever happens
 * next: the file is cleared before anything is checked. Undefined when there is none; null when it is
 * not what was written (corrupt, from another Loopstra version, or a report that did not succeed).
 */
export function takeKept<N extends PhaseName>(ctx: StepContext, marker: string, name: N): Kept<N> | null | undefined {
  const text = readMarker(ctx, marker);
  if (text === null) return undefined;
  clearMarker(ctx, marker);
  let saved: unknown;
  try { saved = JSON.parse(text); } catch { return null; }
  if (typeof saved !== "object" || saved === null) return null;
  const s = saved as Record<string, unknown>;
  const envelope = Envelopes[name].safeParse(s.envelope);
  if (!envelope.success || envelope.data.status !== "success" || typeof s.key !== "string") return null;
  return { key: s.key, envelope: envelope.data as Envelope<N>, saved: s };
}

/** What is not the code: the loop's records and run folders, and its config (what of it a session sees is in its prompt). */
const NOT_CODE = [":(exclude)intent", ":(exclude).loopstra", ":(exclude)loopstra/config.yaml"];

/** True when commits `a` and `b` differ in their code (see NOT_CODE); a commit git cannot read counts as different. */
export async function codeDiffers(git: Git, a: string, b: string): Promise<boolean> {
  return (await git.run(["diff", "--quiet", "--no-ext-diff", "--no-textconv", a, b, "--", ".", ...NOT_CODE], true)).code !== 0;
}

const TESTS_PASSED = "The test command passed after the latest change.";
const TESTS_NOT_RUN = "The tests have not run on the latest change yet; the runtime runs them before merging.";

/**
 * `{{test_result}}` for a judge: what the runtime's own test run says about the code it is judging.
 * A failing run never reaches a judge (the test loop fixes or blocks first), so it is one of two sentences.
 */
export async function testResult(ctx: StepContext, wt: Git): Promise<string> {
  return (await alreadyTested(ctx, wt)) ? TESTS_PASSED : TESTS_NOT_RUN;
}

/**
 * Run-folder marker written just before merging: main's commit before the merge, and, on a second
 * line once it is built, the merge commit itself (see alreadyMerged in merge.ts).
 */
export const MERGING = "merging";

/** Run-folder marker: the pull request waits for main here to get changes merged on GitHub that the sync could not bring in yet (traced once). */
export const REMOTE_AHEAD = "remote-ahead";

/**
 * Run-folder marker: why the merge step waits on a pull request its gate has nothing more to decide
 * on, in plain words: it merged on GitHub but main here does not have it yet, or recording that
 * failed; GitHub is merging it; or it is ready and merges once main here has what GitHub merged
 * meanwhile. Each look at the pull request writes it or removes it. Kept here, not as the note in
 * intent.md: it changes with the sync's reason, and recording it would commit to a main that is out
 * of step with GitHub (#79).
 */
export const PR_WAIT = "pr-wait";

/** The PR_WAIT that only an engineer can end. */
export const PR_MERGED_ELSEWHERE = "The pull request was merged on GitHub, but main here does not have its changes, although it has everything on main on GitHub: was it merged into another branch? An engineer needs to look at it.";

/**
 * How a change watching its pull request reads: `wait`, its PR_WAIT ("" for none), and `note`, its
 * own note, which is "" when a wait stands in for the note the merge gate left (which then says what
 * is no longer so). A note a person wrote stays. Any other status reads as its note alone.
 * `needsPerson`: only an engineer can end the wait.
 */
export function prWait(root: string, intent: Intent): { wait: string; note: string; needsPerson: boolean } {
  const note = intent.file.frontmatter.note;
  if (!WATCHING_PR.has(intent.file.frontmatter.status)) return { wait: "", note, needsPerson: false };
  let wait = "";
  try { wait = readFileSync(join(runDir(root, intent.slug), PR_WAIT), "utf8").trim(); } catch { /* none */ }
  return { wait, note: wait && (GATE_NOTES.has(note.trim()) || isRiskNote(note)) ? "" : note, needsPerson: wait === PR_MERGED_ELSEWHERE };
}

/**
 * Run-folder marker: the commit the pull request's branch on GitHub may be force-pushed over (what
 * Loopstra last pushed there, or took from there). Anything else on that branch is a person's work.
 */
export const PR_LEASE = "pr-lease";

/**
 * Run-folder marker: the head of the push of the pull request's branch in progress, written before
 * the push and cleared once PR_LEASE has it. Left behind when a stop, a timeout or a crash cut the
 * push short, when GitHub may have taken it all the same: once GitHub is seen holding that head, it
 * becomes the lease (see adoptCutShortPush).
 */
export const PR_PUSHING = "pr-pushing";

/**
 * Run-folder marker: the number of this build's pull request, or "" while it has none (each build
 * starts with ""). An earlier build's pull request, closed or merged, is not this build's own.
 */
export const PR_NUMBER = "pr-number";

/** The review round in progress, kept in the run folder so a restart continues it. Null when none. */
export function readRound(ctx: StepContext): number | null {
  const n = Number.parseInt(readMarker(ctx, REVIEW_ROUND) ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function writeRound(ctx: StepContext, round: number): void {
  writeMarker(ctx, REVIEW_ROUND, String(round));
}

/**
 * Run-folder marker: the branch's head before a conflict resolution squashed it onto main (see
 * catchUp), until the resolution is saved. While it is here, the branch is mid-resolution, and
 * restoreCatchUp puts it back.
 */
export const CATCHING_UP = "catching-up";

/**
 * Puts the branch back where it was before a conflict resolution that did not finish (CATCHING_UP),
 * with the files the resolution left removed, and clears the marker. The worktree was clean when
 * the resolution started, so nothing of anyone's is lost. Runs even after a stop request.
 */
export async function restoreCatchUp(ctx: StepContext): Promise<void> {
  const old = readMarker(ctx, CATCHING_UP)?.trim();
  if (old === undefined) return;
  if (old) {
    const wt = new Git(ctx.worktreeDir);
    await wt.run(["merge", "--abort"], { allowFail: true, cleanup: true });
    await wt.run([...NO_AUTO_MAINTENANCE, "reset", "-q", "--hard", old], { cleanup: true });
    await wt.run(["clean", "-f", "-d", "-q"], { allowFail: true, cleanup: true });
    ctx.trace.event(ctx.slug, "command", { command: "catch up", note: "a conflict resolution that did not finish was undone; the branch is back where it was", head: old });
  }
  clearMarker(ctx, CATCHING_UP);
}

/**
 * Makes sure the intent branch exists and has its own worktree checked out on it, and puts back a
 * conflict resolution that did not finish (see restoreCatchUp). Returns a failure for the caller
 * to record; it never blocks by itself.
 */
export async function openBranchWorktree(ctx: StepContext): Promise<{ ok: true } | Failure> {
  if (!(await ctx.git.branchExists(ctx.branch))) {
    return { ok: false, note: "The work for this change is missing. To build it again, set status to plan-approved.", detail: `branch ${ctx.branch} does not exist` };
  }
  try {
    await ctx.git.ensureWorktree(ctx.worktreeDir, ctx.branch);
    await new Git(ctx.worktreeDir).assertBranch(ctx.branch);
    await restoreCatchUp(ctx);
  } catch (e) {
    passOn(e);
    return { ok: false, note: "The workspace for this change could not be prepared. An engineer needs to look at it.", detail: errorText(e) };
  }
  return { ok: true };
}

/** Markdown bullets, one per item. */
export function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}
