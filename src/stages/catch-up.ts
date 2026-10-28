import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearMarker, readMarker, writeArtifact, writeMarker, type Failure, type StepContext } from "../context";
import { Git, NO_AUTO_MAINTENANCE, passOn, RUNTIME_COMMIT_CONFIG, RUNTIME_EMAIL } from "../git";
import { agentPhase, codePhase } from "../phases";
import { errorText } from "../shell";
import { artifacts, bullets, CATCHING_UP, restoreCatchUp } from "./shared";

/** Run-folder marker: how many conflict resolutions this build has tried (see roundsAllowed). A new build clears it. */
export const RESOLUTIONS = "resolutions";
/** Run-folder marker: the latest resolution, as the reviewer reads it (`{{resolution}}`). Cleared when a review passes, and by a new build. */
export const RESOLUTION = "resolution.md";
/** Run-folder marker: when the latest resolution was made (an ISO time). An approval on GitHub from before it does not count (see freshApproval). */
export const RESOLVED_AT = "resolved-at";

/** Every conflict section a prompt shows, at most this many lines per file. */
const LINES_PER_FILE = 200;
/** All conflicts a prompt shows, at most this many characters. */
const CONFLICT_CHARS = 40_000;
/** Lines of context shown around each conflict section. */
const CONTEXT = 3;
/** A conflict marker line the resolution must not leave behind. `=======` alone is left out: it is also a Markdown heading underline. */
const MARKER = /^(<{7}|\|{7}|>{7})( |$)/m;

export const CONFLICT_NOTE = "The change overlaps with other recent changes, and resolving the conflict automatically did not work. Nothing was merged. The details are in conflict.md. An engineer needs to look at it.";
const USED_UP_NOTE = "The change overlaps with other recent changes, and it has already been brought up to date as many times as allowed. Nothing was merged. An engineer needs to look at it.";

/** How the branch was brought up to date: it had main already, it rebased cleanly, or conflicts were resolved. */
export type CatchUpOutcome = "current" | "rebased" | "resolved";

