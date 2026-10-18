import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { configPath, NOT_SET_UP, validateConfig } from "../config";
import { writeFileAtomic } from "../fsutil";
import { Git } from "../git";
import { heartbeatState, readHeartbeat } from "../heartbeat";
import { onCheckout } from "../lanes";
import { DEV_VERSION, stampVersion } from "../package";
import { errorText } from "../shell";
import { closestBase, fetchShipped, loadShippedIndex, type FetchText, type ShippedIndex } from "../shipped";
import { managedFiles, readStamp, STAMP_FILE, textSha, writeStamp, type Stamp } from "../stamp";
import { upgradeFile, type FileResult } from "./files";
import { adoptLegacy, OLD_HOOK_FILE, type Adopted } from "./legacy";
import { migrateConfig, MIGRATIONS, type Migration } from "./migrations";

/** What upgrade says when the loop is running in the repository. */
export const LOOP_RUNNING = "The loop is running. Stop it (Ctrl-C in its terminal), run loopstra upgrade, then start it again.";

const CONFIG = "loopstra/config.yaml";
const SETTINGS = ".claude/settings.json";

/** What the repository step needs from outside, injectable for tests. */
export interface RepoDeps {
  /** The shipped-texts index. */
  index: () => Promise<ShippedIndex>;
  /** Gets a template's text at a commit. */
  fetchText: FetchText;
  /** The version being upgraded to (the stamp's new `loopstra`). */
  version: () => Promise<string>;
  /** Release notes between two versions, as Markdown lines; "" when there are none or they cannot be read. */
  notes: (from: string, to: string) => Promise<string>;
  /** The config migrations; MIGRATIONS when not given (tests pass their own). */
  migrations?: readonly Migration[];
}

/** The real dependencies: the installed package's index and version; release notes come with the tool step. */
export const REAL_DEPS: RepoDeps = { index: loadShippedIndex, fetchText: fetchShipped, version: stampVersion, notes: async () => "" };

/** What the repository step did, or would do (`check`), or why it did nothing. */
export interface RepoResult {
  ok: boolean;
  /** Why nothing was done, in plain words. */
  refusal?: string;
  /** The version the stamp named; null when the repository had no stamp. */
  from: string | null;
  to: string;
  /** Each managed file's outcome. */
  files: FileResult[];
  /** Files deleted (unedited prompt copies, the old hook, settings left empty without it). */
  removed: string[];
  /** Other files changed (the config, .claude/settings.json). */
  changed: string[];
  /** Sentences for the person: the base each of their own files is merged from, and what is left to them. */
  notes: string[];
  /** With `check`: what a real upgrade would refuse for now (the loop running, uncommitted files). */
  warnings: string[];
  committed: boolean;
}

/**
 * The paths `git status --porcelain -z` lists: one NUL-ended entry per path ("XY path"), and a rename
 * or copy followed by its original path as a further entry. Both paths of a rename are named.
 */
export function statusPaths(out: string): string[] {
  const entries = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]!);
  }
  return [...new Set(paths)];
}

/** The config's main branch and poll interval, read leniently: a config that only loads after a migration still names them. */
function loopSettings(text: string): { main: string; poll: number } {
  let raw: unknown = null;
  try { raw = parse(text); } catch { /* the migration step names the problem */ }
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    main: typeof cfg.main_branch === "string" && cfg.main_branch ? cfg.main_branch : "main",
    poll: typeof cfg.poll_seconds === "number" && cfg.poll_seconds > 0 ? cfg.poll_seconds : 60,
  };
}

/** True for a published version, not a development checkout's. */
const released = (v: string | null): v is string => !!v && !v.startsWith(DEV_VERSION);

/**
 * Brings the repository at `root` up to the installed Loopstra (spec: "loopstra upgrade", steps 2-6):
 * refuses when the loop is running, the checkout is not on main, or a managed file, the stamp or the
 * config has uncommitted changes; then works out every file's outcome and the config migration, and
 * only when all of that succeeded writes them and the stamp and commits them as the runtime, in one
 * commit (files left with conflict markers stay out of it). `check`: say what would happen and write
 * nothing; a running loop or uncommitted files are then listed in `warnings` instead of refused.
 */
