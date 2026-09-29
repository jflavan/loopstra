import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

export async function scanIntents(root: string): Promise<Intent[]> {
  const base = intentRoot(root);
  if (!existsSync(base)) return [];
  const out: Intent[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, "intent.md"))) continue;
    out.push(await readIntent(root, name));
  }
  return out;
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
  "merge-review": ["spec.md", "plan.md"], merged: ["spec.md", "plan.md"],
  verifying: ["spec.md", "plan.md"], done: ["spec.md", "plan.md", "outcome.md"],
};

/** Returns a plain-language problem, or null when the folder matches the status. */
export function checkConsistency(intent: Intent): string | null {
  const status = intent.file.frontmatter.status;
  for (const name of IMPLIES[status] ?? []) {
    if (!intent.artifacts.has(name)) {
      return `Status is "${status}" but ${name} is missing. Set status back to an earlier approved state, or to closed.`;
    }
  }
  if (status !== "draft") {
    const missing = REQUIRED_SECTIONS.filter((s) => !intent.file.sections[s]?.trim());
    if (missing.length) return `intent.md is missing the section(s): ${missing.join(", ")}. Add them, then set status to accepted.`;
  }
  return null;
}

export type HumanGates = { spec: "status" | "pr" | "none"; plan: "status" | "pr" | "none"; merge: "status" | "pr" | "none"; done: "status" | "pr" | "none" };

const REVIEW_GATE: Partial<Record<Status, keyof HumanGates>> = {
  "spec-review": "spec", "plan-review": "plan", "merge-review": "merge", verifying: "done",
};

/**
 * Runnable: the runtime has something to do for this intent right now.
 * A review status whose gate is human is not runnable; the scan picks up the
 * person's status change. (PR-gated merge waits are polled by the merge stage
 * itself, so "merge-review" with pr is also not runnable here.)
 */
export function isRunnable(intent: Intent, human: HumanGates): boolean {
  const s = intent.file.frontmatter.status;
  if (s === "draft" || s === "blocked" || s === "done" || s === "closed") return false;
  const gate = REVIEW_GATE[s];
  if (gate && human[gate] !== "none") return false;
  return true;
}

const STATUS_CLASS: Record<Status, number> = {
  designing: 0, planning: 0, building: 0, reviewing: 0, verifying: 0,
  "spec-review": 0, "plan-review": 0, "merge-review": 0,
  "spec-approved": 1, "plan-approved": 1, merged: 1,
  accepted: 2,
  draft: 3, blocked: 3,
  done: 4, closed: 4,
};

export function orderQueue(intents: Intent[]): Intent[] {
  return [...intents].sort((a, b) => {
    const fa = a.file.frontmatter, fb = b.file.frontmatter;
    const c = STATUS_CLASS[fa.status] - STATUS_CLASS[fb.status];
    if (c !== 0) return c;
    const p = PRIORITIES.indexOf(fa.priority) - PRIORITIES.indexOf(fb.priority);
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
  building: "building and testing", reviewing: "in review", "merge-review": "ready to merge", merged: "merged",
  verifying: "checking the result", done: "done", blocked: "needs a person", closed: "closed",
};

export function plainStatus(status: Status): string {
  return PLAIN[status];
}

export function renderQueue(ordered: Intent[]): string {
  const active = ordered.filter((i) => !["done", "closed", "blocked", "draft"].includes(i.file.frontmatter.status));
  const blocked = ordered.filter((i) => i.file.frontmatter.status === "blocked");
  const drafts = ordered.filter((i) => i.file.frontmatter.status === "draft");
  const finished = ordered.filter((i) => ["done", "closed"].includes(i.file.frontmatter.status));
  const row = (i: Intent) => `| ${i.slug} | ${i.file.frontmatter.priority} | ${plainStatus(i.file.frontmatter.status)} | ${i.file.frontmatter.note.replace(/\|/g, "/")} |`;
  const table = (rows: Intent[]) => rows.length
    ? ["| Change | Priority | Where it is | Note |", "|---|---|---|---|", ...rows.map(row)].join("\n")
    : "_Nothing here._";
  return [
    "# Queue",
    "",
    "This file is generated by Loopstra on every pass. Do not edit it. To change priority or status, edit the change's own intent.md.",
    "",
    "## In progress, in order",
    "",
    table(active),
    "",
    "## Needs a person",
    "",
    table(blocked),
    "",
    "## Drafts",
    "",
    table(drafts),
    "",
    "## Finished",
    "",
    table(finished),
    "",
  ].join("\n");
}
