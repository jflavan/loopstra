import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lanesFor, loopDayNote, roomBeside, roomFor, loopDaySpent, loopDayUsedUp, startOfToday, startOfTomorrow, stepOverDayNote } from "./budget";
import { FAKE_CLAUDE_ENV } from "./claude";
import { configPath, loadConfig, NOT_SET_UP, type Config } from "./config";
import { writeFileAtomic } from "./fsutil";
import { MainCheckoutMoved, OFF_MAIN_NOTE, PersonChangedStatus, StepContext, block, clearMarker, onceMarker, personChangedStatus, settleRecord, snapshotsDir, type StepResult } from "./context";
import { Git, GIT_TIMEOUT_NOTE, GitTimeout, removeStaleLocks, removeWorktree, STALE_LOCK_MS } from "./git";
import { GitHub } from "./github";
import { claim, release, runsNoCommands } from "./lanes";
import { activePause, clearPause, dropLoopLock, heartbeatDayPause, heartbeatDoneWith, heartbeatWorkingOn, loopAlreadyRunning, loopHoldText, pauseAfterUnavailable, pidAlive, readLoopHold, runningLoopPid, startHeartbeat, takeLoopLock, type LoopBeat } from "./heartbeat";
import { ownerNote, probeAssistant, STOPPED_NOTE } from "./phases";
import { settleCutShortMove, shareMain, syncMain } from "./remote";
import { errorText, timerMs } from "./shell";
import { checkConsistency, effectivePriority, fileHolds, hasQuestion, humanGates, isRunnable, MERGED, orderQueue, planFilesNeeded, readIntent, renderQueue, scanRepo, waitingOn, WATCHING_PR, type HumanGates, type Intent, type Scan } from "./intents";
import { closeStaleQuestion, closeUnusedAnswer, openQuestions } from "./questions";
import { andList } from "./text";
import { applyRequests, armApplier, betweenPasses, startApplier } from "./apply";
import { parsePlanFiles } from "./checks";
import { mainHealthDue, runMainHealth } from "./signals";
import { runBuildStep } from "./stages/build";
import { runDesignStep } from "./stages/design";
import { cleanupChange, runMergeStep } from "./stages/merge";
import { runPlanStep } from "./stages/plan";
import { RECONCILED_PLAN } from "./stages/shared";
import { runVerifyStep } from "./stages/verify";
import { sweepInbox } from "./steering";
import { clearChangeStop } from "./inbox";
import { repositoryTop, uncommittedSetup } from "./init";
import { loopstraDir, runDir } from "./paths";
import { olderSetupRefusal } from "./stamp";
import { AssistantUnavailable, installStopSignals, LoopBudgetReached, notTheStepsFault, QuestionAsked, recordNotYet, resetStop, SessionStopped, stopPromise, stopRequested, StopRequested } from "./stop";
import { Trace, type EventType } from "./trace";
import { wakeStamp } from "./wake";
import { chatDir } from "./chat/threads";

export interface TickResult {
  /**
   * The change of the first lane's step, and what that step gave; with no lane step, the thinker's
   * last, then the watcher's. Every step is in `steps`, the thinker's and the watcher's too.
   */
  picked: string | null; result?: StepResult; signal?: string;
  /** Every step the tick ran: lane by lane, then the thinker's, then the pull request watcher's, each in the order they ran. */
  steps?: LaneStep[];
  /** The config could not be loaded (plain words); nothing ran. */
  error?: string;
  /**
   * Set when no step ran because the repository needs a person first, because the assistant is
   * unavailable and the loop is backing off, or because a person paused the loop (plain words).
   */
  paused?: string;
  /** A stop was requested during the tick; the step was interrupted, not blocked. */
  stopped?: boolean;
  /** The tick itself hit an unexpected problem; the detail is in the trace. */
  crashed?: string;
}

/**
 * One step a lane (or the pull request watcher) ran: the change, what the step gave, and how long it
 * took. No result when a stop, an outage, the day's budget or a record not committed this time ended it
 * (`stopped` says it was a stop).
 */
export interface LaneStep { slug: string; result?: StepResult; durationMs: number; stopped?: boolean }

/** Why the tick paused when a record a kill cut short could not be finished yet (see settleRecord). */
const RECORD_UNSETTLED_NOTE = "A record the loop was writing when it stopped could not be finished yet; it is tried again on the next tick.";

/** What ended a lane's step without a result. Handled once for the whole tick, after every lane has ended. */
interface LaneProblem { slug: string; error: unknown }

