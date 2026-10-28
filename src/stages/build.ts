import { diffWithinPlan, parsePlanFiles } from "../checks";
import { ACCEPTANCE, acceptanceFiles, block, clearMarker, readMarker, saveSession, SENT_BACK, setStatus, writeMarker, type Failure, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase, alongside, codePhase, mayOverlap, phasePrompt, projectCommand, type AgentPhaseSpec } from "../phases";
import { writeAcceptance } from "./acceptance";
import { EARLY_REVIEW, keepEarlyReview, reviewAhead } from "./early-review";
import { errorText, type CommandResult } from "../shell";
import { StopRequested } from "../stop";
import { RESOLUTION, RESOLUTIONS, RESOLVED_AT } from "./catch-up";
import { artifacts, bullets, buildSession, BY_STATUS_EDIT, checkCommands, MERGING, planFiles, PR_LEASE, PR_NUMBER, PR_PUSHING, PR_WAIT, RECONCILED_PLAN, REMOTE_AHEAD, recordApprovals, restoreCatchUp, REVIEW_ROUND, runHookCommands, saveWork, stageStandards, TESTED, testedMarker, testResult, toolCheckEnv, type ToolCheck } from "./shared";

/** Stage 3 build half plus Stage 4. Called for plan-approved and building. Ends at reviewing or blocked. */
export async function runBuildStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "building") {
    // A plan approved by a status edit: its exceptions are recorded as approved before the build.
    if (ctx.intent.file.frontmatter.status === "plan-approved") await recordApprovals(ctx, "plan", BY_STATUS_EDIT);
    // A new build writes its own acceptance tests; one resumed after a stop keeps what it wrote.
    clearMarker(ctx, ACCEPTANCE);
    await setStatus(ctx, "building");
  }
  clearMarker(ctx, MERGING); // a new build is never an earlier merge in progress
  clearMarker(ctx, RECONCILED_PLAN); // nor is it compared with a plan reconciled for an earlier build
  clearMarker(ctx, EARLY_REVIEW); // nor reviewed by a review of an earlier build
  clearMarker(ctx, REMOTE_AHEAD); // nor waiting like an earlier build's pull request
  clearMarker(ctx, PR_WAIT); // nor shown as one
  clearMarker(ctx, PR_LEASE); // nor tied to what was pushed for it (a person may have deleted that branch on GitHub)
  clearMarker(ctx, PR_PUSHING); // nor an earlier build's push that was cut short
  writeMarker(ctx, PR_NUMBER, ""); // nor an earlier build's pull request, closed or merged (see ownPr)
  clearMarker(ctx, RESOLUTIONS); // a new build gets its own conflict resolutions
  clearMarker(ctx, RESOLUTION); // and no reviewer is shown an earlier build's
  clearMarker(ctx, RESOLVED_AT); // nor does an earlier build's resolution ask for a fresh approval

  const branch = await codePhase(ctx, "branch", async () => {
    // Branches and worktrees take no lock (see Git.run): another change's commits and checkouts go on meanwhile.
    if (!(await ctx.git.branchExists(ctx.branch))) await ctx.git.createBranch(ctx.branch, ctx.cfg.main_branch);
    // Never trust a leftover directory: a plain folder here would send commits to the main checkout.
    await ctx.git.ensureWorktree(ctx.worktreeDir, ctx.branch);
    // A conflict resolution an earlier step left part-way is undone before anything builds on it.
    await restoreCatchUp(ctx);
    if (ctx.cfg.commands.install) {
      const r = await projectCommand(ctx, ctx.cfg.commands.install, ctx.worktreeDir);
      if (r.code !== 0) throw new Error(`install failed: ${r.lastLine}`);
    }
    return { ok: true as const };
  });
  if (!branch.ok) return block(ctx, "The workspace for building this change could not be prepared. An engineer needs to look at it.", { detail: branch.detail });

  const before = await runHookCommands(ctx, "before", "build", ctx.worktreeDir);
  if (!before.ok) return before;

  const wt = new Git(ctx.worktreeDir);
  const a = await artifacts(ctx);
  const stage = ctx.cfg.stages.build;

  // Tests from the owner's Done when list, written before the build, once per build.
  if (stage.acceptance_tests && readMarker(ctx, ACCEPTANCE) === null) {
    const wrote = await writeAcceptance(ctx, wt, a);
    if (!wrote.ok) return block(ctx, wrote.note, wrote);
  }

  const feedback = readMarker(ctx, SENT_BACK)?.trim() ?? "";
  // The build, and the reconcile of its plan, may run the checks of the plan's standards.
  const commands = await checkCommands(ctx, a.plan);
  const phase: AgentPhaseSpec & { name: "build" } = {
    name: "build", permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir, commands,
    vars: { plan: a.plan, spec: a.spec, test_command: ctx.cfg.commands.test, feedback, standards: (await stageStandards(ctx, planFiles(a.plan))).text }, skills: stage.skills,
  };
  // The note reaches the session even through an older build.md without {{feedback}}.
  const build = await agentPhase(ctx, phase, () => phasePrompt(ctx, phase, { variable: "feedback", note: feedback, text: `A person's notes on an earlier build of this change; address each one:\n\n${feedback}` }));
  if (!build.ok) return block(ctx, build.note);
  // The build session is what fix, reconcile, and revise resume.
  if (build.sessionId) saveSession(ctx, "build", build.sessionId);
  const saved = await saveWork(ctx, wt, build.envelope.commit_message || `loopstra(${ctx.slug}): build`);
  if (!saved.ok) return block(ctx, saved.note, saved);
  // Used: the build it asked to change is saved.
  clearMarker(ctx, SENT_BACK);

  // Plan drift: files changed that main's plan did not list. The acceptance tests are not the build's to list.
  let plan = a.plan;
  const accepted = new Set(acceptanceFiles(ctx));
  const drift = await codePhase(ctx, "drift", async () => {
    const changed = (await wt.changedFilesSince(ctx.cfg.main_branch)).filter((f) => !accepted.has(f));
    const planned = parsePlanFiles(plan);
    if (planned === null) {
      // No file list to compare against: say so in the trace rather than flag every file.
      ctx.trace.event(ctx.slug, "command", { command: "drift", changed, note: "the plan has no Files that change section; drift not checked" });
      return { ok: true as const, extra: [] as string[] };
    }
    const extra = diffWithinPlan(changed, planned, ctx.slug);
    ctx.trace.event(ctx.slug, "command", { command: "drift", changed, extra });
    return { ok: true as const, extra };
  });
  if (!drift.ok) return block(ctx, "The change could not be compared with its plan. An engineer needs to look at it.", { detail: drift.detail });
  if (drift.extra.length) {
    const rec = await buildSession(ctx, {
      name: "reconcile", permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir, commands,
      vars: { plan, findings: bullets(drift.extra) },
    });
    if (!rec.ok) return block(ctx, rec.note);
    // Kept for this build only (verify and review read it); never written to the branch or main.
    plan = rec.envelope.plan_markdown;
    writeMarker(ctx, RECONCILED_PLAN, plan);
    // The session was asked not to change code; anything it left anyway is kept on the branch.
    const savedPlan = await saveWork(ctx, wt, `loopstra(${ctx.slug}): reconcile`);
    if (!savedPlan.ok) return block(ctx, savedPlan.note, savedPlan);
  }

  const tested = await testLoop(ctx, "test");
  if (!tested.ok) return block(ctx, tested.note, tested);

  // The verifier. A verify failure gets exactly one fix (then the tests again), then blocks.
  // Round 1's review may judge the same tested commit meanwhile; it is kept only if verify passes,
  // and cancelled as soon as verify does not.
  const verify = () => verifyChange(ctx, a.spec, plan, "verify");
  const [verified, early] = (await reviewsAhead(ctx, wt))
    ? await alongside(ctx, verify, { what: "early review", run: () => reviewAhead(ctx, a.spec, plan), wanted: (v) => v.ok && v.passed })
    : [await verify(), null];
  if (!verified.ok) return block(ctx, verified.note, verified);
  if (verified.passed && early) keepEarlyReview(ctx, early);
  if (!verified.passed) {
    const fix = await buildSession(ctx, {
      name: "fix", traceName: "fix-after-verify", permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir, commands: await checkCommands(ctx, plan),
      vars: { failure_output: `${VERIFY_FAILED}\n${verified.observations}`, test_command: ctx.cfg.commands.test },
    });
    if (!fix.ok) return block(ctx, fix.note);
    const savedFix = await saveWork(ctx, wt, fix.envelope.commit_message || `loopstra(${ctx.slug}): fix`);
    if (!savedFix.ok) return block(ctx, savedFix.note, savedFix);
    const retested = await testLoop(ctx, "retest");
    if (!retested.ok) return block(ctx, retested.note, retested);
    const again = await verifyChange(ctx, a.spec, plan, "verify-2");
    if (!again.ok) return block(ctx, again.note, again);
    if (!again.passed) {
      return block(ctx, VERIFY_STILL_FAILED_NOTE, { detail: { observations: again.observations } });
    }
  }

  const after = await runHookCommands(ctx, "after", "build", ctx.worktreeDir);
  if (!after.ok) return after;
  clearMarker(ctx, REVIEW_ROUND); // a new build gets fresh review rounds
  await setStatus(ctx, "reviewing");
  return { ok: true };
}

