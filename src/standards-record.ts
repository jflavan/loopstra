import { readStandardsSection, RULE_LABEL, STANDARD_NAME, type Scope, type SectionBullet } from "./standards";

/** The file in a change's folder that holds what people decided about its standards. */
export const STANDARDS_RECORD = "standards.md";

/** A standard added to a change or removed from it. `via` is where the person did it, without "from" ("the console"). */
interface Decision { name: string; note: string; by: string; via: string; date: string }

/** An exception a person approved at the spec or the plan. */
export interface ApprovedException { label: string; gate: "spec" | "plan"; reason: string; by: string; via: string; date: string }

export interface ChangeStandards { added: Decision[]; removed: Decision[]; exceptions: ApprovedException[]; problems: string[] }

const TAIL = String.raw`\((.+?), from (.+), (\d{4}-\d{2}-\d{2})\)$`;
const DECISION = new RegExp(String.raw`^- (\S+?): (.+) ${TAIL}`);
const EXCEPTION = new RegExp(String.raw`^- (\S+) at the (spec|plan): (.+) ${TAIL}`);

const SECTIONS = { added: /^## Added\s*$/i, removed: /^## Removed\s*$/i, exceptions: /^## Exceptions approved\s*$/i };

/**
 * Reads a change's standards.md. Forgiving: a line that does not read, and a standard not in `known`
 * (when given), is a problem in words and is not applied.
 */
export function parseRecord(text: string | null, known?: ReadonlySet<string>): ChangeStandards {
  const out: ChangeStandards = { added: [], removed: [], exceptions: [], problems: [] };
  if (text === null) return out;
  let section: keyof typeof SECTIONS | "other" | null = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{1,2}\s/.test(line)) {
      const found = (Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).find((k) => SECTIONS[k].test(line));
      if (found) section = found;
      else if (line.startsWith("## ")) { section = "other"; out.problems.push(`standards.md has a section ${line.slice(3).trim()}, which is not Added, Removed or Exceptions approved.`); }
      continue;
    }
    if (!line.trim()) continue;
    // Any other text (prose, a `###` heading, a wrapped line) is a person's: it does not read, so it is
    // listed and kept as it is (see approvedRecord). Lines under an unknown section are that section's problem.
    if (!line.startsWith("- ")) {
      if (section !== "other") out.problems.push(unread(line, "a `- ` line under Added, Removed or Exceptions approved"));
      continue;
    }
    if (section === "added" || section === "removed") {
      const m = DECISION.exec(line);
      if (!m || !STANDARD_NAME.test(m[1] ?? "")) { out.problems.push(unread(line, `- <standard>: <note> (<who>, from <where>, <date>)`)); continue; }
      const name = m[1] ?? "";
      if (known && !known.has(name)) { out.problems.push(`standards.md names ${name}, which is not a standard on main.`); continue; }
      out[section].push({ name, note: m[2] ?? "", by: m[3] ?? "", via: m[4] ?? "", date: m[5] ?? "" });
    } else if (section === "exceptions") {
      const m = EXCEPTION.exec(line);
      if (!m || !RULE_LABEL.test(m[1] ?? "")) { out.problems.push(unread(line, `- <LABEL> at the <spec or plan>: <reason> (<who>, from <where>, <date>)`)); continue; }
      out.exceptions.push({ label: m[1] ?? "", gate: m[2] === "spec" ? "spec" : "plan", reason: m[3] ?? "", by: m[4] ?? "", via: m[5] ?? "", date: m[6] ?? "" });
    } else if (section === null) out.problems.push(unread(line, "a line under Added, Removed or Exceptions approved"));
  }
  return out;
}

