import { Git, GitTimeout } from "../git";
import { SLUG } from "../intents";
import type { DiffView } from "./types";

export const DIFF_MAX_CHARS = 1_000_000;
export const DIFF_MAX_LINES = 5_000;
/** How long the page waits for git: a person is looking at it. */
const DIFF_TIMEOUT_MS = 30_000;

/**
 * A change's branch against main (`main...intent/<slug>`: what the branch adds since they parted),
 * cut to the limits. None (`exists: false`) when the slug is not a change's name, main is not a
 * branch name, or either branch is missing. The repository's own diff programs and converters are
 * not run. When git cannot produce the diff, `problem` says why. git's whole output is still read before it is cut (the git runner has no output limit);
 * the time limit bounds it.
 */
export async function changeDiff(root: string, mainBranch: string, slug: string, opts: { timeoutMs?: number } = {}): Promise<DiffView> {
  const none: DiffView = { exists: false, stat: "", patch: "", cut: false };
  if (!SLUG.test(slug) || mainBranch.startsWith("-")) return none;
  const git = new Git(root, { timeoutMs: opts.timeoutMs ?? DIFF_TIMEOUT_MS });
  let found = false;
  try {
    if ((await git.run(["check-ref-format", "--branch", mainBranch], true)).code !== 0) return none;
    const main = `refs/heads/${mainBranch}`;
    const branch = `refs/heads/intent/${slug}`;
    for (const ref of [main, branch]) {
      if ((await git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true)).code !== 0) return none;
    }
    found = true;
    // The prefixes are named because the page reads files from `diff --git a/x b/x`, and a repository
    // may be set (diff.noprefix, diff.mnemonicPrefix) to write those lines differently. Names that are
    // not ASCII are written as they are, not quoted with octal escapes.
    const diff = (...extra: string[]) => git.run(["-c", "core.quotePath=false", "diff","--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", ...extra, "--end-of-options", `${main}...${branch}`], true);
    const statResult = await diff("--stat");
    const patchResult = statResult.code === 0 ? await diff() : statResult;
    // A diff git could not produce (an unreadable object, say) must not look like a branch with no changes.
    if (patchResult.code !== 0) return { exists: true, stat: "", patch: "", cut: false, problem: `The diff could not be read: ${firstLine(patchResult.err) || firstLine(patchResult.out) || `git stopped with code ${patchResult.code}`}` };
    const { text, cut } = cutDiff(patchResult.out);
    return { exists: true, stat: statResult.out, patch: text, cut };
  } catch (e) {
    if (!(e instanceof GitTimeout)) throw e;
    // A diff git cannot produce in time is too big to show: the page says it was cut, rather than
    // that the branch is gone or has no changes. Before the branches were found, it is none.
    return found ? { exists: true, stat: "", patch: "", cut: true } : none;
  }
}

/** The first line of git's message that is not one of its warnings. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^warning:/i.test(l)) ?? "";
}

/** `text` cut to DIFF_MAX_CHARS characters and DIFF_MAX_LINES lines. */
export function cutDiff(text: string): { text: string; cut: boolean } {
  let out = text;
  let cut = false;
  if (out.length > DIFF_MAX_CHARS) { out = out.slice(0, DIFF_MAX_CHARS); cut = true; }
  const lines = out.split("\n");
  if (lines.length > DIFF_MAX_LINES) { out = lines.slice(0, DIFF_MAX_LINES).join("\n"); cut = true; }
  return { text: out, cut };
}
