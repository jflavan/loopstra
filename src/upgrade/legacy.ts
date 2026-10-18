import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../fsutil";
import { closestBase, wasShipped, type FetchText, type ShippedIndex } from "../shipped";
import { managedFiles, textSha, type Stamp } from "../stamp";

/** The hook file init used to write into a repository. */
export const OLD_HOOK_FILE = ".claude/hooks/loopstra-protect-tests.ts";
/** The text that marks the old hook's entry in .claude/settings.json. */
export const OLD_HOOK_MARK = "loopstra-protect-tests";

const SETTINGS = ".claude/settings.json";

/** What adopting a repository set up before the stamp did, or would do. */
export interface Adopted {
  /** The stamp to start from: a base for every managed file that exists. Its version is filled in by the caller. */
  stamp: Stamp;
  /** Files deleted: unedited prompt copies and the old hook. */
  removed: string[];
  /** Files edited: .claude/settings.json when the hook entry was taken out. */
  changed: string[];
  /** One sentence per edited managed file, naming the base it is merged from, and per thing left for a person. */
  notes: string[];
}

/** The settings with the old hook's entry taken out: their new text, or null when nothing else is left in them. */
function withoutOldHook(settings: Record<string, unknown>): string | null {
  const hooks = settings.hooks as Record<string, unknown[]>;
  const kept = hooks.PreToolUse!.filter((h) => !JSON.stringify(h).includes(OLD_HOOK_MARK));
  if (kept.length) hooks.PreToolUse = kept; else delete hooks.PreToolUse;
  if (!Object.keys(hooks).length) delete settings.hooks;
  return Object.keys(settings).length ? `${JSON.stringify(settings, null, 2)}\n` : null;
}

/** The parsed settings when they hold the old hook's entry; null when they do not; "invalid" when they are not JSON. */
function settingsWithOldHook(path: string): Record<string, unknown> | null | "invalid" {
  let settings: unknown;
  try { settings = JSON.parse(readFileSync(path, "utf8")); } catch { return "invalid"; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const hooks = (settings as Record<string, unknown>).hooks as Record<string, unknown> | undefined;
  const pre = hooks && typeof hooks === "object" ? hooks.PreToolUse : undefined;
  return Array.isArray(pre) && pre.some((h) => JSON.stringify(h).includes(OLD_HOOK_MARK)) ? (settings as Record<string, unknown>) : null;
}

/**
 * Brings a repository set up before the stamp to the new layout: an unedited prompt copy is deleted
 * (the package has it); an edited one is an override, based on the closest shipped version; the
 * other managed files get a base the same way; the old hook file and its settings entry go.
 *
 * Everything is worked out before anything is written. When an edited file has shipped versions but
 * none can be read (offline), it throws and writes nothing, so the upgrade can be run again: taking
 * today's text as its base would mean never merging what changed since its real one.
 */
export async function adoptLegacy(root: string, index: ShippedIndex, fetchText: FetchText, opts: { write: boolean }): Promise<Adopted> {
  const out: Adopted = { stamp: { loopstra: "", files: {} }, removed: [], changed: [], notes: [] };
  const writes: Array<() => void> = [];
  for (const file of managedFiles(root)) {
    const path = join(root, file.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (wasShipped(index, file.template, text)) {
      if (file.path.startsWith("loopstra/prompts/")) {
        writes.push(() => rmSync(path));
        out.removed.push(file.path);
      } else {
        out.stamp.files[file.path] = { base: textSha(text) };
      }
      continue;
    }
    if (!(index[file.template] ?? []).length) {
      // No shipped version to go by: the file is treated as written from today's text, so nothing is merged into it.
      out.stamp.files[file.path] = { base: textSha(readFileSync(file.shipped, "utf8")) };
      out.notes.push(`${file.path} is your own; Loopstra knows no earlier version of it, so it is left as it is.`);
      continue;
    }
    const best = await closestBase(index, file.template, text, fetchText);
    if (!best) throw new Error(`Loopstra's shipped versions of ${file.path} could not be read to merge from; check the connection and run loopstra upgrade again.`);
    out.stamp.files[file.path] = { base: best.sha };
    out.notes.push(`${file.path} is your own; it is merged from the shipped version of commit ${best.commit.slice(0, 7)}.`);
  }

  const hook = join(root, OLD_HOOK_FILE);
  if (existsSync(hook)) {
    writes.push(() => {
      rmSync(hook);
      const dir = join(root, ".claude", "hooks");
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    });
    out.removed.push(OLD_HOOK_FILE);
  }
  const settingsPath = join(root, SETTINGS);
  const settings = existsSync(settingsPath) ? settingsWithOldHook(settingsPath) : null;
  if (settings === "invalid") {
    out.notes.push(`${SETTINGS} is not valid JSON, so the old test-hook entry was not removed; remove it by hand.`);
  } else if (settings) {
    const text = withoutOldHook(settings);
    if (text === null) {
      writes.push(() => rmSync(settingsPath));
      out.removed.push(SETTINGS);
    } else {
      writes.push(() => writeFileAtomic(settingsPath, text));
      out.changed.push(SETTINGS);
    }
  }

  if (opts.write) for (const w of writes) w();
  return out;
}
