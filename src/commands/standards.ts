import type { Config } from "../config";
import { Git, statusPaths } from "../git";
import { problemText, readStandards, STANDARDS_DIR, standardsSizeWarning, type Standard } from "../standards";

/** How many files on main a standard's patterns match. */
function matching(standard: Standard, files: string[]): number {
  const globs = (standard.appliesTo ?? []).map((p) => new Bun.Glob(p));
  return files.filter((f) => globs.some((g) => g.match(f))).length;
}

function describe(s: Standard, files: string[], main: string): string[] {
  const n = s.appliesTo ? matching(s, files) : 0;
  const scope = s.appliesTo ? `${s.appliesTo.join(", ")} (${n} ${n === 1 ? "file" : "files"} on ${main} ${n === 1 ? "matches" : "match"})` : "every change";
  const person = !s.needsPerson ? "no"
    : s.appliesTo ? "yes, a change that falls under it waits for a person before it merges"
    : "yes, so every change waits for a person, like gates.merge.human: pr";
  return [
    `${s.title} (${s.path})`,
    `  Applies to: ${scope}`,
    `  Needs a person: ${person}`,
    `  Check: ${s.check ?? "none"}`,
    `  Rules: ${s.rules.map((r) => r.label).join(", ")}`,
  ];
}

/**
 * `loopstra standards`: what main's last commit says (never the checkout), then what is wrong or not
 * yet in force. Read-only; a problem in a file is listed, not an error.
 */
export async function renderStandardsList(root: string, cfg: Config): Promise<string> {
  const git = new Git(root);
  const main = await git.commitOf(cfg.main_branch);
  if (!main) return `${cfg.main_branch} has no commit yet, so there are no standards to read.\n`;
  const read = await readStandards(git, main);
  const files = read.standards.some((s) => s.appliesTo)
    ? (await git.run(["ls-tree", "-r", "-z", "--name-only", main])).out.split("\0").filter(Boolean)
    : [];
  const lines: string[] = [];
  if (read.standards.length) {
    lines.push(`Standards on ${cfg.main_branch} (commit ${main.slice(0, 7)}):`);
    for (const s of read.standards) lines.push("", ...describe(s, files, cfg.main_branch));
  } else if (!read.problems.length) {
    lines.push(`There are no standards on ${cfg.main_branch}. Add a file named <name>.md to ${STANDARDS_DIR}/ and commit it.`);
  }
  if (read.problems.length) {
    lines.push("", "Files that cannot be read (until they are fixed on main, no change moves on):");
    for (const p of read.problems) lines.push(`  ${problemText(p)}`);
  }
  if (read.ignored.length) lines.push("", `Ignored, since they are not named <name>.md: ${read.ignored.join(", ")}`);
  const edited = statusPaths((await git.run(["status", "--porcelain", "-z", "--", `${STANDARDS_DIR}/`], true)).out);
  if (edited.length) lines.push("", `Uncommitted edits in this checkout, not in force until they are committed to ${cfg.main_branch}: ${edited.join(", ")}`);
  const size = standardsSizeWarning(read);
  if (size) lines.push("", `Warning: ${size}`);
  return `${lines.join("\n")}\n`;
}
