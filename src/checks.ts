import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/** Normalizes a heading for comparison: lower case, no trailing colon. */
function headingKey(h: string): string {
  return h.trim().replace(/:\s*$/, "").trim().toLowerCase();
}

export function headingsPresent(markdown: string, headings: string[]): { ok: true } | { ok: false; missing: string[] } {
  const present = new Set([...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => headingKey(m[1] ?? "")));
  const missing = headings.filter((h) => !present.has(headingKey(h)));
  return missing.length ? { ok: false, missing } : { ok: true };
}

export interface PlanFile { path: string; new: boolean }

/** Repository-relative path in one spelling: forward slashes, no leading `./`. */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

const FILES_HEADING = /^##\s+files that change\b/i;

/**
 * Reads the bullets under "## Files that change" (any case, with or without a trailing colon
 * or description). Each bullet's first token is the path; `**`, backticks, `./`, a trailing
 * `:` or `,` and a description after it are ignored; `(new)` anywhere on the line marks it new.
 * Returns null when the plan has no Files that change section at all.
 */
export function parsePlanFiles(plan: string): PlanFile[] | null {
  const lines = plan.split(/\r?\n/);
  const start = lines.findIndex((l) => FILES_HEADING.test(l));
  if (start < 0) return null;
  const out: PlanFile[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const token = m[1].replace(/\(new\)/gi, " ").replace(/\*\*|__|`/g, " ").trim().split(/\s+/)[0] ?? "";
    const path = normalizePath(token.replace(/[:,;]+$/, ""));
    if (!path) continue;
    out.push({ path, new: /\(new\)/i.test(line) });
  }
  return out;
}

export function filesExistOrNew(root: string, files: PlanFile[]): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const f of files) {
    if (!f.new && !existsSync(join(root, f.path))) problems.push(`${f.path} is listed as an existing file but does not exist`);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "go.sum"]);

/**
 * Files changed on the branch that the plan did not list. Only the intent's own folder
 * (`intent/<slug>/`) and lockfiles anywhere are exempt; everything else, including
 * `loopstra/`, `.claude/`, CLAUDE.md and other intents' folders, counts as drift.
 */
export function diffWithinPlan(changed: string[], planned: PlanFile[], slug: string): string[] {
  const allowed = new Set(planned.map((p) => normalizePath(p.path)));
  const own = `intent/${slug}/`;
  return changed
    .map(normalizePath)
    .filter((c) => !allowed.has(c) && !c.startsWith(own) && !LOCKFILES.has(basename(c)));
}
