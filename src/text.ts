import { parse } from "yaml";

/** Items as a plain list: "a", "a and b", "a, b and c" ("" for none). */
export function andList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}` : items[0] ?? "";
}

/** Text on one line, at most `max` characters: for commit subjects and pull request titles. */
export function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A text's lines, each with its line ending ("\r\n" or "\n"; none on a last line without one). [""] for "". */
export const linesOf = (text: string): string[] => text.split(/(?<=\n)/);

/** A line's text without its line ending. */
export const lineText = (line: string): string => line.replace(/\r?\n$/, "");

/** True when most of a text's line endings are "\r\n". */
export const isCrlf = (s: string): boolean => (s.match(/\r\n/g)?.length ?? 0) * 2 > (s.match(/\n/g)?.length ?? 0);

/** Text from outside (a file, a fetched source, git's output) safe to print: control characters become spaces. */
export const printable = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * The frontmatter keys of a markdown file (CRLF fine, a byte order mark fine), and the rest of it: null
 * when it has no frontmatter. Frontmatter that is not YAML keys and values counts as none, and
 * `problem` says what it is instead.
 */
export function splitFrontmatter(text: string): { front: Record<string, unknown>; body: string | null; problem?: string } {
  const m = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return { front: {}, body: null };
  const body = m[2] ?? "";
  let v: unknown;
  try { v = parse(m[1] ?? ""); } catch { return { front: {}, body, problem: "not YAML" }; }
  if (v === null || v === undefined) return { front: {}, body };
  if (typeof v === "object" && !Array.isArray(v)) return { front: v as Record<string, unknown>, body };
  return { front: {}, body, problem: "not YAML keys and values" };
}

/** Today's date in the machine's own time zone, as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