/** What the lanes of one tick share: the changes taken this tick, whether to start no more steps, the problems met, and how many lanes have not ended. */
interface TickLanes { taken: Set<string>; halt: boolean; problems: LaneProblem[]; lanesRunning: number }

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

    // A move of main that a kill cut short is put back before anything reads or writes the checkout.
    const cutShort = await settleCutShortMove(root, trace);
    if (cutShort) {
      out.paused = cutShort;
      return out;
    }

    // A record a kill left between moving main and writing the checkout is finished first (see commitRecord).
    const recordSettled = await settleRecord(root, cfg.main_branch, trace);

    // Every artifact commit goes to main_branch. If the checkout is elsewhere, do nothing at all:
    // no signals, no queue, no steps (each would write into someone else's branch).
    const branch = await new Git(root).currentBranch();
    if (branch !== cfg.main_branch) {
      trace.event("_loop", "error", { where: "tick", expected: cfg.main_branch, actual: branch || "(unknown)" });
      out.paused = OFF_MAIN_NOTE;
      // Off main is the reason now (start logs it), not a day pause an earlier tick recorded.
      heartbeatDayPause(root, null);
      return out;
    }

    // On main and still not finished (the failure is traced): every record would refuse to start over
    // it, and the index lags behind main for its files, so nothing runs until it is finished.
    if (!recordSettled) {
      out.paused = RECORD_UNSETTLED_NOTE;
      return out;
    }

    // With a remote: pull what others pushed (an owner's status edits, merges on GitHub), and share
    // Loopstra's own records when only its commits are ahead. Best effort; never stops the tick.
    const hasRemote = (await new Git(root).remoteName()) !== null;
    // Shared at the end only after a sync that went through: a sync that waits or fails says why itself.
    share = hasRemote && (await syncMain(root, cfg, trace))?.result === "pass";

    // What people asked for (chat, the console): only the loop writes main.
    await applyRequests(root, cfg, trace);
    // From here the applier beside the tick may apply requests too (see startApplier).
    armApplier(root);

    // A person paused the loop (.loopstra/hold.json): requests still apply, the queue is still written
    // and leftovers cleaned up, but nothing new starts until they resume it, main's tests included.
    const loopHold = readLoopHold(root);

    // Signals: after a merge, or on the interval. Both are read from disk and the trace.
    const health = loopHold ? null : mainHealthDue(root, cfg, trace);
    if (health?.due) out.signal = await runMainHealth(root, cfg, trace, health.afterSlugs);

    // Scan, check, render queue.
    const first = await scanRepo(root);
    // Traced when the problem is new or has changed, not on every tick.
    for (const u of first.unreadable) trace.eventOnChange(u.slug, "error", '"where":"scan"', { where: "scan", problem: u.problem, detail: u.detail }, "problem");
    let blocked = false;
    for (const i of first.intents) {
      trace.upsertIntent(i.slug, i.file.frontmatter.status, effectivePriority(i.file.frontmatter));
      const problem = checkConsistency(i);
      if (problem && i.file.frontmatter.status !== "blocked") {
        await blockSafely(new StepContext(root, cfg, trace, i), problem);
        blocked = true;
      }
    }
    const { ordered, holds } = await refreshQueue(root, cfg, trace, blocked ? await scanRepo(root) : first);
    await cleanupLeftovers(root, cfg, trace, ordered);
    // Between the applier's passes too: no request commits while git packs.
    await betweenPasses(root, () => packWhileNoLaneRuns(root, trace));

    // The assistant was unavailable a moment ago: no step runs until the pause runs out.
    const pause = activePause(root);
    if (pause) {
      out.paused = pause.reason;
      return out;
    }

    // The loop's day is used up or held (claude.max_budget_usd_per_day): nothing starts until there is budget again.
    if (loopDayUsedUp(cfg, trace)) {
      out.paused = dayPaused(root, cfg, loopDaySpent(cfg, trace));
      // Traced when the reason is new today, not on every poll.
      trace.eventOnChange("_loop", "pause", "", { reason: out.paused }, "reason", startOfToday());
      return out;
    }
    heartbeatDayPause(root, null);

    // Paused by a person (read above): no step starts.
    if (loopHold) {
      out.paused = loopHoldText(loopHold);
      // Traced once per pause: a new pause by the same person reads the same, but starts later.
      trace.eventOnChange("_loop", "pause", "", { reason: out.paused, held: true }, "reason", loopHold.at);
      return out;
    }

    // Run steps for up to speed.max_parallel_changes changes at once, each in its own lane; the
    // tick waits for every lane. A change whose depends_on names one not merged yet waits, so it is
    // never built on a main without it, and so does one waiting for another to merge the same files.
    // With a remote, the changes watching their pull requests are the watcher's, beside the lanes.
    // With speed.think_ahead, design and plan steps also run beside the lanes (see thinkAhead), so
    // the lanes take the steps that may run the project's commands first.
    const human = humanGates(cfg);
    const runnable = ordered.filter((i) => forLane(i, human, hasRemote) && !waitingOn(i, ordered).length && !holds.has(i.slug));
    // Not when the day's budget has no room for a second session (never with a daily budget and no
    // session limit): the thinker could not start, and design and plan steps would only wait longer.
    const thinking = cfg.speed.think_ahead && roomFor(cfg, trace, 2);
    const candidates = thinking
      ? [...runnable.filter((i) => !thinkingStep(i, cfg)), ...runnable.filter((i) => thinkingStep(i, cfg))]
      : runnable;
    const lanes = lanesFor(cfg, trace);
    traceLanes(trace, cfg, lanes);
    const shared: TickLanes = { taken: new Set(), halt: false, problems: [], lanesRunning: 0 };
    const started = Date.now();
    // Settled, not all: the tick goes on only once every lane has ended, even one that failed outright.
    const running = Promise.allSettled(Array.from({ length: lanes }, () => runLane(root, cfg, trace, candidates, shared, human, hasRemote)));
    // Started after the lanes, which take their changes at once: the thinker gets what they left.
    const thinker = thinking ? thinkAhead(root, cfg, trace, shared, human, hasRemote, running) : Promise.resolve([]);
    // Watching until the thinker's step has ended too: the tick waits for it.
    const watcher = hasRemote ? watchPullRequests(root, cfg, trace, shared, human, Promise.allSettled([running, thinker])) : Promise.resolve([]);
    const [settled, [thought, watched]] = await Promise.all([running, Promise.allSettled([thinker, watcher])]);
    const perLane = settled.map((s) => laneSteps(s, shared));
    const thoughtSteps = laneSteps(thought, shared);
    const watchedSteps = laneSteps(watched, shared);
    out.steps = [...perLane.flat(), ...thoughtSteps, ...watchedSteps];
    // As with one change at a time before: the step that did real work, or the last one that only looked.
    const firstStep = perLane.find((l) => l.length)?.at(-1) ?? thoughtSteps.at(-1) ?? watchedSteps.at(-1);
    out.picked = firstStep?.slug ?? null;
    out.result = firstStep?.result;
    if ((lanes > 1 || thoughtSteps.length) && out.steps.length) {
      trace.event("_loop", "command", {
        command: "changes worked on together", lanes, steps: out.steps.map((s) => s.slug),
        durationMs: Date.now() - started, busyMs: out.steps.reduce((sum, s) => sum + s.durationMs, 0),
      });
    }
    return await afterLanes(root, cfg, trace, out, shared.problems, candidates);
  } catch (e) {
    if (e instanceof StopRequested) {
      // Not the intent's fault: it keeps its in-progress status and the step resumes on the next start.
      trace.event("_loop", "stop", { note: STOPPED_NOTE });
      out.stopped = true;
      return out;
    }
    // Defensive: nothing between the tick's start and its lanes starts a session, so neither is expected here; a step's own goes through afterLanes.
    if (e instanceof AssistantUnavailable) return await afterUnavailable(root, cfg, trace, out, null, e);
    if (e instanceof LoopBudgetReached) return await afterDayBudget(root, cfg, trace, out, []);
    trace.event("_loop", "error", { where: "tick", error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
    out.crashed = errorText(e).split("\n")[0] ?? "";
    return out;
  } finally {
    await endOfTick(root, cfg, trace, out, share);
    trace.close();
  }
}

/**
 * One lane: it takes the first of the tick's runnable changes no lane has taken, and runs its step.
 * The lanes share the list, and a change is taken and claimed in one go, so two lanes never run one
 * change and the pull request watcher never runs a change a lane is running. A change read again
 * that is no longer the lane's to run is passed over. A stop, an outage or the day's budget ends the
 * lane, and no lane starts another step; the tick handles them once every lane has ended
 * (afterLanes). It rejects only when the trace cannot be written while it records a problem (a full
 * disk, a database held too long); see laneSteps.
 */
async function runLane(root: string, cfg: Config, trace: Trace, candidates: Intent[], shared: TickLanes, human: HumanGates, hasRemote: boolean): Promise<LaneStep[]> {
  // Counted from the moment the lane is started until it ends (see thinkAhead).
  shared.lanesRunning++;
  try {
    for (;;) {
      // A pause a person set during the tick lets running steps finish and starts nothing more.
      if (shared.halt || stopRequested() || readLoopHold(root)) return [];
      const next = candidates.find((i) => takeChange(shared, i.slug));
      if (!next) return [];
      const ran = await runClaimed(root, cfg, trace, shared, next.slug, (i) => forLane(i, human, hasRemote));
      if (ran) return [ran];
    }
  } finally {
    shared.lanesRunning--;
  }
}

/** True when a change is a lane's to run now: runnable, not held, and (with a remote) not watching its pull request. */
function forLane(i: Intent, human: HumanGates, hasRemote: boolean): boolean {
  return isRunnable(i, human, hasRemote) && !waiting(i) && !(hasRemote && WATCHING_PR.has(i.file.frontmatter.status));
}

/**
 * The change waits for a person, so no step starts for it: they (or chat) put it on hold (`hold:` in
 * intent.md), or an agent's question waits for their answer (`question:`; see src/questions.ts).
 */
function waiting(i: Intent): boolean {
  return i.file.frontmatter.hold.trim() !== "" || hasQuestion(i);
}

/**
 * Runs the step of a change already claimed, and releases it after. The change is read again first
 * (the watcher or another lane may have moved it since the scan): null, without a step, when it is
 * no longer `runs` (or cannot be read). A problem the step does not handle itself is recorded with
 * laneProblem.
 */
async function runClaimed(root: string, cfg: Config, trace: Trace, shared: TickLanes, slug: string, runs: (i: Intent) => boolean): Promise<LaneStep | null> {
  heartbeatWorkingOn(root, slug);
  const t0 = Date.now();
  try {
    const fresh = await readFresh(root, trace, slug);
    if (!fresh || !runs(fresh)) return null;
    // A design or plan step runs none of the project's commands, in a lane as much as beside them.
    if (thinkingStep(fresh, cfg)) runsNoCommands(slug);
    const result = await runStepGuarded(new StepContext(root, cfg, trace, fresh));
    return { slug, result, durationMs: Date.now() - t0 };
  } catch (e) {
    return laneProblem(trace, shared, slug, e, Date.now() - t0);
  } finally {
    release(slug);
    heartbeatDoneWith(root, slug);
  }
}

/** The design and plan statuses, and the stage whose step each runs. */
const THINKING: ReadonlyMap<string, "design" | "plan"> = new Map([
  ["accepted", "design"], ["designing", "design"], ["spec-review", "design"],
  ["spec-approved", "plan"], ["planning", "plan"], ["plan-review", "plan"],
]);

/**
 * The change's step is a design or plan step that runs none of the project's commands: its sessions
 * only read a snapshot of main, and its stage has no `before` or `after` commands.
 */
export function thinkingStep(i: Intent, cfg: Config): boolean {
  const stage = THINKING.get(i.file.frontmatter.status);
  return !!stage && !cfg.stages[stage].before.length && !cfg.stages[stage].after.length;
}

/**
 * With speed.think_ahead, beside the lanes: design and plan steps (see thinkingStep), one at a time
 * and in queue order, while any lane runs a step, so a change accepted during another's build is
 * designed and planned by the time the build ends. They run none of the project's commands, so they
 * do not count against speed.max_parallel_changes. It scans the intents afresh at each look, so a
 * change it designed is planned next; a change it ran is taken again only once its status moved, so
 * a step that only looked is not run over and over. With nothing to take it looks again every
 * poll_seconds, and once every lane has ended it starts nothing more (the next tick's lanes take
 * over). It starts a step only with room in the day's budget for its session beside the others
 * running (roomBeside); that is checked as the step starts, so a later session of the lane's step can
 * still meet the day's end, as with more than one lane. A change that does not match its folder is
 * left to the next tick's start. A stop, an outage or the day's budget ends it like a lane (see laneProblem).
 */
async function thinkAhead(root: string, cfg: Config, trace: Trace, shared: TickLanes, human: HumanGates, hasRemote: boolean, lanesDone: Promise<unknown>): Promise<LaneStep[]> {
  const steps: LaneStep[] = [];
  const ranAt = new Map<string, string>();
  // One that does not match its folder (a section or spec.md missing) waits for the next tick's start, which blocks it.
  const thinks = (i: Intent) => forLane(i, human, hasRemote) && thinkingStep(i, cfg) && checkConsistency(i) === null;
  const goOn = () => shared.lanesRunning > 0 && !shared.halt && !stopRequested() && !readLoopHold(root);
  while (goOn()) {
    const ordered = orderQueue((await scanRepo(root)).intents);
    // Asked again after the scan: a lane may have ended meanwhile.
    const next = goOn() ? ordered.find((i) =>
      thinks(i) && ranAt.get(i.slug) !== i.file.frontmatter.status && !waitingOn(i, ordered).length && roomBeside(cfg, trace, i.slug, 1) && claim(i.slug)) : undefined;
    if (!next) {
      await sleepUnlessStopped(cfg.poll_seconds * 1000, lanesDone);
      continue;
    }
    ranAt.set(next.slug, next.file.frontmatter.status);
    const step = await runClaimed(root, cfg, trace, shared, next.slug, thinks);
    if (!step) continue;
    steps.push(step);
    if (!step.result) break;
  }
  return steps;
}

/**
 * With a remote, beside the lanes: the merge step of every change watching its pull request, so one
 * whose checks passed (or that was approved) merges while other changes' steps run, not only on the
 * next tick. It looks when the lanes start, every poll_seconds while any lane runs, and once more
 * after the last lane ended (a pull request a lane just opened, or one that could not be brought up
 * to date while every lane was busy, is looked at this tick). A change whose step did something
 * (brought its pull request up to date, say) waits for the next tick, when GitHub has started the
 * checks of what was pushed. Each change runs under its claim, so never beside a lane running it. A
 * stop, an outage or the day's budget ends it like a lane (see laneProblem). Its steps are the
 * tick's too, with at most one that only looked per change.
 */
async function watchPullRequests(root: string, cfg: Config, trace: Trace, shared: TickLanes, human: HumanGates, lanesDone: Promise<unknown>): Promise<LaneStep[]> {
  const steps: LaneStep[] = [];
  let ended = false;
  void lanesDone.then(() => { ended = true; });
  for (;;) {
    const last = ended;
    if (!(await watchOnce(root, cfg, trace, shared, human, steps)) || last) return steps;
    await sleepUnlessStopped(cfg.poll_seconds * 1000, lanesDone);
  }
}

/**
 * One look of the watcher (see watchPullRequests), in queue order: at each change watching its pull
 * request, except one whose step already did something this tick (brought it up to date, say),
 * which is looked at again on the next tick. False once a stop or a problem ended it.
 */
async function watchOnce(root: string, cfg: Config, trace: Trace, shared: TickLanes, human: HumanGates, steps: LaneStep[]): Promise<boolean> {
  const watching = (i: Intent) => WATCHING_PR.has(i.file.frontmatter.status) && isRunnable(i, human, true) && !waiting(i);
  const didWork = (slug: string) => steps.some((s) => s.slug === slug && !(s.result?.ok && s.result.waiting));
  const ordered = orderQueue((await scanRepo(root)).intents);
  for (const i of ordered) {
    if (shared.halt || stopRequested() || readLoopHold(root)) return false;
    if (!watching(i) || didWork(i.slug) || waitingOn(i, ordered).length || !claim(i.slug)) continue;
    const step = await runClaimed(root, cfg, trace, shared, i.slug, watching);
    if (!step) continue;
    if (!(step.result?.ok && step.result.waiting && steps.some((s) => s.slug === i.slug))) steps.push(step);
    if (!step.result) return false;
  }
  return true;
}

/**
 * A lane's steps once every lane has ended. A lane that rejected (see runLane) gives none, and its
 * error marks the tick as crashed.
 */
function laneSteps(settled: PromiseSettledResult<LaneStep[]>, shared: TickLanes): LaneStep[] {
  if (settled.status === "fulfilled") return settled.value;
  shared.problems.push({ slug: "_loop", error: settled.reason });
  return [];
}

/**
 * Takes a change for a lane: false when a lane took it this tick already, or when it is claimed (the
 * pull request watcher is running it). Either way no lane takes it again this tick. Synchronous, so
 * two lanes never take one change.
 */
function takeChange(shared: TickLanes, slug: string): boolean {
  if (shared.taken.has(slug)) return false;
  shared.taken.add(slug);
  return claim(slug);
}

/** A change read again from disk, or null (traced) when it cannot be read now; the next scan reports it. */
async function readFresh(root: string, trace: Trace, slug: string): Promise<Intent | null> {
  try {
    return await readIntent(root, slug);
  } catch (e) {
    trace.event(slug, "error", { where: "lane", problem: "the change could not be read", error: errorText(e) });
    return null;
  }
}

/**
 * A step ended with a stop, an outage, the day's budget, a record that could not be committed this
 * time, or (never expected) another problem. No lane starts another step. A stop, a record not
 * committed (the change keeps its status, and the step runs again on the next tick), and a problem
 * that is none of these are traced for the change now; an outage and the day's budget are handled
 * once the lanes have ended (afterLanes).
 */
function laneProblem(trace: Trace, shared: TickLanes, slug: string, e: unknown, durationMs: number): LaneStep {
  shared.halt = true;
  shared.problems.push({ slug, error: e });
  if (e instanceof StopRequested) {
    // Not the change's fault: it keeps its in-progress status and the step resumes on the next start.
    trace.event(slug, "stop", { note: STOPPED_NOTE });
    return { slug, durationMs, stopped: true };
  }
  if (recordNotYet(e)) trace.event(slug, "error", { where: "record", error: e.message, note: "the change keeps its status; the step runs again on the next tick" });
  else if (!notTheStepsFault(e)) trace.event(slug, "error", { where: "lane", error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
  return { slug, durationMs };
}

/**
 * Once every lane has ended: a stop ends the tick; an outage is handled once, with the first change
 * in queue order that met it as its cause, so back-off grows one step per tick however many lanes
 * met it, and the probe never runs beside a step; the day's budget is handled for each change that
 * ran out. Another problem marks the tick as crashed.
 */
async function afterLanes(root: string, cfg: Config, trace: Trace, out: TickResult, problems: LaneProblem[], candidates: Intent[]): Promise<TickResult> {
  if (problems.some((p) => p.error instanceof StopRequested)) {
    out.stopped = true;
    return out;
  }
  const crash = problems.find((p) => !notTheStepsFault(p.error));
  if (crash) out.crashed = errorText(crash.error).split("\n")[0] ?? "";
  // A change the tick did not start with (one the thinker took after it was accepted mid-tick) comes last.
  const place = (slug: string) => { const k = candidates.findIndex((i) => i.slug === slug); return k < 0 ? Infinity : k; };
  const outage = problems.filter((p) => p.error instanceof AssistantUnavailable).sort((a, b) => place(a.slug) - place(b.slug))[0];
  if (outage) await afterUnavailable(root, cfg, trace, out, outage.slug, outage.error as AssistantUnavailable);
  const outOfDay = problems.filter((p) => p.error instanceof LoopBudgetReached).map((p) => p.slug);
  if (outOfDay.length) await afterDayBudget(root, cfg, trace, out, outOfDay);
  return out;
}

/**
 * The same-file waits for this tick (see fileHolds): each waiting change and the change it waits for.
 * At every speed.max_parallel_changes, one included: with a remote the watcher looks after a pull
 * request beside the one lane, and without one a change can wait for a person's merge approval, so
 * the lane would otherwise build another change on the same files, and the two would clash at merge.
 * A plan that cannot be read counts as one with no file list. A change past plan-approved also holds
 * the files its build's drift reconcile added (the run folder's plan.reconciled.md; a plan-approved
 * change's is an earlier build's, which its next build drops).
 */
export async function sameFileHolds(ordered: Intent[], root: string): Promise<Map<string, string>> {
  const files = new Map<string, string[] | null>();
  const paths = (plan: string | null) => (plan === null ? null : (parsePlanFiles(plan)?.map((f) => f.path) ?? null));
  for (const i of ordered.filter((x) => planFilesNeeded(x.file.frontmatter.status))) {
    const plan = i.artifacts.has("plan.md") ? await Bun.file(join(i.dir, "plan.md")).text().catch(() => null) : null;
    const reconciled = i.file.frontmatter.status === "plan-approved" ? null
      : await Bun.file(join(runDir(root, i.slug), RECONCILED_PLAN)).text().catch(() => null);
    const listed = paths(plan), added = paths(reconciled);
    files.set(i.slug, listed === null && added === null ? null : [...new Set([...(listed ?? []), ...(added ?? [])])]);
  }
  return fileHolds(ordered, files);
}

/** The trace's command name for fewer changes at a time than configured. */
const FEWER_LANES = "changes at a time";

/**
 * Says when the day's budget gives fewer lanes than speed.max_parallel_changes (see lanesFor): once
 * each time the number changes, and again on a new day, not on every tick. The number going back up
 * to speed.max_parallel_changes during the day (a bigger day, a session's hold gone stale) is said
 * too, so a later drop counts as a change.
 */
function traceLanes(trace: Trace, cfg: Config, lanes: number): void {
  const configured = cfg.speed.max_parallel_changes;
  const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;
  const last = trace.lastEvent("_loop", "command", `"command":"${FEWER_LANES}"`);
  const today = last && last.ts >= startOfToday() ? (JSON.parse(last.payload) as { note?: string; lanes?: number; configured?: number }) : null;
  if (lanes >= configured) {
    if (today && (today.lanes ?? 0) < (today.configured ?? 0)) {
      trace.event("_loop", "command", { command: FEWER_LANES, note: `Today's budget has room for ${changes(configured)} at a time again.`, lanes: configured, configured });
    }
    return;
  }
  const note = `Today's budget has room for ${changes(lanes)} at a time instead of ${configured}.`;
  if (today?.note === note) return;
  trace.event("_loop", "command", { command: FEWER_LANES, note, lanes, configured });
}

/** How long the tick start's git gc may take: a full repack of a large repository takes a while. */
const GC_TIMEOUT_MS = 60 * 60_000;
/** After a git gc failed, the next try waits this long, so a gc that cannot finish does not hold up every tick. */
const GC_RETRY_MS = 24 * 60 * 60_000;

/**
 * Lets git pack the repository when it thinks it is time, while no lane runs and no request is being
 * applied (the tick runs it between the applier's passes, see betweenPasses). Runtime commits never
 * do it themselves (gc.auto=0): a pack of the refs during one change's commit could make another
 * change's commit fail. Traced only when it fails, and then not tried again for a day; never stops
 * the tick.
 */
async function packWhileNoLaneRuns(root: string, trace: Trace): Promise<void> {
  const failed = trace.lastEvent("_loop", "error", '"where":"gc"');
  if (failed && failed.ts > new Date(Date.now() - GC_RETRY_MS).toISOString()) return;
  const note = "git could not pack the repository; it is tried again tomorrow";
  try {
    const r = await new Git(root).run(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"], { allowFail: true, timeoutMs: GC_TIMEOUT_MS });
    if (r.code !== 0) trace.event("_loop", "error", { where: "gc", error: (r.err || r.out).trim(), note });
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    trace.event("_loop", "error", { where: "gc", error: errorText(e), note });
  }
}

/**
 * Orders a scan's changes and writes queue.md from them. `holds`: the changes that would build into
 * another's files, and wait (see sameFileHolds).
 */
async function refreshQueue(root: string, cfg: Config, trace: Trace, scan: Scan): Promise<{ ordered: Intent[]; holds: Map<string, string> }> {
  const ordered = orderQueue(scan.intents);
  const holds = await sameFileHolds(ordered, root);
  await writeQueue(root, trace, renderQueue(ordered, scan.unreadable, humanGates(cfg), holds, openQuestions(root, ordered)));
  return { ordered, holds };
}

/**
 * After the step: queue.md is brought up to date (uncommitted; the next runtime commit takes it
 * along), and with a remote, main is shared once for the whole tick. Best effort; not after a stop.
 * `share` is null when the tick stopped before it knew the checkout was on main.
 */
async function endOfTick(root: string, cfg: Config, trace: Trace, out: TickResult, share: boolean | null): Promise<void> {
  if (share === null || stopRequested()) return;
  try {
    if (out.steps?.length) await refreshQueue(root, cfg, trace, await scanRepo(root));
    if (share) await shareMain(root, cfg, trace);
  } catch (e) {
    if (!(e instanceof StopRequested)) trace.event("_loop", "error", { where: "end of tick", error: errorText(e) });
  }
}

/**
 * A config that cannot be loaded is traced (once while it stays the same), so `tail` and the trace
 * show it; the attention list shows it too, from loading the config itself. Never throws.
 */
function traceConfigProblem(root: string, error: string): void {
  try {
    const trace = Trace.open(root);
    try {
      trace.eventOnChange("_loop", "error", '"where":"config"', { where: "config", error }, "error");
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
 * probe does not → the loop keeps backing off. `slug` is the change whose step met it (null outside a step).
 */
async function afterUnavailable(root: string, cfg: Config, trace: Trace, out: TickResult, slug: string | null, e: AssistantUnavailable): Promise<TickResult> {
  const cause = slug && e.phase ? { slug, phase: e.phase, line: e.line, model: e.model } : null;
  const p = pauseAfterUnavailable(root, new Date(), cause);
  trace.event(slug ?? "_loop", "pause", { reason: p.reason, until: p.until, failures: p.failures, repeats: p.repeats, phase: p.phase, line: p.line, model: p.model, detail: e.detail });
  out.paused = p.reason;
  if (!cause || (p.repeats ?? 0) < PROBE_AFTER) return out;
  // The probe is a session too: with the loop's day used up, keep backing off instead.
  if (loopDayUsedUp(cfg, trace)) return out;
  try {
    const probe = await probeAssistant(root, cfg, trace, cause.slug, cause.model ?? undefined);
    if (!probe.reached) {
      trace.event(cause.slug, "pause", { note: "the probe could not reach the assistant either; still backing off", probe: probe.detail });
      return out;
    }
    clearPause(root);
    out.paused = undefined;
    const ctx = new StepContext(root, cfg, trace, await readIntent(root, cause.slug));
    trace.event(cause.slug, "error", {
      where: "probe", phase: cause.phase, line: cause.line, repeats: p.repeats,
      detail: `the ${cause.phase} phase failed ${p.repeats ?? PROBE_AFTER} times in a row with the same line, but a probe session reached the assistant, so the failure is the phase's own (crash)`,
    });
    stepEnded(out, cause.slug, await blockSafely(ctx, ownerNote("crash")));
  } catch (err) {
    if (err instanceof StopRequested) { out.stopped = true; return out; }
    trace.event(cause.slug, "error", { where: "probe", error: errorText(err) });
  }
  return out;
}

/**
 * The tick waits for the loop's daily budget: the day's note, which the loop line shows as well
 * (until local midnight when the day is spent; while it is only held, for two polls, so it lasts
 * until the next tick says again). Returns the note.
 */
function dayPaused(root: string, cfg: Config, spent: boolean): string {
  const reason = loopDayNote(cfg, spent);
  const until = spent ? startOfTomorrow() : new Date(Date.now() + 2 * cfg.poll_seconds * 1000);
  heartbeatDayPause(root, { reason, until: until.toISOString() });
  return reason;
}

/**
 * Of the day's budget, the share a change must have spent itself, on both days, before running out
 * partway twice means its step cannot fit in a day. Not all of it: another change's short session
 * may take a little of a day. A change that others left less than this only pauses.
 */
const HAD_THE_DAY = 0.9;

/**
 * The loop's day ran out partway through a step: the change keeps its status and the step resumes
 * when there is budget again. When the day is spent (not only held by others), the pause records
 * that status, what the change itself spent today, and the day's limit. The step is blocked instead,
 * with a note that says so, when it would start over and run out every day: the change's previous
 * such pause was on an earlier day at the same status, its status has not changed since (no status
 * change in the trace after it), and on both days the change itself spent at least HAD_THE_DAY of the day.
 * `slugs` are the changes whose steps ran out (none when it happened outside a step); the day's note is
 * written once.
 */
async function afterDayBudget(root: string, cfg: Config, trace: Trace, out: TickResult, slugs: string[]): Promise<TickResult> {
  const spent = loopDaySpent(cfg, trace);
  let reason: string | undefined;
  const paused = (): string => (reason ??= out.paused = dayPaused(root, cfg, spent));
  if (!slugs.length) trace.event("_loop", "pause", { reason: paused() });
  for (const slug of slugs) {
    let intent: Intent | null = null;
    if (spent) { try { intent = await readIntent(root, slug); } catch { /* unreadable now: only pause */ } }
    const status = intent?.file.frontmatter.status;
    const dayUsd = cfg.claude.max_budget_usd_per_day ?? 0;
    const spentUsd = trace.costSince(slug, startOfToday(), { endedOnly: true });
    const blocked = intent ? await blockOverTheDay(root, cfg, trace, intent, spentUsd, dayUsd) : null;
    if (blocked) { stepEnded(out, slug, blocked); continue; }
    trace.event(slug, "pause", intent ? { reason: paused(), dayBudget: true, status, spentUsd, dayUsd } : { reason: paused() });
  }
  return out;
}

/**
 * Blocks a change whose step ran out of the day partway again (see afterDayBudget), and gives the
 * result; null when it only pauses.
 */
async function blockOverTheDay(root: string, cfg: Config, trace: Trace, intent: Intent, spentUsd: number, dayUsd: number): Promise<StepResult | null> {
  const hadTheDay = (usd: number | undefined, limit: number | undefined) => usd !== undefined && limit !== undefined && usd >= HAD_THE_DAY * limit;
  if (!hadTheDay(spentUsd, dayUsd)) return null;
  const slug = intent.slug;
  const status = intent.file.frontmatter.status;
  const last = trace.lastEvent(slug, "pause", '"dayBudget":true');
  const earlier = last ? (JSON.parse(last.payload) as { status?: string; spentUsd?: number; dayUsd?: number }) : null;
  const moves: EventType[] = ["status_change", "person-changed-status"];
  const movedSince = !!last && moves.some((t) => (trace.lastEvent(slug, t)?.id ?? 0) > last.id);
  if (!(last && earlier && last.ts < startOfToday() && earlier.status === status && !movedSince && hadTheDay(earlier.spentUsd, earlier.dayUsd))) return null;
  const ctx = new StepContext(root, cfg, trace, intent);
  return blockSafely(ctx, stepOverDayNote(cfg), { detail: { where: "day budget", status, spentUsd, dayUsd, earlierPause: last.ts, earlierSpentUsd: earlier.spentUsd } });
}

/**
 * A step that ended without a result got one after the lanes (blocked by the probe or the day's
 * rule). It is the tick's `result` only when that step is the one `picked` names.
 */
function stepEnded(out: TickResult, slug: string, result: StepResult): void {
  if (slug === out.picked) out.result = result;
  const step = out.steps?.findLast((s) => s.slug === slug);
  if (step) step.result = result;
}

/**
 * Runs one step for an intent. A problem the step did not handle itself blocks the intent with a
 * plain note (the detail goes to the trace); only what is not its fault (see notTheStepsFault) passes
 * through. A session a person stopped, or a question an agent asked, ends the step quietly: the
 * change keeps its status. First, what was left in the change's inbox (see sweepInbox) goes to
 * conversation.md for the sessions to come,
 * a question from another stay at a status is closed (see closeStaleQuestion), and a stop of the change
 * is cleared: the step it was for has ended (see writeChangeStop in src/inbox.ts). Once it ends, an
 * answered question nothing in it used is closed (see closeUnusedAnswer), unless it was not the step's
 * fault (see notTheStepsFault): the change then does the step again, and that step may use it.
 */
export async function runStepGuarded(ctx: StepContext): Promise<StepResult> {
  let cutShort = false;
  try {
    try {
      clearChangeStop(ctx.root, ctx.slug);
    } catch (e) {
      // It stands, so the step ends quietly at its first phase; the next step's start tries again.
      ctx.trace.event(ctx.slug, "error", { where: "stop", error: errorText(e) });
    }
    await sweepInbox(ctx);
    closeStaleQuestion(ctx);
    return await runStep(ctx);
  } catch (e) {
    if (e instanceof SessionStopped) {
      ctx.trace.event(ctx.slug, "stop", { by: e.by, note: `the session was stopped by ${e.by}; the change keeps its status` });
      return { ok: true, stoppedBy: e.by };
    }
    if (e instanceof QuestionAsked) return { ok: true, asked: true };
    if (notTheStepsFault(e)) {
      cutShort = true;
      throw e;
    }
    if (e instanceof PersonChangedStatus) return personChangedStatus(ctx, e);
    ctx.trace.event(ctx.slug, "error", { where: "step", error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
    return await blockSafely(ctx, e instanceof MainCheckoutMoved ? e.message : unexpectedNote(e));
  } finally {
    if (!cutShort) closeUnusedAnswer(ctx);
    await dropSnapshot(ctx);
  }
}

/**
 * The step's snapshot of main is removed once it ends; a failure is traced (the next tick's start
 * removes it). A stop request is not the change's error: the removal is a cleanup call that a stop
 * does not interrupt, but should one reach here it is left to the next tick's start, quietly.
 */
async function dropSnapshot(ctx: StepContext): Promise<void> {
  try {
    await ctx.dropSnapshot();
  } catch (e) {
    if (e instanceof StopRequested) return;
    ctx.trace.event(ctx.slug, "error", { where: "snapshot", what: "could not remove the step's snapshot of main", error: errorText(e) });
  }
}

function unexpectedNote(e: unknown): string {
  if (e instanceof GitTimeout) return GIT_TIMEOUT_NOTE;
  return "Something unexpected went wrong in this step. An engineer can find the details in the trace.";
}

/** Blocks with a note; if even that fails (for example a commit is refused), traces it instead of throwing. */
async function blockSafely(ctx: StepContext, note: string, opts: { detail?: unknown } = {}): Promise<StepResult> {
  try {
    return await block(ctx, note, opts);
  } catch (e) {
    if (e instanceof PersonChangedStatus) return personChangedStatus(ctx, e);
    ctx.trace.event(ctx.slug, "error", { where: "block", note, error: errorText(e) });
    return { ok: false, note };
  }
}

/**
 * Writes the generated queue.md (only when it changed), whole (see writeFileAtomic), so the console
 * or a person's editor never reads half of it; the temp file goes in .loopstra, not intent/, where
 * one a kill left behind would be committed with the next record. It is never committed on its own:
 * the next runtime commit on main takes it along, so a tick with nothing else to record adds no commit.
 */
async function writeQueue(root: string, trace: Trace, text: string): Promise<void> {
  try {
    const path = join(root, "intent", "queue.md");
    if (existsSync(path) && (await Bun.file(path).text()) === text) return;
    writeFileAtomic(path, text, loopstraDir(root));
  } catch (e) {
    trace.event("_loop", "error", { where: "queue", error: errorText(e) });
  }
}

/** How long a chat hand-off's copy whose process is not alive here is left before it is removed. */
const HANDOFF_LEFT_MS = 60 * 60_000;

/**
 * A merged change's worktree and branch are removed right after the merge; if that failed, try
 * again here. A closed change's worktree is removed once it holds nothing uncommitted (its branch
 * is kept, so nothing is lost). Snapshots of main a killed loop left behind are removed (no step
 * runs yet), and so are a chat hand-off's throwaway checkouts once the process that made one is gone
 * (its folder, handoff-<time>-<pid>, names it) and the folder is an hour old: a pid not alive here
 * may be another machine's (WSL, say) sharing the repository, mid-push. Best effort and traced;
 * never blocks anything.
 */
async function cleanupLeftovers(root: string, cfg: Config, trace: Trace, intents: Intent[]): Promise<void> {
  if (existsSync(snapshotsDir(root))) {
    for (const name of readdirSync(snapshotsDir(root))) {
      try {
        await removeWorktree(new Git(root), join(snapshotsDir(root), name));
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        trace.event(name, "error", { where: "cleanup", what: "snapshot of main left behind", error: errorText(e) });
      }
    }
  }
  const handoffs = join(chatDir(root), "worktrees");
  if (existsSync(handoffs)) {
    for (const name of readdirSync(handoffs)) {
      const pid = Number(/^handoff-\d+-(\d+)$/.exec(name)?.[1]);
      if (!pid || pidAlive(pid)) continue;
      try {
        if (Date.now() - statSync(join(handoffs, name)).mtimeMs < HANDOFF_LEFT_MS) continue;
        await removeWorktree(new Git(root), join(handoffs, name));
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        trace.event("_loop", "error", { where: "cleanup", what: "chat hand-off copy left behind", dir: name, error: errorText(e) });
      }
    }
  }
  for (const i of intents.filter((x) => x.file.frontmatter.status === "closed")) {
    try {
      await removeClosedWorktree(new StepContext(root, cfg, trace, i));
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      trace.event(i.slug, "error", { where: "cleanup", what: "closed worktree", error: errorText(e) });
    }
  }
  const merged = intents.filter((i) => MERGED.has(i.file.frontmatter.status));
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
 * folder is set up (it has loopstra/config.yaml) by a Loopstra with the stamp (an older setup is
 * upgraded first), no loop is running in it already, the tools are installed, the checkout is on
 * main_branch, Loopstra's own files are committed there, and a repository with a remote has gh,
 * signed in. A config that is there but cannot be loaded is left to the loop, which reports it and retries.
 */
export async function preflight(root: string, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const top = await repositoryTop(root);
  if (top) return `This folder is inside the git repository at ${top}. Loopstra works on a whole repository: run it in ${top}.`;
  if (!existsSync(configPath(root))) return NOT_SET_UP;
  // Its old prompt copies would be used as overrides, and old copies of some prompts are not safe.
  const older = olderSetupRefusal(root, "run loopstra start again");
  if (older) return older;
  const cfg = await loadConfig(root).catch(() => null);
  // By its heartbeat, which also shows a loop started from another machine sharing the folder (WSL, say).
  const running = runningLoopPid(root, cfg?.poll_seconds ?? 60);
  if (running !== null) return loopAlreadyRunning(running);
  const missing = missingTools(env) ?? claudeOverrideProblem(env);
  if (missing) return missing;
  if (!cfg) return null;
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

/** Waits up to `ms`, or until a stop is requested or `until` settles. Leaves no timer behind. */
async function sleepUnlessStopped(ms: number, until?: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = until ? [until.then(() => {}, () => {})] : [];
  try {
    await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, timerMs(ms)); }), stopPromise(), ...ended]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The loop's wait between ticks: up to `ms`, ending early on a stop or when `.loopstra/wake` no
 * longer says `seen` (someone asked for something: a request, a resume). `seen` is read when the
 * tick began, so a wake during the tick ends this wait at once. Checks the file every `checkMs`.
 */
export async function sleepBetweenTicks(root: string, ms: number, seen: string, checkMs = 1000): Promise<"woken" | "timeout" | "stop"> {
  if (wakeStamp(root) !== seen) return "woken";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check: ReturnType<typeof setInterval> | undefined;
  try {
    return await Promise.race([
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timerMs(ms)); }),
      stopPromise().then(() => "stop" as const),
      new Promise<"woken">((resolve) => { check = setInterval(() => { if (wakeStamp(root) !== seen) resolve("woken"); }, checkMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(check);
  }
}

/** What a step gave, for the console line. A step that waits says for what: GitHub unless it names something else. */
export function stepText(r: StepResult): string {
  if (!r.ok) return r.note;
  if (r.stoppedBy) return `stopped by ${r.stoppedBy}`;
  if (r.asked) return "asked a person a question";
  if (r.waiting) return `waiting for ${r.waitingFor ?? "GitHub"}`;
  return r.personChanged ? "a person changed the status; it is picked up next" : "step done";
}

/** Prints a line of the loop's console output, after the time. */
export function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

/**
 * The loop. It never dies: each tick is guarded, a problem is traced, and the next tick comes.
 * Ctrl-C asks for a stop (the running step is interrupted and resumes on the next start); a
 * second Ctrl-C exits at once. It holds the loop's lock while it runs (see takeLoopLock). Returns
 * the refusal when another loop holds the lock, or null once the loop has run.
 */
export async function start(root: string, opts: { once: boolean; installSignals?: boolean }): Promise<string | null> {
  const refused = await takeLoopLock(root, await loadConfig(root).then((c) => c.poll_seconds, () => 60));
  if (refused) return refused;
  let beat: LoopBeat | null = null;
  // A second Ctrl-C exits at once, past every finally: the lock goes and the heartbeat says stopped on the way out.
  const onExit = () => { beat?.stopped(); dropLoopLock(root); };
  process.on("exit", onExit);
  try {
    await runLoop(root, opts, (b) => { beat = b; });
  } finally {
    process.off("exit", onExit);
    dropLoopLock(root);
  }
  return null;
}

/** The loop itself, once start holds the lock; `started` gets its heartbeat. */
async function runLoop(root: string, opts: { once: boolean; installSignals?: boolean }, started: (beat: LoopBeat) => void): Promise<void> {
  resetStop();
  const uninstall = opts.installSignals === false ? () => {} : installStopSignals();
  const beat = startHeartbeat(root);
  started(beat);
  // Applies requests while steps run, once the first tick has settled the checkout (see armApplier).
  const applier = startApplier(root);
  try {
    // The last pause logged: a pause that lasts (the loop's day, until midnight) is logged once, not every poll.
    let lastPaused = "";
    for (;;) {
      // Read as the tick begins: a wake during the tick ends the sleep after it at once.
      const seen = wakeStamp(root);
      try {
        beat.tickStarted();
        const r = await tick(root);
        if (r.error) console.error(`Config problem, will retry next tick:\n${r.error}`);
        else {
          for (const s of r.steps ?? []) if (s.result) log(`${s.slug}: ${stepText(s.result)}`);
          const stopped = (r.steps ?? []).filter((s) => s.stopped).map((s) => s.slug);
          if (r.paused) { if (r.paused !== lastPaused) log(`paused: ${r.paused}`); }
          else if (r.stopped) log(`stopped${stopped.length ? ` during ${andList(stopped)}; ${stopped.length > 1 ? "they resume" : "it resumes"} on the next start` : ""}`);
          else if (r.crashed) log(`the loop hit an unexpected problem and will try again: ${r.crashed}`);
          else if (!r.steps?.length) log("idle");
        }
        lastPaused = r.paused ?? "";
      } catch (e) {
        log(`the loop hit an unexpected problem and will try again: ${errorText(e).split("\n")[0] ?? ""}`);
        try {
          const trace = Trace.open(root);
          try { trace.event("_loop", "error", { where: "start", error: errorText(e), stack: e instanceof Error ? e.stack : undefined }); } finally { trace.close(); }
        } catch { /* nowhere to record it; the console line above stands */ }
      }
      beat.tickEnded();
      if (opts.once || stopRequested()) break;
      const poll = await loadConfig(root).then((c) => c.poll_seconds, () => 60);
      await sleepBetweenTicks(root, poll * 1000, seen);
      if (stopRequested()) break;
    }
  } finally {
    await applier.stop();
    beat.stopped();
    uninstall();
  }
}
