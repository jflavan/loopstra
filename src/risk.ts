import type { Config } from "./config";
import type { Git } from "./git";
import { andList } from "./text";

/*
 * Which changes are risky: facts about the diff (its paths and size), never an agent's judgment, so
 * the answer is predictable and testable. A risky change waits for a person before it merges,
 * whatever gates.merge.human says (see passMergeGate in stages/merge.ts).
 */

/** What the merge gate found about a change's diff against main. */
export interface Risk {
  risky: boolean;
  /** The changed files a pattern in gates.merge.risky.paths matches, as git orders them. */
  files: string[];
  /** Lines added plus removed outside intent/; a binary file counts none. */
  lines: number;
  /** `lines` is over gates.merge.risky.lines. */
  overLines: boolean;
  /** gates.merge.risky.lines, when it is set. */
  limit?: number;
  /** The standards (needs_person) whose patterns the change's files match, with those files. */
  standards: { title: string; path: string; files: string[] }[];
}

/** Patterns beside gates.merge.risky.paths that make a change risky: a standard's applies_to (or `**`). */
export interface RiskSource { patterns: string[]; standard?: { title: string; path: string } }

/** True when the config names anything risky: patterns of files, or a size. */
export function riskySet(cfg: Config): boolean {
  const r = cfg.gates.merge.risky;
  return r.paths.length > 0 || r.lines !== undefined;
}

/** One file of `git diff --numstat -z`: its lines (0 for a binary file), and its paths (a rename's new one first). */
interface Changed { lines: number; paths: string[] }

/**
 * The records of `git diff --numstat -z`: "added TAB removed TAB path NUL", or for a rename
 * "added TAB removed TAB NUL old NUL new NUL". A binary file's counts are "-".
 */
function numstat(out: string): Changed[] {
  const fields = out.split("\0");
  const changed: Changed[] = [];
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i] ?? "");
    if (!m) continue;
    const lines = (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
    if (m[3]) {
      changed.push({ lines, paths: [m[3]] });
      continue;
    }
    const from = fields[i + 1] ?? "";
    const to = fields[i + 2] ?? "";
    i += 2;
    changed.push({ lines, paths: [to, from].filter(Boolean) });
  }
  return changed;
}

/**
 * The files the branch in `wt` changed since it parted from `main`, outside intent/, names as git has
 * them (spaces, other alphabets) and both paths of a rename.
 */
export async function changedFiles(wt: Git, main: string): Promise<string[]> {
  const out = (await wt.run(["diff", "--numstat", "-z", "-M", `${main}...HEAD`])).out;
  return [...new Set(numstat(out).flatMap((c) => c.paths).filter((p) => !p.startsWith("intent/")))];
}

/**
 * Scores the branch checked out in `wt` against `main` (from where the two parted, so only the
 * branch's own changes count), outside intent/. A file counts when a pattern matches its path; a
 * renamed one when a pattern matches its new path or its old one (moving a file out of a risky
 * folder changes it as much as moving one in), listed under the name that matched.
 */
export async function scoreRisk(wt: Git, main: string, cfg: Config, extra: RiskSource[] = []): Promise<Risk> {
  const { paths, lines: limit } = cfg.gates.merge.risky;
  const globs = paths.map((p) => new Bun.Glob(p));
  const sources = extra.map((e) => ({ ...e, globs: e.patterns.map((p) => new Bun.Glob(p)), hits: [] as string[] }));
  // -z: names as they are (spaces, other alphabets); -M: a rename is one record, whatever diff.renames says.
  const out = (await wt.run(["diff", "--numstat", "-z", "-M", `${main}...HEAD`])).out;
  const files: string[] = [];
  let lines = 0;
  for (const c of numstat(out)) {
    const outside = c.paths.filter((p) => !p.startsWith("intent/"));
    if (!outside.length) continue;
    lines += c.lines;
    const hit = outside.find((p) => globs.some((g) => g.match(p)));
    if (hit !== undefined) files.push(hit);
    for (const src of sources) {
      const h = outside.find((p) => src.globs.some((g) => g.match(p)));
      if (h !== undefined) src.hits.push(h);
    }
  }
  const overLines = limit !== undefined && lines > limit;
  const standards = sources.flatMap((s) => (s.standard && s.hits.length ? [{ ...s.standard, files: s.hits }] : []));
  // A source without a standard names nobody, but still makes the change risky.
  const risky = files.length > 0 || overLines || sources.some((s) => s.hits.length > 0);
  return { risky, files, lines, overLines, standards, ...(limit !== undefined ? { limit } : {}) };
}

/** `names` joined in words, at most `max` of them, then how many more. */
function someOf(names: readonly string[], max: number): string {
  return andList(names.length > max ? [...names.slice(0, max), `${names.length - max} more`] : names);
}

/** The merge gate's risk row: what made the change risky (up to 10 files), or "nothing risky". */
export function riskEvidence(r: Risk): string {
  if (!r.risky) return "nothing risky";
  const parts: string[] = [];
  if (r.files.length) parts.push(`touches ${someOf(r.files, 10)}`);
  for (const st of r.standards) parts.push(`standard ${st.title} (${st.path}) applies: touches ${someOf(st.files, 10)}`);
  if (r.overLines) parts.push(`${r.lines} lines changed (over ${r.limit ?? 0})`);
  return parts.join("; ");
}

/** The words every risk note has: what makes it one (see isRiskNote). */
const NEEDS_PERSON = "set to need a person before merging";

/**
 * The owner's note on a risky change waiting in merge-review: why (at most 3 files, so whoever
 * approves knows what to look at), and how to let it in. `human` is who decides: pr when there is a
 * pull request to approve, else status.
 */
export function riskNote(r: Risk, human: "status" | "pr"): string {
  const why: string[] = [];
  if (r.files.length) why.push(`This change touches files ${NEEDS_PERSON}: ${someOf(r.files, 3)}.`);
  for (const st of r.standards) why.push(`This change falls under the standard ${st.title} (${st.path}), which is ${NEEDS_PERSON}: it touches ${someOf(st.files, 3)}.`);
  if (r.overLines) {
    why.push(r.files.length || r.standards.length
      ? `It also has ${r.lines} changed lines, more than the ${r.limit ?? 0} set.`
      : `This change has ${r.lines} changed lines, more than the ${r.limit ?? 0} ${NEEDS_PERSON}.`);
  }
  const how = human === "pr"
    ? "Approve the pull request on GitHub, or set status to merge-approved."
    : "Read review.md. To let this change in, change the status line to merge-approved.";
  return [...why, how, "To stop this change, set it to closed."].join(" ");
}

/** True when a note is one riskNote wrote (the merge gate's own words, which a pull request's wait may stand in for). */
export function isRiskNote(note: string): boolean {
  return note.includes(NEEDS_PERSON);
}
