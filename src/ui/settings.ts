import { MODEL_REFS } from "../models";

/*
 * The Settings page's plain logic: what a picker offers, what a waiting change says, and the one
 * check on a model's name that the page makes before sending (the console checks it again).
 */

/** What a picker offers. A step may also go back to its default (null); a group or a named model always has a model. */
export function pickerChoices(row: { path: string | null; own: unknown }): Array<{ value: string | null; label: string }> {
  const refs: Array<{ value: string | null; label: string }> = MODEL_REFS.map((r) => ({ value: r, label: r }));
  return row.path?.includes(".steps.") ? [{ value: null, label: "Default" }, ...refs] : refs;
}

/** What a change that waits says: saved by the loop when it next runs if the loop is not running. */
export function pendingText(loop: string): string {
  return loop === "stopped" || loop === "not-responding" ? "Saved when the loop next runs." : "Saving…";
}

/** Why a named model's text cannot be sent, or null. The same rule the console applies: one word, like sonnet. */
export function nameProblem(s: string): string | null {
  if (!s) return "A model name cannot be empty.";
  return /\s/.test(s) ? "A model name has no spaces, like sonnet or claude-opus-5-5." : null;
}
