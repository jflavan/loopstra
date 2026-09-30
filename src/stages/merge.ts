import { existsSync } from "node:fs";
import { assertRootOnMain, block, clearMarker, onceMarker, readArtifact, readMarker, setStatus, writeMarker, type Failure, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { bookkeeping, Git, passOn } from "../git";
import { GitHub, type PrInfo } from "../github";
import type { Status } from "../intents";
import { codePhase } from "../phases";
import { deleteRemoteBranch, pushBranch, shareMain, syncMain } from "../remote";
import { errorText } from "../shell";
import { markHealthPending } from "../signals";
import { testLoop } from "./build";
import { REVIEW_PASSED, runReviewRounds } from "./review";
import { alreadyTested, MERGING, openBranchWorktree, readRound, REVIEW_ROUND, saveWork, writeRound } from "./shared";

export const MERGE_WAIT_NOTE = "Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.";
export const DIRTY_ROOT_NOTE = "The main checkout has unsaved changes or is on another branch; an engineer needs to tidy it up before this can merge. Then set status to merge-approved.";
const UPDATE_FAILED_NOTE = "The change overlaps with other recent changes and could not be brought up to date automatically. Nothing was merged. An engineer needs to look at it.";
const REVIEWS_USED_UP = "The change needed more fixes after it was reviewed, and it has already been reviewed as many times as allowed. An engineer needs to look at the change.";

/** Notes for the pull request path (a remote exists). */
const PR_CHECKS_NOTE = "Waiting for the automatic checks on GitHub.";
const PR_APPROVE_NOTE = "A pull request is open. Approve it on GitHub to merge, or close it to stop.";
const PR_CLOSED_NOTE = "The pull request was closed without merging. Set status to closed, or to plan-approved to rebuild.";
const PR_CHECKS_FAILED_NOTE = "The automatic checks on GitHub failed. An engineer should look at the pull request.";
export const NO_REMOTE_PR_NOTE = "This change passed its checks, but it is set to be approved through a pull request and this repository has no GitHub remote. To merge it here instead, set status to merge-approved.";

/** Run-folder marker: cleanup left the branch because main does not have its changes (traced once). */
const BRANCH_KEPT = "branch-kept";
/** Run-folder marker: the pull request merged, but main here does not have it yet (traced once). */
const MAIN_BEHIND = "main-behind";

/** How a person asks the merge step to look again without a rebuild: the status that is runnable for this gate. */
function mergeRetry(ctx: StepContext): Status {
  return ctx.cfg.gates.merge.human === "status" ? "merge-approved" : "merge-review";
}

/** What the merge gate's automated checks concluded. `changed`: they passed, but fixes were committed that no review has seen. */
type MergeVerdict = { result: "pass" } | { result: "changed" } | ({ result: "fail" } & Failure);

/**
 * The merge gate's automated checks, run in the worktree: the branch is brought up to date with
 * main (rebase), the test loop passes (it may commit fixes), and the newest review had no
 * important findings. Each check is recorded as a gate row.
 */
async function checkMerge(ctx: StepContext): Promise<MergeVerdict> {
  const wt = new Git(ctx.worktreeDir);
  const main = ctx.cfg.main_branch;
  // A failing check hands back the failure to record; the tests check says whether it committed fixes.
  const checks: Check<Failure | { ok: true; changed: boolean }>[] = [
    {
      name: "up-to-date",
      run: async () => {
        if (await ctx.git.isAncestor(main, ctx.branch)) return { result: "pass", evidence: "branch contains main" };
        if (await wt.rebaseOnto(main)) return { result: "pass", evidence: "rebased onto main" };
        return {
          result: "fail", evidence: "rebase onto main hit conflicts",
          payload: { ok: false, note: UPDATE_FAILED_NOTE, detail: `rebase of ${ctx.branch} onto ${main} hit conflicts and was aborted` },
        };
      },
    },
    {
      name: "tests",
      run: async () => {
        const before = await wt.headSha();
        // Already tested: the same commit, or one that differs only in records under intent/ (a
        // rebase that brought in main's bookkeeping). Running the tests again would prove nothing new.
        if (await alreadyTested(ctx, wt)) {
          return { result: "pass", evidence: "the tests already passed on this code; only records under intent/ changed since" };
        }
        // After a rebase the tests may need fixing: the same test loop as build, with its fix budget.
        const tested = await testLoop(ctx, "merge-test");
        if (!tested.ok) return { result: "fail", evidence: tested.detail, payload: tested };
        const changed = (await wt.headSha()) !== before;
        return { result: "pass", evidence: changed ? "tests pass after fixes that no review has seen yet" : "all commands exit 0", payload: { ok: true, changed } };
      },
    },
    {
      name: "findings",
      run: async () => {
        // The review step records its verdict as a gate row; only the newest one counts.
        const last = ctx.trace.lastGate(ctx.slug, "review", "findings");
        if (last?.result === "pass") return { result: "pass", evidence: "the last review had no important findings" };
        const detail = last ? last.evidence : "no review recorded";
        return { result: "fail", evidence: detail, payload: { ok: false, note: "The last review found important problems that are still open. An engineer needs to look at the change.", detail } };
      },
    },
  ];
  const outcome = await evaluateGate(ctx, "merge", checks);
  if (outcome.result === "pass") return outcome.payloads.some((p) => p.ok && p.changed) ? { result: "changed" } : { result: "pass" };
  const f: Failure = outcome.payload?.ok === false
    ? outcome.payload
    : { ok: false, note: "The change could not be checked before merging. An engineer needs to look at it.", detail: `${outcome.check}: ${outcome.evidence}` };
  return { result: "fail", ...f };
}

/**
 * The merge gate after its automated checks passed (the gate timing rule). With a remote: push the
 * branch, open its pull request, and wait in merge-review (the merge step watches the pull request
 * unless a person decides on the status line). Without one: no person → merge now; a person →
 * merge-review with a note; a pull request → block plainly (there is nowhere to open one).
 */
async function passMergeGate(ctx: StepContext): Promise<StepResult> {
  const human = ctx.cfg.gates.merge.human;
  if ((await ctx.git.remoteName()) !== null) {
    const opened = await openPullRequest(ctx, true);
    if (!opened.ok) return block(ctx, opened.note, opened);
    await setStatus(ctx, "merge-review", human === "none" ? PR_CHECKS_NOTE : human === "pr" ? PR_APPROVE_NOTE : MERGE_WAIT_NOTE);
    return { ok: true };
  }
  if (human === "none") return mergeNow(ctx);
  if (human === "status") {
    await setStatus(ctx, "merge-review", MERGE_WAIT_NOTE);
    return { ok: true };
  }
  return block(ctx, NO_REMOTE_PR_NOTE, { detail: "gates.merge.human is pr and the repository has no remote" });
}

/**
 * Shares main, pushes the branch, and makes sure it has an open pull request (title `<slug>: <title>`, a body
 * naming the artifacts and the review summary). The review goes on it as a comment when the pull
 * request is new or `newReview` says a review just passed. The number and link go to the trace.
 */
async function openPullRequest(ctx: StepContext, newReview: boolean): Promise<{ ok: true } | Failure> {
  const r = await codePhase(ctx, "pull-request", async () => {
    // Main first, so the pull request's diff against it shows only the change, not the records.
    await shareMain(ctx.root, ctx.cfg, ctx.trace);
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
      try { await gh.comment(pr.number, review); } catch (e) { passOn(e); ctx.trace.event(ctx.slug, "error", { where: "pull request comment", error: errorText(e) }); }
    }
    ctx.trace.event(ctx.slug, "command", { command: "pull request", number: pr.number, url: pr.url, created });
    return { ok: true as const };
  });
  if (r.ok) return { ok: true };
  return {
    ok: false,
    note: "The pull request for this change could not be opened on GitHub. An engineer should check that GitHub can be reached.",
    detail: r.detail,
    retryFrom: mergeRetry(ctx),
  };
}

