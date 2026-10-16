import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { bookkeeping, Git, withDetachedWorktree } from "./git";
import { projectCommand } from "./phases";
import { errorText } from "./shell";
import { StopRequested } from "./stop";
import type { Trace } from "./trace";

export type HealthResult = "pass" | "fail" | "error";

const SIGNAL = "main_health";

/**
 * Written at merge; the next tick runs the check and removes it. Holds the changes merged since the
 * last check, one per line, in the order they merged.
 */
function pendingPath(root: string): string {
  return join(root, ".loopstra", "health-pending");
}

/** The changes waiting for a main_health check (empty when none is asked for). */
function pendingSlugs(root: string): string[] {
  try {
    return readFileSync(pendingPath(root), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Asks for a main_health check on the next tick, attributed to every change merged since the last one (each named once). */
export function markHealthPending(root: string, slug: string): void {
  mkdirSync(join(root, ".loopstra"), { recursive: true });
  const slugs = pendingSlugs(root);
  if (!slugs.includes(slug)) slugs.push(slug);
  writeFileSync(pendingPath(root), slugs.join("\n"));
}

/**
 * Whether main_health should run now, from what is on disk and in the trace (no process state):
 * a merge asked for it, or the newest check is older than the interval, or there never was one.
 */
export function mainHealthDue(root: string, cfg: Config, trace: Trace): { due: boolean; afterSlugs: string[] } {
  if (existsSync(pendingPath(root))) return { due: true, afterSlugs: pendingSlugs(root) };
  const last = trace.lastSignal(SIGNAL);
  const due = !last || Date.now() - Date.parse(last.ts) >= cfg.signals.main_health.every_minutes * 60_000;
  return { due, afterSlugs: [] };
}

/**
 * Runs the test command on main in a throwaway detached worktree (`.loopstra/health/main`).
 * The baseline is the newest result that was not an error. Red after green opens a draft intent;
 * with no baseline yet the result is only recorded. Install or setup problems record `error`,
 * which never opens anything. Test output goes to the trace, never into the intent.
 */
export async function runMainHealth(root: string, cfg: Config, trace: Trace, afterSlugs: string[]): Promise<HealthResult> {
  const git = new Git(root);
  const dir = join(root, ".loopstra", "health", "main");
  // Traced on the loop; the commands get no change's slug.
  const on = { trace, cfg, slug: "_loop" };
  let result: HealthResult;
  let output: string;
  try {
    ({ result, output } = await withDetachedWorktree(git, dir, cfg.main_branch, async (cwd): Promise<{ result: HealthResult; output: string }> => {
      if (cfg.commands.install) {
        const i = await projectCommand(on, cfg.commands.install, cwd, { env: {}, where: SIGNAL });
        if (i.code !== 0) return { result: "error", output: `install failed: ${i.output.slice(-4000)}` };
      }
      const t = await projectCommand(on, cfg.commands.test, cwd, { env: {}, where: SIGNAL });
      return { result: t.code === 0 ? "pass" : "fail", output: t.output.slice(-4000) };
    }));
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    result = "error";
    output = errorText(e);
  }
  const baseline = trace.lastSignal(SIGNAL, { excludeErrors: true });
  trace.signal(SIGNAL, result, output);
  rmSync(pendingPath(root), { force: true });
  if (result === "fail" && baseline?.result === "pass") await openFailureIntent(root, git, trace, afterSlugs, output);
  return result;
}

/** Today's date in the machine's own time zone, as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `after the change "a" merged`, `after the changes "a" and "b" merged`, or `on the main branch`. */
function brokeWhen(afterSlugs: string[]): string {
  const names = afterSlugs.map((s) => `"${s}"`);
  if (names.length === 0) return "on the main branch";
  if (names.length === 1) return `after the change ${names[0]} merged`;
  return `after the changes ${names.slice(0, -1).join(", ")} and ${names.at(-1)} merged`;
}

/** Opens a draft for the failing tests, named after the first change merged since the last check. */
async function openFailureIntent(root: string, git: Git, trace: Trace, afterSlugs: string[], output: string): Promise<void> {
  const today = localDate();
  const slug = afterSlugs[0] ? `fix-tests-after-${afterSlugs[0]}` : `fix-tests-on-main-${today}`;
  const dir = join(root, "intent", slug);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const what = brokeWhen(afterSlugs);
  await Bun.write(join(dir, "intent.md"), `---
status: draft
priority: high
author: loopstra
opened: ${today}
note: "Opened automatically because the tests on main started failing. Review it and set status to accepted, or closed."
---
# Intent: tests broke ${what}

## Problem
Before this, the tests on main passed. Now they fail. An engineer can find the failing test output in the Loopstra trace.

## Proposed outcome
The tests on main pass again.

## Done when
- The tests pass on main.

## Affected users and systems
Everyone working on this repository.

## Open questions
Should the change be reverted, or fixed forward?
`);
  trace.event(slug, "signal", { name: SIGNAL, result: "fail", after: afterSlugs, output });
  await git.commitPaths([`intent/${slug}`], bookkeeping(`loopstra(${slug}): open intent for failing tests on main`));
}