/**
 * Whether round 1's review runs alongside the verifier: when the judges may overlap (mayOverlap),
 * unless commands must run between the two (after the build stage, or before the review stage), or
 * the checks rewrote files in the worktree (review start commits them, so the early review would judge
 * another commit and go unused). Only a speed-up: when git cannot say, verify runs alone.
 */
async function reviewsAhead(ctx: StepContext, wt: Git): Promise<boolean> {
  const { stages } = ctx.cfg;
  if (!mayOverlap(ctx) || stages.build.after.length || stages.review.before.length) return false;
  try {
    return !(await wt.isDirty());
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    ctx.trace.event(ctx.slug, "command", { command: "early review", note: `not run: ${errorText(e)}` });
    return false;
  }
}

/** The owner's notes when the checks still fail after every fix allowed (see testLoop): the tests, or a command that kept running past its limit. */
export const TESTS_KEPT_FAILING_NOTE = "The tests kept failing after several attempts to fix them. An engineer needs to look at the change.";
export const CHECKS_KEPT_TIMING_OUT_NOTE = "A project command kept running past its time limit, even after attempts to fix the change. An engineer needs to look at it.";

/**
 * The owner's note when a standard's check still fails after every fix allowed. A check that does
 * not use LOOPSTRA_BASE may be failing on what main already has, so the note says where to look.
 */
