import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `.loopstra/wake`: written whenever someone asks the loop for something (a request, a resume). The
 * loop's sleep between ticks checks it every second and starts the next tick as soon as it changes.
 */
export function wakePath(root: string): string {
  return join(root, ".loopstra", "wake");
}

let touches = 0;

/** Asks the loop to start its next tick now. Never throws: without the file the loop starts on its poll as before. */
export function touchWake(root: string): void {
  try {
    mkdirSync(dirname(wakePath(root)), { recursive: true });
    writeFileSync(wakePath(root), `${Date.now()}-${process.pid}-${touches++}`);
  } catch { /* the loop's own poll still comes */ }
}

/** What the wake file says now ("" when there is none); a change means someone woke the loop. */
export function wakeStamp(root: string): string {
  try { return readFileSync(wakePath(root), "utf8"); } catch { return ""; }
}
