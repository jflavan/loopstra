import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git";

/**
 * Putting back a record a write left on disk but never committed: the file as HEAD has it, only when it
 * still holds exactly what that write put there, over nobody's uncommitted edit (see src/apply.ts and
 * recordQuestion in src/questions.ts).
 */

/** The sha256 (hex) of a file as it is on disk, or null when it cannot be read. */
export function fileHash(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

/** True when a file (relative to the root) on disk is just what HEAD has: no uncommitted edit, and no uncommitted file where HEAD has none. */
export async function matchesHead(root: string, path: string): Promise<boolean> {
  const git = new Git(root);
  // A file main does not have is someone's own when it is on disk already (an uncommitted draft).
  if ((await git.run(["cat-file", "-e", `HEAD:${path}`], true)).code !== 0) return !existsSync(join(root, path));
  return (await git.run(["diff", "--quiet", "HEAD", "--", path], true)).code === 0;
}

/** A file as it is at HEAD, or gone when HEAD has none. Under the checkout lock. */
export async function asAtHead(git: Git, root: string, path: string): Promise<void> {
  if ((await git.run(["cat-file", "-e", `HEAD:${path}`], true)).code === 0) await git.run(["checkout", "HEAD", "--", path]);
  else {
    await git.run(["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
    rmSync(join(root, path), { force: true });
  }
}