function checkKeptFailingNote(check: ToolCheck, fixes: number): string {
  const note = `The change does not pass the automatic check of the standard ${check.title} (${check.path}), even after ${fixes} ${fixes === 1 ? "try" : "tries"} to fix it. The details are in the trace. An engineer can fix it on the branch and retry the change, or close it.`;
  return check.command.includes("LOOPSTRA_BASE") ? note : `${note} If main fails this check too, the problem may not be this change's; see loopstra setup --check.`;
}

/** The owner's note when the verifier still finds the change does not work after its round of fixes. */
export const VERIFY_STILL_FAILED_NOTE = "The finished change still did not work as the spec describes after one round of fixes. An engineer needs to look at it.";

/** What fix is told after a verify failure: the checks passed, so it must not read as a failed check. */
const VERIFY_FAILED = "The checks pass; the verifier found the change does not do what the spec says:";

/** What fix is told about a failed project command: which one (and the standard, for a tool check), and the end of its output. */
function failureOutput(f: CommandResult, check: ToolCheck | null): string {
  const how = f.timedOut ? "ran past its time limit and was stopped" : "failed";
  const whose = check ? ` It is the automatic check of the standard ${check.title} (${check.path}).` : "";
  return `The command \`${f.command}\` ${how}.${whose} The end of its output:\n\n${f.output.slice(-8000)}`;
}

