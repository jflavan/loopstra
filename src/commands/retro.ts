import { loadConfig } from "../config";
import { buildRetro, retroText, windowStart } from "../retro";
import { Trace } from "../trace";
import { judgesView } from "./judges";

/** How many days `loopstra retro` looks back without --days. */
export const DEFAULT_DAYS = 7;

/**
 * `loopstra retro`: how the loop did over the last `days` days, and what to change. Read-only. Every
 * status move is read, not only the window's: a change merged in the window may have been accepted before it.
 */
export async function renderRetro(root: string, days: number): Promise<string> {
  const cfg = await loadConfig(root);
  const trace = Trace.open(root);
  try {
    const now = new Date();
    const since = windowStart(now, days);
    return retroText(buildRetro({
      days, now, cfg,
      moves: trace.statusChangesSince(new Date(0).toISOString()),
      gates: trace.gatesSince(since),
      phases: trace.phasesSince(since),
      questions: trace.eventsOfTypeSince("question", since),
      requests: trace.eventsOfTypeSince("request", since),
      judges: judgesView(root, cfg, trace),
    }));
  } finally {
    trace.close();
  }
}
