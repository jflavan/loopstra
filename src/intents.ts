import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { errorText } from "./shell";

export const STATUSES = [
  "draft", "accepted",
  "designing", "spec-review", "spec-approved",
  "planning", "plan-review", "plan-approved",
  "building", "reviewing", "merge-review", "merge-approved", "merged",
  "verifying", "done",
  "blocked", "closed",
] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A plain-language field that non-technical editors often leave blank, yielding YAML null. */
const blankableString = z.string().nullable().transform((v) => v ?? "").default("");

export const Frontmatter = z.object({
  status: z.enum(STATUSES).default("draft"),
  /** Optional: absent means the owner did not state one; the queue treats that as normal. Blank reads as absent. */
  priority: z.enum(PRIORITIES).nullish().transform((v) => v ?? undefined),
  author: blankableString,
  opened: blankableString,
  note: blankableString,
  /**
   * Optional: changes that must be merged before this one runs. One name or a list; blank reads
   * as absent. Written by a person, never by the runtime.
   */
  depends_on: z.union([z.string(), z.array(z.string())]).nullish().transform((v) => {
    const names = (typeof v === "string" ? [v] : v ?? []).map((n) => n.trim()).filter(Boolean);
    return names.length ? [...new Set(names)] : undefined;
  }),
  /** The last approved status, so a person can retry from it. Runtime-managed. */
  resume_from: z.enum(STATUSES).optional(),
}).strict();
export type Frontmatter = z.infer<typeof Frontmatter>;

/** The priority used for ordering and display: the stated one, or normal when none is stated. */
export function effectivePriority(fm: { priority?: Priority }): Priority {
  return fm.priority ?? "normal";
}

export interface IntentFile {
  frontmatter: Frontmatter;
  title: string;
  body: string;
  sections: Record<string, string>;
}

export const REQUIRED_SECTIONS = ["Problem", "Proposed outcome", "Done when"] as const;

export function parseIntentFile(rawText: string): IntentFile {
  const text = rawText.replace(/^﻿/, "");
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
    const unknown = issue?.code === "unrecognized_keys" ? issue.keys : [];
    const field = issue?.path.join(".") || unknown.join(", ") || "top";
    throw new FrontmatterProblem(field, `intent.md frontmatter problem at ${field}: ${issue?.message}`, unknown.length > 0);
  }
  const titleMatch = /^#(?!#)\s*(?:Intent:\s*)?(.+)$/m.exec(body);
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
  const crlf = file.body.includes("\r\n");
  const fm = stringify(file.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = file.body.replace(/^\r?\n/, "");
  const text = `---\n${fm}\n---\n${body}`;
  return crlf ? text.replace(/\r?\n/g, "\r\n") : text;
}

export interface Intent {
  slug: string;
  dir: string;
  file: IntentFile;
  /** Artifact file names present in the folder, e.g. "spec.md". */
  artifacts: Set<string>;
}

export const ARTIFACTS = ["intent.md", "spec.md", "plan.md", "review.md", "outcome.md", "lessons.md"] as const;

export function intentRoot(root: string): string {
  return join(root, "intent");
}

export async function readIntent(root: string, slug: string): Promise<Intent> {
  const dir = join(intentRoot(root), slug);
  const text = await Bun.file(join(dir, "intent.md")).text();
  const artifacts = new Set(ARTIFACTS.filter((a) => existsSync(join(dir, a))));
  return { slug, dir, file: parseIntentFile(text), artifacts };
}

/** An intent folder whose intent.md could not be read. `problem` is plain; `detail` is for the trace. */
export interface Unreadable { slug: string; problem: string; detail: string }

export interface Scan { intents: Intent[]; unreadable: Unreadable[] }

