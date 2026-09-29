import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertRootOnMain, blockWith, blockWithDetail, clearMarker, onceMarker, readArtifact, setStatus, type Failure, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { Git, passOn } from "../git";
import { GitHub, type PrInfo } from "../github";
import { codePhase } from "../phases";
import { pushBranch, syncMain } from "../remote";
import { markHealthPending } from "../signals";
import { testLoop } from "./build";
import { MERGING, openBranchWorktree, readRound, REVIEW_ROUND, saveWork, writeRound } from "./shared";


export const MERGE_WAIT_NOTE = "Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.";
export const DIRTY_ROOT_NOTE = "The main checkout has unsaved changes or is on another branch; an engineer needs to tidy it up before this can merge. Then set status to merge-approved.";
const UPDATE_FAILED_NOTE = "The change overlaps with other recent changes and could not be brought up to date automatically. Nothing was merged. An engineer needs to look at it.";
export const REVIEWS_USED_UP = "The change needed more fixes after it was reviewed, and it has already been reviewed as many times as allowed. An engineer needs to look at the change.";

/** Notes for the pull request path (a remote exists). */
export const PR_CHECKS_NOTE = "Waiting for the automatic checks on GitHub.";
export const PR_APPROVE_NOTE = "A pull request is open. Approve it on GitHub to merge, or close it to stop.";
export const PR_CLOSED_NOTE = "The pull request was closed without merging. Set status to closed, or to plan-approved to rebuild.";
export const PR_CHECKS_FAILED_NOTE = "The automatic checks on GitHub failed. An engineer should look at the pull request.";
export const NO_REMOTE_PR_NOTE = "This change passed its checks, but it is set to be approved through a pull request and this repository has no GitHub remote. To merge it here instead, set status to merge-approved.";

/** Run-folder marker: cleanup left the branch because main does not have its changes (traced once). */
const BRANCH_KEPT = "branch-kept";

/** How a person asks the merge step to look again: the status that is runnable for this gate. */
function mergeRetry(ctx: StepContext): string {
  return `To try again, set status to ${ctx.cfg.gates.merge.human === "status" ? "merge-approved" : "merge-review"}.`;
}

/** What the merge gate's automated checks concluded. `changed`: they passed, but fixes were committed that no review has seen. */
export type MergeVerdict = { result: "pass" } | { result: "changed" } | ({ result: "fail" } & Failure);

/**
 * The merge gate's automated checks, run in the worktree: the branch is brought up to date with
 * main (rebase), the test loop passes (it may commit fixes), and the newest review had no
 * important findings. Each check is recorded as a gate row.
 */
export async function checkMerge(ctx: StepContext): Promise<MergeVerdict> {
  const wt = new Git(ctx.worktreeDir);
  const main = ctx.cfg.main_branch;
  let failure: Failure | null = null;
  let changed = false;
  const checks: Check[] = [
    {
      name: "up-to-date",
      run: async () => {
        if (await ctx.git.isAncestor(main, ctx.branch)) return { result: "pass", evidence: "branch contains main" };
        if (await wt.rebaseOnto(main)) return { result: "pass", evidence: "rebased onto main" };
        failure = {
          ok: false,
          note: UPDATE_FAILED_NOTE,
          detail: `rebase of ${ctx.branch} onto ${main} hit conflicts and was aborted`,
        };
        return { result: "fail", evidence: "rebase onto main hit conflicts" };
      },
    },
    {
      name: "tests",
      run: async () => {
        // After a rebase the tests may need fixing: the same test loop as build, with its fix budget.
        const before = await wt.headSha();
        const tested = await testLoop(ctx, "merge-test");
        if (!tested.ok) { failure = tested; return { result: "fail", evidence: tested.detail }; }
        changed = (await wt.headSha()) !== before;
        return { result: "pass", evidence: changed ? "tests pass after fixes that no review has seen yet" : "all commands exit 0" };
      },
    },
    {
      name: "findings",
      run: async () => {
        // The review step records its verdict as a gate row; only the newest one counts.
        const last = ctx.trace.lastGate(ctx.slug, "review", "findings");
        if (last?.result === "pass") return { result: "pass", evidence: "the last review had no important findings" };
        failure = { ok: false, note: "The last review found important problems that are still open. An engineer needs to look at the change.", detail: last ? last.evidence : "no review recorded" };
        return { result: "fail", evidence: failure.detail };
      },
    },
  ];
  const outcome = await evaluateGate(ctx, "merge", checks);
  if (outcome.result !== "pass") {
    const f: Failure = failure ?? { ok: false, note: "The change could not be checked before merging. An engineer needs to look at it.", detail: `${outcome.check}: ${outcome.evidence}` };
    return { result: "fail", ...f };
  }
  return changed ? { result: "changed" } : { result: "pass" };
}

