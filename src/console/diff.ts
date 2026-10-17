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
 * not run. git's whole output is still read before it is cut (the git runner has no output limit);
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
    const diff = (...extra: string[]) => git.run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...extra, "--end-of-options", `${main}...${branch}`], true);
    const stat = (await diff("--stat")).out;
    const { text, cut } = cutDiff((await diff()).out);
    return { exists: true, stat, patch: text, cut };
  } catch (e) {
    if (!(e instanceof GitTimeout)) throw e;
    // A diff git cannot produce in time is too big to show: the page says it was cut, rather than
    // that the branch is gone or has no changes. Before the branches were found, it is none.
    return found ? { exists: true, stat: "", patch: "", cut: true } : none;
  }
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
