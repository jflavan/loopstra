import { stringify } from "yaml";
import { z } from "zod";
import type { Git } from "./git";
import { andList, lineText, splitFrontmatter } from "./text";

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

/** Reads the standards as they are in a commit: only what is committed, never the checkout's edits. None there gives an empty read. */
export async function readStandards(git: Git, commit: string): Promise<StandardsRead> {
  const listed = await git.run(["ls-tree", "-z", "--name-only", commit, "--", `${STANDARDS_DIR}/`], { allowFail: true });
  const paths = listed.code === 0 ? listed.out.split("\0").filter(Boolean) : [];
  const files: { path: string; text: string }[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    const blob = await git.run(["cat-file", "blob", `${commit}:${path}`], { allowFail: true });
    if (blob.code === 0) files.push({ path, text: blob.out });
    else skipped.push(path); // a folder
  }
  const read = parseStandards(files);
  read.ignored.push(...skipped);
  return read;
}

/** The standards a person added to a change or removed from it, by name. */
export interface Scope { added: string[]; removed: string[] }

/** A standard that applies to a change, why, and the files that made it apply (for `files`). */
export interface Applying { standard: Standard; why: "every" | "files" | "added"; files: string[] }

/** Which standards apply to a change's files. A removed standard applies to none; an added one applies whatever the files. The order of `standards` is kept. */
export function applying(standards: Standard[], files: string[], scope: Scope = { added: [], removed: [] }): Applying[] {
  const out: Applying[] = [];
  for (const standard of standards) {
    if (scope.removed.includes(standard.name)) continue;
    if (!standard.appliesTo) { out.push({ standard, why: "every", files: [] }); continue; }
    const globs = standard.appliesTo.map((p) => new Bun.Glob(p));
    const hit = files.filter((f) => globs.some((g) => g.match(f)));
    if (hit.length) out.push({ standard, why: "files", files: hit });
    else if (scope.added.includes(standard.name)) out.push({ standard, why: "added", files: [] });
  }
  return out;
}

/** A rule under an approved exception, with the reason. */
export interface Excepted { label: string; reason: string }

const standardText = (s: Standard): string => `### ${s.title} (${s.path})`;

/** The `standards` prompt variable: each standard whole under a line naming why it applies, then the scoped ones that do not apply yet, then the approved exceptions. "" when there is nothing to show. */
export function renderStandards(list: Applying[], opts: { scoped?: Standard[]; excepted?: Excepted[] } = {}): string {
  const scoped = opts.scoped ?? [];
  if (!list.length && !scoped.length) return "";
  const parts = list.map(({ standard, why, files }) => {
    const line = why === "every" ? "Applies to every change."
      : why === "added" ? "Applies because a person added it to this change."
      : `Applies because the change touches ${andList(files)}.`;
    return `${standardText(standard)}\n${line}\n\n${standard.body.trim()}`;
  });
  if (scoped.length) {
    parts.push("These apply only to changes that touch the files named.");
    for (const s of scoped) parts.push(`${standardText(s)}\nApplies only to changes that touch ${andList(s.appliesTo ?? [])}.\n\n${s.body.trim()}`);
  }
  const excepted = opts.excepted ?? [];
  if (excepted.length) parts.push(`Rules under an approved exception:\n${excepted.map((e) => `- ${e.label}: ${e.reason}`).join("\n")}`);
  return parts.join("\n\n");
}

type BulletKind = "keeps" | "not-applicable" | "exception";
export interface SectionBullet { label: string; kind: BulletKind; text: string }

