import { existsSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CLAUDE_ENV } from "./claude";
import { loadConfig, type Config } from "./config";
import { MainCheckoutMoved, OFF_MAIN_NOTE, PersonChangedStatus, StepContext, block, personChangedStatus, type StepResult } from "./context";
import { Git, GIT_TIMEOUT_NOTE, GitTimeout } from "./git";
import { GitHub } from "./github";
import { heartbeatWorkingOn, startHeartbeat } from "./heartbeat";
import { syncMain } from "./remote";
import { checkConsistency, effectivePriority, isRunnable, orderQueue, renderQueue, scanRepo, type Intent } from "./intents";
import { mainHealthDue, runMainHealth } from "./signals";
import { runBuildStep } from "./stages/build";
import { runDesignStep } from "./stages/design";
import { cleanupChange, runMergeStep } from "./stages/merge";
import { runPlanStep } from "./stages/plan";
import { runReviewStep } from "./stages/review";
import { runVerifyStep } from "./stages/verify";
import { installStopSignals, resetStop, stopPromise, stopRequested, StopRequested } from "./stop";
import { Trace } from "./trace";

export interface TickResult {
  picked: string | null; result?: StepResult; signal?: string;
  /** The config could not be loaded (plain words); nothing ran. */
  error?: string;
  /** Set when the tick did nothing because the repository needs a person first (plain words). */
  paused?: string;
  /** A stop was requested during the tick; the step was interrupted, not blocked. */
  stopped?: boolean;
  /** The tick itself hit an unexpected problem; the detail is in the trace. */
  crashed?: string;
}

/** Statuses after a merge: the change's worktree and branch are no longer needed. */
const MERGED_STATUSES = new Set(["merged", "verifying", "done"]);

