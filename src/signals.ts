import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { Git } from "./git";
import { runCommand } from "./shell";
import type { Trace } from "./trace";

/**
 * Runs the test command on the main branch in a clean, temporary worktree.
 * Green after green: nothing. Red after green: opens a draft intent. Red after red: nothing new.
 */
export async function runMainHealth(root: string, cfg: Config, trace: Trace, afterSlug: string | null): Promise<"pass" | "fail" | "error"> {
  const git = new Git(root);
  const wt = join(root, ".loopstra", "worktrees", "_main-health");
  let result: "pass" | "fail" | "error";
  let output = "";
  try {
    if (existsSync(wt)) { await git.worktreeRemove(wt); }
    mkdirSync(join(root, ".loopstra", "worktrees"), { recursive: true });
    await git.run(["worktree", "add", "--detach", wt, cfg.main_branch]);
    if (cfg.commands.install) await runCommand(cfg.commands.install, wt);
    const r = await runCommand(cfg.commands.test, wt);
    result = r.code === 0 ? "pass" : "fail";
    output = r.output.slice(-4000);
  } catch (e) {
    result = "error";
    output = (e as Error).message;
  } finally {
    try { if (existsSync(wt)) await git.worktreeRemove(wt); } catch { rmSync(wt, { recursive: true, force: true }); }
  }
  const previous = trace.signals(1)[0]?.result ?? "pass";
  trace.signal("main_health", result, output);
  if (result === "fail" && previous === "pass") await openFailureIntent(root, git, afterSlug, output);
  return result;
}

async function openFailureIntent(root: string, git: Git, afterSlug: string | null, output: string): Promise<void> {
  const slug = afterSlug ? `fix-tests-after-${afterSlug}` : `fix-tests-on-main-${new Date().toISOString().slice(0, 10)}`;
  const dir = join(root, "intent", slug);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const lastLines = output.trim().split(/\r?\n/).slice(-15).join("\n");
  const what = afterSlug ? `after the change "${afterSlug}" merged` : "on the main branch";
  await Bun.write(join(dir, "intent.md"), `---
status: draft
priority: high
author: loopstra
opened: ${new Date().toISOString().slice(0, 10)}
note: "Opened automatically because the tests on main started failing. Review it and set status to accepted, or closed."
---
# Intent: tests broke ${what}

## Problem
Before this, the tests on main passed. Now they fail. The last lines of the test output were:

\`\`\`
${lastLines}
\`\`\`

## Proposed outcome
The tests on main pass again.

## Done when
- The test command exits successfully on main.

## Affected users and systems
Everyone working on this repository.

## Open questions
Should the change be reverted, or fixed forward?
`);
  await git.commitPaths([`intent/${slug}`], `loopstra(${slug}): open intent for failing tests on main`);
}
