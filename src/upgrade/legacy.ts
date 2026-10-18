import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closestBase, wasShipped, type FetchText, type ShippedIndex } from "../shipped";
import { managedFiles, textSha, type Stamp } from "../stamp";

/** The hook file init used to write into a repository. */
export const OLD_HOOK_FILE = ".claude/hooks/loopstra-protect-tests.ts";
/** The text that marks the old hook's entry in .claude/settings.json. */
export const OLD_HOOK_MARK = "loopstra-protect-tests";

/** What adopting a repository set up before the stamp did, or would do. */
export interface Adopted {
  /** The stamp to start from: a base for every managed file that exists. Its version is filled in by the caller. */
  stamp: Stamp;
  /** Files deleted: unedited prompt copies and the old hook. */
  removed: string[];
  /** Files edited: .claude/settings.json when the hook entry was taken out. */
  changed: string[];
  /** One sentence per override whose base was guessed. */
  notes: string[];
}

/**
 * Brings a repository set up before the stamp to the new layout: an unedited prompt copy is deleted
 * (the package has it); an edited one is an override, based on the closest shipped version; the
 * other managed files get a base the same way; the old hook file and its settings entry go.
 */
export async function adoptLegacy(root: string, index: ShippedIndex, fetchText: FetchText, opts: { write: boolean }): Promise<Adopted> {
  const out: Adopted = { stamp: { loopstra: "", files: {} }, removed: [], changed: [], notes: [] };
  for (const file of managedFiles(root)) {
    const path = join(root, file.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const isPrompt = file.path.startsWith("loopstra/prompts/");
    if (wasShipped(index, file.template, text)) {
      if (isPrompt) {
        if (opts.write) rmSync(path);
        out.removed.push(file.path);
      } else {
        out.stamp.files[file.path] = { base: textSha(text) };
      }
      continue;
    }
    const best = await closestBase(index, file.template, text, fetchText);
    // No shipped version to go by: the file is treated as written from today's text, so nothing is merged into it.
    out.stamp.files[file.path] = { base: best ? best.sha : textSha(readFileSync(file.shipped, "utf8")) };
    if (isPrompt) out.notes.push(best ? `${file.path} is your own; it is merged from the shipped version of commit ${best.commit.slice(0, 7)}.` : `${file.path} is your own; no shipped version could be read, so it is left as it is.`);
  }

  const hook = join(root, OLD_HOOK_FILE);
  if (existsSync(hook)) {
    if (opts.write) {
      rmSync(hook);
      const dir = join(root, ".claude", "hooks");
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    }
    out.removed.push(OLD_HOOK_FILE);
  }
  const settingsRel = ".claude/settings.json";
  const settingsPath = join(root, settingsRel);
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown> | null = null;
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { /* not JSON: left alone */ }
    const hooks = settings?.hooks as Record<string, unknown[]> | undefined;
    const pre = hooks?.PreToolUse;
    if (settings && hooks && Array.isArray(pre) && pre.some((h) => JSON.stringify(h).includes(OLD_HOOK_MARK))) {
      const kept = pre.filter((h) => !JSON.stringify(h).includes(OLD_HOOK_MARK));
      if (kept.length) hooks.PreToolUse = kept; else delete hooks.PreToolUse;
      if (!Object.keys(hooks).length) delete settings.hooks;
      if (Object.keys(settings).length) {
        if (opts.write) writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        out.changed.push(settingsRel);
      } else {
        if (opts.write) rmSync(settingsPath);
        out.removed.push(settingsRel);
      }
    }
  }
  return out;
}
