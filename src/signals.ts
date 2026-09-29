import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { bookkeeping, Git, withDetachedWorktree } from "./git";
import { commandTimeoutMs, runCommand } from "./shell";
import { StopRequested } from "./stop";
import type { Trace } from "./trace";

export type HealthResult = "pass" | "fail" | "error";

const SIGNAL = "main_health";

/** Written at merge; the next tick runs the check and removes it. Holds the merged slug. */
function pendingPath(root: string): string {
  return join(root, ".loopstra", "health-pending");
}

/** Asks for a main_health check on the next tick, attributed to the change that just merged. */
export function markHealthPending(root: string, slug: string): void {
  mkdirSync(join(root, ".loopstra"), { recursive: true });
  writeFileSync(pendingPath(root), slug);
}

/**
 * Whether main_health should run now, from what is on disk and in the trace (no process state):
 * a merge asked for it, or the newest check is older than the interval, or there never was one.
 */
export function mainHealthDue(root: string, cfg: Config, trace: Trace): { due: boolean; afterSlug: string | null } {
  const p = pendingPath(root);
  if (existsSync(p)) return { due: true, afterSlug: readFileSync(p, "utf8").trim() || null };
  const last = trace.lastSignal(SIGNAL);
  const due = !last || Date.now() - Date.parse(last.ts) >= cfg.signals.main_health.every_minutes * 60_000;
  return { due, afterSlug: null };
}

/**
 * Runs the test command on main in a throwaway detached worktree (`.loopstra/health/main`).
 * The baseline is the newest result that was not an error. Red after green opens a draft intent;
 * with no baseline yet the result is only recorded. Install or setup problems record `error`,
 * which never opens anything. Test output goes to the trace, never into the intent.
 */
export async function runMainHealth(root: string, cfg: Config, trace: Trace, afterSlug: string | null): Promise<HealthResult> {
  const git = new Git(root);
  const dir = join(root, ".loopstra", "health", "main");
  const timeoutMs = commandTimeoutMs(cfg);
  let result: HealthResult;
  let output: string;
  try {
    ({ result, output } = await withDetachedWorktree(git, dir, cfg.main_branch, async (cwd): Promise<{ result: HealthResult; output: string }> => {
      if (cfg.commands.install) {
        const i = await runCommand(cfg.commands.install, cwd, { timeoutMs });
        if (i.code !== 0) return { result: "error", output: `install failed: ${i.output.slice(-4000)}` };
      }
      const t = await runCommand(cfg.commands.test, cwd, { timeoutMs });
      return { result: t.code === 0 ? "pass" : "fail", output: t.output.slice(-4000) };
    }));
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    result = "error";
    output = e instanceof Error ? e.message : String(e);
  }
  const baseline = trace.lastSignal(SIGNAL, { excludeErrors: true });
  trace.signal(SIGNAL, result, output);
  rmSync(pendingPath(root), { force: true });
  if (result === "fail" && baseline?.result === "pass") await openFailureIntent(root, git, trace, afterSlug, output);
  return result;
}

/** Today's date in the machine's own time zone, as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function openFailureIntent(root: string, git: Git, trace: Trace, afterSlug: string | null, output: string): Promise<void> {
  const today = localDate();
  const slug = afterSlug ? `fix-tests-after-${afterSlug}` : `fix-tests-on-main-${today}`;
  const dir = join(root, "intent", slug);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const what = afterSlug ? `after the change "${afterSlug}" merged` : "on the main branch";
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
  trace.event(slug, "signal", { name: SIGNAL, result: "fail", after: afterSlug, output });
  await git.commitPaths([`intent/${slug}`], bookkeeping(`loopstra(${slug}): open intent for failing tests on main`));
}