/**
 * The merge gate after its automated checks passed (the gate timing rule). With a remote: push the
 * branch, open its pull request, and wait in merge-review (the merge step watches the pull request
 * unless a person decides on the status line). Without one: no person → merge now; a person →
 * merge-review with a note; a pull request → block plainly (there is nowhere to open one).
 */
export async function passMergeGate(ctx: StepContext): Promise<StepResult> {
  const human = ctx.cfg.gates.merge.human;
  if ((await ctx.git.remoteName()) !== null) {
    const opened = await openPullRequest(ctx, true);
    if (!opened.ok) return blockWith(ctx, opened);
    await setStatus(ctx, "merge-review", human === "none" ? PR_CHECKS_NOTE : human === "pr" ? PR_APPROVE_NOTE : MERGE_WAIT_NOTE);
    return { ok: true };
  }
  if (human === "none") return mergeNow(ctx);
  if (human === "status") {
    await setStatus(ctx, "merge-review", MERGE_WAIT_NOTE);
    return { ok: true };
  }
  return blockWithDetail(ctx, NO_REMOTE_PR_NOTE, "gates.merge.human is pr and the repository has no remote");
}

/**
 * Pushes the branch and makes sure it has an open pull request (title `<slug>: <title>`, a body
 * naming the artifacts and the review summary). The review goes on it as a comment when the pull
 * request is new or `newReview` says a review just passed. The number and link go to the trace.
 */
async function openPullRequest(ctx: StepContext, newReview: boolean): Promise<{ ok: true } | Failure> {
  const r = await codePhase(ctx, "pull-request", async () => {
    const pushed = await pushBranch(ctx.git, ctx.branch);
    if (!pushed.ok) throw new Error(pushed.detail);
    const gh = new GitHub(ctx.root);
    const found = await gh.lookupPr(ctx.branch);
    if ("error" in found) throw new Error(`gh pr view: ${found.error}`);
    let pr: { number: number; url: string } | null = found.pr?.state === "OPEN" ? found.pr : null;
    const created = !pr;
    if (!pr) {
      const dir = `intent/${ctx.slug}`;
      const body = [
        `Loopstra change \`${ctx.slug}\`.`,
        "",
        `- Intent: \`${dir}/intent.md\``,
        `- Spec: \`${dir}/spec.md\``,
        `- Plan: \`${dir}/plan.md\``,
        `- Review: \`${dir}/review.md\``,
        "",
        "## Review summary",
        "",
        ctx.trace.lastGate(ctx.slug, "review", "findings")?.evidence ?? "No review recorded.",
      ].join("\n");
      pr = await gh.createPr({ head: ctx.branch, base: ctx.cfg.main_branch, title: `${ctx.slug}: ${ctx.intent.file.title || ctx.slug}`, body });
    }
    const review = await readArtifact(ctx, "review.md");
    if (review && (created || newReview)) {
      // The comment is a courtesy: a failure is traced and does not stop the pull request.
      try { await gh.comment(pr.number, review); } catch (e) { ctx.trace.event(ctx.slug, "error", { where: "pull request comment", error: (e as Error).message }); }
    }
    ctx.trace.event(ctx.slug, "command", { command: "pull request", number: pr.number, url: pr.url, created });
    return { ok: true as const };
  });
  if (r.ok) return { ok: true };
  return {
    ok: false,
    note: `The pull request for this change could not be opened on GitHub. An engineer should check that GitHub can be reached. ${mergeRetry(ctx)}`,
    detail: r.note,
  };
}

