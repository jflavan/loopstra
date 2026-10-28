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
export function globProblem(pattern: string): string | null {
  if (!pattern.trim()) return "an empty pattern";
  try { new Bun.Glob(pattern); } catch { return "not a valid pattern"; }
  let square = 0;
  let curly = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    // Inside a class every character but `]` is itself (`[[]` is a class of one `[`).
    else if (square > 0) { if (c === "]") square = 0; }
    else if (c === "[") square = 1;
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
        const bare = /^- (\S+?):\s*$/.exec(l);
        if (bare && RULE_LABEL.test(bare[1] ?? "")) { problem(line, `the rule on line ${line} has a label but no text (write it as \`- ${bare[1] ?? ""}: text\`)`); continue; }
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

/** What the loop, `start` and Needs attention say after the first unreadable file's sentence. */
const STANDARDS_STOP = " Fix it on main and commit; until then no change moves on.";

/** The one sentence for a set of problems (the first one's, then what to do); null when there are none. */
export function standardsStopText(problems: StandardsProblem[]): string | null {
  const first = problems[0];
  return first ? `${problemText(first)}${STANDARDS_STOP}` : null;
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

/**
 * Whether the form keeps a standard's file whole: the form read from it writes the same text back,
 * line endings and the file's end aside. When it does not (text before the title, a section after
 * the rules, front matter written another way), editing it as a form would rewrite it, so setup
 * leaves it to be edited by hand. The console's page makes the same decision (opensAsMarkdown).
 */
export function formKeeps(text: string, s: Standard): boolean {
  const norm = (t: string) => t.replace(/\r\n/g, "\n").trimEnd();
  return norm(text) === norm(formToMarkdown(standardToForm(s)));
}

/** The files in the standards folder as they are in a commit (only what is committed), and the folders found there. */
export async function standardsFilesAt(git: Git, commit: string): Promise<{ files: { path: string; text: string }[]; folders: string[] }> {
  // A missing folder lists nothing (exit 0); any failure is real and throws, so a step never runs on fewer rules than main has.
  const listed = await git.run(["ls-tree", "-z", commit, "--", `${STANDARDS_DIR}/`]);
  const blobs: string[] = [];
  const folders: string[] = [];
  for (const entry of listed.out.split("\0").filter(Boolean)) {
    const m = /^\d+ (\w+) \w+\t([\s\S]*)$/.exec(entry);
    if (!m) throw new Error(`git ls-tree gave a line that does not read: ${entry}`);
    const [type, path] = [m[1] ?? "", m[2] ?? ""];
    if (type !== "blob") folders.push(path);
    else blobs.push(path);
  }
  // The files are read at the same time: a folder holds a handful, and each read is one short git call.
  const files = await Promise.all(blobs.map(async (path) => ({ path, text: (await git.run(["cat-file", "blob", `${commit}:${path}`])).out })));
  return { files, folders };
}

/** A commit's full name: what a cached read is keyed by (a branch name moves, so it is never cached). */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** How many commits' reads are kept: main's last few, so the tick, Needs attention and the requests share one. */
const READS_KEPT = 8;
const reads = new Map<string, StandardsRead>();

/**
 * Reads the standards as they are in a commit: only what is committed, never the checkout's edits.
 * None there gives an empty read. A commit's files never change, so a read by its full sha is kept
 * (the last few, newest last) and the next caller gets a copy of it without asking git again.
 */
export async function readStandards(git: Git, commit: string): Promise<StandardsRead> {
  const keep = COMMIT_SHA.test(commit);
  const kept = keep ? reads.get(commit) : undefined;
  if (kept) {
    reads.delete(commit);
    reads.set(commit, kept);
    return copyOf(kept);
  }
  const { files, folders } = await standardsFilesAt(git, commit);
  const read = parseStandards(files);
  read.ignored.push(...folders);
  if (keep) {
    reads.set(commit, read);
    for (const oldest of reads.keys()) { if (reads.size <= READS_KEPT) break; reads.delete(oldest); }
  }
  return copyOf(read);
}

/** A read's lists copied, so a caller that adds to one never changes the kept read. */
function copyOf(r: StandardsRead): StandardsRead {
  return { standards: [...r.standards], problems: [...r.problems], ignored: [...r.ignored] };
}

/** The standards on a branch's last commit, with that commit; null when the branch has no commit yet. */
export async function branchStandards(git: Git, branch: string): Promise<{ commit: string; read: StandardsRead } | null> {
  const commit = await git.commitOf(branch);
  return commit ? { commit, read: await readStandards(git, commit) } : null;
}

/** True when a read found standard files, read or not: a repository with any has rules to except. */
export function hasStandardFiles(r: StandardsRead): boolean {
  return r.standards.length + r.problems.length > 0;
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

/**
 * Run-folder marker: the standards that applied to the change when the merge gate's checks passed,
 * JSON `{ commit, applying: { name, why, files }[] }` (commit: the one the standards were read at).
 * The done step and the console's panel judge the merged files by it. Not written in a repository without standards.
 */
export const STANDARDS_APPLIED = "standards.applied";

const AppliedMarker = z.object({
  commit: z.string().optional(),
  applying: z.array(z.object({ name: z.string(), why: z.enum(["every", "files", "added"]), files: z.array(z.string()).default([]) })),
});

/** What STANDARDS_APPLIED holds. */
export type AppliedRecord = z.infer<typeof AppliedMarker>;

/** The marker's text read, or null when there is none or it is not what the merge gate writes. */
export function readAppliedMarker(text: string | null): AppliedRecord | null {
  if (text === null) return null;
  try {
    const m = AppliedMarker.safeParse(JSON.parse(text));
    return m.success ? m.data : null;
  } catch {
    return null;
  }
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

/** More standards text than this (40 KB) gets a warning. */
const SIZE_WARNING_BYTES = 40 * 1024;

/** The warning for standards over 40 KB together, or null. A warning, not a limit: a team with large standards can scope them. */
export function standardsSizeWarning(r: StandardsRead): string | null {
  const bytes = standardsBytes(r);
  if (bytes <= SIZE_WARNING_BYTES) return null;
  return `The standards together are ${Math.round(bytes / 1024)} KB, over 40 KB. Every standard that applies goes into every prompt that uses them whole, so scope some with applies_to or shorten them.`;
}

/** One rule's line in an outcome's Standards section. `result` is met, unmet, needs-person, exception or not-checked; `evidence` is the reason for an exception. */
export interface OutcomeLine { label: string; title: string; result: string; evidence: string }

/** `- LABEL (`, then the rest of the line: the title, then `): ` and the result. */
const OUTCOME_LINE = /^- (\S+) \((.*)$/;
/** Where the title ends: `): ` before a result. A title may hold `): ` itself, so the last one counts. */
const RESULT_START = /\): (?=(?:met|unmet|needs-person):(?:\s|$)|exception, approved by |not checked automatically$)/g;

/** Reads the runtime's Standards section of outcome.md back. Lines that do not start with a rule label are skipped. */
export function readOutcomeStandards(outcome: string): OutcomeLine[] {
  const out: OutcomeLine[] = [];
  for (const raw of outcome.split(/\r?\n/)) {
    const m = OUTCOME_LINE.exec(raw.trimEnd());
    if (!m || !RULE_LABEL.test(m[1] ?? "")) continue;
    const tail = m[2] ?? "";
    const end = [...tail.matchAll(RESULT_START)].at(-1)?.index;
    if (end === undefined) continue;
    const [label, title, rest] = [m[1] ?? "", tail.slice(0, end), tail.slice(end + 3)];
    const judged = /^(met|unmet|needs-person):\s*(.*)$/.exec(rest);
    const exception = /^exception, approved by .+? at the (?:spec|plan): (.*)$/.exec(rest);
    if (judged) out.push({ label, title, result: judged[1] ?? "", evidence: judged[2] ?? "" });
    else if (exception) out.push({ label, title, result: "exception", evidence: exception[1] ?? "" });
    else if (rest === "not checked automatically") out.push({ label, title, result: "not-checked", evidence: "" });
  }
  return out;
}
