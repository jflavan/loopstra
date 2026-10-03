import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a file whole: a temp file beside it, then a rename over it, so a reader never sees half of
 * it. Makes its folder. Windows refuses the rename while a reader has the file open; a plain write
 * is used then.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, text);
    rmSync(tmp, { force: true });
  }
}
