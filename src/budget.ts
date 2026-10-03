import type { Config } from "./config";

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