/** A change's folder name: lowercase letters and digits, words joined by dashes. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Every intent folder: the readable intents, and the ones a person needs to fix. Never throws for one bad file. */
export async function scanRepo(root: string): Promise<Scan> {
  const base = intentRoot(root);
  const scan: Scan = { intents: [], unreadable: [] };
  if (!existsSync(base)) return scan;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, "intent.md"))) continue;
      // The folder name is also the branch name and the pull request's title: keep it plain.
      if (!SLUG.test(name)) {
        scan.unreadable.push({ slug: name, problem: "Rename the folder to lowercase words joined by dashes, like add-numbers.", detail: `"${name}" is not a valid change name (${SLUG})` });
        continue;
      }
      scan.intents.push(await readIntent(root, name));
    } catch (e) {
      const detail = errorText(e);
      scan.unreadable.push({ slug: name, problem: unreadableProblem(e), detail });
    }
  }
  return scan;
}

function unreadableProblem(e: unknown): string {
  if (e instanceof FrontmatterProblem && e.unknownKey) {
    return `intent.md has a line Loopstra does not recognise: '${e.field.split(", ").join("', '")}'. Remove it or fix the spelling.`;
  }
  if (e instanceof FrontmatterProblem) {
    return `The ${e.field} line at the top of intent.md has a value Loopstra does not understand. Fix it, and the change is picked up again.`;
  }
  return "The lines between the --- markers at the top of intent.md could not be read. Fix them, and the change is picked up again.";
}

/** intent.md frontmatter that parsed as YAML but has an invalid field (or, `unknownKey`, a key Loopstra does not know). */
export class FrontmatterProblem extends Error {
  constructor(public readonly field: string, message: string, public readonly unknownKey = false) {
    super(message);
    this.name = "FrontmatterProblem";
  }
}

/** One frontmatter value as YAML on a single line (quoted when YAML needs it). */
function scalar(v: string): string {
  const s = stringify(v, { lineWidth: 0 }).trimEnd();
  return s.includes("\n") ? JSON.stringify(v) : s;
}

/** Where a `key: value` line's trailing comment starts (with the whitespace before it), or -1. */
function commentStart(rest: string): number {
  const t = rest.trimStart();
  let from = rest.length - t.length;
  const q = t[0];
  if (q === '"' || q === "'") {
    // Skip past the closing quote ('' escapes a single quote; \" escapes a double one).
    let i = from + 1;
    while (i < rest.length) {
      if (q === '"' && rest[i] === "\\") { i += 2; continue; }
      if (rest[i] === q) {
        if (q === "'" && rest[i + 1] === "'") { i += 2; continue; }
        break;
      }
      i++;
    }
    from = i + 1;
  }
  const m = /\s#/.exec(rest.slice(from));
  if (!m) return -1;
  // Include the whitespace run before the #, so the comment keeps its column.
  let start = from + m.index;
  while (start > 0 && /\s/.test(rest[start - 1]!)) start--;
  return start;
}

/**
 * Changes frontmatter keys in intent.md text, line by line: each given key's line is replaced (a
 * trailing comment is kept), or added just before the closing `---`. Everything else (other keys
 * and their order, comments, blank lines, the body, CRLF or LF, a leading BOM) stays as it was, so
 * a person's own edits to the file survive a status change. A frontmatter shape the line patcher
 * cannot handle (for example a one-line `{...}` map) is rewritten whole, which still parses.
 */
