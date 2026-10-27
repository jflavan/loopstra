import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../fsutil";
import { spawnBounded } from "../shell";
import { isPromptOverride, textSha, type ManagedFile, type StampEntry } from "../stamp";
import { isCrlf } from "../text";

/**
 * What upgrade did, or would do, to one managed file. "dropped": a prompt override was deleted, so
 * its stamp entry goes and the shipped prompt is used.
 */
export type FileOutcome = "unchanged" | "replaced" | "merged" | "conflict" | "no-base" | "added" | "deleted" | "dropped";

/** One managed file's outcome and its stamp entry afterwards. */
export interface FileResult {
  path: string;
  outcome: FileOutcome;
  /** The file's stamp entry afterwards; absent when the file leaves the stamp (a deleted override). */
  entry?: StampEntry;
  /** The text written to the file (or, with `write` false, that would be); absent when it is left as it is. */
  text?: string;
}

/** Gets the shipped text whose textSha is `sha`, or null. */
type BaseFor = (sha: string) => Promise<string | null>;

/** How long one merge may take before it is stopped. */
const MERGE_TIMEOUT_MS = 60_000;

const lf = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * A 3-way merge with `git merge-file`, all three as `\n` text: the merged text, and whether it has
 * conflict markers. git exits with the number of conflicts (1 to 127) or, when it cannot merge at
 * all, with a code above 127; that is thrown. `git` is the executable to run (tests name one that
 * does not exist).
 */
export async function mergeText(theirs: string, base: string, next: string, git = "git"): Promise<{ text: string; conflict: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "loopstra-merge-"));
  try {
    const [a, o, b] = [join(dir, "theirs"), join(dir, "base"), join(dir, "new")];
    writeFileSync(a, lf(theirs)); writeFileSync(o, lf(base)); writeFileSync(b, lf(next));
    const r = await spawnBounded({
      cmd: [git, "merge-file", "-p", "-L", "yours", "-L", "base", "-L", "loopstra", a, o, b],
      cwd: dir, timeoutMs: MERGE_TIMEOUT_MS, onStop: "ignore",
    });
    if (!r.started) throw new Error(`git merge-file could not be started: ${r.err}`);
    if (r.timedOut) throw new Error(`git merge-file did not finish within ${MERGE_TIMEOUT_MS / 1000}s`);
    if (r.code === null || r.code < 0 || r.code > 127) throw new Error(`git merge-file failed (${r.code ?? "no exit code"}): ${r.err.trim()}`);
    return { text: r.out, conflict: r.code > 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Applies the managed-file rules (spec: "Rules for a managed file") to one file. `entry` is its
 * stamp entry (undefined: Loopstra never wrote it). With `write` false it only says what it would do
 * (and gives the text it would write, for a caller that writes later).
 */
export async function upgradeFile(root: string, file: ManagedFile, entry: StampEntry | undefined, baseFor: BaseFor, opts: { write: boolean }): Promise<FileResult> {
  const target = join(root, file.path);
  const next = readFileSync(file.shipped, "utf8");
  const nextSha = textSha(next);
  let written: string | undefined;
  const done = (outcome: FileOutcome, e: StampEntry | undefined): FileResult => ({
    path: file.path, outcome, ...(e === undefined ? {} : { entry: e }), ...(written === undefined ? {} : { text: written }),
  });
  const put = (text: string) => {
    written = text;
    if (opts.write) writeFileAtomic(target, text);
  };

  if (!existsSync(target)) {
    // A deleted override means going back to the shipped prompt: its entry goes, nothing is written.
    if (isPromptOverride(file.path)) return done(entry ? "dropped" : "unchanged", undefined);
    // A fixed managed file is recorded as deleted once, when the removal is first seen; after that it is simply left out.
    if (entry?.deleted) return done("unchanged", { base: entry.base, deleted: true });
    if (entry) return done("deleted", { base: entry.base, deleted: true });
    put(next);
    return done("added", { base: nextSha });
  }
  const theirs = readFileSync(target, "utf8");
  const theirSha = textSha(theirs);
  if (theirSha === nextSha) return done("unchanged", { base: nextSha });
  if (entry && theirSha === entry.base) {
    put(isCrlf(theirs) ? lf(next).replace(/\n/g, "\r\n") : next);
    return done("replaced", { base: nextSha });
  }
  if (entry && entry.base === nextSha) return done("unchanged", { base: nextSha });
  // No entry: the caller found no base for the file (see upgradeRepo); it is treated as written from today's text, so nothing is merged into it now.
  const base = entry ? await baseFor(entry.base) : null;
  if (base === null) return done("no-base", entry ?? { base: nextSha });
  const merged = await mergeText(theirs, base, next);
  put(isCrlf(theirs) ? merged.text.replace(/\n/g, "\r\n") : merged.text);
  // A conflict also moves the base on: once the person resolves and commits the file, the shipped
  // changes are in it, and the next upgrade must not merge (and conflict over) them again.
  return done(merged.conflict ? "conflict" : "merged", { base: nextSha });
}
