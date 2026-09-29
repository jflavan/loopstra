import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { FAKE_CLAUDE_ENV } from "./claude";
import { configPath, loadConfig, NOT_SET_UP, type Config } from "./config";
import { MainCheckoutMoved, OFF_MAIN_NOTE, PersonChangedStatus, StepContext, block, clearMarker, onceMarker, personChangedStatus, type StepResult } from "./context";
import { Git, GIT_TIMEOUT_NOTE, GitTimeout, removeStaleLocks, removeWorktree, STALE_LOCK_MS } from "./git";
import { GitHub } from "./github";
import { activePause, clearPause, heartbeatWorkingOn, pauseAfterUnavailable, startHeartbeat } from "./heartbeat";
import { ownerNote, probeAssistant } from "./phases";
import { shareMain, syncMain } from "./remote";
import { errorText } from "./shell";
import { checkConsistency, effectivePriority, isRunnable, orderQueue, readIntent, renderQueue, scanRepo, type HumanGates, type Intent } from "./intents";
import { mainHealthDue, runMainHealth } from "./signals";
import { runBuildStep } from "./stages/build";
import { runDesignStep } from "./stages/design";
import { cleanupChange, runMergeStep } from "./stages/merge";
import { runPlanStep } from "./stages/plan";
import { runVerifyStep } from "./stages/verify";
import { uncommittedSetup } from "./init";
import { AssistantUnavailable, installStopSignals, resetStop, stopPromise, stopRequested, StopRequested } from "./stop";
import { Trace } from "./trace";