export function patchFrontmatter(raw: string, patch: Record<string, string>): string {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const text = raw.slice(bom.length);
  const parts = text.split(/(?<=\n)/);
  const content = (p: string) => p.replace(/\r?\n$/, "");
  const eol = /\r\n/.exec(text) ? "\r\n" : "\n";
  const entries = Object.entries(patch);
  if (!entries.length) return raw;

  const close = content(parts[0] ?? "").trimEnd() === "---" ? parts.findIndex((p, i) => i > 0 && content(p).trimEnd() === "---") : -1;
  let out: string;
  if (close < 0) {
    out = bom + ["---", ...entries.map(([k, v]) => `${k}: ${scalar(v)}`), "---"].join(eol) + eol + text;
  } else {
    const head = parts.slice(0, close);
    const tail = parts.slice(close);
    for (const [key, value] of entries) {
      const at = head.findIndex((p, i) => i > 0 && new RegExp(`^${key}\\s*:`).test(content(p)));
      const line = `${key}: ${scalar(value)}`;
      if (at < 0) { head.push(line + eol); continue; }
      const own = content(head[at]!);
      const ending = head[at]!.slice(own.length) || eol;
      const rest = own.slice(own.indexOf(":") + 1);
      const c = commentStart(rest);
      head[at] = line + (c >= 0 ? rest.slice(c) : "") + ending;
      // A value that went on over indented lines (a block or folded scalar) is replaced whole.
      let end = at + 1;
      while (end < head.length && /^(\s+\S|\s*$)/.test(content(head[end]!))) end++;
      while (end > at + 1 && !content(head[end - 1]!).trim()) end--;
      head.splice(at + 1, end - at - 1);
    }
    out = bom + head.join("") + tail.join("");
  }
  if (patched(out, patch)) return out;
  // Fallback: rewrite the whole frontmatter from what the file says, with the patch on top.
  const file = parseIntentFile(raw);
  const next = Frontmatter.parse({ ...file.frontmatter, ...patch });
  return serializeIntentFile({ ...file, frontmatter: next });
}

/** True when `text` parses and has every patched value. */
function patched(text: string, patch: Record<string, string>): boolean {
  try {
    const fm = parseIntentFile(text).frontmatter as Record<string, unknown>;
    return Object.entries(patch).every(([k, v]) => (fm[k] ?? "") === v);
  } catch {
    return false;
  }
}

/**
 * Writes frontmatter keys into intent.md. The file is read from disk right before writing and only
 * the given keys change (see patchFrontmatter), so a person's edits made meanwhile are kept. With
 * `expectStatus`, nothing is written when the status on disk is a different one (a person changed
 * it); the return value says whether it wrote. `intent.file` is refreshed from what was written.
 */
export async function writeIntent(intent: Intent, patch: Partial<Frontmatter>, opts: { expectStatus?: Status } = {}): Promise<boolean> {
  const path = join(intent.dir, "intent.md");
  const onDisk = existsSync(path) ? await Bun.file(path).text() : serializeIntentFile(intent.file);
  if (opts.expectStatus !== undefined && parseIntentFile(onDisk).frontmatter.status !== opts.expectStatus) return false;
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) values[k] = String(v);
  const text = patchFrontmatter(onDisk, values);
  await Bun.write(path, text);
  intent.file = parseIntentFile(text);
  return true;
}

/** Artifacts a status implies. */
const IMPLIES: Partial<Record<Status, readonly string[]>> = {
  "spec-review": ["spec.md"], "spec-approved": ["spec.md"],
  planning: ["spec.md"], "plan-review": ["spec.md", "plan.md"], "plan-approved": ["spec.md", "plan.md"],
  building: ["spec.md", "plan.md"], reviewing: ["spec.md", "plan.md"],
  "merge-review": ["spec.md", "plan.md"], "merge-approved": ["spec.md", "plan.md"], merged: ["spec.md", "plan.md"],
  verifying: ["spec.md", "plan.md"], done: ["spec.md", "plan.md", "outcome.md"],
};

/**
 * Returns a plain-language problem, or null when the folder matches the status. Drafts are still
 * being written and done or closed changes are finished, so none of them is checked.
 */
export function checkConsistency(intent: Intent): string | null {
  const status = intent.file.frontmatter.status;
  if (status === "draft" || status === "done" || status === "closed") return null;
  for (const name of IMPLIES[status] ?? []) {
    if (!intent.artifacts.has(name)) {
      return `Status is "${status}" but ${name} is missing. Set status back to an earlier approved state, or to closed.`;
    }
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !intent.file.sections[s]?.trim());
  if (missing.length) {
    return `This request is missing ${listText(missing.map((s) => `a ${s}`))} section. Add ${missing.length > 1 ? "them" : "it"} to intent.md, then set status to accepted.`;
  }
  return null;
}

/** "a", "a and b", "a, b and c". */
function listText(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0] ?? "";
}

