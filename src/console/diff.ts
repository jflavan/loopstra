import { Git } from "../git";
import type { DiffView } from "./types";

export const DIFF_MAX_CHARS = 1_000_000;
export const DIFF_MAX_LINES = 5_000;

/** A change's branch against main (`main...intent/<slug>`: what the branch adds since they parted), cut to the limits. */
export async function changeDiff(root: string, mainBranch: string, slug: string): Promise<DiffView> {
  const git = new Git(root);
  const branch = `intent/${slug}`;
  if ((await git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], true)).code !== 0) {
    return { exists: false, stat: "", patch: "", cut: false };
  }
  const range = `${mainBranch}...${branch}`;
  const stat = (await git.run(["diff", "--no-color", "--no-ext-diff", "--stat", range], true)).out;
  const { text, cut } = cutDiff((await git.run(["diff", "--no-color", "--no-ext-diff", range], true)).out);
  return { exists: true, stat, patch: text, cut };
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
