import { existsSync } from "node:fs";
import { join } from "node:path";

export function headingsPresent(markdown: string, headings: string[]): { ok: true } | { ok: false; missing: string[] } {
  const present = new Set([...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => (m[1] ?? "").toLowerCase()));
  const missing = headings.filter((h) => !present.has(h.toLowerCase()));
  return missing.length ? { ok: false, missing } : { ok: true };
}

export interface PlanFile { path: string; new: boolean }

/** Reads "## Files that change" bullets: `- path (new)` or `- \`path\``. */
export function parsePlanFiles(plan: string): PlanFile[] {
  const section = /^##\s+Files that change\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m.exec(plan)?.[1] ?? "";
  const out: PlanFile[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+`?([^\s`]+)`?\s*(\(new\))?/.exec(line);
    if (m?.[1]) out.push({ path: m[1], new: !!m[2] });
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

const IGNORED_DRIFT = [/^bun\.lock$/, /^package-lock\.json$/, /^yarn\.lock$/, /^intent\//, /^loopstra\//];

/** Files changed on the branch that the plan did not list. */
export function diffWithinPlan(changed: string[], planned: PlanFile[]): string[] {
  const allowed = new Set(planned.map((p) => p.path));
  return changed.filter((c) => !allowed.has(c) && !IGNORED_DRIFT.some((re) => re.test(c)));
}
