import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ARTIFACTS, intentRoot, SLUG } from "../intents";

/** Files a phase can leave behind, in the order the console lists them. */
export const PHASE_FILES = ["prompt.md", "envelope.json", "raw.jsonl"] as const;

export function runsDir(root: string): string {
  return join(root, ".loopstra", "runs");
}

/**
 * The real path of a file under `.loopstra/runs/`, or null. `rel` is the part of the URL after
 * `/files/`, already decoded. Refuses `..`, absolute and drive paths, stream names, anything that
 * is not a regular file, and anything whose real path (after links) leaves the runs directory.
 */
export function resolveRunFile(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.includes(":") || isAbsolute(rel) || /^[\\/]/.test(rel)) return null;
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) return null;
  const base = runsDir(root);
  if (!existsSync(base)) return null;
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(resolve(base, ...parts));
    if (!real.startsWith(realBase + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * The real path of one of a change's own documents, `intent/<slug>/<name>`, or null. The slug must
 * be a valid change name and the name one of the documents Loopstra knows (intent.md, spec.md, ...);
 * the real path (after links) must stay inside the change's folder and be a regular file, and the
 * change's folder must itself be inside the intent folder (a linked folder could be anywhere).
 */
export function resolveDocument(root: string, slug: string, name: string): string | null {
  if (!SLUG.test(slug) || !(ARTIFACTS as readonly string[]).includes(name)) return null;
  const dir = join(intentRoot(root), slug);
  try {
    const realRoot = realpathSync(intentRoot(root));
    const realDir = realpathSync(dir);
    const real = realpathSync(join(dir, name));
    if (!realDir.startsWith(realRoot + sep) || !real.startsWith(realDir + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
