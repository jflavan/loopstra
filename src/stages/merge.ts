import { existsSync } from "node:fs";
import { block, clearMarker, onceMarker, PersonChangedStatus, readArtifact, readMarker, recordPersonEdits, setStatus, settleRecord, writeMarker, type Failure, type StatusFields, type StepContext, type StepResult } from "../context";
import { evaluateGate, type Check } from "../gates";
import { Git, NO_AUTO_MAINTENANCE, passOn, statusPaths } from "../git";
import { GitHub, recordGitHub, type PrInfo } from "../github";
import { onCheckout, oneMerge, othersRunningCommands } from "../lanes";
import { changeGates, humanGates, type Status } from "../intents";
import { codePhase } from "../phases";
import { deleteRemoteBranch, moveMain, pushBranch, shareMain, syncMain, type SyncOutcome } from "../remote";
import { branchDiff, changedFiles, filesOf, riskEvidence, riskNote, riskySet, scoreRisk, type BranchDiff, type Risk, type RiskSource } from "../risk";
import { STANDARDS_DIR, type Applying } from "../standards";
import { errorText } from "../shell";
import { andList } from "../text";
import { markHealthPending } from "../signals";
import { endsStepQuietly, notTheStepsFault } from "../stop";
import { testLoop } from "./build";
import { catchUp, outOfDate, PUSH_PENDING, RESOLVED_AT, roundsAllowed } from "./catch-up";
import { catchUpTested, REVIEW_PASSED, runReviewRounds } from "./review";
import { alreadyTested, KEEP_UNFINISHED, MERGE_WAIT_NOTE, MERGING, openBranchWorktree, PR_APPROVE_NOTE, PR_CHECKS_NOTE, PR_LEASE, PR_MERGED_ELSEWHERE, PR_NUMBER, PR_PUSHING, PR_WAIT, readRound, REMOTE_AHEAD, REVIEW_ROUND, saveWork, stageStandards, toolChecks, writeRound, type ToolCheck } from "./shared";

export const DIRTY_ROOT_NOTE = "The main checkout has unsaved changes or is on another branch; an engineer needs to tidy it up before this can merge. Then set status to merge-approved.";
export const UPDATE_FAILED_NOTE = "The change overlaps with other recent changes and could not be brought up to date automatically. Nothing was merged. An engineer needs to look at it.";
export const REVIEWS_USED_UP = "The change needed more fixes after it was reviewed, and it has already been reviewed as many times as allowed. An engineer needs to look at the change.";

/** Notes for the pull request path (a remote exists). */
export const PR_CLOSED_NOTE = "The pull request was closed without merging. Set status to closed, or to plan-approved to rebuild.";
export const PR_CHECKS_FAILED_NOTE = "The automatic checks on GitHub failed. An engineer should look at the pull request.";
const PR_BRANCH_MOVED_NOTE = "Someone added commits to the pull request's branch on GitHub, and the branch here changed too, so Loopstra overwrote neither. An engineer needs to bring the two together.";
const PERSON_COMMITS_NOT_TAKEN_NOTE = "Someone added commits to the pull request's branch on GitHub, and they could not be taken into the workspace here, so nothing was merged. An engineer needs to look at the change's workspace (for example unsaved edits to the same files).";
const PR_MERGED_WITHOUT_FIXES_NOTE = "The pull request was merged on GitHub before this change's latest fixes were made, so main does not have them; they are still on the change's branch. An engineer needs to look at the branch. Then set status to closed, or to plan-approved to rebuild.";
/** Why a change watching its pull request waits, for PR_WAIT (see prWait). */
export const MERGED_NOT_HERE = "The pull request was merged on GitHub, and is recorded as merged once main here has it.";
export const RECORDING_FAILED = "The pull request was merged on GitHub, but recording it here failed; the next look tries again. An engineer can find the error in the trace.";
export const GITHUB_MERGING = "GitHub took the merge of the pull request but has not merged it yet (for example, in a merge queue); the next look checks again.";
export const READY_BEHIND = "The pull request is ready to merge, and merges once main here has what was merged on GitHub meanwhile.";
export const NO_REMOTE_PR_NOTE = "This change passed its checks, but it is set to be approved through a pull request and this repository has no GitHub remote. To merge it here instead, set status to merge-approved.";

/**
 * How long after a pull request opens, Loopstra last pushed its branch, or took a person's commits
 * from it, "no checks reported" still means "not registered yet", when the branch has GitHub Actions
 * workflows. After that, a pull request with no checks merges.
 */
const CHECKS_GRACE_MS = 5 * 60_000;
/**
 * Run-folder marker: when Loopstra last pushed the branch for its pull request, or took commits a
 * person pushed to it (an ISO time).
 */
const PR_PUSHED = "pr-pushed";

/** Run-folder marker: cleanup left the branch because main does not have its changes (traced once). */
const BRANCH_KEPT = "branch-kept";
/**
 * Run-folder marker: Loopstra asked GitHub to merge the pull request (its number), so the branch on
 * GitHub is its to delete once the merge is seen, on whichever look sees it (see finishRemoteMerge).
 * Written before `gh pr merge`: gh can report a problem, or the look right after can fail, when the
 * merge went through all the same.
 */
const GH_MERGE = "gh-merge";
/** Run-folder marker: the pull request is a draft on GitHub, which is waited on (traced once). */
const PR_DRAFT = "pr-draft";
/** Run-folder marker: the pull request merged, but main here does not have it yet (traced once). */
const MAIN_BEHIND = "main-behind";
/**
 * Run-folder marker: the standards that applied to the change when the merge gate's checks passed,
 * JSON `{ commit, applying: { name, why, files }[] }` (commit: the one the standards were read at).
 * The done step judges the merged files by it. Not written in a repository without standards.
 */
export const STANDARDS_APPLIED = "standards.applied";
/**
 * Run-folder marker: when recording a merged pull request first failed and when it last did (two ISO
 * times, one per line; see finishRemoteMerge).
 */
const FINISH_FAILING = "finish-failing";
/** How long recording a merged pull request may keep failing before the change blocks. */
const FINISH_FAILING_MS = 30 * 60_000;
/** A failure this long after the last one (the loop was off meanwhile) starts the count again. */
const FINISH_FAILING_GAP_MS = 10 * 60_000;

/**
 * Who decides this change's merge: the config's merge gate, or the change's own merge_gate when the
 * config has nobody there (see changeGates). Without a remote there is no pull request to approve,
 * so a merge_gate of pr acts as status.
 */
function mergeHuman(ctx: StepContext, hasRemote: boolean): "none" | "status" | "pr" {
  const gate = changeGates(humanGates(ctx.cfg), ctx.intent.file.frontmatter).merge;
  return gate === "pr" && !hasRemote && ctx.cfg.gates.merge.human !== "pr" ? "status" : gate;
}

/**
 * How a person asks the merge step to look again without a rebuild: the status that is runnable for
 * this change's gate. Only on the pull request's path, so a remote exists.
 */
function mergeRetry(ctx: StepContext): Status {
  return mergeHuman(ctx, true) === "status" ? "merge-approved" : "merge-review";
}

/** What the merge gate's automated checks concluded. `changed`: they passed, but fixes were committed that no review has seen. */
type MergeVerdict = { result: "pass" } | { result: "changed" } | ({ result: "fail" } & Failure);

/**
 * The merge gate's automated checks, run in the worktree: the branch is brought up to date with
 * main (rebase), the test loop passes (it may commit fixes) with the checks of the standards that
 * apply to the diff after the tests, and the newest review had no important findings. Each check
 * is recorded as a gate row, and each standard's check as one of its own (`check:<name>`).
 */
