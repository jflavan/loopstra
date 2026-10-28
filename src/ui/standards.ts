import { STANDARD_EXAMPLES } from "../standard-examples";
import type { DraftCheck, ExceptionRow, StandardForm, StandardRow, StandardsProblem, StandardsView } from "../console/types";

/*
 * Settings › Standards on the page's side: what the editor says next to each field, when Save is
 * offered, and the words of the list and its notices. Reading a standard, its patterns and the set
 * it joins happens on the server (`POST /api/standards/check`); these are only the checks the page
 * can make as a person types. The two patterns are src/standards.ts's, which the page may not import.
 */

const RULE_LABEL = /^(?:[A-Z]|[A-Z][A-Za-z0-9._-]{0,30}[A-Za-z0-9])$/;
const STANDARD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether a name can be a standard's file name (the check route takes no other). */
export const isStandardName = (name: string): boolean => STANDARD_NAME.test(name);

/** The form's fields; `file` is a problem with the file as a whole (its front matter, say), said under the form. */
type Field = "name" | "title" | "patterns" | "check" | "rules" | "file" | `rule:${number}`;

const andList = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1) ?? ""}` : xs[0] ?? "");

/**
 * What to say next to each field of the form. The page's own checks (the name, the title, each rule's
 * label and words, labels used twice in the form, empty patterns), then the server's problems, each
 * on the field it is about: a pattern's on the patterns, a label's on its rule rows, a check's on the
 * check, anything else on `file`. `taken`: the names main has, for a new standard (an edited one keeps its own).
 */
export function fieldProblems(f: StandardForm, serverProblems: StandardsProblem[], taken: readonly string[] = []): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  const add = (k: Field, text: string) => { out[k] = out[k] ? `${out[k]} ${text}` : text; };
  if (!STANDARD_NAME.test(f.name)) add("name", "A standard's name is lowercase words joined by dashes, like security.");
  else if (taken.includes(f.name)) add("name", `There is already a file loopstra/standards/${f.name}.md: pick another name.`);
  if (!f.title.trim()) add("title", "Give the standard a title.");
  if (f.patterns.some((p) => !p.trim())) add("patterns", "A pattern cannot be empty: fill it in or take it out.");
  if (!f.rules.length) add("rules", "Add at least one rule.");
  f.rules.forEach((r, i) => {
    if (!RULE_LABEL.test(r.label)) add(`rule:${i}`, r.label ? `${r.label} is not a valid label: start with a capital letter, then letters, digits, ., _ or -, ending in a letter or digit, 32 characters at most.` : "Give the rule a label.");
    else if (f.rules.some((o, j) => j !== i && o.label === r.label)) add(`rule:${i}`, `${r.label} is used twice in this standard.`);
    if (!r.text.trim()) add(`rule:${i}`, "Say what the rule asks.");
  });
  const rulesSaid = Object.keys(out).some((k) => k.startsWith("rule"));
  for (const p of serverProblems) {
    const text = `${p.text}.`;
    const label = /\bthe label (\S+)/.exec(p.text)?.[1];
    const rows = label ? f.rules.flatMap((r, i) => (r.label === label ? [i] : [])) : [];
    // A problem the page caught already is not said twice.
    if (rows.length) { for (const i of rows) if (!out[`rule:${i}`]) add(`rule:${i}`, text); }
    else if (p.text.startsWith("applies_to")) { if (!out.patterns) add("patterns", text); }
    else if (p.text.startsWith("check")) add("check", text);
    else if (p.text.startsWith("it has no title")) { if (!out.title) add("title", text); }
    else if (!(rulesSaid && /^the (rule|Rules section) on line/.test(p.text))) add("file", text);
  }
  return out;
}

/** The names a new standard may not take: main's standards, files there that cannot be read, and ignored `<name>.md` paths (a folder, say). */
export function takenNames(v: { standards: Pick<StandardRow, "name">[]; problems: StandardsView["problems"]; ignored: StandardsView["ignored"] }): string[] {
  const named = (t: string) => /^loopstra\/standards\/([^/\s]+)\.md(?:\s|$)/.exec(t)?.[1];
  const names = [...v.standards.map((s) => s.name), ...[...v.problems, ...v.ignored].map(named).filter((n): n is string => !!n && isStandardName(n))];
  return [...new Set(names)];
}

/**
 * Whether a standard of main's opens as Markdown: when the server, given the form it read from the
 * file, writes something else (`formText`; null when it read no form), since the form keeps only the
 * title, the patterns, the check, the context and the rules. Line endings and the file's end do not count.
 */
export function opensAsMarkdown(fileText: string, formText: string | null): boolean {
  const norm = (t: string) => t.replace(/\r\n/g, "\n").trimEnd();
  return formText === null || norm(fileText) !== norm(formText);
}

/** Save is offered only for a form the page finds nothing wrong with and that the server has checked, as it stands, with no problems. */
export function canSave(f: StandardForm, check: DraftCheck | null): boolean {
  return check !== null && check.problems.length === 0 && Object.keys(fieldProblems(f, [])).length === 0;
}

/** What saving says, when changes in progress are held to the standard; null when none are. */
export function saveNotice(inProgress: readonly string[]): string | null {
  if (!inProgress.length) return null;
  const one = inProgress.length === 1;
  return `${andList(inProgress)} ${one ? "is" : "are"} in progress under this standard; ${one ? "its" : "their"} next steps use the new rules.`;
}

/** The question Remove asks first, naming the changes in progress it applies to. */
export function removeText(s: Pick<StandardRow, "title" | "path" | "inProgress">): string {
  const ask = `Remove ${s.title} (${s.path})?`;
  if (!s.inProgress.length) return `${ask} No change in progress is under it.`;
  return `${ask} ${andList(s.inProgress)} ${s.inProgress.length === 1 ? "is" : "are"} in progress under it; ${s.inProgress.length === 1 ? "its" : "their"} next steps no longer use its rules.`;
}

/** A row's scope: every change, or its patterns with how many files they match on main now. */
export function scopeLine(s: Pick<StandardRow, "scope" | "matches">): string {
  return s.matches === null ? s.scope : `${s.scope} (${s.matches} file${s.matches === 1 ? "" : "s"} on main now)`;
}

/** The exceptions of one standard and one rule; an empty filter keeps all. */
export function filterExceptions(rows: ExceptionRow[], by: { standard: string; rule: string }): ExceptionRow[] {
  return rows.filter((r) => (!by.standard || r.standard === by.standard) && (!by.rule || r.label === by.rule));
}

/** A blank standard, for New standard. */
export const BLANK: StandardForm = { name: "", title: "", patterns: [], needsPerson: false, check: "", rules: [{ label: "", text: "" }], context: "" };

/** The README's two examples, offered by New standard to start from. */
export const EXAMPLES: { label: string; form: StandardForm }[] = STANDARD_EXAMPLES;