/**
 * The merge step with a remote: watch the pull request. Merged (on GitHub, or by an earlier step
 * that stopped before recording it) → sync main and record it. Closed → block. Checks pending, gh
 * not answering, or (merge.human pr) not approved yet → wait, changing nothing. Checks failed →
 * block. Otherwise merge through gh.
 */
async function runRemoteMerge(ctx: StepContext): Promise<StepResult> {
  const gh = new GitHub(ctx.root);
  const found = await gh.lookupPr(ctx.branch);
  if ("error" in found) {
    ctx.trace.event(ctx.slug, "error", { where: "pull request", error: found.error, note: "will look again on the next tick" });
    return { ok: true, waiting: true };
  }
  const pr = found.pr;
  if (pr?.merged) return finishRemoteMerge(ctx);
  if (pr?.state === "CLOSED") return blockWithDetail(ctx, PR_CLOSED_NOTE, { pr: pr.number, url: pr.url });
  if (!pr) {
    // No pull request yet (for example GitHub could not be reached when the review passed): open it.
    if (!(await ctx.git.branchExists(ctx.branch))) {
      return blockWithDetail(ctx, "The work for this change is missing. To build it again, set status to plan-approved.", `branch ${ctx.branch} does not exist`);
    }
    const opened = await openPullRequest(ctx, false);
    if (!opened.ok) return blockWith(ctx, opened);
    return { ok: true, waiting: true };
  }

  const checks = await gh.checks(pr.number);
  if (checks === "pending" || checks === "unknown") return { ok: true, waiting: true };
  const where = `pull request #${pr.number} ${pr.url}`;
  if (checks === "fail") {
    ctx.trace.gate(ctx.slug, "merge", "pr-checks", "fail", where);
    return blockWithDetail(ctx, `${PR_CHECKS_FAILED_NOTE} ${mergeRetry(ctx)}`, { pr: pr.number, url: pr.url });
  }
  const status = ctx.intent.file.frontmatter.status;
  // merge.human pr: approved on GitHub, or a person set merge-approved on the status line.
  if (ctx.cfg.gates.merge.human === "pr" && !pr.approved && status !== "merge-approved") return { ok: true, waiting: true };
  ctx.trace.gate(ctx.slug, "merge", "pr-checks", "pass", where);
  if (ctx.cfg.gates.merge.human === "pr") ctx.trace.gate(ctx.slug, "merge", "pr-approved", "pass", pr.approved ? "approved on GitHub" : "merge-approved on the status line");
  return mergeOnGitHub(ctx, gh, pr);
}

async function mergeOnGitHub(ctx: StepContext, gh: GitHub, pr: PrInfo): Promise<StepResult> {
  const merged = await codePhase(ctx, "merge", async () => {
    await gh.merge(pr.number, ctx.cfg.gates.merge.method);
    return { ok: true as const };
  });
  if (!merged.ok) {
    // gh can report a problem after the merge went through (for example tidying up a local branch).
    const again = await gh.prForBranch(ctx.branch);
    if (!again?.merged) {
      return blockWithDetail(ctx, `The pull request could not be merged on GitHub. An engineer should look at it. ${mergeRetry(ctx)}`, { pr: pr.number, error: merged.note });
    }
  }
  return finishRemoteMerge(ctx);
}

/** The pull request is merged on GitHub: bring main up to date here, then record the merge. */
async function finishRemoteMerge(ctx: StepContext): Promise<StepResult> {
  await syncMain(ctx.root, ctx.cfg, ctx.trace);
  return finishMerge(ctx);
}

/** True when the review round that just passed may be followed by one more (fixes were made after it). */
export function mayReviewAgain(ctx: StepContext, round: number): boolean {
  return round <= ctx.cfg.stages.review.max_rounds;
}

/** Fixes were committed after the review: back to reviewing for one more round, if rounds are left. */
async function reviewAgain(ctx: StepContext): Promise<StepResult> {
  const round = readRound(ctx) ?? 1;
  if (!mayReviewAgain(ctx, round)) {
    clearMarker(ctx, REVIEW_ROUND);
    return blockWithDetail(ctx, REVIEWS_USED_UP, { rounds: round, reason: "fixes were committed after the last review" });
  }
  writeRound(ctx, round + 1);
  await setStatus(ctx, "reviewing");
  return { ok: true };
}