async function checkMerge(ctx: StepContext): Promise<MergeVerdict> {
  const wt = new Git(ctx.worktreeDir);
  const main = ctx.cfg.main_branch;
  // A failing check hands back the failure to record; the tests check says whether it committed fixes.
  const prefix = `${STANDARDS_DIR}/`;
  const changedNow = await changedFiles(wt, main);
  const touched = changedNow.filter((f) => f.startsWith(prefix));
  const list = andList(touched);
  const hasStandards = (await ctx.standards()).standards.length > 0;
  // The standards' checks, in the standards' order, each with its standard's name for its row.
  const tools = hasStandards
    ? (await stageStandards(ctx, changedNow)).list.flatMap((a) => toolChecks([a]).map((check) => ({ name: a.standard.name, check })))
    : [];
  const extra = tools.map((t) => t.check);
  // What the tests check found for the tool checks: they passed on this code before, or this one kept failing.
  let toolsSkipped = false;
  let toolFailed: (Failure & { check?: ToolCheck }) | null = null;
  const checks: Check<Failure | { ok: true; changed: boolean }>[] = [
    // First, so nothing is spent on a change that cannot merge. Only a person edits the standards.
    // A repository without standards, and a diff that leaves the folder alone, gets no row for it.
    ...(touched.length || hasStandards ? [{
      name: "standards-untouched",
      run: async (): ReturnType<Check<Failure | { ok: true; changed: boolean }>["run"]> => touched.length
        ? {
          result: "fail",
          evidence: `edits ${list}`,
          payload: { ok: false, note: `This change edits the repository's standards (${touched.join(", ")}), which only a person may change. An engineer can take that edit out of the change's branch and retry the change, or close it.`, detail: `the diff against ${main} touches ${list}` },
        }
        : { result: "pass", evidence: `nothing under ${prefix}` },
    }] : []),
    {
      name: "up-to-date",
      run: async () => {
        if (await ctx.git.isAncestor(main, ctx.branch)) return { result: "pass", evidence: "branch contains main" };
        // A conflict is resolved (see catchUp): the tests run on it next, and a review round sees it before it merges.
        const up = await catchUp(ctx);
        if (!up.ok) return { result: "fail", evidence: `bringing the branch up to date with main failed: ${up.detail}`, payload: up };
        if (up.outcome === "resolved") return { result: "pass", evidence: `resolved conflicts with main in ${up.files.join(", ")}`, payload: { ok: true, changed: true } };
        return { result: "pass", evidence: "rebased onto main" };
      },
    },
    {
      name: "tests",
      run: async () => {
        const before = await wt.headSha();
        // Already tested: the same commit, or one that differs only in records under intent/ (a
        // rebase that brought in main's bookkeeping). Running the tests again would prove nothing new.
        if (await alreadyTested(ctx, wt, extra)) {
          toolsSkipped = true;
          return { result: "pass", evidence: "the tests already passed on this code; only records under intent/ changed since" };
        }
        // After a rebase the tests may need fixing: the same test loop as build, with its fix budget.
        // The standards' checks run in it after the tests, and a failing one is fixed the same way.
        const tested = await testLoop(ctx, "merge-test", extra);
        // Tracked files the commands rewrote (a lint --fix, a report with a timestamp) are put back,
        // whatever the outcome: the merge checks never keep them, so a file rewritten on every run
        // cannot start one review round after another, and no later rebase (a retry's, say) or merge
        // meets them unsaved. The build's own runs keep a reformat (review start commits it), so it is
        // reviewed. New files were removed after each run.
        const rewritten = await wt.changedTrackedFiles();
        if (rewritten.length) {
          await wt.putBack(rewritten);
          ctx.trace.event(ctx.slug, "command", { command: "merge checks", note: `left out files the checks' commands rewrote: ${rewritten.join(", ")}` });
        }
        if (!tested.ok && tested.check) {
          // The tests passed in the last run (the checks run after them); the check's own row fails.
          toolFailed = tested;
          return { result: "pass", evidence: "the tests pass; a standard's check does not" };
        }
        if (!tested.ok) return { result: "fail", evidence: tested.detail, payload: tested };
        const changed = (await wt.headSha()) !== before;
        return { result: "pass", evidence: changed ? "tests pass after fixes that no review has seen yet" : "all commands exit 0", payload: { ok: true, changed } };
      },
    },
    ...tools.map(({ name, check }): Check<Failure | { ok: true; changed: boolean }> => ({
      name: `check:${name}`,
      run: async () => {
        if (toolsSkipped) return { result: "pass", evidence: "already passed on this code" };
        const failed = toolFailed;
        if (failed?.check === check) return { result: "fail", evidence: failed.detail, payload: { ok: false, note: failed.note, detail: failed.detail } };
        return { result: "pass", evidence: `\`${check.command}\` exits 0` };
      },
    })),
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
 * The merge gate after its automated checks passed (the gate timing rule). First, whether the change
 * is risky (see src/risk.ts), on the code that will merge: a risky change with nobody on the
 * config's merge gate gets a person, gates.merge.risky.human, as its merge_gate, written in the same
 * record as its move to merge-review, so nothing reads the status without it; a change that is not
 * risky loses one an earlier pass wrote. With a remote: push the branch, open its pull request, and
 * wait in merge-review (the merge step watches the pull request unless a person decides on the
 * status line). Without one: no person → merge now; a person → merge-review with a note; a pull
 * request set in the config → block plainly (there is nowhere to open one).
 */
async function passMergeGate(ctx: StepContext): Promise<StepResult> {
  const hasRemote = (await ctx.git.remoteName()) !== null;
  // The branch's diff, read at most once for this pass (the standards and the risk both use it), and only when one needs it.
  let diff: Promise<BranchDiff> | null = null;
  const diffOnce = (): Promise<BranchDiff> => (diff ??= branchDiff(new Git(ctx.worktreeDir), ctx.cfg.main_branch));
  const applyingNow = await recordStandards(ctx, diffOnce);
  const risk = await riskOf(ctx, applyingNow, diffOnce);
  const own = ctx.cfg.gates.merge.human === "none" && risk?.risky ? ctx.cfg.gates.merge.risky.human : undefined;
  const fields = own ? { set: { merge_gate: own } } : { remove: ["merge_gate" as const] };
  // The note says why when the change's own gate brings in the person.
  const human = own === "pr" && !hasRemote ? "status" : own ?? ctx.cfg.gates.merge.human;
  const why = (r: Risk | null, otherwise: string) => (own && r ? riskNote(r, human === "pr" ? "pr" : "status") : otherwise);
  if (hasRemote) {
    const opened = await openPullRequest(ctx, true);
    if (!opened.ok) return block(ctx, opened.note, opened);
    await setStatus(ctx, "merge-review", why(risk, human === "none" ? PR_CHECKS_NOTE : human === "pr" ? PR_APPROVE_NOTE : MERGE_WAIT_NOTE), {}, fields);
    return { ok: true };
  }
  if (human === "none") return mergeNow(ctx, fields);
  if (human === "status") {
    await setStatus(ctx, "merge-review", why(risk, MERGE_WAIT_NOTE), {}, fields);
    return { ok: true };
  }
  return block(ctx, NO_REMOTE_PR_NOTE, { detail: "gates.merge.human is pr and the repository has no remote" });
}

/**
 * The standards that apply to the change's diff, recorded as the `standards` gate row and the
 * STANDARDS_APPLIED marker; nothing is written (and nothing read from the diff) in a repository
 * without standards. The list is empty then.
 */
async function recordStandards(ctx: StepContext, diff: () => Promise<BranchDiff>): Promise<Applying[]> {
  if (!(await ctx.standards()).standards.length) return [];
  const list = (await stageStandards(ctx, filesOf(await diff()))).list;
  writeMarker(ctx, STANDARDS_APPLIED, JSON.stringify({
    commit: await ctx.readCommit(),
    applying: list.map((a) => ({ name: a.standard.name, why: a.why, files: a.files })),
  }, null, 2));
  const named = list.map((a) => `${a.standard.title} (${a.standard.rules.map((r) => r.label).join(", ")})`);
  ctx.trace.gate(ctx.slug, "merge", "standards", "pass", named.length ? `applying ${named.join("; ")}` : "no standard applies to this change");
  return list;
}

/**
 * Scores the change's branch in its worktree against main (see scoreRisk) and records it as the
 * merge gate's risk row; null, with no row, when the config names nothing risky and no standard
 * needs a person, or already has a person on the merge gate (risk would change nothing, so it is
 * neither scored nor shown). A standard with needs_person counts as patterns beside risky.paths:
 * its applies_to when they matched, every file when it applies to every change or a person added it.
 */
async function riskOf(ctx: StepContext, applyingNow: Applying[], diff: () => Promise<BranchDiff>): Promise<Risk | null> {
  const extra: RiskSource[] = applyingNow
    .filter((a) => a.standard.needsPerson)
    // Only a standard whose own patterns matched is scoped by them; one for every change, or one a
    // person added to this change (its patterns matched nothing), covers every file.
    .map((a) => ({ patterns: a.why === "files" && a.standard.appliesTo ? a.standard.appliesTo : ["**"], standard: { title: a.standard.title, path: a.standard.path } }));
  if ((!riskySet(ctx.cfg) && !extra.length) || ctx.cfg.gates.merge.human !== "none") return null;
  const risk = await scoreRisk(new Git(ctx.worktreeDir), ctx.cfg.main_branch, ctx.cfg, extra, await diff());
  ctx.trace.gate(ctx.slug, "merge", "risk", risk.risky ? "waiting" : "pass", riskEvidence(risk));
  return risk;
}

/**
 * Shares main, pushes the branch, and makes sure it has an open pull request (title `<slug>: <title>`, a body
 * naming the artifacts and the review summary): this build's own (see ownPr), or a new one. When a
 * person closed this build's pull request, nothing is pushed or opened: the failure says so. The
 * review goes on it as a comment when the pull request is new or `newReview` says a review just passed. The number and link go to the trace.
 * The push overwrites only the commit recorded in PR_LEASE; a branch someone changed on GitHub is
 * left alone, and the change blocked in plain words. GitHub is asked for its copy first (see
 * settleLease): a branch it no longer has (a person deleted it) must still be missing when the push
 * lands. A push cut short earlier is settled before this one is recorded in PR_PUSHING, which it is
 * until PR_LEASE has it; when GitHub cannot be asked, this attempt fails and the record is kept.
 */
async function openPullRequest(ctx: StepContext, newReview: boolean): Promise<{ ok: true } | Failure> {
  let moved = false;
  const r = await codePhase<{ closed: PrInfo | null; unmerged: PrInfo | null }>(ctx, "pull-request", async () => {
    // This build's pull request first: one a person closed is not replaced by a new one, and one
    // merged meanwhile needs no push (the merge step records it on its next look), unless the branch
    // here has fixes since that the merge did not take: then nothing is recorded, and the failure says so.
    const gh = new GitHub(ctx.root);
    const found = await ownPr(ctx, gh);
    if ("error" in found) throw new Error(`gh pr view: ${found.error}`);
    if (found.pr?.merged) return { ok: true as const, closed: null, unmerged: (await fixesNotMerged(ctx, found.pr)) ? found.pr : null };
    // A change built before PR_NUMBER existed (no marker at all) opens a new one, as it did then.
    const closed = found.pr?.state === "CLOSED";
    if (closed && readMarker(ctx, PR_NUMBER) !== null) return { ok: true as const, closed: found.pr, unmerged: null };
    let pr: { number: number; url: string } | null = closed ? null : found.pr;
    // Main first, so the pull request's diff against it shows only the change, not the records.
    await shareMain(ctx.root, ctx.cfg, ctx.trace);
    const head = await ctx.git.commitOf(`refs/heads/${ctx.branch}`);
    if (head === null) throw new Error(`branch ${ctx.branch} does not exist`);
    const theirs = await headOnGitHub(ctx);
    if (theirs === null && readMarker(ctx, PR_PUSHING)) throw new Error(`GitHub could not be asked for ${ctx.branch}, to settle a push of it that was cut short`);
    if (theirs !== null) await settleLease(ctx, theirs);
    writeMarker(ctx, PR_PUSHING, head);
    // GitHub has no such branch: it must still have none (an empty lease), whatever was pushed before.
    const pushed = await pushBranch(ctx.git, ctx.branch, theirs === "" ? "" : readMarker(ctx, PR_LEASE)?.trim() || undefined);
    if (!pushed.ok) {
      moved = pushed.moved === true;
      throw new Error(pushed.detail);
    }
    writeMarker(ctx, PR_LEASE, head);
    clearMarker(ctx, PR_PUSHING);
    writeMarker(ctx, PR_PUSHED, new Date().toISOString());
    // A resolution is on GitHub from now: only an approval given after this covers it (see freshApproval).
    if (readMarker(ctx, RESOLVED_AT)?.trim() === PUSH_PENDING) writeMarker(ctx, RESOLVED_AT, new Date().toISOString());
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
    writeMarker(ctx, PR_NUMBER, String(pr.number));
    const review = await readArtifact(ctx, "review.md");
    if (review && (created || newReview)) {
      // The comment is a courtesy: a failure is traced and does not stop the pull request.
      try { await gh.comment(pr.number, review); } catch (e) { passOn(e); ctx.trace.event(ctx.slug, "error", { where: "pull request comment", error: errorText(e) }); }
    }
    ctx.trace.event(ctx.slug, "command", { command: "pull request", number: pr.number, url: pr.url, created });
    return { ok: true as const, closed: null, unmerged: null };
  });
  if (r.ok && r.closed) return { ok: false, note: PR_CLOSED_NOTE, detail: `pull request #${r.closed.number} ${r.closed.url} was closed without merging` };
  if (r.ok && r.unmerged) return { ok: false, note: PR_MERGED_WITHOUT_FIXES_NOTE, detail: `pull request #${r.unmerged.number} ${r.unmerged.url} was merged at ${r.unmerged.head ?? "an unknown head"}, and ${ctx.branch} has changes since that neither it nor its merge commit has` };
  if (r.ok) return { ok: true };
  if (moved) return { ok: false, note: PR_BRANCH_MOVED_NOTE, detail: r.detail, retryFrom: mergeRetry(ctx) };
  return {
    ok: false,
    note: "The pull request for this change could not be opened on GitHub. An engineer should check that GitHub can be reached.",
    detail: r.detail,
    retryFrom: mergeRetry(ctx),
  };
}

/**
 * True when a pull request merged on GitHub did not take changes the branch here has outside
 * intent/: fixes a later review round committed after someone merged it by hand. The merge took
 * them when its merge commit has them, or the pull request's head as GitHub named it does, of those
 * known here; false when neither is (nothing to compare with). The merge commit counts on its own:
 * a branch the merge checks only brought up to date (rebased onto a newer main) while a person
 * merged the old head differs from that head in the files main changed meanwhile, but not from what
 * the merge made of them. It is fetched with main when it is not here yet (it was made on GitHub);
 * a fetch that fails or hangs past its time leaves the head to compare with (a stop is passed on).
 * The head counts on its own too: a branch not brought up to date lacks what main changed, which
 * the merge commit has. The branch's own changes are those since it diverged from main, not from
 * either commit: the merge checks may have rebased it onto a main that already has the merge, and
 * then only the commits on top are its own.
 */
export async function fixesNotMerged(ctx: StepContext, pr: PrInfo): Promise<boolean> {
  if (!(await ctx.git.branchExists(ctx.branch))) return false;
  const main = ctx.cfg.main_branch;
  const remote = pr.mergeCommit && (await ctx.git.commitOf(pr.mergeCommit)) === null ? await ctx.git.remoteName() : null;
  if (remote) {
    try {
      await ctx.git.fetch(["--quiet", remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`], true);
    } catch (e) {
      // A GitTimeout or another failure is not this look's: an already merged pull request must not read as one that could not be opened.
      if (notTheStepsFault(e) || endsStepQuietly(e)) throw e;
    }
  }
  const known: string[] = [];
  for (const candidate of [pr.mergeCommit, pr.head]) {
    if (candidate && (await ctx.git.commitOf(candidate)) !== null) known.push(candidate);
  }
  if (!known.length) return false;
  for (const target of known) {
    if (await ctx.git.containsChanges(target, ctx.branch, { ignore: ["intent/"], base: main })) return false;
  }
  return true;
}

/**
 * A push of the pull request's branch that a stop, a timeout or a crash cut short (PR_PUSHING left
 * behind) may have reached GitHub all the same. When GitHub's copy (`theirs`) is that push's head,
 * it is Loopstra's own work, not a person's: it becomes the lease, so the next push may go over it.
 */
function adoptCutShortPush(ctx: StepContext, theirs: string): void {
  const pending = readMarker(ctx, PR_PUSHING)?.trim();
  if (!pending || theirs !== pending) return;
  writeMarker(ctx, PR_LEASE, pending);
  clearMarker(ctx, PR_PUSHING);
}

/**
 * GitHub's copy of the pull request's branch (`theirs`, "" when it has none) becomes the lease when
 * the next push may go over it: it is Loopstra's own push that was cut short, or the branch here
 * already contains it (an engineer brought a person's commits in), so the push only adds to it.
 */
async function settleLease(ctx: StepContext, theirs: string): Promise<void> {
  adoptCutShortPush(ctx, theirs);
  if (theirs && theirs !== readMarker(ctx, PR_LEASE)?.trim() && (await ctx.git.isAncestor(theirs, ctx.branch))) writeMarker(ctx, PR_LEASE, theirs);
}

/**
 * This build's pull request (see PR_NUMBER): by its number once it has one. While it has none (""),
 * only an open one for the branch counts, since a closed or merged one is an earlier build's. A
 * change built before the marker existed has none: the branch's pull request, whatever its state.
 */
async function ownPr(ctx: StepContext, gh: GitHub): Promise<{ pr: PrInfo | null } | { error: string }> {
  const mine = readMarker(ctx, PR_NUMBER)?.trim();
  if (mine) return gh.lookupPr(mine);
  const found = await gh.lookupPr(ctx.branch);
  if (mine === "" && "pr" in found && found.pr?.state !== "OPEN") return { pr: null };
  return found;
}

/** The head of the pull request's branch on GitHub, asked of GitHub: "" when it has none, null when it cannot be asked. */
async function headOnGitHub(ctx: StepContext): Promise<string | null> {
  const remote = await ctx.git.remoteName();
  if (!remote) return null;
  const r = await ctx.git.run(["ls-remote", remote, `refs/heads/${ctx.branch}`], true);
  return r.code === 0 ? r.out.trim().split(/\s+/)[0] ?? "" : null;
}

/**
 * The merge step with a remote, for every merge.human mode: watch the pull request. Merged (on
 * GitHub, or by an earlier step that stopped before recording it) → sync main and record it.
 * Closed → block. A person on the status line who has not set merge-approved, checks pending (or
 * not reported yet on a new pull request whose branch has workflows), gh not answering, or
 * (merge.human pr) not approved yet → wait, changing nothing. Checks failed → block. Otherwise
 * merge through gh. Whether GitHub answered the look (the pull request, its checks) is recorded once
 * it is over, as the `github` signal (see recordGitHub), not traced on every look. Why it waits on
 * a pull request its gate has nothing more to decide on is its PR_WAIT, written or removed by each
 * look that ends.
 */
async function runRemoteMerge(ctx: StepContext): Promise<StepResult> {
  const gh = new GitHub(ctx.root);
  let unanswered: string | null = null;
  let why: string | null = null;
  const r = await watchPullRequest(ctx, gh, (error) => { unanswered ??= error; }, (text) => { why = text; });
  recordGitHub(ctx.trace, unanswered);
  if (why === null) clearMarker(ctx, PR_WAIT);
  else if (readMarker(ctx, PR_WAIT) !== why) writeMarker(ctx, PR_WAIT, why);
  return r;
}

/** `waits`: says why the step waits, for PR_WAIT (see runRemoteMerge). */
type Waits = (why: string) => void;

async function watchPullRequest(ctx: StepContext, gh: GitHub, unanswered: (error: string) => void, waits: Waits): Promise<StepResult> {
  const found = await ownPr(ctx, gh);
  if ("error" in found) {
    unanswered(found.error);
    return { ok: true, waiting: true };
  }
  const pr = found.pr;
  if (pr?.merged) return finishRemoteMerge(ctx, pr, waits);
  if (pr?.state === "CLOSED") {
    clearMarker(ctx, REMOTE_AHEAD); // a later wait, after a person sorts this out, is traced again
    return block(ctx, PR_CLOSED_NOTE, { detail: { pr: pr.number, url: pr.url } });
  }
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
  // Who decides this change: the config's merge gate, or its own merge_gate (a risky change).
  const human = mergeHuman(ctx, true);
  // A person decides on the status line and has not yet: only a merge or close on GitHub counts,
  // and the change is kept mergeable meanwhile.
  if (human === "status" && status !== "merge-approved") return keepCurrentWhileWatching(ctx);
  // A draft: GitHub refuses to merge it until a person marks it ready for review, so it is not
  // approved yet, whatever its checks say (traced once).
  if (pr.draft) {
    if (onceMarker(ctx, PR_DRAFT)) ctx.trace.event(ctx.slug, "command", { command: "merge", waiting: "the pull request is a draft on GitHub; it merges once it is marked ready for review", pr: pr.number });
    return { ok: true, waiting: true };
  }
  clearMarker(ctx, PR_DRAFT);
  const checks = await gh.checks(pr.number, unanswered);
  if (checks === "pending" || checks === "unknown") return { ok: true, waiting: true };
  if (checks === "none" && (await checksMayStillStart(ctx, pr))) return { ok: true, waiting: true };
  const where = `pull request #${pr.number} ${pr.url}`;
  if (checks === "fail") {
    ctx.trace.gate(ctx.slug, "merge", "pr-checks", "fail", where);
    clearMarker(ctx, REMOTE_AHEAD);
    return block(ctx, PR_CHECKS_FAILED_NOTE, { detail: { pr: pr.number, url: pr.url }, retryFrom: mergeRetry(ctx) });
  }
  // merge.human pr: approved on GitHub, or a person set merge-approved on the status line. An
  // approval from before a conflict resolution approved other code (see freshApproval).
  const approved = pr.approved && freshApproval(ctx, pr);
  if (human === "pr" && !approved && status !== "merge-approved") {
    if (pr.approved) {
      // Approved on GitHub, but before a conflict resolution: say why it waits, or it would look stuck.
      if (onceMarker(ctx, STALE_APPROVAL)) ctx.trace.event(ctx.slug, "command", { command: "merge", waiting: STALE_APPROVAL_TEXT, pr: pr.number });
      waits(STALE_APPROVAL_TEXT);
    } else clearMarker(ctx, STALE_APPROVAL);
    return keepCurrentWhileWatching(ctx);
  }
  clearMarker(ctx, STALE_APPROVAL);
  ctx.trace.gate(ctx.slug, "merge", "pr-checks", "pass", checks === "none" ? `${where} (no checks reported)` : where);
  if (human === "pr") ctx.trace.gate(ctx.slug, "merge", "pr-approved", "pass", approved ? "approved on GitHub" : "merge-approved on the status line");
  // At every speed.max_parallel_changes: the watcher runs beside the lanes even at one, so another
  // pull request may merge while this one waits, and it is then out of date.
  return mergeWhenUpToDate(ctx, gh, pr, waits);
}

/** The trace's plain line when a pull request was brought up to date before it could merge. */
const BROUGHT_UP_TO_DATE = "Brought up to date with changes merged meanwhile; waiting for the automatic checks on GitHub again.";
/** The trace's plain line when GitHub refused the merge because commits arrived after the checks were read. */
const NEW_COMMITS = "New commits arrived on the pull request after its checks were read, so it was not merged; their checks are looked at next.";

/**
 * Whether the pull request's branch on GitHub still has what it was checked against (see upToDate).
 * `not pushed`: the branch here has commits GitHub's copy lacks (a bring-up-to-date that stopped
 * before its push). `both changed`: on top of that, a person added commits to GitHub's copy.
 * `taken`: up to date, but only once a person's commits were taken from GitHub's copy, whose
 * checks were read before those commits: they are read again first.
 */
type Freshness = "up to date" | "taken" | "main ahead" | "not pushed" | "remote ahead" | "both changed" | "unreachable";

/**
 * Another change may have merged since this pull request's checks ran (the watcher merges beside
 * the lanes, also at one change at a time), so its checks never saw the two together. Under the
 * merge lock: sync main, fetch, and merge on GitHub only when the pull request's branch there is
 * the branch here and neither main here nor the remote's main gained code it lacks. When only the remote's main did (the sync could
 * not bring it in; the `main_sync` signal says why), wait (traced once). When main here did, or the
 * branch here was brought up to date but not pushed, bring it up to date outside the lock (the merge
 * checks again, then a push that keeps the pull request open) and wait for GitHub's checks again.
 * That runs tests and maybe sessions, so only while no more than speed.max_parallel_changes changes
 * run a step that may run commands (a design or plan step runs none), counting this one; otherwise a
 * later look does it. Commits a person added to the pull request are kept: taken into the branch
 * here, or, when the branch here changed too, the change is blocked for an engineer.
 */
async function mergeWhenUpToDate(ctx: StepContext, gh: GitHub, pr: PrInfo, waits: Waits): Promise<StepResult> {
  let synced: SyncOutcome | null = null;
  const r = await oneMergeAtATime(ctx, async () => {
    synced = await syncMain(ctx.root, ctx.cfg, ctx.trace);
    const seen = await upToDate(ctx);
    if (typeof seen !== "string") return block(ctx, seen.note, { ...seen, retryFrom: mergeRetry(ctx) });
    return seen === "up to date" ? mergeOnGitHub(ctx, gh, pr, waits) : seen;
  });
  const main = ctx.cfg.main_branch;
  if (r === "remote ahead") {
    if (onceMarker(ctx, REMOTE_AHEAD)) {
      ctx.trace.event(ctx.slug, "command", { command: "up to date", waiting: `${main} on GitHub has changes merged meanwhile that ${main} here could not take yet (the main_sync signal says why); this change is brought up to date once it has them` });
    }
    waits(withReason(READY_BEHIND, synced));
    return { ok: true, waiting: true };
  }
  if (r !== "unreachable") clearMarker(ctx, REMOTE_AHEAD);
  if (typeof r !== "string") return r;
  if (r === "both changed") return block(ctx, PR_BRANCH_MOVED_NOTE, { detail: `${ctx.branch} here and on GitHub each have commits the other lacks`, retryFrom: mergeRetry(ctx) });
  // A person's commits: the next look reads GitHub's checks of them.
  if (r === "taken") return { ok: true, waiting: true };
  if (r === "unreachable" || othersRunningCommands(ctx.slug) >= ctx.cfg.speed.max_parallel_changes) return { ok: true, waiting: true };
  // Brought up to date and pushed: real work, so the watcher looks again only on the next tick, once
  // GitHub has started the checks of the new head.
  return checkAgain(ctx, async () => {
    const opened = await openPullRequest(ctx, false);
    if (!opened.ok) return block(ctx, opened.note, opened);
    ctx.trace.event(ctx.slug, "command", { command: "up to date", note: BROUGHT_UP_TO_DATE, pr: pr.number });
    return { ok: true };
  });
}

/**
 * Fetches, then judges what GitHub would merge: the pull request's branch as GitHub has it. A copy
 * the branch here may be pushed over becomes the lease (see settleLease). Commits a person added to
 * that copy are taken into the branch here first (see takePersonCommits), so the checks and the
 * next push include them; when the branch here changed too, both changed, and when the workspace
 * cannot take them, the failure to block with is returned. The
 * branch here has commits that copy lacks (a bring-up-to-date that stopped before its push): it is
 * not pushed. Otherwise, is main here or the remote's main ahead of that copy with code outside
 * intent/? Both branches are fetched by name, so this works whatever the remote's fetch setting
 * covers (a single-branch clone fetches only main). A fetch that fails is traced; the step waits
 * and looks again next time.
 */
async function upToDate(ctx: StepContext): Promise<Freshness | Failure> {
  const remote = await ctx.git.remoteName();
  if (!remote) return "unreachable";
  const main = ctx.cfg.main_branch;
  const tracking = (b: string) => `+refs/heads/${b}:refs/remotes/${remote}/${b}`;
  const fetched = await ctx.git.fetch(["--quiet", remote, tracking(main), tracking(ctx.branch)], true);
  if (fetched.code !== 0) {
    ctx.trace.event(ctx.slug, "error", { where: "up to date", error: (fetched.err || `exit ${fetched.code}`).trim(), note: "will look again on the next tick" });
    return "unreachable";
  }
  const pushed = `refs/remotes/${remote}/${ctx.branch}`;
  const theirs = (await ctx.git.commitOf(pushed)) ?? "";
  await settleLease(ctx, theirs);
  // GitHub's copy has commits that neither the branch here nor Loopstra's last push has: a person's.
  let took = false;
  const lease = readMarker(ctx, PR_LEASE)?.trim();
  if (theirs && theirs !== lease) {
    // Both changed only when the branch here moved since Loopstra's push and GitHub's copy lacks it: a
    // copy rewritten on GitHub ("Update with rebase") over a branch here that did not move is taken.
    const here = (await ctx.git.commitOf(`refs/heads/${ctx.branch}`)) ?? "";
    if (here !== lease && !(await ctx.git.isAncestor(ctx.branch, pushed))) return "both changed";
    const taken = await takePersonCommits(ctx, theirs);
    if (!taken.ok) return taken;
    took = true;
  }
  if (!(await ctx.git.isAncestor(ctx.branch, pushed))) return "not pushed";
  if (await outOfDate(ctx.git, main, pushed)) return "main ahead";
  if (await outOfDate(ctx.git, `${remote}/${main}`, pushed)) return "remote ahead";
  return took ? "taken" : "up to date";
}

/**
 * Moves the branch here to `sha`, GitHub's copy, which has commits a person added on top of it, or
 * which a person rewrote while the branch here stayed at Loopstra's push (in the worktree, so its
 * files follow; `reset --keep` keeps unsaved edits and refuses over ones to the same files). From
 * then on the pull request's branch may be pushed over `sha`: the person's work is part of the branch
 * here, and GitHub may not have registered their checks yet: the grace period starts again (see
 * checksMayStillStart). A failure to block with when the workspace cannot be prepared, or cannot take them.
 */
async function takePersonCommits(ctx: StepContext, sha: string): Promise<{ ok: true } | Failure> {
  const open = await openBranchWorktree(ctx);
  if (!open.ok) return open;
  const r = await new Git(ctx.worktreeDir).run([...NO_AUTO_MAINTENANCE, "reset", "-q", "--keep", sha], true);
  if (r.code !== 0) return { ok: false, note: PERSON_COMMITS_NOT_TAKEN_NOTE, detail: `git reset --keep ${sha} in ${ctx.branch}'s workspace: ${(r.err || r.out).trim()}` };
  writeMarker(ctx, PR_LEASE, sha);
  writeMarker(ctx, PR_PUSHED, new Date().toISOString());
  ctx.trace.event(ctx.slug, "command", { command: "take pull request commits", note: "Commits someone added to the pull request on GitHub were taken into the branch here.", head: sha });
  return { ok: true };
}

/** GitHub may not have registered the workflow runs of a pull request opened, or pushed to (by Loopstra or a person), moments ago. */
async function checksMayStillStart(ctx: StepContext, pr: PrInfo): Promise<boolean> {
  const since = Math.max(0, ...[Date.parse(pr.createdAt), Date.parse(readMarker(ctx, PR_PUSHED) ?? "")].filter(Number.isFinite));
  if (!(Date.now() - since < CHECKS_GRACE_MS)) return false;
  const r = await ctx.git.run(["ls-tree", "-z", "--name-only", `refs/heads/${ctx.branch}`, ".github/workflows/"], true);
  return r.code === 0 && r.out.split("\0").some((f) => /\.ya?ml$/i.test(f));
}

/**
 * Merges the pull request on GitHub, only at `pr.head`, the head GitHub named before its checks were
 * read: commits pushed since are not merged untested. When GitHub refuses because the branch moved
 * on, the step waits, and the next look reads the checks of the new head.
 */
async function mergeOnGitHub(ctx: StepContext, gh: GitHub, pr: PrInfo, waits: Waits): Promise<StepResult> {
  // Loopstra's own merge, from here on (see GH_MERGE): the marker outlives a look that fails right after.
  writeMarker(ctx, GH_MERGE, String(pr.number));
  const merged = await codePhase(ctx, "merge", async () => {
    await gh.merge(pr.number, ctx.cfg.gates.merge.method, pr.head);
    return { ok: true as const };
  });
  // Asked again either way: gh can report a problem after the merge went through, and the merged
  // pull request names the commit main must have before the merge is recorded.
  const again = await gh.lookupPr(String(pr.number));
  const after = "pr" in again ? again.pr : null;
  if (!after?.merged) {
    if (!merged.ok && pr.head && after?.head && after.head !== pr.head) {
      // Refused, so nothing merged: the next merge is its own.
      clearMarker(ctx, GH_MERGE);
      ctx.trace.event(ctx.slug, "command", { command: "merge", waiting: NEW_COMMITS, pr: pr.number, head: after.head });
      return { ok: true, waiting: true };
    }
    if (!merged.ok) return block(ctx, "The pull request could not be merged on GitHub. An engineer should look at it.", { detail: { pr: pr.number, error: merged.detail }, retryFrom: mergeRetry(ctx) });
    // gh accepted the merge but it has not happened yet (a merge queue, or GitHub not answering):
    // the branch stays, since deleting it would close the pull request, and the next tick looks again.
    waits(GITHUB_MERGING);
    return { ok: true, waiting: true };
  }
  return finishRemoteMerge(ctx, after, waits);
}

/**
 * The pull request is merged on GitHub: bring main up to date here, then record the merge. When
 * main still does not have it (the sync was skipped or failed: unsaved changes in the main
 * checkout, GitHub out of reach, a clash; the `main_sync` signal says which), wait and try again
 * later, so the done-check never judges a main without the change. Main has it when it contains
 * the pull request's merge commit, or the branch's changes when gh does not name one. Main only
 * moves forward meanwhile, so once it has them it keeps them. A merge Loopstra made (see GH_MERGE)
 * has its branch on GitHub deleted first, by whichever look sees the merge; a person's merge leaves
 * the branch to them. Whatever fails from here on, except a stop,
 * an outage, the day's budget or a person's status change, is traced (once per error) and waits: the
 * pull request is merged, so the next look records it (a block would advise building it again). Once
 * the failures have lasted FINISH_FAILING_MS, it blocks, and a person asks for another look.
 */
async function finishRemoteMerge(ctx: StepContext, pr: PrInfo, waits: Waits): Promise<StepResult> {
  try {
    // Only for the pull request the marker names: one left by an earlier build's failed merge says
    // nothing about a later pull request a person merged.
    const ours = readMarker(ctx, GH_MERGE);
    if (ours !== null && ours.trim() === String(pr.number)) {
      const deleted = await deleteRemoteBranch(ctx.git, ctx.branch);
      if (!deleted.ok) ctx.trace.event(ctx.slug, "command", { command: "delete merged branch on the remote", kept: ctx.branch, reason: deleted.detail });
    }
    if (ours !== null) clearMarker(ctx, GH_MERGE);
    const recorded = await recordRemoteMerge(ctx, pr, waits);
    clearMarker(ctx, FINISH_FAILING);
    return recorded;
  } catch (e) {
    if (notTheStepsFault(e) || endsStepQuietly(e) || e instanceof PersonChangedStatus) throw e;
    const error = errorText(e);
    const now = Date.now();
    const [first = "", last = first] = (readMarker(ctx, FINISH_FAILING) ?? "").trim().split("\n");
    const started = Date.parse(first);
    // A failure long after the last one, or a marker that cannot be read, starts the count again.
    const since = now - Date.parse(last) < FINISH_FAILING_GAP_MS && started <= now ? started : now;
    if (now - since >= FINISH_FAILING_MS) {
      clearMarker(ctx, FINISH_FAILING);
      return block(ctx, `The pull request merged on GitHub, but recording it here kept failing: ${error}. An engineer needs to look at it.`, { retryFrom: mergeRetry(ctx) });
    }
    writeMarker(ctx, FINISH_FAILING, `${new Date(since).toISOString()}\n${new Date(now).toISOString()}`);
    ctx.trace.eventOnChange(ctx.slug, "error", '"where":"finish merge"', { where: "finish merge", error, note: "the pull request is merged; recording it is tried again on the next look" }, "error");
    waits(RECORDING_FAILED);
    return { ok: true, waiting: true };
  }
}

/** finishRemoteMerge's body: sync main, then record the merge once main has it. */
async function recordRemoteMerge(ctx: StepContext, pr: PrInfo, waits: Waits): Promise<StepResult> {
  const main = ctx.cfg.main_branch;
  // A status a person saved without committing would keep the sync from touching main. Off main,
  // the sync is skipped anyway and says so.
  if ((await ctx.git.currentBranch()) === main) await recordPersonEdits(ctx);
  const synced = await syncMain(ctx.root, ctx.cfg, ctx.trace);
  const hasIt = pr.mergeCommit
    ? (await ctx.git.isAncestor(pr.mergeCommit, main)) || ((await ctx.git.branchExists(ctx.branch)) && (await ctx.git.containsChanges(main, ctx.branch, { ignore: ["intent/"] })))
    : !(await ctx.git.branchExists(ctx.branch)) || (await ctx.git.containsChanges(main, ctx.branch, { ignore: ["intent/"] }));
  if (!hasIt) {
    if (onceMarker(ctx, MAIN_BEHIND)) {
      const waiting = `the pull request is merged, but ${main} here does not have it yet; the merge is recorded once the sync brings it in`;
      ctx.trace.event(ctx.slug, "command", { command: "finish merge", waiting, pr: pr.number, mergeCommit: pr.mergeCommit });
    }
    // Main here took all of GitHub's main, merge commit included, and still lacks the change: it
    // merged elsewhere. Without the merge commit here, GitHub may not show it on main yet.
    const elsewhere = synced && !synced.behind && (!pr.mergeCommit || (await ctx.git.commitOf(pr.mergeCommit)) !== null);
    waits(elsewhere ? PR_MERGED_ELSEWHERE : withReason(MERGED_NOT_HERE, synced));
    return { ok: true, waiting: true };
  }
  clearMarker(ctx, MAIN_BEHIND);
  return finishMerge(ctx);
}

/** `text`, then why main here could not take main on GitHub, when the sync stopped before it could. */
function withReason(text: string, synced: SyncOutcome | null): string {
  return synced?.behind ? `${text} ${synced.text}` : text;
}

/** The note of a change sent back to review after it was brought up to date while it waited for a person. */
export const CAUGHT_UP_NOTE = "Other work merged into main meanwhile conflicted with this change, so it was brought up to date. It is tested and reviewed again before it comes back to you.";

/**
 * Whether a change waiting at the merge gate no longer merges cleanly into main: main gained code
 * since it parted, and git finds a conflict merging the two. False when it merges cleanly (even if
 * it is behind), and when git cannot say (before git 2.38): the merge checks resolve it later.
 */
export async function conflictsWhileWaiting(git: Git, main: string, branch: string): Promise<boolean> {
  const [at, head] = [await git.commitOf(main), await git.commitOf(`refs/heads/${branch}`)];
  if (at === null || head === null) return false;
  // Asked every tick and every look of the watcher: worked out again only once either side moved.
  const where = `${git.cwd}\0${branch}`;
  const known = conflictsSeen.get(where);
  if (known?.at === at && known.head === head) return known.conflicts;
  const conflicts = (await outOfDate(git, main, branch)) && (await git.mergesCleanly(main, branch)) === false;
  conflictsSeen.set(where, { at, head, conflicts });
  return conflicts;
}

/** What conflictsWhileWaiting last found for each repository and branch, with main's commit and the branch's then. */
const conflictsSeen = new Map<string, { at: string; head: string; conflicts: boolean }>();

/**
 * Keeps a change that waits for a person at the merge gate mergeable (see conflictsWhileWaiting):
 * one that no longer merges cleanly is brought up to date (see catchUp), tested, and sent back to
 * reviewing for one more round, so the person approves code that will merge. Null when there was
 * nothing to do.
 */
async function keepCurrent(ctx: StepContext): Promise<StepResult | null> {
  if (!(await conflictsWhileWaiting(ctx.git, ctx.cfg.main_branch, ctx.branch))) return null;
  const open = await openBranchWorktree(ctx);
  if (!open.ok) return block(ctx, open.note, open);
  const wt = new Git(ctx.worktreeDir);
  if (await wt.isDirty()) {
    // As the merge checks do: edits nobody reviewed are kept on the branch, so the next review sees them.
    const kept = await saveWork(ctx, wt, KEEP_UNFINISHED);
    if (!kept.ok) return block(ctx, kept.note, kept);
  }
  const up = await catchUpTested(ctx);
  if (!up.ok) return block(ctx, up.note, up);
  const again = await anotherRound(ctx);
  if (again !== REVIEW_AGAIN) return again;
  await setStatus(ctx, "reviewing", CAUGHT_UP_NOTE);
  return { ok: true };
}

/**
 * keepCurrent for a pull request the watcher looks at while it waits for a person. It may run tests
 * and sessions, so only while no more than speed.max_parallel_changes changes run a step that may
 * run commands, counting this one (as mergeWhenUpToDate); otherwise a later look does it.
 */
async function keepCurrentWhileWatching(ctx: StepContext): Promise<StepResult> {
  const waiting: StepResult = { ok: true, waiting: true };
  if (othersRunningCommands(ctx.slug) >= ctx.cfg.speed.max_parallel_changes) return waiting;
  if (!(await conflictsWhileWaiting(ctx.git, ctx.cfg.main_branch, ctx.branch))) return waiting;
  // What would merge on GitHub first, as mergeWhenUpToDate does: main as it is there, and commits a
  // person added to the pull request, so the resolution starts from them and its push goes over them.
  const seen = await oneMergeAtATime(ctx, async () => {
    await syncMain(ctx.root, ctx.cfg, ctx.trace);
    return upToDate(ctx);
  });
  if (typeof seen !== "string") return block(ctx, seen.note, { ...seen, retryFrom: mergeRetry(ctx) });
  if (seen === "both changed") return block(ctx, PR_BRANCH_MOVED_NOTE, { detail: `${ctx.branch} here and on GitHub each have commits the other lacks`, retryFrom: mergeRetry(ctx) });
  if (seen === "unreachable") return waiting;
  return (await keepCurrent(ctx)) ?? waiting;
}

/** Run-folder marker: the pull request's approval on GitHub came before a conflict resolution (traced once). */
const STALE_APPROVAL = "stale-approval";
/** Why a pull request approved before a conflict resolution waits, for PR_WAIT. */
export const STALE_APPROVAL_TEXT = "It was approved on GitHub before conflicts with main were resolved; approve the pull request again to merge the resolved code.";

/**
 * True when an approval on GitHub covers the code as it is: there was no conflict resolution in this
 * build, or a person approved after the latest one reached GitHub (RESOLVED_AT). Not while the
 * resolution is still waiting to be pushed. GitHub keeps an approval through a push unless the
 * repository dismisses stale ones, and the resolution is code they have not seen.
 */
function freshApproval(ctx: StepContext, pr: PrInfo): boolean {
  const marker = readMarker(ctx, RESOLVED_AT)?.trim();
  if (marker === undefined) return true;
  if (marker === PUSH_PENDING) return false;
  const pushed = Date.parse(marker);
  // A marker that cannot be read says nothing: as before resolutions, GitHub's approval stands.
  if (!Number.isFinite(pushed)) return true;
  return pr.approvedAt !== null && Date.parse(pr.approvedAt) > pushed;
}

/** The merge gate sent the change back for one more review round (the round marker names it). */
const REVIEW_AGAIN = "review-again";

/**
 * The merge gate, one entry point for the review step (a review just passed; `onPass` is
 * passMergeGate) and the merge step (merge-approved, or merge-review with no person; `onPass`
 * merges): its automated checks run, and then `onPass`. Fixes the checks committed, and edits
 * waiting unsaved in the worktree before the checks, go back for one more review round (see
 * anotherRound), so nothing reaches main that a review did not see. Files the checks' commands
 * rewrote are put back (see checkMerge); the same edits back right after they were kept block.
 *
 * Without a remote it holds the merge lock from the checks to the merge: one change at a time is
 * checked and merged, so between its checks and its merge main only gains records under intent/.
 * The next change is checked against main with the first one's code, and its tests run again. With
 * a remote the checks only open a pull request; the lock is taken where it merges (runRemoteMerge).
 */
async function mergeGate(ctx: StepContext, onPass: () => Promise<StepResult>): Promise<StepResult | typeof REVIEW_AGAIN> {
  const wt = new Git(ctx.worktreeDir);
  if (await wt.isDirty()) {
    // Edits nobody reviewed (a review after command that rewrote a file, a revision stopped part-way):
    // keep them on the branch and review again rather than merge them unseen, or let them stop the rebase.
    // Never put back: they could be a person's.
    const again = await editedAgain(wt);
    if (again.length) return block(ctx, `These files change every time the review's after command runs: ${again.join(", ")}. Change the command so it leaves them alone, or stop tracking them (git rm --cached, then add them to .gitignore); then set status to reviewing.`);
    const kept = await saveWork(ctx, wt, KEEP_UNFINISHED);
    if (!kept.ok) return block(ctx, kept.note, kept);
    return anotherRound(ctx);
  }
  const gate = async () => {
    const verdict = await checkMerge(ctx);
    if (verdict.result === "fail") return block(ctx, verdict.note, verdict);
    if (verdict.result === "pass") return onPass();
    return anotherRound(ctx);
  };
  return (await ctx.git.remoteName()) === null ? oneMergeAtATime(ctx, gate) : gate();
}

/**
 * Files edited in the worktree that the newest commit on the branch, a keep of unfinished changes,
 * had just kept: they changed again, so keeping them once more would only start another review
 * round. None when that commit is something else, or another file is edited too.
 */
async function editedAgain(wt: Git): Promise<string[]> {
  if ((await wt.run(["log", "-1", "--format=%s"])).out.trim() !== KEEP_UNFINISHED) return [];
  const kept = (await wt.run(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])).out.split("\0");
  const added = (await wt.run(["ls-files", "--others", "--exclude-standard", "-z"])).out.split("\0").filter(Boolean);
  const edited = [...(await wt.changedTrackedFiles()), ...added];
  return edited.every((f) => kept.includes(f)) ? edited : [];
}

/**
 * Runs `fn` under the merge lock, as this change. When another change holds it, the trace says so
 * once, before waiting: "waits for add-numbers to finish merging first".
 */
function oneMergeAtATime<T>(ctx: StepContext, fn: () => Promise<T>): Promise<T> {
  if (!oneMerge.heldHere() && oneMerge.busy()) {
    const holder = oneMerge.holder();
    ctx.trace.event(ctx.slug, "command", { command: "merge lock", waiting: `waits for ${holder && holder !== ctx.slug ? holder : "another change"} to finish merging first` });
  }
  return oneMerge.run(fn, ctx.slug);
}

/**
 * Changes no review has seen are on the branch: one more review round while rounds are left (the
 * round marker moves on to it), else block. The one place the review rounds run out after a pass.
 */
async function anotherRound(ctx: StepContext): Promise<StepResult | typeof REVIEW_AGAIN> {
  const round = readRound(ctx) ?? 1;
  if (round > roundsAllowed(ctx)) {
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
  // A person decides and has not yet: the change is kept mergeable meanwhile (the scheduler runs
  // this step only when it no longer merges cleanly; see conflictsWhileWaiting).
  if (status === "merge-review" && mergeHuman(ctx, false) !== "none") return (await keepCurrent(ctx)) ?? { ok: true };

  // A person may have set merge-approved (or edited the change's other files) without committing:
  // record the change's own folder first, so their edit is part of main before the checks run.
  await recordPersonEdits(ctx);
  return checkAgain(ctx, () => mergeNow(ctx));
}

/**
 * The merge gate once more, after the review step passed it: in the change's worktree, then
 * `onPass`. Edits nobody reviewed waiting in the worktree are kept on the branch and reviewed
 * first, and so are fixes the checks commit (status reviewing), so nothing merges unseen (see mergeGate).
 */
async function checkAgain(ctx: StepContext, onPass: () => Promise<StepResult>): Promise<StepResult> {
  const open = await openBranchWorktree(ctx);
  if (!open.ok) return block(ctx, open.note, open);
  const next = await mergeGate(ctx, onPass);
  if (next !== REVIEW_AGAIN) return next;
  await setStatus(ctx, "reviewing");
  return { ok: true };
}

/**
 * Merges the intent branch into main in the main checkout, in one step that either lands whole or
 * not at all: the merge commit is built aside (see Git.mergeCommit) and main moves to it (see
 * moveMain). Only when the checkout is on main, nothing is staged, and no tracked file outside
 * intent/ has unsaved changes, so a person's work there is never touched. Unsaved edits inside
 * intent/ (an owner's status lines) never block it; the merge takes only the branch. The look at
 * the checkout, the catch-up rebase, the marker and the move are one checkout-lock section, so no
 * other change commits on main in between. `fields` go into the record of the merge (see finishMerge).
 */
async function mergeNow(ctx: StepContext, fields?: StatusFields): Promise<StepResult> {
  const landed = await onCheckout(ctx.root, () => mergeIntoMain(ctx));
  return landed === true ? finishMerge(ctx, fields) : landed;
}

/**
 * mergeNow's section: true when the merge landed, else the block it recorded, or a wait. A record
 * another change's step or a request left between moving main and writing the checkout (see
 * settleRecord) is finished first: until it is, the index lags behind main for its files, which
 * would read as a person's staged changes. One that cannot be finished yet (traced) makes the step
 * wait for the next tick, on main; off main the checkout is not ready, as before.
 */
async function mergeIntoMain(ctx: StepContext): Promise<true | StepResult> {
  if (!(await settleRecord(ctx.root, ctx.cfg.main_branch, ctx.trace)) && (await ctx.git.currentBranch()) === ctx.cfg.main_branch) {
    return { ok: true, waiting: true, waitingFor: "a record the loop was writing to be finished" };
  }
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
    let error: string | null;
    try {
      const { from, to } = await ctx.git.mergeCommit(ctx.branch, ctx.cfg.gates.merge.method, `${ctx.slug}: ${title}`);
      // The merge commit is known now: a step resumed after a stop looks for it on main (see alreadyMerged).
      writeMarker(ctx, MERGING, `${from}\n${to}`);
      const moved = await moveMain(ctx.git, from, to);
      error = moved.ok ? null : moved.error;
    } catch (e) {
      passOn(e);
      error = errorText(e);
    }
    // Nothing landed: main, the index, and the files are as they were. The detail goes to the trace.
    if (error !== null) ctx.trace.event(ctx.slug, "error", { where: "merge", error });
    return { ok: true as const, landed: error === null };
  });
  if (!merged.ok || !merged.landed) {
    clearMarker(ctx, MERGING);
    return block(ctx, "The change could not be merged; main was left untouched. An engineer needs to look at it.", { detail: merged.ok ? `merge of ${ctx.branch} into ${main} refused` : merged.detail });
  }
  return true;
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
  const unsaved = statusPaths((await ctx.git.run(["status", "--porcelain", "-z", "--untracked-files=no", "--", ".", ":(exclude)intent"])).out);
  if (unsaved.length) return { ok: false, detail: `root checkout has unsaved changes to tracked files outside intent/: ${unsaved.join(", ")}` };
  return { ok: true };
}

/**
 * True when a merge was started (the marker exists) and its result is already on main: the branch
 * is gone, or main has the merge commit the marker names, or (a marker written before that commit
 * was known, or by an older Loopstra) main moved past the commit it was on before the merge and has
 * the branch's version of every file the branch changed outside intent/ (every file, intent/ too,
 * when it changed nothing else: with nothing to compare, that test would always pass). Records land
 * on main between a landed merge and the resumed step (a status, another change's), and they must
 * not make the merge run again. A marker whose merge never landed is removed.
 */
async function alreadyMerged(ctx: StepContext): Promise<boolean> {
  const marker = readMarker(ctx, MERGING)?.trim();
  if (marker === undefined) return false;
  if (!(await ctx.git.branchExists(ctx.branch))) return true;
  const main = ctx.cfg.main_branch;
  const [base = "", merge] = marker.split(/\r?\n/);
  if (merge && (await ctx.git.isAncestor(merge, main))) return true;
  const moved = (await ctx.git.commitOf(main)) !== base;
  if (moved && (await ctx.git.containsChanges(main, ctx.branch, { ignore: ["intent/"], ignoreOnlyWithOthers: true }))) return true;
  clearMarker(ctx, MERGING);
  return false;
}

/** The change is on main: tidy up (best effort) and record it as merged, with `fields` (see setStatus) in the same record. */
async function finishMerge(ctx: StepContext, fields?: StatusFields): Promise<StepResult> {
  await cleanupChange(ctx);
  markHealthPending(ctx.root, ctx.slug);
  await setStatus(ctx, "merged", "", {}, fields);
  clearMarker(ctx, MERGING);
  clearMarker(ctx, REVIEW_ROUND);
  clearMarker(ctx, REMOTE_AHEAD);
  clearMarker(ctx, GH_MERGE);
  clearMarker(ctx, PR_DRAFT);
  return { ok: true };
}

/**
 * Removes a merged change's worktree and branch. Best effort: a failure is traced and the
 * scheduler tries again on a later tick. Returns true when nothing is left.
 * The branch is deleted only when main already has its changes. Otherwise (a person set merged by
 * hand, or main is not synced yet) the worktree and branch are left as they are, and the reason is
 * traced once. Files under intent/ are not compared: main's own record of the change moves on after
 * the merge (status, outcome), and the branch only holds an older copy of it. No lock: main only
 * moves forward, so once it has the branch's changes it keeps them.
 */
export async function cleanupChange(ctx: StepContext): Promise<boolean> {
  const main = ctx.cfg.main_branch;
  if ((await ctx.git.branchExists(ctx.branch)) && !(await ctx.git.containsChanges(main, ctx.branch, { ignore: ["intent/"] }))) {
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