export interface TickResult {
  picked: string | null; result?: StepResult; signal?: string;
  /** The config could not be loaded (plain words); nothing ran. */
  error?: string;
  /**
   * Set when no step ran because the repository needs a person first, or because the assistant is
   * unavailable and the loop is backing off (plain words).
   */
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
  try {
    cfg = await loadConfig(root);
  } catch (e) {
    const error = errorText(e);
    traceConfigProblem(root, error);
    return { picked: null, error };
  }
  const trace = Trace.open(root);
  const out: TickResult = { picked: null };
  // Known once the checkout is on main: whether main is shared with a remote at the end of the tick.
  let share: boolean | null = null;
  try {
    trace.event("_loop", "tick", {});

    // A git process that died (killed, or the machine went down) leaves its index lock behind, and
    // every git write after it would fail. The loop is the only automated git user: an old lock is its own.
    for (const path of await removeStaleLocks(root)) trace.event("_loop", "stale-lock-removed", { path, olderThanMinutes: STALE_LOCK_MS / 60_000 });

    // Every artifact commit goes to main_branch. If the checkout is elsewhere, do nothing at all:
    // no signals, no queue, no steps (each would write into someone else's branch).
    const branch = await new Git(root).currentBranch();
    if (branch !== cfg.main_branch) {
      trace.event("_loop", "error", { where: "tick", expected: cfg.main_branch, actual: branch || "(unknown)" });
      out.paused = OFF_MAIN_NOTE;
      return out;
    }

    // With a remote: pull what others pushed (an owner's status edits, merges on GitHub), and share
    // Loopstra's own records when only its commits are ahead. Best effort; never stops the tick.
    const hasRemote = (await new Git(root).remoteName()) !== null;
    // Shared at the end only after a sync that went through: a sync that waits or fails says why itself.
    share = hasRemote && (await syncMain(root, cfg, trace)) === "pass";

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
    await writeQueue(root, trace, renderQueue(ordered, scan.unreadable, humanGates(cfg)));
    await cleanupLeftovers(root, cfg, trace, ordered);

    // The assistant was unavailable a moment ago: no step runs until the pause runs out.
    const pause = activePause(root);
    if (pause) {
      out.paused = pause.reason;
      return out;
    }

    // Pick and run one step. A step that only looked and found nothing to do yet (a pull request
    // still waiting on GitHub) does not hold up the next change: it runs in the same tick.
    const human = humanGates(cfg);
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
    if (e instanceof AssistantUnavailable) return await afterUnavailable(root, cfg, trace, out, e);
    trace.event("_loop", "error", { where: "tick", error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
    out.crashed = errorText(e).split("\n")[0] ?? "";
    return out;
  } finally {
    await endOfTick(root, cfg, trace, out, share);
    trace.close();
  }
}

/**
 * After the step: queue.md is brought up to date (uncommitted; the next runtime commit takes it
 * along), and with a remote, main is shared once for the whole tick. Best effort; not after a stop.
 * `share` is null when the tick stopped before it knew the checkout was on main.
 */
async function endOfTick(root: string, cfg: Config, trace: Trace, out: TickResult, share: boolean | null): Promise<void> {
  if (share === null || stopRequested()) return;
  try {
    if (out.picked) {
      const scan = await scanRepo(root);
      await writeQueue(root, trace, renderQueue(orderQueue(scan.intents), scan.unreadable, humanGates(cfg)));
    }
    if (share) await shareMain(root, cfg, trace);
  } catch (e) {
    if (!(e instanceof StopRequested)) trace.event("_loop", "error", { where: "end of tick", error: errorText(e) });
  }
}

/** Which gates have a person on them, for the queue and for what is runnable. */
function humanGates(cfg: Config): HumanGates {
  return { spec: cfg.gates.spec.human, plan: cfg.gates.plan.human, merge: cfg.gates.merge.human, done: cfg.gates.done.human };
}

/**
 * A config that cannot be loaded is traced (once while it stays the same), so `tail` and the trace
 * show it; the attention list shows it too, from loading the config itself. Never throws.
 */
function traceConfigProblem(root: string, error: string): void {
  try {
    const trace = Trace.open(root);
    try {
      const last = trace.lastEvent("_loop", "error", '"where":"config"');
      if (!last || (JSON.parse(last.payload) as { error?: string }).error !== error) trace.event("_loop", "error", { where: "config", error });
    } finally {
      trace.close();
    }
  } catch { /* nowhere to record it; the console line stands */ }
}

/** After this many pauses in a row for the same change, phase, and line, a probe checks whether it really is an outage. */
export const PROBE_AFTER = 3;

/**
 * The assistant could not be used. Not the intent's fault: it keeps its status, and the loop backs
 * off before trying again. When the same phase keeps failing with the same line, a tiny probe
 * session tells an outage from the phase's own failure: the probe gets through → the pause ends
 * and the change is blocked like any crash (the detail, probe included, goes to the trace); the
 * probe does not → the loop keeps backing off.
 */
async function afterUnavailable(root: string, cfg: Config, trace: Trace, out: TickResult, e: AssistantUnavailable): Promise<TickResult> {
  const cause = out.picked && e.phase ? { slug: out.picked, phase: e.phase, line: e.line } : null;
  const p = pauseAfterUnavailable(root, new Date(), cause);
  trace.event(out.picked ?? "_loop", "pause", { reason: p.reason, until: p.until, failures: p.failures, repeats: p.repeats, phase: p.phase, line: p.line, detail: e.detail });
  out.paused = p.reason;
  if (!cause || (p.repeats ?? 0) < PROBE_AFTER) return out;
  try {
    const probe = await probeAssistant(root, cfg, trace, cause.slug);
    if (!probe.reached) {
      trace.event(cause.slug, "pause", { note: "the probe could not reach the assistant either; still backing off", probe: probe.detail });
      return out;
    }
    clearPause(root);
    out.paused = undefined;
    const ctx = new StepContext(root, cfg, trace, await readIntent(root, cause.slug));
    trace.event(cause.slug, "error", {
      where: "probe", phase: cause.phase, line: cause.line, repeats: p.repeats,
      detail: `the ${cause.phase} phase failed ${p.repeats} times in a row with the same line, but a probe session reached the assistant, so the failure is the phase's own (crash)`,
    });
    out.result = await blockSafely(ctx, ownerNote("crash"));
  } catch (err) {
    if (err instanceof StopRequested) { out.stopped = true; return out; }
    trace.event(cause.slug, "error", { where: "probe", error: errorText(err) });
  }
  return out;
}

/**
 * Runs one step for an intent. A problem the step did not handle itself blocks the intent with a
 * plain note (the detail goes to the trace); only a stop request passes through.
 */
export async function runStepGuarded(ctx: StepContext): Promise<StepResult> {
  try {
    return await runStep(ctx);
  } catch (e) {
    if (e instanceof StopRequested || e instanceof AssistantUnavailable) throw e;
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

/**
 * Writes the generated queue.md (only when it changed). It is never committed on its own: the next
 * runtime commit on main takes it along, so a tick with nothing else to record adds no commit.
 */
async function writeQueue(root: string, trace: Trace, text: string): Promise<void> {
  try {
    const path = join(root, "intent", "queue.md");
    if (existsSync(path) && (await Bun.file(path).text()) === text) return;
    await Bun.write(path, text);
  } catch (e) {
    trace.event("_loop", "error", { where: "queue", error: errorText(e) });
  }
}

/**
 * A merged change's worktree and branch are removed right after the merge; if that failed, try
 * again here. A closed change's worktree is removed once it holds nothing uncommitted (its branch
 * is kept, so nothing is lost). Best effort and traced; never blocks anything.
 */
async function cleanupLeftovers(root: string, cfg: Config, trace: Trace, intents: Intent[]): Promise<void> {
  for (const i of intents.filter((x) => x.file.frontmatter.status === "closed")) {
    try {
      await removeClosedWorktree(new StepContext(root, cfg, trace, i));
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      trace.event(i.slug, "error", { where: "cleanup", what: "closed worktree", error: errorText(e) });
    }
  }
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

/** Run-folder marker: a closed change's worktree was kept because it has uncommitted work (traced once). */
const WORKTREE_KEPT = "worktree-kept";

/**
 * Removes a closed change's worktree when it is a real worktree with nothing uncommitted (untracked
 * files count as uncommitted). Its branch stays. A worktree with uncommitted work is left as it is,
 * and that is traced once.
 */
async function removeClosedWorktree(ctx: StepContext): Promise<void> {
  if (!existsSync(ctx.worktreeDir)) return;
  const wt = new Git(ctx.worktreeDir);
  // A plain folder would resolve to the main checkout: never judge (or remove) that.
  if (!(await wt.isWorktreeRoot())) return;
  if (await wt.isDirty()) {
    if (onceMarker(ctx, WORKTREE_KEPT)) ctx.trace.event(ctx.slug, "command", { command: "clean up closed change", kept: ctx.worktreeDir, reason: "the worktree has uncommitted work" });
    return;
  }
  await removeWorktree(ctx.git, ctx.worktreeDir);
  clearMarker(ctx, WORKTREE_KEPT);
  ctx.trace.event(ctx.slug, "command", { command: "clean up closed change", removed: ctx.worktreeDir, branchKept: ctx.branch });
}

async function runStep(ctx: StepContext): Promise<StepResult> {
  switch (ctx.intent.file.frontmatter.status) {
    case "accepted": case "designing": case "spec-review": return runDesignStep(ctx);
    case "spec-approved": case "planning": case "plan-review": return runPlanStep(ctx);
    case "plan-approved": case "building": return runBuildStep(ctx);
    case "reviewing": case "merge-review": case "merge-approved": return runMergeStep(ctx);
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
 * A plain message when LOOPSTRA_CLAUDE_EXECUTABLE is set but cannot be run: not found (as a path, or
 * on PATH for a bare name), or on POSIX not executable. A `.ts` file is run through bun, so only its
 * existence matters. Null when it is unset or fine.
 */
export function claudeOverrideProblem(env: Record<string, string | undefined> = process.env): string | null {
  const exe = env[FAKE_CLAUDE_ENV];
  if (!exe) return null;
  const bare = !/[\\/]/.test(exe);
  const path = bare ? Bun.which(exe, { PATH: env.PATH ?? env.Path ?? "" }) : exe;
  if (!path || !existsSync(path)) return `${FAKE_CLAUDE_ENV} is set to ${exe}, which was not found. Correct it, or unset it to use claude from PATH.`;
  if (exe.endsWith(".ts") || process.platform === "win32") return null;
  try { accessSync(path, constants.X_OK); } catch {
    return `${FAKE_CLAUDE_ENV} is set to ${exe}, which is not executable. Run chmod +x on it, or unset it to use claude from PATH.`;
  }
  return null;
}

/**
 * What `start` checks before the loop begins, as a plain message, or null when it may start: the
 * folder is set up (it has loopstra/config.yaml), the tools are installed, the checkout is on
 * main_branch, Loopstra's own files are committed there, and a repository with a remote has gh,
 * signed in. A config that is there but cannot be loaded is left to the loop, which reports it and retries.
 */
export async function preflight(root: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (!existsSync(configPath(root))) return NOT_SET_UP;
  const missing = missingTools(env) ?? claudeOverrideProblem(env);
  if (missing) return missing;
  let cfg: Config;
  try { cfg = await loadConfig(root); } catch { return null; }
  const git = new Git(root);
  const branch = await git.currentBranch();
  if (branch !== cfg.main_branch) return `Run loopstra from a checkout of ${cfg.main_branch}; you are on ${branch || "no branch"}.`;
  const uncommitted = await uncommittedSetup(root, cfg.main_branch);
  if (uncommitted.length) {
    return `These Loopstra files are not committed on ${cfg.main_branch} yet, so the loop's own checkouts would not see them: ${uncommitted.join(", ")}. Commit them, then start again.`;
  }
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
