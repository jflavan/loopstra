import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockWith, blockWithDetail, clearMarker, setStatus, type Failure, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { Git } from "../git";
import { codePhase } from "../phases";
import { markHealthPending } from "../signals";
import { testLoop } from "./build";
import { MERGING, openBranchWorktree, readRound, REVIEW_ROUND, saveWork, writeRound } from "./shared";


export const MERGE_WAIT_NOTE = "Read review.md. To let this change in, change the status line to merge-approved. To stop this change, set it to closed.";
export const DIRTY_ROOT_NOTE = "The main checkout has unsaved changes or is on another branch; an engineer needs to tidy it up before this can merge. Then set status to merge-approved.";
export const REVIEWS_USED_UP = "The change needed more fixes after it was reviewed, and it has already been reviewed as many times as allowed. An engineer needs to look at the change.";

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
          note: "The change overlaps with other recent changes and could not be brought up to date automatically. Nothing was merged. An engineer needs to look at it.",
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
 * The merge gate after its automated checks passed (the gate timing rule): no person → merge now;
 * a person → merge-review with a note; a pull request → not wired yet, so block plainly.
 */
export async function passMergeGate(ctx: StepContext): Promise<StepResult> {
  const human = ctx.cfg.gates.merge.human;
  if (human === "none") return mergeNow(ctx);
  if (human === "status") {
    await setStatus(ctx, "merge-review", MERGE_WAIT_NOTE);
    return { ok: true };
  }
  return blockWithDetail(
    ctx,
    "This change passed its checks, but approving merges through a pull request is not set up yet. To merge it here instead, set status to merge-approved.",
    "gates.merge.human is pr; the pull request path is not wired yet",
  );
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
 * The merge step. merge-review with a person on the gate waits (it is not runnable). merge-approved
 * (a person approved), or merge-review with no person on the gate: check again and merge.
 */
export async function runMergeStep(ctx: StepContext): Promise<StepResult> {
  if (await alreadyMerged(ctx)) return finishMerge(ctx);
  const status = ctx.intent.file.frontmatter.status;
  if (status === "merge-review" && ctx.cfg.gates.merge.human !== "none") return { ok: true };

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

/**
 * Merges the intent branch into main in the root checkout. Only when the root is on main with no
 * staged or unstaged changes to tracked files, so a person's work there is never touched.
 */
async function mergeNow(ctx: StepContext): Promise<StepResult> {
  const root = await rootReady(ctx);
  if (!root.ok) return blockWithDetail(ctx, DIRTY_ROOT_NOTE, root.detail);

  mkdirSync(ctx.runDir, { recursive: true });
  writeFileSync(join(ctx.runDir, MERGING), await ctx.git.headSha());
  const merged = await codePhase(ctx, "merge", async () => {
    const title = ctx.intent.file.title || ctx.slug;
    try {
      await ctx.git.merge(ctx.branch, ctx.cfg.gates.merge.method, `${ctx.slug}: ${title}`);
    } catch (e) {
      // git.merge has already aborted, so main is clean. Keep the technical detail in the trace.
      ctx.trace.event(ctx.slug, "error", { where: "merge", error: (e as Error).message });
      return { ok: true as const, conflict: true };
    }
    return { ok: true as const, conflict: false };
  });
  if (!merged.ok || merged.conflict) {
    clearMarker(ctx, MERGING);
    return blockWithDetail(
      ctx,
      "The change could not be merged because it overlaps with other recent changes. Main was left untouched. An engineer needs to look at it.",
      merged.ok ? `merge of ${ctx.branch} into ${ctx.cfg.main_branch} refused` : merged.note,
    );
  }
  return finishMerge(ctx);
}

async function rootReady(ctx: StepContext): Promise<{ ok: true } | { ok: false; detail: string }> {
  const branch = (await ctx.git.run(["rev-parse", "--abbrev-ref", "HEAD"], true)).out.trim();
  if (branch !== ctx.cfg.main_branch) return { ok: false, detail: `root checkout is on ${branch || "(unknown)"}, not ${ctx.cfg.main_branch}` };
  if (await ctx.git.hasTrackedChanges()) return { ok: false, detail: "root checkout has staged or unstaged changes to tracked files" };
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
  const changed = await ctx.git.run(["diff", "--name-only", `${base}...${ctx.branch}`], true);
  const moved = (await ctx.git.run(["rev-parse", main], true)).out.trim() !== base;
  if (changed.code === 0 && moved) {
    const files = changed.out.trim().split(/\r?\n/).filter(Boolean);
    if (await ctx.git.sameContent(main, ctx.branch, files)) return true;
  }
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
 */
export async function cleanupChange(ctx: StepContext): Promise<boolean> {
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