/**
 * The merge step. merge-review with a person on the status line waits (it is not runnable). With a
 * remote, the step watches the pull request (see runRemoteMerge). Without one: merge-approved (a
 * person approved), or merge-review with no person on the gate: check again and merge.
 */
export async function runMergeStep(ctx: StepContext): Promise<StepResult> {
  if (await alreadyMerged(ctx)) return finishMerge(ctx);
  const status = ctx.intent.file.frontmatter.status;
  const human = ctx.cfg.gates.merge.human;
  if (status === "merge-review" && human === "status") return { ok: true };
  if ((await ctx.git.remoteName()) !== null) return runRemoteMerge(ctx);
  if (status === "merge-review" && human !== "none") return { ok: true };

  // A person may have set merge-approved (or edited the change's other files) without committing:
  // record the change's own folder first, so their edit is part of main before the checks run.
  await recordPersonEdits(ctx);
  const open = await openBranchWorktree(ctx);
  if (!open.ok) return blockWith(ctx, open);
  const wt = new Git(ctx.worktreeDir);
  if (await wt.isDirty()) {
    // Edits nobody reviewed: keep them on the branch and review again rather than merge them unseen.
    const kept = await saveWork(ctx, wt, "chore: keep unfinished changes");
    if (!kept.ok) return blockWith(ctx, kept);
    return reviewAgain(ctx);
  }
  const verdict = await checkMerge(ctx);
  if (verdict.result === "fail") return blockWith(ctx, verdict);
  if (verdict.result === "changed") return reviewAgain(ctx);
  return mergeNow(ctx);
}

/** Commits the change's own folder on main (a person's uncommitted edits to it). Nothing else is touched. */
async function recordPersonEdits(ctx: StepContext): Promise<void> {
  await assertRootOnMain(ctx);
  await ctx.git.commitPaths([`intent/${ctx.slug}`], `loopstra(${ctx.slug}): record edits made by a person`);
}

/**
 * Merges the intent branch into main in the root checkout, in one step that either lands whole or
 * not at all (see Git.merge). Only when the root is on main, nothing is staged, and no tracked file
 * outside intent/ has unsaved changes, so a person's work there is never touched. Unsaved edits
 * inside intent/ (an owner's status lines) never block it; the merge takes only the branch.
 */
async function mergeNow(ctx: StepContext): Promise<StepResult> {
  const root = await rootReady(ctx);
  if (!root.ok) return blockWithDetail(ctx, DIRTY_ROOT_NOTE, root.detail);

  // The checks brought the branch up to date; if main moved since (bookkeeping), catch up again.
  const main = ctx.cfg.main_branch;
  if (!(await ctx.git.isAncestor(main, ctx.branch)) && !(await new Git(ctx.worktreeDir).rebaseOnto(main))) {
    return blockWithDetail(ctx, UPDATE_FAILED_NOTE, `rebase of ${ctx.branch} onto ${main} before the merge hit conflicts and was aborted`);
  }

  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, MERGING), await ctx.git.headSha());
  const merged = await codePhase(ctx, "merge", async () => {
    const title = ctx.intent.file.title || ctx.slug;
    try {
      await ctx.git.merge(ctx.branch, ctx.cfg.gates.merge.method, `${ctx.slug}: ${title}`);
    } catch (e) {
      passOn(e);
      // Nothing landed: main, the index, and the files are as they were. The detail goes to the trace.
      ctx.trace.event(ctx.slug, "error", { where: "merge", error: (e as Error).message });
      return { ok: true as const, landed: false };
    }
    return { ok: true as const, landed: true };
  });
  if (!merged.ok || !merged.landed) {
    clearMarker(ctx, MERGING);
    return blockWithDetail(
      ctx,
      "The change could not be merged; main was left untouched. An engineer needs to look at it.",
      merged.ok ? `merge of ${ctx.branch} into ${main} refused` : merged.note,
    );
  }
  return finishMerge(ctx);
}

