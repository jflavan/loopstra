import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../fsutil";
import { baseOf, wasShipped, type FetchText, type ShippedIndex } from "../shipped";
import { isPromptOverride, managedFiles, textSha, type Stamp } from "../stamp";

/** The hook file init used to write into a repository. */
export const OLD_HOOK_FILE = ".claude/hooks/loopstra-protect-tests.ts";
/** The text that marks the old hook's entry in .claude/settings.json. */
export const OLD_HOOK_MARK = "loopstra-protect-tests";

const SETTINGS = ".claude/settings.json";

/** What adopting a repository set up before the stamp did, or would do. */
export interface Adopted {
  /** The stamp to start from: a base for every managed file that exists, and "deleted" for a fixed one that does not. Its version is filled in by the caller. */
  stamp: Stamp;
  /** Files deleted: unedited prompt copies and the old hook. */
  removed: string[];
  /** Files edited: .claude/settings.json when the hook entry was taken out. */
  changed: string[];
  /** One sentence per edited managed file, naming the base it is merged from, and per thing left for a person. */
  notes: string[];
  /** Makes the deletions and edits above (done already with `write` true), for a caller that writes once everything else is worked out too. */
  apply: () => void;
}

/** The settings with the old hook's entry taken out: their new text, or null when nothing else is left in them. */
function withoutOldHook(settings: Record<string, unknown>): string | null {
  const hooks = settings.hooks as Record<string, unknown[]>;
  const kept = hooks.PreToolUse!.filter((h) => !JSON.stringify(h).includes(OLD_HOOK_MARK));
  if (kept.length) hooks.PreToolUse = kept; else delete hooks.PreToolUse;
  if (!Object.keys(hooks).length) delete settings.hooks;
  return Object.keys(settings).length ? `${JSON.stringify(settings, null, 2)}\n` : null;
}

/**
 * The parsed settings when they hold the old hook's entry; null when they do not; "invalid" when
 * they are not JSON but name the old hook (settings that never had it are left alone).
 */
function settingsWithOldHook(path: string): Record<string, unknown> | null | "invalid" {
  const raw = readFileSync(path, "utf8");
  let settings: unknown;
  try { settings = JSON.parse(raw); } catch { return raw.includes(OLD_HOOK_MARK) ? "invalid" : null; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const hooks = (settings as Record<string, unknown>).hooks as Record<string, unknown> | undefined;
  const pre = hooks && typeof hooks === "object" ? hooks.PreToolUse : undefined;
  return Array.isArray(pre) && pre.some((h) => JSON.stringify(h).includes(OLD_HOOK_MARK)) ? (settings as Record<string, unknown>) : null;
}

/**
 * Brings a repository set up before the stamp to the new layout: an unedited prompt copy is deleted
 * (the package has it); an edited one is an override, based on the closest shipped version; the
 * other managed files get a base the same way, and one of them that is not there is recorded as
 * removed on purpose (as an upgrade records a removal it sees), so the first upgrade does not bring
 * it back; the old hook file and its settings entry go.
 *
 * Everything is worked out before anything is written. When an edited file has shipped versions but
 * none can be read (offline), it throws and writes nothing, so the upgrade can be run again: taking
 * today's text as its base would mean never merging what changed since its real one.
 */
export async function adoptLegacy(root: string, index: ShippedIndex, fetchText: FetchText, opts: { write: boolean }): Promise<Adopted> {
  const writes: Array<() => void> = [];
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    for (const w of writes) w();
  };
  const out: Adopted = { stamp: { loopstra: "", files: {} }, removed: [], changed: [], notes: [], apply };
  for (const file of managedFiles(root)) {
    const path = join(root, file.path);
    if (!existsSync(path)) {
      // Only the fixed files can be missing: the overrides listed are the ones in the folder.
      if (isPromptOverride(file.path)) continue;
      out.stamp.files[file.path] = { base: textSha(readFileSync(file.shipped, "utf8")), deleted: true };
      out.notes.push(`${file.path} is not in this repository; it is recorded as removed on purpose, and upgrades leave it out.`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (isPromptOverride(file.path) && wasShipped(index, file.template, text)) {
      writes.push(() => {
        rmSync(path);
        // No overrides left: the folder goes too (customize makes it again).
        const dir = join(root, "loopstra", "prompts");
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      });
      out.removed.push(file.path);
      continue;
    }
    const base = await baseOf(index, file, text, fetchText);
    out.stamp.files[file.path] = { base: base.sha };
    if (base.note) out.notes.push(base.note);
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

  if (opts.write) apply();
  return out;
}