type Verified = { ok: true; passed: boolean; observations: string } | Failure;

/** Runs the verifier (a fresh, read-only session that exercises the change). */
async function verifyChange(ctx: StepContext, spec: string, plan: string, traceName: string): Promise<Verified> {
  const r = await agentPhase(ctx, {
    name: "verify", traceName, permissionMode: "default", tools: "read+commands", cwd: ctx.worktreeDir,
    vars: { spec, plan, run_command: ctx.cfg.commands.run || "none configured", test_result: await testResult(ctx, new Git(ctx.worktreeDir)) },
    skills: ctx.cfg.stages.verify.skills,
  });
  if (!r.ok) return { ok: false, note: `The finished change could not be checked. ${r.note}`, detail: `${traceName} failed: ${r.reason}` };
  return { ok: true, passed: r.envelope.passed, observations: bullets(r.envelope.observations) };
}

/**
 * Test, lint, and build commands in the worktree, then the tool checks `extra` (the merge checks'
 * standards' checks; see toolCheckEnv); on failure, a fix in the build session and again, up to
 * `max_fix_loops` fixes. Phases are `<prefix>-1`, `fix-1`, `<prefix>-2`, ... Used after build, after
 * a verify fix, after a review revision, and after a rebase before merge. Returns a failure for the
 * caller to record, with the tool check that kept failing if it was one; it never blocks by itself.
 */
export async function testLoop(ctx: StepContext, prefix: string, extra: ToolCheck[] = []): Promise<{ ok: true } | (Failure & { check?: ToolCheck })> {
  const max = ctx.cfg.stages.build.max_fix_loops;
  const wt = new Git(ctx.worktreeDir);
  for (let i = 1; ; i++) {
    let failed: Failed;
    try {
      failed = await runChecks(ctx, `${prefix}-${i}`, extra);
    } finally {
      // New files are the commands' output (a coverage folder, a junit xml): every caller commits its
      // work before the loop, and each fix is committed below. Removed, so neither a fix's commit nor a
      // later look for unsaved work (review start, the merge checks) commits them; also when a stop cut
      // the run short.
      await removeNewFiles(ctx, wt);
    }
    if (!failed) {
      // The merge checks need not run them again on the same code (see checkMerge).
      writeMarker(ctx, TESTED, testedMarker(ctx, await wt.headSha(), extra));
      return { ok: true };
    }
    const { result: failure, check } = failed;
    if (i > max) {
      const detail = `${failure.command} still failing after ${max} fix attempts: ${failure.lastLine}`;
      if (check) return { ok: false, note: checkKeptFailingNote(check, max), detail, check };
      return { ok: false, note: failure.timedOut ? CHECKS_KEPT_TIMING_OUT_NOTE : TESTS_KEPT_FAILING_NOTE, detail };
    }
    // The fix may run the checks of the plan's standards, and those that run here.
    const commands = [...new Set([...(await checkCommands(ctx, (await artifacts(ctx)).currentPlan)), ...extra.map((c) => c.command)])];
    const fix = await buildSession(ctx, {
      name: "fix", traceName: `fix-${i}`, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir, commands,
      vars: { failure_output: failureOutput(failure, check), test_command: ctx.cfg.commands.test },
    });
    if (!fix.ok) return { ok: false, note: fix.note, detail: `fix-${i} failed: ${fix.reason}` };
    const saved = await saveWork(ctx, wt, fix.envelope.commit_message || `loopstra(${ctx.slug}): fix`);
    if (!saved.ok) return saved;
  }
}

/**
 * Removes the new files in the worktree after the checks ran (see testLoop), best effort. Windows
 * can hold a brief open handle on a file a command just wrote (as worktreeRemove sees), so a
 * failure is tried once more after a short wait; one that lasts is traced, since the next fix's
 * commit may then include the commands' output files.
 */
