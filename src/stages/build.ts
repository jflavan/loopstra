import { join } from "node:path";
import { diffWithinPlan, parsePlanFiles } from "../checks";
import { block, clearSession, loadSessions, saveSession, setStatus, type StepContext, type StepResult } from "../context";
import { Git } from "../git";
import { agentPhase, codePhase } from "../phases";
import { commandTimeoutMs, runCommand, type CommandResult } from "../shell";
import { artifacts, runHookCommands } from "./shared";

/** Stage 3 build half plus Stage 4. Called for plan-approved and building. Ends at reviewing or blocked. */
export async function runBuildStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status !== "building") await setStatus(ctx, "building");

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
  if (!branch.ok) return block(ctx, `Could not prepare the branch for building. ${branch.note}`);

  const before = await runHookCommands(ctx, "before", "build", ctx.worktreeDir);
  if (!before.ok) return before;

  const wt = new Git(ctx.worktreeDir);
  const a = await artifacts(ctx);
  const stage = ctx.cfg.stages.build;

  const build = await agentPhase(ctx, {
    name: "build", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
    vars: { plan: a.plan, spec: a.spec, test_command: ctx.cfg.commands.test }, skills: stage.skills,
  });
  if (!build.ok) return block(ctx, build.note);
  if (build.sessionId) saveSession(ctx, "build", build.sessionId);
  const saved = await commitWork(ctx, wt, build.envelope.commit_message || `loopstra(${ctx.slug}): build`);
  if (!saved.ok) return saved;

  // Plan drift: files changed that the plan did not list.
  const drift = await codePhase(ctx, "drift", async () => {
    const changed = await wt.changedFilesSince(ctx.cfg.main_branch);
    const planned = parsePlanFiles(a.plan);
    if (planned === null) {
      // No file list to compare against: say so in the trace rather than flag every file.
      ctx.trace.event(ctx.slug, "command", { command: "drift", changed, note: "the plan has no Files that change section; drift not checked" });
      return { ok: true as const, extra: [] as string[] };
    }
    const extra = diffWithinPlan(changed, planned, ctx.slug);
    ctx.trace.event(ctx.slug, "command", { command: "drift", changed, extra });
    return { ok: true as const, extra };
  });
  if (!drift.ok) return block(ctx, drift.note);
  if (drift.extra.length) {
    const rec = await agentPhase(ctx, {
      name: "reconcile", model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      resume: loadSessions(ctx).build, vars: { plan: a.plan, findings: drift.extra.map((f) => `- ${f}`).join("\n") },
    });
    if (!rec.ok) return block(ctx, rec.note);
    await Bun.write(join(ctx.worktreeDir, "intent", ctx.slug, "plan.md"), rec.envelope.plan_markdown);
    const savedPlan = await commitWork(ctx, wt, `loopstra(${ctx.slug}): reconcile plan with implementation`);
    if (!savedPlan.ok) return savedPlan;
  }

  // Test loop.
  let failure: CommandResult | null = null;
  let observations = "";
  for (let i = 1; i <= stage.max_fix_loops + 1; i++) {
    failure = await runChecks(ctx, `test-${i}`);
    if (!failure && i > 1 && observations) observations = "";
    if (!failure) {
      const verify = await agentPhase(ctx, {
        name: "verify", model: ctx.cfg.stages.verify.model, permissionMode: "default", tools: "read+commands", cwd: ctx.worktreeDir,
        vars: { spec: a.spec, plan: a.plan, run_command: ctx.cfg.commands.run || "none configured" }, skills: ctx.cfg.stages.verify.skills,
      });
      if (!verify.ok) return block(ctx, verify.note);
      if (verify.envelope.passed) break;
      observations = verify.envelope.observations.map((o) => `- ${o}`).join("\n");
      failure = { command: "verify", code: 1, output: observations, lastLine: "verifier found problems", durationMs: 0, timedOut: false };
    }
    if (i > stage.max_fix_loops) {
      return block(ctx, `The tests kept failing after ${stage.max_fix_loops} fix attempt${stage.max_fix_loops === 1 ? "" : "s"}. Last failure: ${failure.lastLine}. An engineer should look at branch ${ctx.branch}.`);
    }
    const fix = await agentPhase(ctx, {
      name: "fix", traceName: `fix-${i}`, model: stage.model, permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      resume: loadSessions(ctx).build, env: { LOOPSTRA_PHASE: "fix" },
      vars: { failure_output: failure.output.slice(-8000), observations, test_command: ctx.cfg.commands.test },
    });
    if (!fix.ok) {
      // A dead session: the next attempt starts fresh.
      if ((fix.reason === "no-session" || fix.reason === "crash") && loadSessions(ctx).build) clearSession(ctx, "build");
      return block(ctx, fix.note);
    }
    if (fix.sessionId) saveSession(ctx, "build", fix.sessionId);
    const savedFix = await commitWork(ctx, wt, fix.envelope.commit_message || `loopstra(${ctx.slug}): fix`);
    if (!savedFix.ok) return savedFix;
  }

  await setStatus(ctx, "reviewing");
  return { ok: true };
}

/** Commits the worktree only after confirming it is on the intent branch; anything else blocks. */
async function commitWork(ctx: StepContext, wt: Git, message: string): Promise<StepResult> {
  try {
    await wt.assertBranch(ctx.branch);
    await wt.commitAll(message);
    return { ok: true };
  } catch (e) {
    ctx.trace.event(ctx.slug, "error", { where: "commit", error: e instanceof Error ? e.message : String(e) });
    return block(ctx, "The work could not be saved to this change's own branch. An engineer needs to look at it.");
  }
}

/** Runs test, lint, build in order in the worktree. Returns the first failure, or null when all pass. */
export async function runChecks(ctx: StepContext, phaseName: string): Promise<CommandResult | null> {
  const r = await codePhase(ctx, phaseName, async () => {
    const cmds = [ctx.cfg.commands.test, ctx.cfg.commands.lint, ctx.cfg.commands.build].filter((c): c is string => !!c);
    for (const cmd of cmds) {
      const res = await runCommand(cmd, ctx.worktreeDir, { env: { LOOPSTRA_SLUG: ctx.slug }, timeoutMs: commandTimeoutMs(ctx.cfg) });
      ctx.trace.event(ctx.slug, "command", { command: cmd, code: res.code, lastLine: res.lastLine, durationMs: res.durationMs });
      if (res.code !== 0) return { ok: true as const, failure: res };
    }
    return { ok: true as const, failure: null };
  });
  if (!r.ok) return { command: "checks", code: 1, output: r.note, lastLine: r.note, durationMs: 0, timedOut: false };
  return r.failure;
}