const STANDARDS_HEADING = /^##\s+Standards\s*:?\s*$/i;
/** `- ARCH-1: x` as agents write it: the label bare, in `**`, or in backticks, followed by `:`, a dash or a long dash. */
const SECTION_BULLET = /^[-*]\s+(?:\*\*|`)?([A-Z][A-Za-z0-9._-]*)(?:\*\*|`)?(?:\s*[:\u2014\u2013]|\s+-{1,2}(?=\s))\s*(?:\*\*|`)?\s*(.*)$/;

/** The bullets of a spec's or plan's `## Standards` section; null when it has no such heading, [] for "None.". */
export function readStandardsSection(markdown: string): SectionBullet[] | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => STANDARDS_HEADING.test(l));
  if (start < 0) return null;
  const out: SectionBullet[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^#{1,2}\s/.test(l)) break;
    const m = SECTION_BULLET.exec(l);
    if (m) {
      const rest = (m[2] ?? "").trim();
      const na = /^does not apply\s*:\s*/i.exec(rest);
      const ex = /^exception\s*:\s*/i.exec(rest);
      out.push({ label: m[1] ?? "", kind: na ? "not-applicable" : ex ? "exception" : "keeps", text: rest.slice((na ?? ex)?.[0].length ?? 0).trim() });
    } else if (/^\s+\S/.test(l) && out.length && !/^\s*[-*]\s/.test(l)) {
      const last = out[out.length - 1];
      if (last) last.text = `${last.text} ${l.trim()}`.trim();
    }
  }
  return out;
}

/** The standards code check of the spec and plan gates: the heading is there, each required rule has a bullet, and every label is a real rule's. */
export function checkStandardsSection(section: SectionBullet[] | null, required: string[], known: ReadonlySet<string>): { ok: boolean; evidence: string } {
  if (!section) return { ok: false, evidence: "no Standards section" };
  const labels = new Set(section.map((b) => b.label));
  const missing = required.filter((r) => !labels.has(r));
  const unknown = [...labels].filter((l) => !known.has(l));
  const problems = [...(missing.length ? [`missing ${missing.join(", ")}`] : []), ...unknown.map((l) => `no rule called ${l}`)];
  if (problems.length) return { ok: false, evidence: problems.join("; ") };
  if (required.length) return { ok: true, evidence: `all ${required.length} rules addressed` };
  const exceptions = section.filter((b) => b.kind === "exception").length;
  return { ok: true, evidence: `${labels.size} ${labels.size === 1 ? "rule" : "rules"} addressed${exceptions ? `, ${exceptions} ${exceptions === 1 ? "exception" : "exceptions"}` : ""}` };
}

/** The size of the standards' text in bytes: what goes into every prompt that uses them whole. */
export function standardsBytes(r: StandardsRead): number {
  return r.standards.reduce((n, s) => n + Buffer.byteLength(s.body), 0);
}

/** One rule's line in an outcome's Standards section. `result` is met, unmet, needs-person, exception or not-checked; `evidence` is the reason for an exception. */
export interface OutcomeLine { label: string; title: string; result: string; evidence: string }

const OUTCOME_LINE = /^- (\S+) \((.+?)\): (.*)$/;

/** Reads the runtime's Standards section of outcome.md back. Lines that do not start with a rule label are skipped. */
export function readOutcomeStandards(outcome: string): OutcomeLine[] {
  const out: OutcomeLine[] = [];
  for (const raw of outcome.split(/\r?\n/)) {
    const m = OUTCOME_LINE.exec(raw);
    if (!m || !RULE_LABEL.test(m[1] ?? "")) continue;
    const [label, title, rest] = [m[1] ?? "", m[2] ?? "", m[3] ?? ""];
    const judged = /^(met|unmet|needs-person): (.*)$/.exec(rest);
    const exception = /^exception, approved by .+? at the (?:spec|plan): (.*)$/.exec(rest);
    if (judged) out.push({ label, title, result: judged[1] ?? "", evidence: judged[2] ?? "" });
    else if (exception) out.push({ label, title, result: "exception", evidence: exception[1] ?? "" });
    else if (rest === "not checked automatically") out.push({ label, title, result: "not-checked", evidence: "" });
  }
  return out;
}