export type HumanGates = { spec: "status" | "pr" | "none"; plan: "status" | "pr" | "none"; merge: "status" | "pr" | "none"; done: "status" | "pr" | "none" };

/** The review statuses, and the gate whose `human` setting decides whether a person is on each. */
export const REVIEW_GATE: Partial<Record<Status, keyof HumanGates>> = {
  "spec-review": "spec", "plan-review": "plan", "merge-review": "merge", verifying: "done",
};

/**
 * Waiting for a person: blocked, a draft, or a review status whose gate has a person on it. (A
 * merge-review with nobody on the gate waits for GitHub's checks, not for a person.)
 */
export function waitsForPerson(intent: Intent, human: HumanGates): boolean {
  const s = intent.file.frontmatter.status;
  if (s === "blocked" || s === "draft") return true;
  const gate = REVIEW_GATE[s];
  return !!gate && human[gate] !== "none";
}

/**
 * Runnable: the runtime has something to do for this intent right now.
 * A review status whose gate has a person on it is not runnable: it means the automated checks
 * passed and a person is deciding; the scan picks up their status change (for example
 * merge-review → merge-approved, which is runnable).
 * With a remote, merge-review is always runnable: the merge step watches the pull request (merged
 * or closed on GitHub, its checks, and its approval when merge.human is pr).
 */
export function isRunnable(intent: Intent, human: HumanGates, hasRemote = false): boolean {
  const s = intent.file.frontmatter.status;
  if (s === "draft" || s === "blocked" || s === "done" || s === "closed") return false;
  if (s === "merge-review" && hasRemote) return true;
  const gate = REVIEW_GATE[s];
  if (gate && human[gate] !== "none") return false;
  return true;
}

/** A dependency counts as met once its code is in main. */
const MERGED: ReadonlySet<Status> = new Set(["merged", "verifying", "done"]);

/** The changes named in `depends_on` that are not merged yet (or cannot be found), in the order written. */
export function waitingOn(intent: Intent, intents: Intent[]): string[] {
  return (intent.file.frontmatter.depends_on ?? []).filter((slug) => {
    const dep = intents.find((i) => i.slug === slug);
    return !dep || !MERGED.has(dep.file.frontmatter.status);
  });
}

/**
 * Why a change waits for others, or null when it does not. `needsPerson` is set when only a person
 * can end the wait (a name that matches no change, a closed change, or changes waiting for each
 * other); otherwise the change goes on by itself once the others merge. Drafts, blocked, and
 * finished changes have nothing to hold up, so none of them gets a note.
 */
export function dependencyWait(intent: Intent, intents: Intent[]): { note: string; needsPerson: boolean } | null {
  const s = intent.file.frontmatter.status;
  if (s === "draft" || s === "blocked" || s === "done" || s === "closed") return null;
  const waits = waitingOn(intent, intents);
  if (!waits.length) return null;
  let needsPerson = false;
  const notes = waits.map((slug) => {
    const dep = intents.find((i) => i.slug === slug);
    if (!dep) {
      needsPerson = true;
      return `Waits for ${slug}, which Loopstra cannot find or read in intent/. Fix the name in depends_on, or remove it.`;
    }
    if (dep.file.frontmatter.status === "closed") {
      needsPerson = true;
      return `Waits for ${slug}, which was closed. Remove it from depends_on to go ahead.`;
    }
    if (dependsOn(dep, intent.slug, intents)) {
      needsPerson = true;
      return `Waits for ${slug}, which waits for this change too. Remove one of them from depends_on.`;
    }
    return `Waits for ${slug} to be merged (now: ${plainStatus(dep.file.frontmatter.status)}).`;
  });
  return { note: notes.join(" "), needsPerson };
}

/** dependencyWait's note alone. */
export function dependencyNote(intent: Intent, intents: Intent[]): string | null {
  return dependencyWait(intent, intents)?.note ?? null;
}

