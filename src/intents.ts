import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

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
    const field = issue?.path.join(".") || (issue?.code === "unrecognized_keys" ? issue.keys.join(", ") : "") || "top";
    throw new FrontmatterProblem(field, `intent.md frontmatter problem at ${field}: ${issue?.message}`);
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

export const ARTIFACTS = ["intent.md", "spec.md", "plan.md", "review.md", "outcome.md"] as const;

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
      scan.intents.push(await readIntent(root, name));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      scan.unreadable.push({ slug: name, problem: unreadableProblem(e), detail });
    }
  }
  return scan;
}

/** The readable intents only. Never throws for one bad file; see scanRepo for the others. */
export async function scanIntents(root: string): Promise<Intent[]> {
  return (await scanRepo(root)).intents;
}

function unreadableProblem(e: unknown): string {
  if (e instanceof FrontmatterProblem) {
    return `The ${e.field} line at the top of intent.md has a value Loopstra does not understand. Fix it, and the change is picked up again.`;
  }
  return "The lines between the --- markers at the top of intent.md could not be read. Fix them, and the change is picked up again.";
}

/** intent.md frontmatter that parsed as YAML but has an invalid field. */
export class FrontmatterProblem extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "FrontmatterProblem";
  }
}

export async function writeIntent(intent: Intent, patch: Partial<Frontmatter>): Promise<void> {
  Object.assign(intent.file.frontmatter, patch);
  await Bun.write(join(intent.dir, "intent.md"), serializeIntentFile(intent.file));
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
  if (missing.length) return `intent.md is missing the section(s): ${missing.join(", ")}. Add them, then set status to accepted.`;
  return null;
}

export type HumanGates = { spec: "status" | "pr" | "none"; plan: "status" | "pr" | "none"; merge: "status" | "pr" | "none"; done: "status" | "pr" | "none" };

const REVIEW_GATE: Partial<Record<Status, keyof HumanGates>> = {
  "spec-review": "spec", "plan-review": "plan", "merge-review": "merge", verifying: "done",
};

/**
 * Runnable: the runtime has something to do for this intent right now.
 * A review status whose gate has a person on it is not runnable: it means the automated checks
 * passed and a person is deciding; the scan picks up their status change (for example
 * merge-review → merge-approved, which is runnable).
 * With a remote, merge-review is runnable unless a person decides on the status line: the merge
 * step watches the pull request (its checks, and its approval when merge.human is pr).
 */
export function isRunnable(intent: Intent, human: HumanGates, hasRemote = false): boolean {
  const s = intent.file.frontmatter.status;
  if (s === "draft" || s === "blocked" || s === "done" || s === "closed") return false;
  if (s === "merge-review" && hasRemote) return human.merge !== "status";
  const gate = REVIEW_GATE[s];
  if (gate && human[gate] !== "none") return false;
  return true;
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

/** Intents whose intent.md cannot be read are listed under "Needs a person" with their plain problem. */
export function renderQueue(ordered: Intent[], unreadable: Unreadable[] = []): string {
  const active = ordered.filter((i) => !["done", "closed", "blocked", "draft"].includes(i.file.frontmatter.status));
  const blocked = ordered.filter((i) => i.file.frontmatter.status === "blocked");
  const drafts = ordered.filter((i) => i.file.frontmatter.status === "draft");
  const finished = ordered.filter((i) => ["done", "closed"].includes(i.file.frontmatter.status));
  const cell = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "/");
  const row = (i: Intent) => `| ${i.slug} | ${effectivePriority(i.file.frontmatter)} | ${plainStatus(i.file.frontmatter.status)} | ${cell(i.file.frontmatter.note)} |`;
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
    table([...blocked.map(row), ...unreadable.map(badRow)]),
    "",
    "## Drafts",
    "",
    table(drafts.map(row)),
    "",
    "## Finished",
    "",
    table(finished.map(row)),
    "",
  ].join("\n");
}
