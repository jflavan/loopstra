import { stringify } from "yaml";
import { z } from "zod";
import { lineText, splitFrontmatter } from "./text";

/** Where a repository's standard files are, relative to its root. */
export const STANDARDS_DIR = "loopstra/standards";

/** A rule's label: a capital letter, then up to 30 letters, digits, `.`, `_` and `-`, ending in a letter or digit (32 at most). */
export const RULE_LABEL = /^(?:[A-Z]|[A-Z][A-Za-z0-9._-]{0,30}[A-Za-z0-9])$/;

/** A standard's name: lowercase words joined by dashes, as an intent slug is. */
export const STANDARD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Rule { label: string; text: string; line: number }

export interface Standard {
  name: string;
  path: string;
  title: string;
  /** Glob patterns; null when the standard applies to every change. */
  appliesTo: string[] | null;
  needsPerson: boolean;
  /** A shell command that exits 0 when the code keeps the rules a tool can check; null when there is none. */
  check: string | null;
  rules: Rule[];
  /** The file without its front matter, line endings as "\n". */
  body: string;
}

/** Why a standard cannot be read. `text` is a clause that finishes "<path> cannot be read: ...". */
export interface StandardsProblem { path: string; line: number | null; text: string }

export interface StandardsRead {
  standards: Standard[];
  problems: StandardsProblem[];
  /** Paths in the standards folder that are not `<name>.md`. */
  ignored: string[];
}

const FrontMatter = z.strictObject({
  applies_to: z.array(z.string()).optional(),
  needs_person: z.boolean().default(false),
  check: z.string().optional(),
});

/** A rule bullet: `- LABEL: text`. */
const RULE_BULLET = /^- (\S+?):\s+(.*)$/;
const TITLE = /^# +(.*\S)\s*$/;
const RULES_HEADING = /^## Rules\s*$/;

/** What is wrong with a glob pattern, or null. Bun.Glob reads any text, so an unclosed `[` or `{` is caught here. */
function globProblem(pattern: string): string | null {
  if (!pattern.trim()) return "an empty pattern";
  try { new Bun.Glob(pattern); } catch { return "not a valid pattern"; }
  let square = 0;
  let curly = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (c === "[") square++;
    else if (c === "]" && square > 0) square--;
    else if (c === "{") curly++;
    else if (c === "}" && curly > 0) curly--;
  }
  return square > 0 || curly > 0 ? "an unclosed bracket" : null;
}

/** The line (1-based) a key is written on; the first line when it is not found. */
function keyLine(front: string, key: string): number {
  const i = front.split("\n").findIndex((l) => l.startsWith(`${key}:`));
  return i < 0 ? 1 : i + 1;
}

/** Reads one standard file. Every way it cannot be read comes back as a problem with its line. */
export function parseStandard(name: string, text: string): { ok: true; standard: Standard } | { ok: false; problems: StandardsProblem[] } {
  const path = `${STANDARDS_DIR}/${name}.md`;
  const problems: StandardsProblem[] = [];
  const problem = (line: number | null, text: string): void => { problems.push({ path, line, text }); };

  const lf = text.replace(/\r\n/g, "\n");
  const split = splitFrontmatter(lf);
  const body = split.body ?? lf.replace(/^﻿/, "");
  const frontText = split.body === null ? "" : lf.slice(0, lf.length - split.body.length);
  // Lines before the body, so a line number counts from the top of the file.
  const offset = (frontText.match(/\n/g) ?? []).length;

  if (split.problem) problem(1, `the front matter is ${split.problem === "not YAML" ? "not valid YAML" : "not keys and values"} (write \`key: value\` lines between two \`---\` lines)`);
  let appliesTo: string[] | null = null;
  let needsPerson = false;
  let check: string | null = null;
  if (!split.problem) {
    const parsed = FrontMatter.safeParse(split.front);
    if (parsed.success) {
      appliesTo = parsed.data.applies_to ?? null;
      needsPerson = parsed.data.needs_person;
      check = parsed.data.check?.trim() || null;
      for (const p of appliesTo ?? []) {
        const bad = globProblem(p);
        if (bad) problem(keyLine(frontText, "applies_to"), `applies_to has ${bad}: ${JSON.stringify(p)}`);
      }
    } else {
      for (const issue of parsed.error.issues) {
        if (issue.code === "unrecognized_keys") {
          for (const k of issue.keys) problem(keyLine(frontText, k), `the front matter has the key ${k}, which is not one of applies_to, needs_person and check`);
        } else {
          const key = String(issue.path[0] ?? "");
          problem(keyLine(frontText, key), `${key || "the front matter"} is not the right kind of value (applies_to is a list of patterns, needs_person is true or false, check is a command)`);
        }
      }
    }
  }

  const lines = body.split("\n").map(lineText);
  const titleAt = lines.findIndex((l) => TITLE.test(l));
  const rulesAt = lines.findIndex((l) => RULES_HEADING.test(l));
  const title = titleAt < 0 ? "" : (TITLE.exec(lines[titleAt] ?? "")?.[1] ?? "");
  if (titleAt < 0) problem(null, "it has no title (start the text with `# Title`)");

  const rules: Rule[] = [];
  if (rulesAt < 0) problem(null, "it has no Rules section (add `## Rules`, then one `- LABEL: text` line for each rule)");
  else {
    const seen = new Set<string>();
    let open: Rule | null = null;
    for (let i = rulesAt + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.startsWith("## ")) break;
      const line = offset + i + 1;
      if (l.startsWith("- ")) {
        open = null;
        const m = RULE_BULLET.exec(l);
        if (!m) { problem(line, `the rule on line ${line} has no rule label (write it as \`- LABEL: text\`)`); continue; }
        const label = m[1] ?? "";
        if (!RULE_LABEL.test(label)) { problem(line, `the rule on line ${line} has the label ${label}, which is not valid (start with a capital letter, then letters, digits, \`.\`, \`_\` or \`-\`, 32 characters at most)`); continue; }
        if (seen.has(label)) { problem(line, `the label ${label} is used twice (line ${line})`); continue; }
        seen.add(label);
        open = { label, text: (m[2] ?? "").trim(), line };
        rules.push(open);
      } else if (open && /^\s+\S/.test(l)) open.text = `${open.text} ${l.trim()}`;
    }
    if (!rules.length && !problems.length) problem(offset + rulesAt + 1, `the Rules section on line ${offset + rulesAt + 1} has no rules (write each as \`- LABEL: text\`)`);
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, standard: { name, path, title, appliesTo, needsPerson, check, rules, body } };
}

