import type { SettingsView } from "../console/types";
import { MODEL_REFS } from "../models";
import { ago } from "./format";

/*
 * The Settings page's plain logic: what a picker offers, what a named model last ran on, what a
 * waiting change says, and the quick check on a model's name that the page makes before sending (the
 * loop checks it in full).
 */

/**
 * What a picker offers. A step may also go back to its default (null), offered as setup's word for it
 * with that default shown: `auto (follows build: default)`, `auto (strong)`. A group or a named model
 * always has a model.
 */
export function pickerChoices(row: { path: string | null; byDefault?: string }): Array<{ value: string | null; label: string }> {
  const refs: Array<{ value: string | null; label: string }> = MODEL_REFS.map((r) => ({ value: r, label: r }));
  return row.path?.includes(".steps.") ? [{ value: null, label: row.byDefault ? `auto (${row.byDefault})` : "auto" }, ...refs] : refs;
}

/**
 * What a named model last ran on, by the name the session asked for then (the name may have changed
 * since): "opus → claude-opus-5-5, 4m ago", "failed: opuss is not a model" or "not used yet".
 */
export function lastRanText(last: SettingsView["models"][number]["last"], at: number): string {
  if (!last) return "not used yet";
  if (last.result === "bad-model") return `failed: ${last.asked} is not a model`;
  const t = ago(last.ts, at);
  return `${last.asked} → ${last.ran ?? last.asked}, ${t === "now" || t === "–" ? t : `${t} ago`}`;
}

/** What a change that waits says: saved by the loop when it next runs if the loop is not running. */
export function pendingText(loop: string): string {
  return loop === "stopped" || loop === "not-responding" ? "Saved when the loop next runs." : "Saving…";
}

/**
 * Why a named model's text cannot be sent, or null: the page's quick check, one word like sonnet. The
 * loop checks the rest (see modelName in src/setup/sections/models.ts) and says why when it refuses.
 */
export function nameProblem(s: string): string | null {
  if (!s) return "A model name cannot be empty.";
  return /\s/.test(s) ? "A model name has no spaces, like sonnet or claude-opus-5-5." : null;
}