export async function upgradeRepo(root: string, opts: { check: boolean }, deps: RepoDeps = REAL_DEPS): Promise<RepoResult> {
  const to = await deps.version();
  const stamp = readStamp(root);
  const result: RepoResult = { ok: false, from: stamp?.loopstra ?? null, to, files: [], removed: [], changed: [], notes: [], warnings: [], committed: false };
  const refuse = (refusal: string): RepoResult => ({ ...result, ok: false, refusal });

  // Checks: a real upgrade works out and writes nothing unless they all pass.
  if (!existsSync(configPath(root))) return refuse(NOT_SET_UP);
  const cfgText = readFileSync(configPath(root), "utf8");
  const { main, poll } = loopSettings(cfgText);
  const git = new Git(root);
  const branch = await git.currentBranch();
  if (branch !== main) return refuse(`The checkout is on ${branch || "no branch"}, not ${main}. Switch to ${main}, then run loopstra upgrade again.`);
  // --check writes nothing, so what would stop a real upgrade is only reported.
  const stop = (why: string): RepoResult | null => {
    if (!opts.check) return refuse(why);
    result.warnings.push(why);
    return null;
  };
  // A loop that is not responding but whose process is alive may still be running.
  const loop = heartbeatState(readHeartbeat(root), poll).state;
  if (loop === "running" || loop === "paused" || loop === "not-responding") {
    const refused = stop(LOOP_RUNNING);
    if (refused) return refused;
  }
  const watched = [...new Set([CONFIG, STAMP_FILE, SETTINGS, OLD_HOOK_FILE, ...managedFiles(root, stamp).map((f) => f.path)])];
  const dirty = statusPaths((await git.run(["status", "--porcelain", "-z", "--", ...watched])).out);
  if (dirty.length) {
    const refused = stop(`These files have changes that are not committed: ${dirty.join(", ")}. Commit or undo them, then run loopstra upgrade again.`);
    if (refused) return refused;
  }

  // Work everything out, writing nothing.
  const index = await deps.index();
  let adopted: Adopted | null = null;
  let base: Stamp;
  let migrated: { text: string };
  try {
    if (stamp) {
      base = { loopstra: stamp.loopstra, files: { ...stamp.files } };
    } else {
      adopted = await adoptLegacy(root, index, deps.fetchText, { write: false });
      base = adopted.stamp;
      result.removed.push(...adopted.removed);
      result.changed.push(...adopted.changed);
      result.notes.push(...adopted.notes);
    }
    const removed = new Set(result.removed);
    // A managed file with no stamp entry (an override made by hand): its base is the shipped version
    // it is, else the closest one. With no shipped version known, today's text (nothing is merged into
    // it until that changes). Versions known but none readable (offline): refused, as adoptLegacy does.
    for (const f of managedFiles(root, base)) {
      const path = join(root, f.path);
      if (base.files[f.path] || removed.has(f.path) || !existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      const sha = textSha(text);
      const versions = index[f.template] ?? [];
      if (!versions.length) { base.files[f.path] = { base: textSha(readFileSync(f.shipped, "utf8")) }; continue; }
      const best = versions.some((e) => e.sha === sha) ? { sha } : await closestBase(index, f.template, text, deps.fetchText);
      if (!best) throw new Error(`Loopstra's shipped versions of ${f.path} could not be read to merge from; check the connection and run loopstra upgrade again.`);
      base.files[f.path] = { base: best.sha };
    }
    const baseFor = (template: string) => async (sha: string) => {
      const entry = (index[template] ?? []).find((e) => e.sha === sha);
      return entry ? deps.fetchText(template, entry.commit) : null;
    };
    for (const f of managedFiles(root, base)) {
      if (removed.has(f.path)) continue;
      result.files.push(await upgradeFile(root, f, base.files[f.path], baseFor(f.template), { write: false }));
    }
  } catch (e) {
    return refuse(errorText(e));
  }
  try {
    // Checked only when a migration changed it: a config left as it is is the loop's to report on (its preflight does).
    migrated = migrateConfig(cfgText, deps.migrations ?? MIGRATIONS, (t) => { if (t !== cfgText) validateConfig(parse(t) ?? {}); });
  } catch (e) {
    return refuse(`The config could not be brought up to date, so nothing was changed: ${errorText(e)}`);
  }
  if (migrated.text !== cfgText) result.changed.push(CONFIG);
  const next: Stamp = { loopstra: to, files: Object.fromEntries(result.files.map((r) => [r.path, r.entry])) };
  result.ok = true;
  if (opts.check) return result;

  // Write, then commit.
  adopted?.apply();
  for (const r of result.files) if (r.text !== undefined) writeFileAtomic(join(root, r.path), r.text);
  if (migrated.text !== cfgText) writeFileAtomic(configPath(root), migrated.text);
  writeStamp(root, next);

  const conflicted = new Set(result.files.filter((f) => f.outcome === "conflict").map((f) => f.path));
  const paths = [...new Set([STAMP_FILE, ...result.removed, ...result.changed, ...result.files.map((f) => f.path)])].filter((p) => !conflicted.has(p));
  // Notes only between two releases: a first upgrade, or one from a development checkout, would list every release.
  const notes = released(result.from) && released(to) ? await deps.notes(result.from, to) : "";
  const subject = `loopstra: upgrade to ${to}${result.from && result.from !== to ? ` (from ${result.from})` : ""}`;
  const message = notes ? `${subject}\n\n${notes}` : subject;
  result.committed = await onCheckout(root, async () => {
    // One path at a time: `add -A` stages a deleted file's removal, and errors on a path git has never seen (a settings file that never existed).
    for (const p of paths) await git.run(["add", "-A", "--", p], true);
    const staged = (await git.run(["diff", "--cached", "--name-only", "--", ...paths])).out.split(/\r?\n/).filter(Boolean);
    if (!staged.length) return false;
    // Only these paths: anything else a person has staged stays staged and out of the commit.
    await git.runtime("commit", ["-q", "-m", message, "--", ...staged]);
    return true;
  });
  return result;
}
