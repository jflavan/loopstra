import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { z } from "zod";

/**
 * Writes a file whole: a temp file, then a rename over it, so a reader never sees half of it. Makes
 * its folder. The temp file goes beside it, or in `tmpDir` (on the same drive) when one left behind
 * by a kill must stay out of the file's folder. Windows refuses the rename while another process
 * has either file open (a reader, or an antivirus scanning the temp file just written); the rename is
 * tried again a few times over about 100 ms, since a scan's hold passes quickly, and only then is a
 * plain write used (as it is at once when the rename cannot cross to the file's drive).
 */
export function writeFileAtomic(path: string, text: string, tmpDir = dirname(path)): void {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  for (let tries = 1; ; tries++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (tries < RENAME_TRIES && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) { Bun.sleepSync(RENAME_WAIT_MS); continue; }
      try { writeFileSync(path, text); } finally { rmSync(tmp, { force: true }); }
      return;
    }
  }
}

/** How often writeFileAtomic tries a refused rename, and how long it waits between tries. */
const RENAME_TRIES = 5;
const RENAME_WAIT_MS = 25;

/** Writes a JSON file whole (see writeFileAtomic), so a reader never sees half of it. Makes its folder. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}

/** A JSON file's value as the caller expects it, or null when it is missing or not JSON. The shape is the caller's to check. */
export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/**
 * A JSON file's value checked against `schema` (with its defaults filled in), or null when the file
 * is missing, not JSON, or not that shape: a file someone else wrote, or half of one, is never read
 * as the real thing.
 */
export function readJsonAs<T>(path: string, schema: z.ZodType<T>): T | null {
  const raw = readJson<unknown>(path);
  if (raw === null) return null;
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}