/** True when `from` is `target`, or reaches it through depends_on. */
function dependsOn(from: Intent, target: string, intents: Intent[], seen = new Set<string>()): boolean {
  if (from.slug === target) return true;
  if (seen.has(from.slug)) return false;
  seen.add(from.slug);
  return (from.file.frontmatter.depends_on ?? []).some((slug) => {
    const next = intents.find((i) => i.slug === slug);
    return !!next && dependsOn(next, target, intents, seen);
  });
}

/** The note shown for a change: why it waits for others, if it does, then its own note. */
export function shownNote(intent: Intent, intents: Intent[]): string {
  return [dependencyNote(intent, intents), intent.file.frontmatter.note].filter(Boolean).join(" ");
}

const STATUS_CLASS: Record<Status, number> = {
  designing: 0, planning: 0, building: 0, reviewing: 0, verifying: 0,
  "spec-review": 0, "plan-review": 0, "merge-review": 0,
  "spec-approved": 1, "plan-approved": 1, "merge-approved": 1, merged: 1,
  accepted: 2,
  draft: 3, blocked: 3,
  done: 4, closed: 4,
};

export function orderQueue(intents: Intent[]): Intent[] {
  return [...intents].sort((a, b) => {
    const fa = a.file.frontmatter, fb = b.file.frontmatter;
    const c = STATUS_CLASS[fa.status] - STATUS_CLASS[fb.status];
    if (c !== 0) return c;
    const p = PRIORITIES.indexOf(effectivePriority(fa)) - PRIORITIES.indexOf(effectivePriority(fb));
    if (p !== 0) return p;
    const o = (fa.opened || "9999").localeCompare(fb.opened || "9999");
    if (o !== 0) return o;
    return a.slug.localeCompare(b.slug);
  });
}

const PLAIN: Record<Status, string> = {
  draft: "being written", accepted: "waiting to be designed",
  designing: "designing", "spec-review": "spec ready for review", "spec-approved": "spec approved, waiting to plan",
  planning: "planning", "plan-review": "plan ready for review", "plan-approved": "plan approved, waiting to build",
  building: "building and testing", reviewing: "in review",
  "merge-review": "ready to merge, waiting for a person", "merge-approved": "approved, waiting to merge", merged: "merged",
  verifying: "result ready for a person to confirm", done: "done", blocked: "needs a person", closed: "closed",
};

export function plainStatus(status: Status): string {
  return PLAIN[status];
}

const NOBODY: HumanGates = { spec: "none", plan: "none", merge: "none", done: "none" };

/**
 * The generated queue.md. "Needs a person" holds every change waiting for one (blocked, drafts, and
 * reviews with a person on the gate; see waitsForPerson) and intents whose intent.md cannot be read,
 * with their plain problem.
 */
export function renderQueue(ordered: Intent[], unreadable: Unreadable[] = [], human: HumanGates = NOBODY): string {
  const finished = ordered.filter((i) => ["done", "closed"].includes(i.file.frontmatter.status));
  const waiting = ordered.filter((i) => waitsForPerson(i, human));
  const active = ordered.filter((i) => !finished.includes(i) && !waiting.includes(i));
  const cell = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "/");
  const row = (i: Intent) => `| ${i.slug} | ${effectivePriority(i.file.frontmatter)} | ${plainStatus(i.file.frontmatter.status)} | ${cell(shownNote(i, ordered))} |`;
  const badRow = (u: Unreadable) => `| ${u.slug} | - | ${plainStatus("blocked")} | ${cell(u.problem)} |`;
  const table = (rows: string[]) => rows.length
    ? ["| Change | Priority | Where it is | Note |", "|---|---|---|---|", ...rows].join("\n")
    : "_Nothing here._";
  return [
    "# Queue",
    "",
    "This file is generated by Loopstra on every pass. Do not edit it. To change priority or status, edit the change's own intent.md.",
    "",
    "## In progress, in order",
    "",
    table(active.map(row)),
    "",
    "## Needs a person",
    "",
    table([...waiting.map(row), ...unreadable.map(badRow)]),
    "",
    "## Finished",
    "",
    table(finished.map(row)),
    "",
  ].join("\n");
}