/**
 * The root checkout may take a merge: it is on main, nothing is staged (anywhere), and no tracked
 * file outside intent/ has unsaved changes. Untracked files are left to git, which refuses a merge
 * that would overwrite one.
 */
async function rootReady(ctx: StepContext): Promise<{ ok: true } | { ok: false; detail: string }> {
  const branch = (await ctx.git.run(["rev-parse", "--abbrev-ref", "HEAD"], true)).out.trim();
  if (branch !== ctx.cfg.main_branch) return { ok: false, detail: `root checkout is on ${branch || "(unknown)"}, not ${ctx.cfg.main_branch}` };
  const staged = (await ctx.git.run(["diff", "--cached", "--name-only"])).out.trim();
  if (staged) return { ok: false, detail: `root checkout has staged changes: ${staged.split(/\r?\n/).join(", ")}` };
  const unsaved = (await ctx.git.run(["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)intent"])).out.trim();
  if (unsaved) return { ok: false, detail: `root checkout has unsaved changes to tracked files outside intent/: ${unsaved.split(/\r?\n/).map((l) => l.slice(3)).join(", ")}` };
  return { ok: true };
}

/**
 * True when a merge was started (the marker exists) and its result is already on main: the branch
 * is gone, or main moved past the commit it was on before the merge and has the branch's version of
 * every file the branch changed. A marker whose merge never landed is removed.
 */
export async function alreadyMerged(ctx: StepContext): Promise<boolean> {
  const marker = join(ctx.runDir, MERGING);
  if (!existsSync(marker)) return false;
  if (!(await ctx.git.branchExists(ctx.branch))) return true;
  const base = readFileSync(marker, "utf8").trim();
  const main = ctx.cfg.main_branch;
  const moved = (await ctx.git.run(["rev-parse", main], true)).out.trim() !== base;
  if (moved && (await ctx.git.containsChanges(main, ctx.branch))) return true;
  clearMarker(ctx, MERGING);
  return false;
}

/** The change is on main: tidy up (best effort) and record it as merged. */
export async function finishMerge(ctx: StepContext): Promise<StepResult> {
  await cleanupChange(ctx);
  markHealthPending(ctx.root, ctx.slug);
  await setStatus(ctx, "merged");
  clearMarker(ctx, MERGING);
  clearMarker(ctx, REVIEW_ROUND);
  return { ok: true };
}

/**
 * Removes a merged change's worktree and branch. Best effort: a failure is traced and the
 * scheduler tries again on a later tick. Returns true when nothing is left.
 * The branch is deleted only when main already has its changes. Otherwise (a person set merged by
 * hand, or main is not synced yet) the worktree and branch are left as they are, and the reason is
 * traced once. Files under intent/ are not compared: main's own record of the change moves on after
 * the merge (status, outcome), and the branch only holds an older copy of it.
 */
export async function cleanupChange(ctx: StepContext): Promise<boolean> {
  const main = ctx.cfg.main_branch;
  if ((await ctx.git.branchExists(ctx.branch)) && !(await ctx.git.containsChanges(main, ctx.branch, ["intent/"]))) {
    if (onceMarker(ctx, BRANCH_KEPT)) {
      ctx.trace.event(ctx.slug, "command", { command: "clean up after merge", kept: ctx.branch, reason: `${main} does not have this branch's changes, so the branch and its worktree were left in place` });
    }
    return false;
  }
  clearMarker(ctx, BRANCH_KEPT);
  let clean = true;
  try {
    if (existsSync(ctx.worktreeDir)) await ctx.git.worktreeRemove(ctx.worktreeDir);
  } catch (e) {
    clean = false;
    ctx.trace.event(ctx.slug, "error", { where: "cleanup", what: "worktree", error: e instanceof Error ? e.message : String(e) });
  }
  try {
    if (await ctx.git.branchExists(ctx.branch)) await ctx.git.deleteBranch(ctx.branch);
  } catch (e) {
    clean = false;
    ctx.trace.event(ctx.slug, "error", { where: "cleanup", what: "branch", error: e instanceof Error ? e.message : String(e) });
  }
  return clean;
}