async function removeNewFiles(ctx: StepContext, wt: Git): Promise<void> {
  const clean = () => wt.run(["clean", "-f", "-d", "-q"], { allowFail: true, cleanup: true });
  let r = await clean();
  if (r.code !== 0) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    r = await clean();
  }
  if (r.code !== 0) ctx.trace.event(ctx.slug, "error", { where: "clean", error: (r.err || r.out || `exit ${r.code}`).trim(), note: "new files the commands wrote were not removed; the next fix's commit may include them" });
}

/** The first command of a run that failed, and the tool check it is, if one; null when all passed. */
type Failed = { result: CommandResult; check: ToolCheck | null } | null;

/**
 * Runs test, lint, build in the worktree, then, once they all passed, the tool checks `extra` with
 * their environment (see toolCheckEnv): in order, stopping at the first failure, or with
 * `speed.parallel_checks` each of the two groups all at once. Returns the first failure in that
 * order, or null when all pass. The phase is recorded as failed when a command fails.
 */
async function runChecks(ctx: StepContext, phaseName: string, extra: ToolCheck[]): Promise<Failed> {
  const configured = [ctx.cfg.commands.test, ctx.cfg.commands.lint, ctx.cfg.commands.build].filter((c): c is string => !!c);
  let failed = null as Failed;
  const r = await codePhase(ctx, phaseName, async (seq) => {
    // Read each run: the base moves when the branch is brought up to date with main.
    const env = extra.length ? await toolCheckEnv(ctx, new Git(ctx.worktreeDir)) : undefined;
    type Cmd = { command: string; check: ToolCheck | null };
    const groups: Cmd[][] = [configured.map((command) => ({ command, check: null })), extra.map((check) => ({ command: check.command, check }))];
    const cmds = groups.flat();
    const run = (c: Cmd, signal?: AbortSignal) => projectCommand(ctx, c.command, ctx.worktreeDir, { seq, signal, ...(c.check ? { env } : {}) });
    const results: CommandResult[] = [];
    // A group's results go to `results` in order, ending at its first failure.
    const runGroup = async (group: Cmd[]): Promise<void> => {
      if (!ctx.cfg.speed.parallel_checks) {
        for (const c of group) {
          const res = await run(c);
          results.push(res);
          if (res.code !== 0) return;
        }
        return;
      }
      // All at once, read in order: once one fails (or throws), every one before it has ended, so it
      // is the failure to report, and those still running are cancelled.
      const cancel = new AbortController();
      const runs = group.map((c) => run(c, cancel.signal));
      for (const pending of runs) pending.catch(() => {}); // each is read below; one may reject before it is reached
      let thrown: { error: unknown } | null = null;
      for (const pending of runs) {
        try {
          const res = await pending;
          results.push(res);
          if (res.code !== 0) break;
        } catch (error) {
          thrown = { error };
          break;
        }
      }
      cancel.abort();
      // Wait for the rest, so none is still running when the phase ends. A stop request that reached
      // any of them wins over the error read first, so the phase is interrupted, not failed.
      const settled = await Promise.allSettled(runs);
      const stop = settled.find((s) => s.status === "rejected" && s.reason instanceof StopRequested);
      if (stop) throw (stop as PromiseRejectedResult).reason;
      if (thrown) throw thrown.error;
    };
    // The standards' checks run only on code whose tests pass, as the spec has it, in parallel too.
    for (const group of groups) {
      await runGroup(group);
      if (results.some((x) => x.code !== 0)) break;
    }
    const at = results.findIndex((x) => x.code !== 0);
    if (at >= 0) {
      const res = results[at]!;
      failed = { result: res, check: cmds[at]!.check };
      throw new Error(`${res.command} exited ${res.code}: ${res.lastLine}`);
    }
    return { ok: true as const };
  });
  if (r.ok) return null;
  return failed ?? { result: { command: "checks", code: 1, output: r.detail, lastLine: r.detail, durationMs: 0, timedOut: false }, check: null };
}
