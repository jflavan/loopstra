import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffWithinPlan, parsePlanFiles } from "../checks";
import { block, blockWith, blockWithDetail, clearMarker, saveSession, setStatus, type Failure, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase, codePhase } from "../phases";
import { commandTimeoutMs, runCommand, type CommandResult } from "../shell";
import { artifacts, bullets, buildSession, MERGING, REVIEW_ROUND, runHookCommands, saveWork } from "./shared";

const RETRY = "To try again, set status to plan-approved.";

/** Stage 3 build half plus Stage 4. Called for plan-approved and building. Ends at reviewing or blocked. */
export async function runBuildStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "building") await setStatus(ctx, "building");
  clearMarker(ctx, MERGING); // a new build is never an earlier merge in progress

  const branch = await codePhase(ctx, "branch", async () => {
    if (!(await ctx.git.branchExists(ctx.branch))) await ctx.git.createBranch(ctx.branch, ctx.cfg.main_branch);
    // Never trust a leftover directory: a plain folder here would send commits to the main checkout.
    await ctx.git.ensureWorktree(ctx.worktreeDir, ctx.branch);
    if (ctx.cfg.commands.install) {
      const r = await runCommand(ctx.cfg.commands.install, ctx.worktreeDir, { env: { LOOPSTRA_SLUG: ctx.slug }, timeoutMs: commandTimeoutMs(ctx.cfg) });
      ctx.trace.event(ctx.slug, "command", { command: ctx.cfg.commands.install, code: r.code, lastLine: r.lastLine });
      if (r.code !== 0) throw new Error(`install failed: ${r.lastLine}`);
    }
    return { ok: true as const };
  });
  if (!branch.ok) return blockWithDetail(ctx, "The workspace for building this change could not be prepared. An engineer needs to look at it.", branch.note);

  const before = await runHookCommands(ctx, "before", "build", ctx.worktreeDir);
  if (!before.ok) return before;

  const wt = new Git(ctx.worktreeDir);
  const a = await artifacts(ctx);
  const stage = ctx.cfg.stages.build;

  const build = await agentPhase(ctx, {
    name: "build", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
    vars: { plan: a.plan, spec: a.spec, test_command: ctx.cfg.commands.test }, skills: stage.skills,
  });
  if (!build.ok) return block(ctx, `${build.note} ${RETRY}`);
  // The build session is what fix, reconcile, and revise resume.
  if (build.sessionId) saveSession(ctx, "build", build.sessionId);
  const saved = await saveWork(ctx, wt, build.envelope.commit_message || `loopstra(${ctx.slug}): build`);
  if (!saved.ok) return blockWith(ctx, saved);

  // Plan drift: files changed that the plan did not list. The branch's own plan is the reference
  // (a retry after a reconcile must not reconcile again).
  let plan = branchPlan(ctx) ?? a.plan;
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
  if (!drift.ok) return blockWithDetail(ctx, "The change could not be compared with its plan. An engineer needs to look at it.", drift.note);
  if (drift.extra.length) {
    const rec = await buildSession(ctx, {
      name: "reconcile", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { plan, findings: bullets(drift.extra) },
    });
    if (!rec.ok) return block(ctx, `${rec.note} ${RETRY}`);
    plan = rec.envelope.plan_markdown;
    await Bun.write(branchPlanPath(ctx), plan);
    const savedPlan = await saveWork(ctx, wt, `loopstra(${ctx.slug}): reconcile plan with implementation`);
    if (!savedPlan.ok) return blockWith(ctx, savedPlan);
  }

  const tested = await testLoop(ctx, "test");
  if (!tested.ok) return blockWith(ctx, tested);

  // The verifier. A verify failure gets exactly one fix (then the tests again), then blocks.
  const verified = await verifyChange(ctx, a.spec, plan, "verify");
  if (!verified.ok) return blockWith(ctx, verified);
  if (!verified.passed) {
    const fix = await buildSession(ctx, {
      name: "fix", traceName: "fix-after-verify", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { failure_output: "", observations: verified.observations, test_command: ctx.cfg.commands.test },
    });
    if (!fix.ok) return block(ctx, `${fix.note} ${RETRY}`);
    const savedFix = await saveWork(ctx, wt, fix.envelope.commit_message || `loopstra(${ctx.slug}): fix`);
    if (!savedFix.ok) return blockWith(ctx, savedFix);
    const retested = await testLoop(ctx, "retest");
    if (!retested.ok) return blockWith(ctx, retested);
    const again = await verifyChange(ctx, a.spec, plan, "verify-2");
    if (!again.ok) return blockWith(ctx, again);
    if (!again.passed) {
      return blockWithDetail(ctx, `The finished change still did not work as the spec describes after one round of fixes. An engineer needs to look at it. ${RETRY}`, { observations: again.observations });
    }
  }

  const after = await runHookCommands(ctx, "after", "build", ctx.worktreeDir);
  if (!after.ok) return after;
  clearMarker(ctx, REVIEW_ROUND); // a new build gets fresh review rounds
  await setStatus(ctx, "reviewing");
  return { ok: true };
}