/** Reads the files found in the standards folder: names come from paths, other files are ignored, a label used in two files is a problem in both. */
export function parseStandards(files: { path: string; text: string }[]): StandardsRead {
  const out: StandardsRead = { standards: [], problems: [], ignored: [] };
  const prefix = `${STANDARDS_DIR}/`;
  for (const f of files) {
    const name = f.path.startsWith(prefix) && f.path.endsWith(".md") ? f.path.slice(prefix.length, -3) : "";
    if (!STANDARD_NAME.test(name)) { out.ignored.push(f.path); continue; }
    const r = parseStandard(name, f.text);
    if (r.ok) out.standards.push(r.standard);
    else out.problems.push(...r.problems);
  }
  out.standards.sort((a, b) => a.name.localeCompare(b.name));
  const owners = new Map<string, Set<string>>();
  for (const s of out.standards) for (const r of s.rules) owners.set(r.label, (owners.get(r.label) ?? new Set()).add(s.path));
  const clash = (s: Standard): Rule[] => s.rules.filter((r) => (owners.get(r.label)?.size ?? 0) > 1);
  for (const s of out.standards) {
    for (const r of clash(s)) {
      const others = [...(owners.get(r.label) ?? [])].filter((p) => p !== s.path);
      out.problems.push({ path: s.path, line: r.line, text: `the label ${r.label} (line ${r.line}) is also used in ${others.join(" and ")}` });
    }
  }
  out.standards = out.standards.filter((s) => !clash(s).length);
  return out;
}

/** A problem as one plain sentence. */
export function problemText(p: StandardsProblem): string {
  return `${p.path} cannot be read: ${p.text}.`;
}

/** What setup and the console edit: a standard's parts, rendered back to a file by `formToMarkdown`. */
export interface StandardForm {
  name: string;
  title: string;
  patterns: string[];
  needsPerson: boolean;
  check: string;
  rules: { label: string; text: string }[];
  /** The text between the title and `## Rules`. */
  context: string;
}

/** The file for a form: the one renderer, used by setup and by the console's server. */
export function formToMarkdown(f: StandardForm): string {
  const front: string[] = [];
  if (f.patterns.length) front.push(`applies_to: [${f.patterns.map((p) => JSON.stringify(p)).join(", ")}]`);
  if (f.needsPerson) front.push("needs_person: true");
  if (f.check) front.push(stringify({ check: f.check }, { lineWidth: 0 }).trimEnd());
  const head = front.length ? `---\n${front.join("\n")}\n---\n` : "";
  const context = f.context.trim() ? `${f.context.trim()}\n\n` : "";
  const rules = f.rules.map((r) => `- ${r.label}: ${r.text.replace(/\n/g, "\n  ")}\n`).join("");
  return `${head}# ${f.title}\n\n${context}## Rules\n${rules}`;
}

/** The form for a parsed standard, the inverse of `formToMarkdown`. */
export function standardToForm(s: Standard): StandardForm {
  const lines = s.body.split("\n");
  const titleAt = lines.findIndex((l) => TITLE.test(lineText(l)));
  const rulesAt = lines.findIndex((l) => RULES_HEADING.test(lineText(l)));
  return {
    name: s.name,
    title: s.title,
    patterns: s.appliesTo ?? [],
    needsPerson: s.needsPerson,
    check: s.check ?? "",
    rules: s.rules.map(({ label, text }) => ({ label, text })),
    context: titleAt >= 0 && rulesAt > titleAt ? lines.slice(titleAt + 1, rulesAt).join("\n").trim() : "",
  };
}