function unread(line: string, form: string): string {
  return `standards.md has a line that does not read: ${line} (write it as ${form}).`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const decision = (d: Decision): string => `- ${d.name}: ${oneLine(d.note)} (${d.by}, from ${d.via}, ${d.date})`;
const exception = (e: ApprovedException): string => `- ${e.label} at the ${e.gate}: ${oneLine(e.reason)} (${e.by}, from ${e.via}, ${e.date})`;

/** The file for a record, or null when there is nothing to record (a change without decisions has no such file). */
export function renderRecord(slug: string, r: ChangeStandards): string | null {
  const sections = [
    r.added.length ? `## Added\n${r.added.map(decision).join("\n")}` : "",
    r.removed.length ? `## Removed\n${r.removed.map(decision).join("\n")}` : "",
    r.exceptions.length ? `## Exceptions approved\n${r.exceptions.map(exception).join("\n")}` : "",
  ].filter(Boolean);
  return sections.length ? `# Standards decisions for ${slug}\n\n${sections.join("\n\n")}\n` : null;
}

/** The record as a scope, for `applying`. */
export function scopeOf(r: ChangeStandards): Scope {
  return { added: r.added.map((d) => d.name), removed: r.removed.map((d) => d.name) };
}

type Gate = "spec" | "plan";

/** Who approved and from where, as the record words it: "J." and "the console", or "a status edit" and "intent.md". */
interface Approver { by: string; via: string }

/** True when the record has the exception approved: the same rule with the same reason (at either gate). A reworded reason is a new exception. */
const approved = (r: ChangeStandards, label: string, reason: string): boolean => r.exceptions.some((e) => e.label === label && oneLine(e.reason) === oneLine(reason));

/**
 * The exceptions a spec's or plan's Standards section asks for that the record has not approved yet:
 * one approved at the spec and repeated in the plan for the same rule with the same reason needs no
 * second approval. The gate (which artifact this is) does not change what counts as approved.
 */
export function exceptionsToApprove(artifact: string, _gate: Gate, r: ChangeStandards): SectionBullet[] {
  const out: SectionBullet[] = [];
  for (const b of readStandardsSection(artifact) ?? []) {
    if (b.kind !== "exception" || approved(r, b.label, b.text) || out.some((o) => o.label === b.label && oneLine(o.text) === oneLine(b.text))) continue;
    out.push(b);
  }
  return out;
}

/** The note of a gate that waits for a person to allow its exceptions; `titles` gives each rule's standard's title. */
export function exceptionNote(gate: Gate, bullets: SectionBullet[], titles: ReadonlyMap<string, string>): string {
  const one = (b: SectionBullet): string => {
    const title = titles.get(b.label);
    return `${b.label}${title ? ` (${title})` : ""}: ${oneLine(b.text).replace(/[.\s]+$/, "")}`;
  };
  const many = bullets.length > 1;
  const asks = many
    ? `exceptions to ${bullets.slice(0, -1).map(one).join("; to ")}; and to ${one(bullets[bullets.length - 1]!)}`
    : `an exception to ${bullets.map(one).join("")}`;
  const it = many ? "them" : "it";
  return `The ${gate} asks for ${asks}. Read ${gate}.md. To allow ${it}, set status to ${gate}-approved; to have the ${gate} written again without ${it}, send it back with a note.`;
}

/** Who or where as the record can read it back: one line, with no parentheses (they end the reason's tail). */
const tailSafe = (s: string): string => oneLine(s).replace(/\(/g, "[").replace(/\)/g, "]");

/**
 * The record with `bullets` approved at `gate` by `who` on `date` (YYYY-MM-DD); one approved already is
 * not added again. `who` is written so it reads back (see tailSafe).
 */
export function withApprovals(r: ChangeStandards, gate: Gate, bullets: SectionBullet[], who: Approver, date: string): ChangeStandards {
  const exceptions = [...r.exceptions];
  for (const b of bullets) {
    if (approved({ ...r, exceptions }, b.label, b.text)) continue;
    exceptions.push({ label: b.label, gate, reason: oneLine(b.text), by: tailSafe(who.by), via: tailSafe(who.via), date });
  }
  return { ...r, exceptions };
}

/** The approvals in `after` that `before` does not have: what one record added. */
export function addedApprovals(before: ChangeStandards, after: ChangeStandards): ApprovedException[] {
  return after.exceptions.filter((e) => !before.exceptions.some((b) => sameApproval(b, e)));
}

const sameApproval = (a: ApprovedException, b: ApprovedException): boolean =>
  a.label === b.label && a.gate === b.gate && oneLine(a.reason) === oneLine(b.reason) && a.by === b.by && a.via === b.via && a.date === b.date;

/**
 * The record's file, `text`, without the approvals `taken` (an approval taken back): exactly those
 * entries, by rule, gate, reason, who, where and date. Null when nothing is left to record (the file
 * goes). A record with lines that do not read keeps them: only the taken lines are dropped.
 */
export function revokedRecord(slug: string, text: string | null, taken: ApprovedException[]): string | null {
  const r = parseRecord(text);
  const isTaken = (e: ApprovedException) => taken.some((t) => sameApproval(t, e));
  if (!r.problems.length || text === null) return renderRecord(slug, { ...r, exceptions: r.exceptions.filter((e) => !isTaken(e)) });
  return text.split(/(?<=\n)/).filter((line) => {
    const e = parseRecord(`## Exceptions approved\n${line}`).exceptions[0];
    return !(e && isTaken(e));
  }).join("");
}

/**
 * The record's file, `text` (null for none), once `bullets` are approved (see withApprovals). A record
 * that reads is written again whole; one with lines that do not read (a person's, listed under Needs
 * attention for them to fix) is kept as it is, with the approvals added at its end.
 */
export function approvedRecord(slug: string, text: string | null, gate: Gate, bullets: SectionBullet[], who: Approver, date: string): string {
  const r = parseRecord(text);
  const next = withApprovals(r, gate, bullets, who, date);
  if (!r.problems.length || text === null) return renderRecord(slug, next) ?? "";
  const lines = next.exceptions.slice(r.exceptions.length).map(exception).join("\n");
  const body = text.replace(/\s*$/, "\n");
  const headings = body.split(/\r?\n/).filter((l) => /^#{1,2}\s/.test(l));
  const last = headings[headings.length - 1] ?? "";
  return SECTIONS.exceptions.test(last.trimEnd()) ? `${body}${lines}\n` : `${body}\n## Exceptions approved\n${lines}\n`;
}