function branchPlanPath(ctx: StepContext): string {
  return join(ctx.worktreeDir, "intent", ctx.slug, "plan.md");
}

/** The plan as the intent branch has it (reconciled on an earlier run), or null when the branch has none. */
export function branchPlan(ctx: StepContext): string | null {
  const p = branchPlanPath(ctx);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

type Verified = { ok: true; passed: boolean; observations: string } | Failure;

/** Runs the verifier (a fresh, read-only session that exercises the change). */
async function verifyChange(ctx: StepContext, spec: string, plan: string, traceName: string): Promise<Verified> {
  const r = await agentPhase(ctx, {
    name: "verify", traceName, model: ctx.cfg.stages.verify.model, permissionMode: "default", tools: "read+commands", cwd: ctx.worktreeDir,
    vars: { spec, plan, run_command: ctx.cfg.commands.run || "none configured" }, skills: ctx.cfg.stages.verify.skills,
  });
  if (!r.ok) return { ok: false, note: `The finished change could not be checked. ${r.note} ${RETRY}`, detail: `${traceName} failed: ${r.reason}` };
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
    const failure = await runChecks(ctx, `${prefix}-${i}`);
    if (!failure) return { ok: true };
    if (i > max) {
      const note = failure.timedOut
        ? "A project command kept running past its time limit, even after attempts to fix the change. An engineer needs to look at it."
        : "The tests kept failing after several attempts to fix them. An engineer needs to look at the change.";
      return { ok: false, note, detail: `${failure.command} still failing after ${max} fix attempts: ${failure.lastLine}` };
    }
    const fix = await buildSession(ctx, {
      name: "fix", traceName: `fix-${i}`, model: ctx.cfg.stages.build.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { failure_output: failure.output.slice(-8000), test_command: ctx.cfg.commands.test },
    });
    if (!fix.ok) return { ok: false, note: `${fix.note} ${RETRY}`, detail: `fix-${i} failed: ${fix.reason}` };
    const saved = await saveWork(ctx, wt, fix.envelope.commit_message || `loopstra(${ctx.slug}): fix`);
    if (!saved.ok) return saved;
  }
}

/**
 * Runs test, lint, build in order in the worktree. Returns the first failure, or null when all
 * pass. The phase is recorded as failed when a command fails.
 */
export async function runChecks(ctx: StepContext, phaseName: string): Promise<CommandResult | null> {
  const seq = ctx.trace.phaseStart(ctx.slug, phaseName, "code");
  try {
    const cmds = [ctx.cfg.commands.test, ctx.cfg.commands.lint, ctx.cfg.commands.build].filter((c): c is string => !!c);
    for (const cmd of cmds) {
      const res = await runCommand(cmd, ctx.worktreeDir, { env: { LOOPSTRA_SLUG: ctx.slug }, timeoutMs: commandTimeoutMs(ctx.cfg) });
      ctx.trace.event(ctx.slug, "command", { command: cmd, code: res.code, lastLine: res.lastLine, durationMs: res.durationMs }, seq);
      if (res.code !== 0) {
        ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: `${cmd} exited ${res.code}: ${res.lastLine}` });
        return res;
      }
    }
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success" });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: msg });
    return { command: "checks", code: 1, output: msg, lastLine: msg.split("\n")[0] ?? "", durationMs: 0, timedOut: false };
  }
}