export async function tick(root: string): Promise<TickResult> {
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch (e) { return { picked: null, error: (e as Error).message }; }
  const trace = Trace.open(root);
  const out: TickResult = { picked: null };
  try {
    trace.event("_loop", "tick", {});

    // Every artifact commit goes to main_branch. If the checkout is elsewhere, do nothing at all:
    // no signals, no queue, no steps (each would write into someone else's branch).
    const branch = await new Git(root).run(["rev-parse", "--abbrev-ref", "HEAD"], true);
    if (branch.code !== 0 || branch.out.trim() !== cfg.main_branch) {
      trace.event("_loop", "error", { where: "tick", expected: cfg.main_branch, actual: branch.out.trim() || branch.err.trim() });
      out.paused = OFF_MAIN_NOTE;
      return out;
    }

    // With a remote: pull what others pushed (an owner's status edits, merges on GitHub), and share
    // Loopstra's own records when only its commits are ahead. Best effort; never stops the tick.
    const hasRemote = (await new Git(root).remoteName()) !== null;
    if (hasRemote) await syncMain(root, cfg, trace);

    // Signals: after a merge, or on the interval. Both are read from disk and the trace.
    const health = mainHealthDue(root, cfg, trace);
    if (health.due) out.signal = await runMainHealth(root, cfg, trace, health.afterSlug);

    // Scan, check, render queue.
    const first = await scanRepo(root);
    for (const u of first.unreadable) {
      // Traced when the problem is new or has changed, not on every tick.
      const last = trace.lastEvent(u.slug, "error", '"where":"scan"');
      const lastProblem = last ? (JSON.parse(last.payload) as { problem?: string }).problem : undefined;
      if (lastProblem !== u.problem) trace.event(u.slug, "error", { where: "scan", problem: u.problem, detail: u.detail });
    }
    for (const i of first.intents) {
      trace.upsertIntent(i.slug, i.file.frontmatter.status, effectivePriority(i.file.frontmatter));
      const problem = checkConsistency(i);
      if (problem && i.file.frontmatter.status !== "blocked") await blockSafely(new StepContext(root, cfg, trace, i), problem);
    }
    const scan = await scanRepo(root);
    const ordered = orderQueue(scan.intents);
    await writeQueue(root, trace, renderQueue(ordered, scan.unreadable));
    await cleanupLeftovers(root, cfg, trace, ordered);

    // Pick and run one step. A step that only looked and found nothing to do yet (a pull request
    // still waiting on GitHub) does not hold up the next change: it runs in the same tick.
    const human = { spec: cfg.gates.spec.human, plan: cfg.gates.plan.human, merge: cfg.gates.merge.human, done: cfg.gates.done.human };
    for (const next of ordered.filter((i) => isRunnable(i, human, hasRemote))) {
      out.picked = next.slug;
      heartbeatWorkingOn(root, next.slug);
      out.result = await runStepGuarded(new StepContext(root, cfg, trace, next));
      if (!(out.result.ok && out.result.waiting)) break;
    }
    return out;
  } catch (e) {
    if (e instanceof StopRequested) {
      // Not the intent's fault: it keeps its in-progress status and the step resumes on the next start.
      trace.event(out.picked ?? "_loop", "stop", { note: "stopped by request; the step resumes on the next start" });
      out.stopped = true;
      return out;
    }
    trace.event("_loop", "error", { where: "tick", error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
    out.crashed = errorText(e).split("\n")[0] ?? "";
    return out;
  } finally {
    trace.close();
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs one step for an intent. A problem the step did not handle itself blocks the intent with a
 * plain note (the detail goes to the trace); only a stop request passes through.
 */
export async function runStepGuarded(ctx: StepContext): Promise<StepResult> {
  try {
    return await runStep(ctx);
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    if (e instanceof PersonChangedStatus) return personChangedStatus(ctx, e);
    ctx.trace.event(ctx.slug, "error", { where: "step", error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
    return blockSafely(ctx, e instanceof MainCheckoutMoved ? e.message : unexpectedNote(e));
  }
}

function unexpectedNote(e: unknown): string {
  if (e instanceof GitTimeout) return GIT_TIMEOUT_NOTE;
  return "Something unexpected went wrong in this step. An engineer can find the details in the trace.";
}

/** Blocks with a note; if even that fails (for example a commit is refused), traces it instead of throwing. */
async function blockSafely(ctx: StepContext, note: string): Promise<StepResult> {
  try {
    return await block(ctx, note);
  } catch (e) {
    if (e instanceof PersonChangedStatus) return personChangedStatus(ctx, e);
    ctx.trace.event(ctx.slug, "error", { where: "block", note, error: errorText(e) });
    return { ok: false, note };
  }
}

async function writeQueue(root: string, trace: Trace, text: string): Promise<void> {
  try {
    await Bun.write(join(root, "intent", "queue.md"), text);
    await new Git(root).commitPaths(["intent/queue.md"], "loopstra: update queue");
  } catch (e) {
    trace.event("_loop", "error", { where: "queue", error: errorText(e) });
  }
}

/**
 * A merged change's worktree and branch are removed right after the merge; if that failed, try
 * again here. Best effort and traced; never blocks anything.
 */
async function cleanupLeftovers(root: string, cfg: Config, trace: Trace, intents: Intent[]): Promise<void> {
  const merged = intents.filter((i) => MERGED_STATUSES.has(i.file.frontmatter.status));
  if (!merged.length) return;
  const refs = await new Git(root).run(["for-each-ref", "--format=%(refname:short)", "refs/heads/intent/"], true);
  const branches = new Set(refs.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  for (const i of merged) {
    const ctx = new StepContext(root, cfg, trace, i);
    if (!existsSync(ctx.worktreeDir) && !branches.has(ctx.branch)) continue;
    // Only a cleanup that finished is traced here; cleanupChange traces its own problems (and a
    // branch it keeps, once), so a change waiting for a person does not add a line every tick.
    if (await cleanupChange(ctx)) trace.event(ctx.slug, "command", { command: "clean up after merge (retry)", clean: true });
  }
}

async function runStep(ctx: StepContext): Promise<StepResult> {
  switch (ctx.intent.file.frontmatter.status) {
    case "accepted": case "designing": case "spec-review": return runDesignStep(ctx);
    case "spec-approved": case "planning": case "plan-review": return runPlanStep(ctx);
    case "plan-approved": case "building": return runBuildStep(ctx);
    case "reviewing": return runReviewStep(ctx);
    case "merge-review": case "merge-approved": return runMergeStep(ctx);
    case "merged": case "verifying": return runVerifyStep(ctx);
    default: return { ok: true };
  }
}

/** A plain message naming a tool `start` needs that is not installed, or null when both are there. */
export function missingTools(env: Record<string, string | undefined> = process.env): string | null {
  const PATH = env.PATH ?? env.Path ?? "";
  if (!Bun.which("git", { PATH })) return "git was not found. Install Git, then start Loopstra again.";
  if (!env[FAKE_CLAUDE_ENV] && !Bun.which("claude", { PATH })) return "claude was not found. Install Claude Code, then start Loopstra again.";
  return null;
}

/**
 * What `start` checks before the loop begins, as a plain message, or null when it may start: the
 * tools are installed, the checkout is on main_branch, and a repository with a remote has gh.
 * A config that cannot be loaded is left to the loop, which reports it and retries.
 */
export async function preflight(root: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const missing = missingTools(env);
  if (missing) return missing;
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch { return null; }
  const git = new Git(root);
  const branch = (await git.run(["rev-parse", "--abbrev-ref", "HEAD"], true)).out.trim();
  if (branch !== cfg.main_branch) return `Run loopstra from a checkout of ${cfg.main_branch}; you are on ${branch || "no branch"}.`;
  if (await git.remoteName()) {
    const gh = new GitHub(root);
    if (!(await gh.available())) return "This repo has a remote but gh was not found. Install GitHub CLI or remove the remote.";
    if (!(await gh.signedIn())) return "GitHub CLI is installed but not signed in. Run gh auth login, then start again.";
  }
  return null;
}

/** Waits up to `ms`, or until a stop is requested. Leaves no timer behind. */
async function sleepUnlessStopped(ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), stopPromise()]);
  } finally {
    clearTimeout(timer);
  }
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

/**
 * The loop. It never dies: each tick is guarded, a problem is traced, and the next tick comes.
 * Ctrl-C asks for a stop (the running step is interrupted and resumes on the next start); a
 * second Ctrl-C exits at once.
 */
export async function start(root: string, opts: { once: boolean; installSignals?: boolean }): Promise<void> {
  resetStop();
  const uninstall = opts.installSignals === false ? () => {} : installStopSignals();
  const beat = startHeartbeat(root);
  try {
    for (;;) {
      try {
        beat.tickStarted();
        const r = await tick(root);
        if (r.error) console.error(`Config problem, will retry next tick:\n${r.error}`);
        else if (r.paused) log(`paused: ${r.paused}`);
        else if (r.stopped) log(`stopped${r.picked ? ` during ${r.picked}; it resumes on the next start` : ""}`);
        else if (r.crashed) log(`the loop hit an unexpected problem and will try again: ${r.crashed}`);
        else if (r.picked) log(`${r.picked}: ${r.result?.ok ? (r.result.waiting ? "waiting for GitHub" : r.result.personChanged ? "a person changed the status; it is picked up next" : "step done") : r.result?.note}`);
        else log("idle");
      } catch (e) {
        log(`the loop hit an unexpected problem and will try again: ${errorText(e).split("\n")[0]}`);
        try {
          const trace = Trace.open(root);
          try { trace.event("_loop", "error", { where: "start", error: errorText(e), stack: e instanceof Error ? e.stack : undefined }); } finally { trace.close(); }
        } catch { /* nowhere to record it; the console line above stands */ }
      }
      beat.tickEnded();
      if (opts.once || stopRequested()) break;
      const poll = await loadConfig(root).then((c) => c.poll_seconds, () => 60);
      await sleepUnlessStopped(poll * 1000);
      if (stopRequested()) break;
    }
  } finally {
    beat.stopped();
    uninstall();
  }
}
