import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil";
import { templatePath } from "./package";

/** The committed record of the Loopstra version a repository is on and where each managed file came from. */
export const STAMP_FILE = "loopstra/stamp.json";

/** One managed file's line in the stamp. */
export interface StampEntry {
  /** textSha of the shipped text the file was last written from or merged to. */
  base: string;
  /** The repository removed the file on purpose; upgrade does not bring it back. */
  deleted?: true;
}

/** A repository's stamp: the version that last wrote its managed files, and the base of each. */
export interface Stamp {
  /** The Loopstra version that last wrote the repository's files. */
  loopstra: string;
  /** Keyed by the file's path in the repository, with forward slashes. */
  files: Record<string, StampEntry>;
}

/** A file Loopstra keeps up to date in the repository. */
export interface ManagedFile {
  /** Its path in the repository. */
  path: string;
  /** Its template's path in the Loopstra repository (the key in shipped.json). */
  template: string;
  /** The shipped text's path in the installed package. */
  shipped: string;
}

/** The files that must live in the repository; prompt overrides are added to these. */
const FIXED: ReadonlyArray<{ path: string; template: string[] }> = [
  { path: ".claude/skills/loopstra/SKILL.md", template: ["skill", "SKILL.md"] },
  { path: "intent/README.md", template: ["intent-README.md"] },
  { path: "REVIEW.md", template: ["REVIEW.md"] },
];

/** The folder of a repository's prompt overrides, as a stamp path prefix. */
const PROMPTS = "loopstra/prompts/";

/** sha256 of a text with its line endings made `\n`, so a checkout with core.autocrlf hashes the same. */
export function textSha(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function managed(path: string, template: string[]): ManagedFile {
  return { path, template: ["templates", ...template].join("/"), shipped: templatePath(...template) };
}

/**
 * The repository's managed files: the fixed three, then every prompt override (a .md in
 * loopstra/prompts/ named like a shipped prompt), and any prompt the stamp still records (one deleted
 * on purpose stays managed, so it is not brought back).
 */
export function managedFiles(root: string, stamp: Stamp | null = null): ManagedFile[] {
  const files = FIXED.map((f) => managed(f.path, f.template));
  const dir = join(root, "loopstra", "prompts");
  const names = new Set(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : []);
  for (const p of Object.keys(stamp?.files ?? {})) if (p.startsWith(PROMPTS)) names.add(p.slice(PROMPTS.length));
  for (const name of [...names].sort()) {
    if (existsSync(templatePath("prompts", name))) files.push(managed(`${PROMPTS}${name}`, ["prompts", name]));
  }
  return files;
}

/** The repository's stamp, or null when it has none or it cannot be read. */
export function readStamp(root: string): Stamp | null {
  try {
    const s = JSON.parse(readFileSync(join(root, STAMP_FILE), "utf8")) as Stamp;
    return typeof s?.loopstra === "string" && s.files && typeof s.files === "object" ? s : null;
  } catch {
    return null;
  }
}

/** Writes the stamp, its files in path order. */
export function writeStamp(root: string, stamp: Stamp): void {
  const files = Object.fromEntries(Object.entries(stamp.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileAtomic(join(root, STAMP_FILE), `${JSON.stringify({ loopstra: stamp.loopstra, files }, null, 2)}\n`);
}