/** The resolutions this build has tried. */
function resolutionsUsed(ctx: StepContext): number {
  const n = Number.parseInt(readMarker(ctx, RESOLUTIONS) ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The review rounds this build may run: review.max_rounds, plus one for each resolution, whose review does not count against them. */
export function roundsAllowed(ctx: StepContext): number {
  return ctx.cfg.stages.review.max_rounds + resolutionsUsed(ctx);
}

/**
 * True when `ref` has code (outside intent/) that `branch` lacks: it changed files since they
 * parted. A comparison git cannot make (no common history) counts as out of date.
 */
export async function outOfDate(git: Git, ref: string, branch: string): Promise<boolean> {
  if (await git.isAncestor(ref, branch)) return false;
  const gained = await git.run(["diff", "--name-only", "-z", `${branch}...${ref}`], true);
  if (gained.code !== 0) return true;
  return gained.out.split("\0").some((f) => f && !f.startsWith("intent/"));
}

/**
 * Brings the change's branch up to date with main, in its worktree, which must be clean (each
 * caller saves or refuses unsaved edits first). The branch has main → current; it rebases cleanly →
 * rebased. On a conflict, while resolutions are left (stages.review.max_resolutions per build), the
 * branch's commits are squashed into one on top of main (see resolveConflicts): a squash that
 * applies cleanly → rebased; one that conflicts → the resolve session resolves it → resolved. A
 * failure leaves the branch where it was, writes conflict.md, and is returned for the caller to
 * block with.
 */
export async function catchUp(ctx: StepContext): Promise<{ ok: true; outcome: CatchUpOutcome; files: string[] } | Failure> {
  const main = ctx.cfg.main_branch;
  if (await ctx.git.isAncestor(main, ctx.branch)) return { ok: true, outcome: "current", files: [] };
  const wt = new Git(ctx.worktreeDir);
  if (await wt.rebaseOnto(main)) return { ok: true, outcome: "rebased", files: [] };
  if (resolutionsUsed(ctx) >= ctx.cfg.stages.review.max_resolutions) {
    return { ok: false, note: USED_UP_NOTE, detail: `rebase of ${ctx.branch} onto ${main} hit conflicts; ${resolutionsUsed(ctx)} of ${ctx.cfg.stages.review.max_resolutions} resolutions used` };
  }
  return resolveConflicts(ctx, wt);
}

/**
 * The branch's commits since it parted from main, squashed into one on top of main (`merge
 * --squash`): the resolve session then meets every conflict once, against the final code, not once
 * per commit. The old head is kept in CATCHING_UP until the branch is saved again, so a stop, an
 * outage or a crash meanwhile puts it back (here, or the next time the worktree is opened).
 */
async function resolveConflicts(ctx: StepContext, wt: Git): Promise<{ ok: true; outcome: CatchUpOutcome; files: string[] } | Failure> {
  const main = ctx.cfg.main_branch;
  const old = await wt.headSha();
  const base = (await wt.run(["merge-base", main, "HEAD"])).out.trim();
  const message = await squashMessage(ctx, wt, base);
  writeMarker(ctx, CATCHING_UP, old);
  try {
    const squashed = await codePhase(ctx, "catch-up", async () => {
      await wt.run([...NO_AUTO_MAINTENANCE, "reset", "-q", "--keep", main]);
      const merged = await wt.run([...RUNTIME_COMMIT_CONFIG, "-c", "merge.conflictStyle=diff3", "merge", "--no-verify", "-q", "--squash", old], true);
      const files = await wt.unmergedFiles();
      if (merged.code !== 0 && !files.length) throw new Error(`merge --squash of ${old} onto ${main}: ${(merged.err || merged.out).trim()}`);
      if (!files.length) await wt.runtime("commit", ["-q", "-m", message]);
      ctx.trace.event(ctx.slug, "command", { command: "catch up", main, files, note: files.length ? "the change was squashed onto main, and conflicts are left for the resolve session" : "the change was squashed onto main without conflicts" });
      return { ok: true as const, files };
    });
    if (!squashed.ok) return await failed(ctx, old, [], "", squashed.detail);
    if (!squashed.files.length) {
      clearMarker(ctx, CATCHING_UP);
      return { ok: true, outcome: "rebased", files: [] };
    }
    const files = squashed.files;
    const conflicts = await conflictsText(ctx, wt, base, files);
    const a = await artifacts(ctx);
    const session = await agentPhase(ctx, {
      name: "resolve", permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
      vars: { spec: a.spec, plan: a.currentPlan, conflicts, test_command: ctx.cfg.commands.test },
    });
    // Counted once the session has answered: one a stop, an outage or the day's budget cut short is not.
    writeMarker(ctx, RESOLUTIONS, String(resolutionsUsed(ctx) + 1));
    if (!session.ok) return await failed(ctx, old, files, conflicts, `the resolve session did not finish: ${session.note}`);
    const { resolved, reason, summary_markdown: summary } = session.envelope;
    if (!resolved) return await failed(ctx, old, files, conflicts, `the resolve session could not resolve it: ${reason || "no reason given"}`, summary);
    const marked = files.filter((f) => hasMarkers(join(ctx.worktreeDir, f)));
    if (marked.length) return await failed(ctx, old, files, conflicts, `conflict markers were left in ${marked.join(", ")}`, summary);
    const saved = await codePhase(ctx, "save-resolution", async () => {
      await wt.run(["add", "-A"]);
      const left = await wt.unmergedFiles();
      if (left.length) throw new Error(`still unmerged: ${left.join(", ")}`);
      await wt.runtime("commit", ["-q", "-m", message]);
      return { ok: true as const };
    });
    if (!saved.ok) return await failed(ctx, old, files, conflicts, saved.detail, summary);
    clearMarker(ctx, CATCHING_UP);
    const sha = (await ctx.git.run(["rev-parse", "--short", main])).out.trim();
    writeMarker(ctx, RESOLUTION, resolutionRecord(main, sha, files, summary, conflicts));
    writeMarker(ctx, RESOLVED_AT, new Date().toISOString());
    ctx.trace.event(ctx.slug, "command", { command: "catch up", main, files, note: `conflicts with ${main} were resolved; the resolution is tested and reviewed before it merges` });
    return { ok: true, outcome: "resolved", files };
  } finally {
    // A stop, an outage, the day's budget or a crash part-way: the branch goes back to where it was.
    if (readMarker(ctx, CATCHING_UP) !== null) await restoreCatchUp(ctx);
  }
}

/** The squashed commit's message: the subjects it replaces, and a Co-authored-by line for each author who is not the runtime. */
async function squashMessage(ctx: StepContext, wt: Git, base: string): Promise<string> {
  const log = (await wt.run(["log", "--reverse", "--format=%s%x00%an <%ae>", `${base}..HEAD`])).out.split("\n").filter(Boolean);
  const subjects = log.map((l) => l.split("\0")[0] ?? "");
  const authors = [...new Set(log.map((l) => l.split("\0")[1] ?? "").filter((a) => a && !a.endsWith(`<${RUNTIME_EMAIL}>`)))];
  return [
    `loopstra(${ctx.slug}): brought up to date with ${ctx.cfg.main_branch}`,
    "",
    "Squashes:",
    bullets(subjects),
    ...(authors.length ? ["", ...authors.map((a) => `Co-authored-by: ${a}`)] : []),
  ].join("\n");
}

/** True when the file has a conflict marker line (a missing file has none: deleting it is a resolution). */
function hasMarkers(path: string): boolean {
  if (!existsSync(path)) return false;
  try { return MARKER.test(readFileSync(path, "utf8")); } catch { return false; }
}

/**
 * What the resolve session and the reviewer are shown: for each file, its conflict sections with a
 * few lines around them (at most LINES_PER_FILE lines per file, CONFLICT_CHARS in all), then the
 * commits on main since the branch parted from it that touched those files, naming the spec and plan
 * of each change merged locally (`<slug>: <title>`) that has them.
 */
async function conflictsText(ctx: StepContext, wt: Git, base: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  let left = CONFLICT_CHARS;
  for (const file of files) {
    let text = `### ${file}\n\n`;
    const path = join(ctx.worktreeDir, file);
    const content = existsSync(path) ? readFileSync(path, "utf8") : null;
    const sections = content === null ? null : conflictSections(content);
    if (content === null) text += "Deleted on one side and changed on the other.\n";
    else if (!sections) text += "No conflict sections in the text (a binary file, or deleted on one side and changed on the other).\n";
    else text += `\`\`\`\n${sections.text}\n\`\`\`\n${sections.cut ? "\nThe file has more conflicts than are shown here; read it in full.\n" : ""}`;
    if (text.length > left) {
      parts.push(`### ${file}\n\nNot shown here (too long); read the file.\n`);
      continue;
    }
    left -= text.length;
    parts.push(text);
  }
  const log = (await wt.run(["log", "--format=%h %s", `${base}..${ctx.cfg.main_branch}`, "--", ...files], true)).out.split("\n").filter(Boolean);
  const commits = log.map((line) => {
    const slug = /^\S+ ([a-z0-9][a-z0-9-]*): /.exec(line)?.[1];
    const other = slug && slug !== ctx.slug && existsSync(join(ctx.worktreeDir, "intent", slug, "spec.md"));
    return other ? `${line} (its spec: intent/${slug}/spec.md, its plan: intent/${slug}/plan.md)` : line;
  });
  return `${parts.join("\n")}\n### Commits on ${ctx.cfg.main_branch} that touched these files\n\n${commits.length ? bullets(commits) : "(none found)"}\n`;
}

/** The conflict sections of a file, each with CONTEXT lines around it, at most LINES_PER_FILE lines. Null when it has none. */
function conflictSections(content: string): { text: string; cut: boolean } | null {
  const lines = content.split("\n");
  const keep = new Set<number>();
  let open = -1;
  lines.forEach((line, i) => {
    if (line.startsWith("<<<<<<<")) open = i;
    else if (line.startsWith(">>>>>>>") && open >= 0) {
      for (let j = Math.max(0, open - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep.add(j);
      open = -1;
    }
  });
  if (!keep.size) return null;
  const out: string[] = [];
  let last = -2;
  let cut = false;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (out.length >= LINES_PER_FILE) { cut = true; break; }
    if (i > last + 1 && out.length) out.push("...");
    out.push(`${i + 1}: ${lines[i] ?? ""}`);
    last = i;
  }
  return { text: out.join("\n"), cut };
}

/** The resolution as the reviewer reads it. */
function resolutionRecord(main: string, sha: string, files: string[], summary: string, conflicts: string): string {
  return [
    `This change was brought up to date with ${main} (at ${sha}), and conflicts in ${files.join(", ")} were resolved by an agent. Check that the resolution keeps what both sides meant.`,
    "",
    "## What the agent did",
    "",
    summary.trim() || "(no summary)",
    "",
    "## The conflicts as they were",
    "",
    conflicts,
  ].join("\n");
}

/**
 * A resolution that did not work: the branch goes back to where it was, conflict.md records what
 * happened (written on main beside review.md), and the failure says so in plain words.
 */
async function failed(ctx: StepContext, old: string, files: string[], conflicts: string, reason: string, summary = ""): Promise<Failure> {
  await restoreCatchUp(ctx);
  ctx.trace.event(ctx.slug, "command", { command: "catch up", files, note: `the conflicts with ${ctx.cfg.main_branch} were not resolved: ${reason}`, head: old });
  const record = [
    "# Conflict with main",
    "",
    `Bringing this change up to date with ${ctx.cfg.main_branch} hit conflicts that were not resolved automatically. The change's branch was left as it was.`,
    "",
    `Why: ${reason}`,
    ...(summary.trim() ? ["", "## What the agent said", "", summary.trim()] : []),
    "",
    "## The conflicts",
    "",
    conflicts || (files.length ? bullets(files) : "(not known)"),
  ].join("\n");
  try {
    await writeArtifact(ctx, "conflict.md", record);
  } catch (e) {
    passOn(e);
    ctx.trace.event(ctx.slug, "error", { where: "catch up", what: "conflict.md", error: errorText(e) });
  }
  return { ok: false, note: CONFLICT_NOTE, detail: `${reason}${files.length ? ` (conflicts in ${files.join(", ")})` : ""}` };
}