/**
 * The merge step with a remote, for every merge.human mode: watch the pull request. Merged (on
 * GitHub, or by an earlier step that stopped before recording it) → sync main and record it.
 * Closed → block. A person on the status line who has not set merge-approved, checks pending, gh
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
  if (pr?.merged) return finishRemoteMerge(ctx, pr);
  if (pr?.state === "CLOSED") return block(ctx, PR_CLOSED_NOTE, { detail: { pr: pr.number, url: pr.url } });
  if (!pr) {
    // No pull request yet (for example GitHub could not be reached when the review passed): open it.
    if (!(await ctx.git.branchExists(ctx.branch))) {
      return block(ctx, "The work for this change is missing. To build it again, set status to plan-approved.", { detail: `branch ${ctx.branch} does not exist` });
    }
    const opened = await openPullRequest(ctx, false);
    if (!opened.ok) return block(ctx, opened.note, opened);
    return { ok: true, waiting: true };
  }

  const status = ctx.intent.file.frontmatter.status;
  // A person decides on the status line and has not yet: only a merge or close on GitHub counts.
  if (ctx.cfg.gates.merge.human === "status" && status !== "merge-approved") return { ok: true, waiting: true };
  const checks = await gh.checks(pr.number);
  if (checks === "pending" || checks === "unknown") return { ok: true, waiting: true };
  const where = `pull request #${pr.number} ${pr.url}`;
  if (checks === "fail") {
    ctx.trace.gate(ctx.slug, "merge", "pr-checks", "fail", where);
    return block(ctx, PR_CHECKS_FAILED_NOTE, { detail: { pr: pr.number, url: pr.url }, retryFrom: mergeRetry(ctx) });
  }
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
  // Asked again either way: gh can report a problem after the merge went through, and the merged
  // pull request names the commit main must have before the merge is recorded.
  const after = await gh.prForBranch(ctx.branch);
  if (!after?.merged) {
    if (!merged.ok) return block(ctx, "The pull request could not be merged on GitHub. An engineer should look at it.", { detail: { pr: pr.number, error: merged.detail }, retryFrom: mergeRetry(ctx) });
    // gh accepted the merge but it has not happened yet (a merge queue, or GitHub not answering):
    // the branch stays, since deleting it would close the pull request, and the next tick looks again.
    return { ok: true, waiting: true };
  }
  const deleted = await deleteRemoteBranch(ctx.git, ctx.branch);
  if (!deleted.ok) ctx.trace.event(ctx.slug, "command", { command: "delete merged branch on the remote", kept: ctx.branch, reason: deleted.detail });
  return finishRemoteMerge(ctx, after);
}

/**
 * The pull request is merged on GitHub: bring main up to date here, then record the merge. When
 * main still does not have it (the sync was skipped or failed: unsaved changes in the main
 * checkout, GitHub out of reach, a clash; the `main_sync` signal says which), wait and try again
 * on the next tick, so the done-check never judges a main without the change. Main has it when it
 * contains the pull request's merge commit, or the branch's changes when gh does not name one.
 */
