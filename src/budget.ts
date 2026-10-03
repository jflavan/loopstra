import type { Config } from "./config";
import type { Trace } from "./trace";

/** The trace slug every chat turn and writer run is recorded under. */
export const CHAT_SLUG = "_chat";

/** The least a session may hold of a daily budget; with less left, it does not start. */
export const MIN_SESSION_USD = 0.01;

/** Local midnight today, as an ISO time: where every daily budget starts. */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** A budget that is not set is no limit. */
export function limitOf(usd: number | undefined): number {
  return usd ?? Infinity;
}

/** A session ends by its timeout plus this, at the latest; a hold still "running" after that was left by a killed process. */
export const STALE_GRACE_MINUTES = 10;

/**
 * The ISO time before which a phase still marked running no longer holds budget: its process was
 * killed (nothing ends its row), and its hold must not lock the day.
 */
export function staleBefore(cfg: Config, now = new Date()): string {
  return new Date(now.getTime() - (cfg.claude.timeout_minutes + STALE_GRACE_MINUTES) * 60_000).toISOString();
}

/** Whose spending counts against the loop's day: every change, not chat. */
const LOOP_POOL = { except: CHAT_SLUG };

/** claude.max_budget_usd_per_day is set and less than a session's floor of it is left. */
export function loopDayUsedUp(cfg: Config, trace: Trace, now = new Date()): boolean {
  const day = cfg.claude.max_budget_usd_per_day;
  // Spent plus what running phases hold, as startPhase counts it, so the tick pauses instead of picking a change that cannot start.
  return day !== undefined && day - trace.costIn(LOOP_POOL, startOfToday(now), { runningSince: staleBefore(cfg, now) }) < MIN_SESSION_USD;
}

/**
 * What ended today alone uses up the loop's day: the loop waits until midnight. Not so while the day
 * is only held by running phases (with no session cap, a running phase holds the rest of the day):
 * that clears by itself and needs no person.
 */
export function loopDaySpent(cfg: Config, trace: Trace, now = new Date()): boolean {
  const day = cfg.claude.max_budget_usd_per_day;
  return day !== undefined && day - trace.costIn(LOOP_POOL, startOfToday(now), { endedOnly: true }) < MIN_SESSION_USD;
}

/**
 * Why the loop is waiting: the tick's pause and, once the day is spent, the attention list. Asked once
 * loopDayUsedUp: unless loopDaySpent, the rest is only held by a phase still running (or by one whose
 * process was killed, until its hold goes stale).
 */
export function loopDayNote(cfg: Config, trace: Trace, now = new Date()): string {
  const day = cfg.claude.max_budget_usd_per_day ?? 0;
  const setting = `claude.max_budget_usd_per_day, $${day.toFixed(2)}`;
  if (!loopDaySpent(cfg, trace, now)) {
    return `The rest of the loop's budget for today (${setting}) is held by a phase still running, or by one that stopped without ending. The loop goes on once it ends, or within ${cfg.claude.timeout_minutes + STALE_GRACE_MINUTES} minutes at the latest.`;
  }
  return `The loop has used today's budget (${setting}). It resumes after midnight, or an engineer can change it with \`loopstra setup budgets\`.`;
}
