import { RULE_LABEL, STANDARD_NAME, type Scope } from "./standards";

/** The file in a change's folder that holds what people decided about its standards. */
export const STANDARDS_RECORD = "standards.md";

/** A standard added to a change or removed from it. `via` is where the person did it, without "from" ("the console"). */
interface Decision { name: string; note: string; by: string; via: string; date: string }

/** An exception a person approved at the spec or the plan. */
interface ApprovedException { label: string; gate: "spec" | "plan"; reason: string; by: string; via: string; date: string }

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
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{1,2}\s/.test(line)) {
      const found = (Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).find((k) => SECTIONS[k].test(line));
      if (found) section = found;
      else if (line.startsWith("## ")) { section = "other"; out.problems.push(`standards.md has a section ${line.slice(3).trim()}, which is not Added, Removed or Exceptions approved.`); }
      continue;
    }
    if (!line.startsWith("- ")) continue;
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