async function finishRemoteMerge(ctx: StepContext, pr: PrInfo): Promise<StepResult> {
  // A status a person saved without committing would keep the sync from touching main. Off main,
  // the sync is skipped anyway and says so.
  if ((await ctx.git.currentBranch()) === ctx.cfg.main_branch) await recordPersonEdits(ctx);
  await syncMain(ctx.root, ctx.cfg, ctx.trace);
  const main = ctx.cfg.main_branch;
  const hasIt = pr.mergeCommit
    ? (await ctx.git.isAncestor(pr.mergeCommit, main)) || ((await ctx.git.branchExists(ctx.branch)) && (await ctx.git.containsChanges(main, ctx.branch, ["intent/"])))
    : !(await ctx.git.branchExists(ctx.branch)) || (await ctx.git.containsChanges(main, ctx.branch, ["intent/"]));
  if (!hasIt) {
    if (onceMarker(ctx, MAIN_BEHIND)) {
      ctx.trace.event(ctx.slug, "command", { command: "finish merge", waiting: `the pull request is merged, but ${main} here does not have it yet; the merge is recorded once the sync brings it in`, pr: pr.number, mergeCommit: pr.mergeCommit });
    }
    return { ok: true, waiting: true };
  }
  clearMarker(ctx, MAIN_BEHIND);
  return finishMerge(ctx);
}

