import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes a file whole: a temp file, then a rename over it, so a reader never sees half of it. Makes
 * its folder. The temp file goes beside it, or in `tmpDir` (on the same drive) when one left behind
 * by a kill must stay out of the file's folder. Windows refuses the rename while a reader has the
 * file open; a plain write is used then (and when the rename cannot cross to the file's drive).
 */
export function writeFileAtomic(path: string, text: string, tmpDir = dirname(path)): void {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, text); } finally { rmSync(tmp, { force: true }); }
  }
}

/** Writes a JSON file whole (see writeFileAtomic), so a reader never sees half of it. Makes its folder. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}

/** A JSON file's value as the caller expects it, or null when it is missing or not JSON. The shape is the caller's to check. */
export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
