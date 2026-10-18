/*
 * Which sessions a person may steer, and how the runner words what it writes to them. Shared by the
 * loop (src/steering.ts, src/claude.ts) and the page, so it must never import server code.
 */

/** The work sessions a person may message or redirect (any session may be stopped). Shared by the loop and the page. */
export const STEERABLE_PHASES = ["intake", "design", "plan", "build", "fix", "reconcile", "revise", "lessons"] as const;

/**
 * A phase row's name as the phase it runs: "fix-2" → fix, "early-lessons" → lessons, "design-retry" → design,
 * "review-1" → review, "fix-after-verify" → fix, "design-fresh-retry" → design, "spec-check-cheap" → spec-check.
 */
export function phaseKind(name: string): string {
  let kind = name.replace(/^early-/, "");
  for (let before = ""; before !== kind;) {
    before = kind;
    kind = kind.replace(/-(retry|fresh|cheap|after-verify|\d+)$/, "");
  }
  return kind;
}

/** True when a person may message or redirect a session of this phase (a phase's name, or its row's). */
export function steerable(name: string): boolean {
  return (STEERABLE_PHASES as readonly string[]).includes(phaseKind(name));
}

/** The words the runner starts a message and a redirect with (see src/steering.ts); the transcript shows those echoes. */
export const MESSAGE_LEAD = "A message from";
export const REDIRECT_LEAD = "A change of direction from";

/** The words the runner ends a message and a redirect with, after a blank line; the transcript leaves them out. */
export const MESSAGE_TAIL = "Take it into account and carry on. Your final answer keeps the same format.";
export const REDIRECT_TAIL = "Stop what you were doing and work this way instead. Your final answer keeps the same format.";

/** What heads, in a redirect's prompt, the messages the killed process had not taken up yet (see src/claude.ts); the transcript shows each. */
export const MEANWHILE_HEADING = "Messages sent meanwhile:";