/** The merge gate sent the change back for one more review round (the round marker names it). */
const REVIEW_AGAIN = "review-again";

/**
 * The merge gate, one entry point for the review step (a review just passed; `onPass` is
 * passMergeGate) and the merge step (merge-approved, or merge-review with no person; `onPass`
 * merges): its automated checks run, and then `onPass`. Fixes the checks committed go back for one
 * more review round (see anotherRound), so nothing reaches main that a review did not see.
 */
async function mergeGate(ctx: StepContext, onPass: () => Promise<StepResult>): Promise<StepResult | typeof REVIEW_AGAIN> {
  const verdict = await checkMerge(ctx);
  if (verdict.result === "fail") return block(ctx, verdict.note, verdict);
  if (verdict.result === "pass") return onPass();
  return anotherRound(ctx);
}

/**
 * Changes no review has seen are on the branch: one more review round while rounds are left (the
 * round marker moves on to it), else block. The one place the review rounds run out after a pass.
 */
async function anotherRound(ctx: StepContext): Promise<StepResult | typeof REVIEW_AGAIN> {
  const round = readRound(ctx) ?? 1;
  if (round > ctx.cfg.stages.review.max_rounds) {
    clearMarker(ctx, REVIEW_ROUND);
    return block(ctx, REVIEWS_USED_UP, { detail: { rounds: round, reason: "fixes were committed after the last review" } });
  }
  writeRound(ctx, round + 1);
  return REVIEW_AGAIN;
}

/**
 * Stage 5, one entry for reviewing, merge-review, and merge-approved. A merge that landed before a
 * stop is recorded first, never merged twice. reviewing: review rounds, then the merge gate in the
 * same step (the gate timing rule), ending at merged (no person), merge-review (a person or a pull
 * request decides), or blocked. With a remote, merge-review and merge-approved watch the pull request
 * (see runRemoteMerge). Without one: merge-review with a person on the gate waits (it is not
 * runnable); merge-approved, or merge-review with no person on the gate: check again and merge.
 */
export async function runMergeStep(ctx: StepContext): Promise<StepResult> {
  // Stopped part-way through a merge that did land: finish recording it.
  if (await alreadyMerged(ctx)) return finishMerge(ctx);
  const status = ctx.intent.file.frontmatter.status;
  if (status === "reviewing") {
    for (;;) {
      const reviewed = await runReviewRounds(ctx);
      if (reviewed !== REVIEW_PASSED) return reviewed;
      const gate = await mergeGate(ctx, () => passMergeGate(ctx));
      if (gate !== REVIEW_AGAIN) return gate;
    }
  }
  if ((await ctx.git.remoteName()) !== null) return runRemoteMerge(ctx);
  if (status === "merge-review" && ctx.cfg.gates.merge.human !== "none") return { ok: true };

  // A person may have set merge-approved (or edited the change's other files) without committing:
  // record the change's own folder first, so their edit is part of main before the checks run.
  await recordPersonEdits(ctx);
  const open = await openBranchWorktree(ctx);
  if (!open.ok) return block(ctx, open.note, open);
  const wt = new Git(ctx.worktreeDir);
  let next: StepResult | typeof REVIEW_AGAIN;
  if (await wt.isDirty()) {
    // Edits nobody reviewed: keep them on the branch and review again rather than merge them unseen.
    const kept = await saveWork(ctx, wt, "chore: keep unfinished changes");
    if (!kept.ok) return block(ctx, kept.note, kept);
    next = await anotherRound(ctx);
  } else {
    next = await mergeGate(ctx, () => mergeNow(ctx));
  }
  if (next !== REVIEW_AGAIN) return next;
  await setStatus(ctx, "reviewing");
  return { ok: true };
}

