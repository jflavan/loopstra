import { parse, stringify } from "yaml";
import { z } from "zod";

export const STATUSES = [
  "draft", "accepted",
  "designing", "spec-review", "spec-approved",
  "planning", "plan-review", "plan-approved",
  "building", "reviewing", "merge-review", "merged",
  "verifying", "done",
  "blocked", "closed",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const Frontmatter = z.object({
  status: z.enum(STATUSES).default("draft"),
  priority: z.enum(PRIORITIES).default("normal"),
  author: z.string().default(""),
  opened: z.string().default(""),
  note: z.string().default(""),
  /** The last approved status, so a person can retry from it. Runtime-managed. */
  resume_from: z.enum(STATUSES).optional(),
}).strict();
export type Frontmatter = z.infer<typeof Frontmatter>;

export interface IntentFile {
  frontmatter: Frontmatter;
  title: string;
  body: string;
  sections: Record<string, string>;
}

export const REQUIRED_SECTIONS = ["Problem", "Proposed outcome", "Done when"] as const;

export function parseIntentFile(text: string): IntentFile {
  let fmText = "";
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    fmText = m[1] ?? "";
    body = text.slice(m[0].length);
  }
  const raw = fmText.trim() ? parse(fmText) : {};
  const fm = Frontmatter.safeParse(raw ?? {});
  if (!fm.success) {
    const issue = fm.error.issues[0];
    throw new Error(`intent.md frontmatter problem at ${issue?.path.join(".") || "top"}: ${issue?.message}`);
  }
  const titleMatch = /^#\s*(?:Intent:\s*)?(.+)$/m.exec(body);
  const title = titleMatch?.[1]?.trim() ?? "";
  return { frontmatter: fm.data, title, body, sections: parseSections(body) };
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current !== null) sections[current] = buf.join("\n").trim(); };
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { flush(); current = h[1] ?? ""; buf = []; }
    else if (current !== null) buf.push(line);
  }
  flush();
  return sections;
}

export function serializeIntentFile(file: IntentFile): string {
  const fm = stringify(file.frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${file.body.replace(/^\r?\n/, "")}`;
}
