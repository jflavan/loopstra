import { join } from "node:path";

/** Loopstra's own folder in a repository: the trace, the runs, the heartbeat, requests (ignored by git). */
export function loopstraDir(root: string): string {
  return join(root, ".loopstra");
}

/** The run folders of every change, `.loopstra/runs/`. */
export function runsDir(root: string): string {
  return join(loopstraDir(root), "runs");
}

/** A change's run folder, `.loopstra/runs/<slug>/`: its session records, inbox, question and markers. */
export function runDir(root: string, slug: string): string {
  return join(runsDir(root), slug);
}