/** Commits the change's own folder on main (a person's uncommitted edits to it). Nothing else is touched. */
async function recordPersonEdits(ctx: StepContext): Promise<void> {
  await assertRootOnMain(ctx);
  await ctx.git.commitPaths([`intent/${ctx.slug}`], bookkeeping(`loopstra(${ctx.slug}): record edits made by a person`));
}

/**
 * Merges the intent branch into main in the root checkout, in one step that either lands whole or
 * not at all (see Git.merge). Only when the root is on main, nothing is staged, and no tracked file
 * outside intent/ has unsaved changes, so a person's work there is never touched. Unsaved edits
 * inside intent/ (an owner's status lines) never block it; the merge takes only the branch.
 */
async function mergeNow(ctx: StepContext): Promise<StepResult> {
  const root = await rootReady(ctx);
  if (!root.ok) return block(ctx, DIRTY_ROOT_NOTE, { detail: root.detail });

  // The checks brought the branch up to date; if main moved since (bookkeeping), catch up again.
  const main = ctx.cfg.main_branch;
  if (!(await ctx.git.isAncestor(main, ctx.branch)) && !(await new Git(ctx.worktreeDir).rebaseOnto(main))) {
    return block(ctx, UPDATE_FAILED_NOTE, { detail: `rebase of ${ctx.branch} onto ${main} before the merge hit conflicts and was aborted` });
  }

  writeMarker(ctx, MERGING, await ctx.git.headSha());
  const merged = await codePhase(ctx, "merge", async () => {
    const title = ctx.intent.file.title || ctx.slug;
    try {
      await ctx.git.merge(ctx.branch, ctx.cfg.gates.merge.method, `${ctx.slug}: ${title}`);
    } catch (e) {
      passOn(e);
      // Nothing landed: main, the index, and the files are as they were. The detail goes to the trace.
      ctx.trace.event(ctx.slug, "error", { where: "merge", error: errorText(e) });
      return { ok: true as const, landed: false };
    }
    return { ok: true as const, landed: true };
  });
  if (!merged.ok || !merged.landed) {
    clearMarker(ctx, MERGING);
    return block(ctx, "The change could not be merged; main was left untouched. An engineer needs to look at it.", { detail: merged.ok ? `merge of ${ctx.branch} into ${main} refused` : merged.detail });
  }
  return finishMerge(ctx);
}

/**
 * The root checkout may take a merge: it is on main, nothing is staged (anywhere), and no tracked
 * file outside intent/ has unsaved changes. Untracked files are left to git, which refuses a merge
 * that would overwrite one.
 */
async function rootReady(ctx: StepContext): Promise<{ ok: true } | { ok: false; detail: string }> {
  const branch = await ctx.git.currentBranch();
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
async function alreadyMerged(ctx: StepContext): Promise<boolean> {
  const base = readMarker(ctx, MERGING)?.trim();
  if (base === undefined) return false;
  if (!(await ctx.git.branchExists(ctx.branch))) return true;
  const main = ctx.cfg.main_branch;
  const moved = (await ctx.git.run(["rev-parse", main], true)).out.trim() !== base;
  if (moved && (await ctx.git.containsChanges(main, ctx.branch))) return true;
  clearMarker(ctx, MERGING);
  return false;
}

/** The change is on main: tidy up (best effort) and record it as merged. */
async function finishMerge(ctx: StepContext): Promise<StepResult> {
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
    ctx.trace.event(ctx.slug, "error", { where: "cleanup", what: "worktree", error: errorText(e) });
  }
  try {
    if (await ctx.git.branchExists(ctx.branch)) await ctx.git.deleteBranch(ctx.branch);
  } catch (e) {
    clean = false;
    ctx.trace.event(ctx.slug, "error", { where: "cleanup", what: "branch", error: errorText(e) });
  }
  return clean;
}
