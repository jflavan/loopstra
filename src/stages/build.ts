import { diffWithinPlan, parsePlanFiles } from "../checks";
import { block, clearMarker, readMarker, saveSession, SENT_BACK, setStatus, writeMarker, type Failure, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase, alongside, codePhase, mayOverlap, projectCommand, withNote, type AgentPhaseSpec } from "../phases";
import { EARLY_REVIEW, keepEarlyReview, reviewAhead } from "./early-review";
import { errorText, type CommandResult } from "../shell";
import { StopRequested } from "../stop";
import { artifacts, bullets, buildSession, MERGING, PR_LEASE, PR_NUMBER, PR_PUSHING, RECONCILED_PLAN, REMOTE_AHEAD, REVIEW_ROUND, runHookCommands, saveWork, TESTED, testedMarker, testResult } from "./shared";

/** Stage 3 build half plus Stage 4. Called for plan-approved and building. Ends at reviewing or blocked. */
export async function runBuildStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "building") await setStatus(ctx, "building");
  clearMarker(ctx, MERGING); // a new build is never an earlier merge in progress
  clearMarker(ctx, RECONCILED_PLAN); // nor is it compared with a plan reconciled for an earlier build
  clearMarker(ctx, EARLY_REVIEW); // nor reviewed by a review of an earlier build
  clearMarker(ctx, REMOTE_AHEAD); // nor waiting like an earlier build's pull request
  clearMarker(ctx, PR_LEASE); // nor tied to what was pushed for it (a person may have deleted that branch on GitHub)
  clearMarker(ctx, PR_PUSHING); // nor an earlier build's push that was cut short
  writeMarker(ctx, PR_NUMBER, ""); // nor an earlier build's pull request, closed or merged (see ownPr)

  const branch = await codePhase(ctx, "branch", async () => {
    // Branches and worktrees take no lock (see Git.run): another change's commits and checkouts go on meanwhile.
    if (!(await ctx.git.branchExists(ctx.branch))) await ctx.git.createBranch(ctx.branch, ctx.cfg.main_branch);
    // Never trust a leftover directory: a plain folder here would send commits to the main checkout.
    await ctx.git.ensureWorktree(ctx.worktreeDir, ctx.branch);
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

  const feedback = readMarker(ctx, SENT_BACK)?.trim() ?? "";
  const phase: AgentPhaseSpec & { name: "build" } = {
    name: "build", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
    vars: { plan: a.plan, spec: a.spec, test_command: ctx.cfg.commands.test, feedback }, skills: stage.skills,
  };
  // The note reaches the session even through an older build.md without {{feedback}}.
  const build = await agentPhase(ctx, phase, () => withNote(ctx, phase, "feedback", feedback, `A person's notes on an earlier build of this change; address each one:\n\n${feedback}`));
  if (!build.ok) return block(ctx, build.note);
  // The build session is what fix, reconcile, and revise resume.
  if (build.sessionId) saveSession(ctx, "build", build.sessionId);
  const saved = await saveWork(ctx, wt, build.envelope.commit_message || `loopstra(${ctx.slug}): build`);
  if (!saved.ok) return block(ctx, saved.note, saved);
  // Used: the build it asked to change is saved.
  clearMarker(ctx, SENT_BACK);

  // Plan drift: files changed that main's plan did not list.
  let plan = a.plan;
  const drift = await codePhase(ctx, "drift", async () => {
    const changed = await wt.changedFilesSince(ctx.cfg.main_branch);
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
      name: "reconcile", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
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
      name: "fix", traceName: "fix-after-verify", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
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
      return block(ctx, `The finished change still did not work as the spec describes after one round of fixes. An engineer needs to look at it.`, { detail: { observations: again.observations } });
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

/** What fix is told after a verify failure: the checks passed, so it must not read as a failed check. */
export const VERIFY_FAILED = "The checks pass; the verifier found the change does not do what the spec says:";

/** What fix is told about a failed project command: which one, and the end of its output. */
function failureOutput(f: CommandResult): string {
  const how = f.timedOut ? "ran past its time limit and was stopped" : "failed";
  return `The command \`${f.command}\` ${how}. The end of its output:\n\n${f.output.slice(-8000)}`;
}

type Verified = { ok: true; passed: boolean; observations: string } | Failure;

/** Runs the verifier (a fresh, read-only session that exercises the change). */
async function verifyChange(ctx: StepContext, spec: string, plan: string, traceName: string): Promise<Verified> {
  const r = await agentPhase(ctx, {
    name: "verify", traceName, model: ctx.cfg.stages.verify.model, permissionMode: "default", tools: "read+commands", cwd: ctx.worktreeDir,
    vars: { spec, plan, run_command: ctx.cfg.commands.run || "none configured", test_result: await testResult(ctx, new Git(ctx.worktreeDir)) },
    skills: ctx.cfg.stages.verify.skills,
  });
  if (!r.ok) return { ok: false, note: `The finished change could not be checked. ${r.note}`, detail: `${traceName} failed: ${r.reason}` };
  return { ok: true, passed: r.envelope.passed, observations: bullets(r.envelope.observations) };
}

/**
 * Test, lint, and build commands in the worktree; on failure, a fix in the build session and
 * again, up to `max_fix_loops` fixes. Phases are `<prefix>-1`, `fix-1`, `<prefix>-2`, ... Used after
 * build, after a verify fix, after a review revision, and after a rebase before merge.
 * Returns a failure for the caller to record; it never blocks by itself.
 */
export async function testLoop(ctx: StepContext, prefix: string): Promise<{ ok: true } | Failure> {
  const max = ctx.cfg.stages.build.max_fix_loops;
  const wt = new Git(ctx.worktreeDir);
  for (let i = 1; ; i++) {
    let failure: CommandResult | null;
    try {
      failure = await runChecks(ctx, `${prefix}-${i}`);
    } finally {
      // New files are the commands' output (a coverage folder, a junit xml): every caller commits its
      // work before the loop, and each fix is committed below. Removed, so neither a fix's commit nor a
      // later look for unsaved work (review start, the merge checks) commits them; also when a stop cut
      // the run short.
      await removeNewFiles(ctx, wt);
    }
    if (!failure) {
      // The merge checks need not run them again on the same code (see checkMerge).
      writeMarker(ctx, TESTED, testedMarker(ctx, await wt.headSha()));
      return { ok: true };
    }
    if (i > max) {
      const note = failure.timedOut
        ? "A project command kept running past its time limit, even after attempts to fix the change. An engineer needs to look at it."
        : "The tests kept failing after several attempts to fix them. An engineer needs to look at the change.";
      return { ok: false, note, detail: `${failure.command} still failing after ${max} fix attempts: ${failure.lastLine}` };
    }
    const fix = await buildSession(ctx, {
      name: "fix", traceName: `fix-${i}`, model: ctx.cfg.stages.build.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { failure_output: failureOutput(failure), test_command: ctx.cfg.commands.test },
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

/**
 * Runs test, lint, build in the worktree: in order, stopping at the first failure, or with
 * `speed.parallel_checks` all at once. Returns the first failure in that order, or null when all
 * pass. The phase is recorded as failed when a command fails.
 */
export async function runChecks(ctx: StepContext, phaseName: string): Promise<CommandResult | null> {
  const cmds = [ctx.cfg.commands.test, ctx.cfg.commands.lint, ctx.cfg.commands.build].filter((c): c is string => !!c);
  let failed = null as CommandResult | null;
  const r = await codePhase(ctx, phaseName, async (seq) => {
    const results: CommandResult[] = [];
    if (ctx.cfg.speed.parallel_checks) {
      // All at once, read in order: once one fails (or throws), every one before it has ended, so it
      // is the failure to report, and those still running are cancelled.
      const cancel = new AbortController();
      const runs = cmds.map((cmd) => projectCommand(ctx, cmd, ctx.worktreeDir, { seq, signal: cancel.signal }));
      for (const run of runs) run.catch(() => {}); // each is read below; one may reject before it is reached
      let thrown: { error: unknown } | null = null;
      for (const run of runs) {
        try {
          const res = await run;
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
    } else {
      for (const cmd of cmds) {
        const res = await projectCommand(ctx, cmd, ctx.worktreeDir, { seq });
        results.push(res);
        if (res.code !== 0) break;
      }
    }
    const res = results.find((x) => x.code !== 0);
    if (res) {
      failed = res;
      throw new Error(`${res.command} exited ${res.code}: ${res.lastLine}`);
    }
    return { ok: true as const };
  });
  if (r.ok) return null;
  return failed ?? { command: "checks", code: 1, output: r.detail, lastLine: r.detail, durationMs: 0, timedOut: false };
}
