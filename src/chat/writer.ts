import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import { checkConsistency, parseIntentFile, scanRepo, SLUG, type Intent, type Status } from "../intents";
import { localDate } from "../signals";
import type { Trace } from "../trace";
import { chatTemplate, renderChatPrompt, runChatAgent } from "./agents";
import { WriterResult, type DraftIntent, type Handoff } from "./schemas";

/** A change name the writer may use: a valid slug, and short enough to be a branch name. */
const MAX_SLUG = 60;

/** One written intent, ready to commit: its slug, the full intent.md text, and whether it replaces a draft. */
export interface WrittenIntent { slug: string; title: string; text: string; update: boolean }

/** The intent.md the runtime writes for a draft. Frontmatter is the runtime's; sections are the writer's. */
export function renderDraft(d: DraftIntent, who: { author: string; opened?: string; via: string }): string {
  const fm: string[] = ["---", "status: draft"];
  if (d.priority) fm.push(`priority: ${d.priority}`);
  const deps = [...new Set(d.depends_on.map((s) => s.trim()).filter(Boolean))];
  if (deps.length) fm.push(`depends_on: [${deps.join(", ")}]`);
  fm.push(`author: ${JSON.stringify(who.author)}`);
  fm.push(`opened: ${who.opened ?? localDate()}`);
  fm.push(`note: ${JSON.stringify(`Written from a chat with ${who.author} (${who.via}). When it says what you want, set status to accepted, or ask in chat to start it.`)}`);
  fm.push("---");
  const section = (name: string, text: string) => `## ${name}\n${text.trim()}\n`;
  return [
    fm.join("\n"),
    `# Intent: ${d.title.trim().replace(/^intent:\s*/i, "")}`,
    "",
    section("Problem", d.problem),
    section("Proposed outcome", d.proposed_outcome),
    section("Done when", d.done_when),
    section("Affected users and systems", d.affected_users_and_systems),
    section("Constraints", d.constraints),
    section("Open questions", d.open_questions),
  ].join("\n");
}

/**
 * Problems with what the writer returned, in plain words (empty when it can be committed). `existing`
 * is every change in the repository and its status; `updates` the drafts the brief may change.
 * The rendered text must parse and pass the loop's own consistency check as if it were accepted.
 */
export function draftProblems(drafts: DraftIntent[], rendered: string[], existing: Map<string, Status | "unreadable">, updates: string[]): string[] {
  const problems: string[] = [];
  if (!drafts.length) problems.push("No intents were returned.");
  const batch = new Set<string>();
  drafts.forEach((d, i) => {
    const slug = d.slug;
    if (!SLUG.test(slug) || slug.length > MAX_SLUG) problems.push(`"${slug}" is not a valid slug: lowercase letters and digits, words joined by dashes, at most ${MAX_SLUG} characters.`);
    if (batch.has(slug)) problems.push(`The slug "${slug}" is used twice.`);
    batch.add(slug);
    const status = existing.get(slug);
    if (status !== undefined && !updates.includes(slug)) problems.push(`"${slug}" already exists (${status}); choose another slug.`);
    if (status !== undefined && updates.includes(slug) && status !== "draft") problems.push(`"${slug}" is ${status}, not a draft, so it cannot be changed this way.`);
    if (!d.title.trim()) problems.push(`"${slug}" has no title.`);
    for (const dep of d.depends_on) {
      if (dep === slug) problems.push(`"${slug}" depends on itself.`);
      else if (!existing.has(dep) && !drafts.some((o) => o.slug === dep)) problems.push(`"${slug}" depends on "${dep}", which is not an existing intent or one you returned.`);
    }
    try {
      const file = parseIntentFile(rendered[i]!);
      const asAccepted: Intent = { slug, dir: "", artifacts: new Set(["intent.md"]), file: { ...file, frontmatter: { ...file.frontmatter, status: "accepted" } } };
      const problem = checkConsistency(asAccepted);
      if (problem) problems.push(`"${slug}": ${problem.replace(/ Add (it|them) to intent\.md, then set status to accepted\.$/, "")}`);
    } catch (e) {
      problems.push(`"${slug}" could not be read back: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return problems;
}

export type WriteOutcome =
  | { ok: true; intents: WrittenIntent[]; summary: string; costUsd: number }
  | { ok: false; problem: string; costUsd: number };

/** The repository's changes as `slug: status` lines, for the writer. */
function existingList(existing: Map<string, Status | "unreadable">): string {
  return existing.size ? [...existing].map(([s, st]) => `- ${s}: ${st}`).join("\n") : "None yet.";
}

/** Every change in a checkout and its status (unreadable ones count as taken). */
export async function existingIntents(root: string): Promise<Map<string, Status | "unreadable">> {
  const scan = await scanRepo(root);
  const out = new Map<string, Status | "unreadable">();
  for (const i of scan.intents) out.set(i.slug, i.file.frontmatter.status);
  // A folder whose intent.md cannot be read still takes its name.
  for (const u of scan.unreadable) if (SLUG.test(u.slug)) out.set(u.slug, "unreadable");
  return out;
}

/**
 * Runs the writer on an agreed brief and checks what it returns. A result with problems goes back
 * once with them (the one-rewrite rule the gates use); a second failure is reported, nothing written.
 * `source` is the checkout the brief is checked against (the PR's base, or the main checkout).
 */
export async function writeIntents(o: {
  root: string; cfg: Config; trace: Trace; source: string; handoff: Handoff; author: string; via: string; maxBudgetUsd: number;
}): Promise<WriteOutcome> {
  const existing = await existingIntents(o.source);
  const notDraft = o.handoff.updates.filter((s) => existing.get(s) !== "draft");
  if (notDraft.length) {
    return { ok: false, costUsd: 0, problem: `Only drafts can be changed this way, and ${notDraft.map((s) => `"${s}"`).join(", ")} ${notDraft.length > 1 ? "are not drafts (or do not exist)" : "is not a draft (or does not exist)"}.` };
  }
  const updateFiles = await Promise.all(o.handoff.updates.map(async (s) => [s, await Bun.file(join(o.source, "intent", s, "intent.md")).text()] as const));
  const updateTexts = updateFiles.map(([s, text]) => `### ${s}\n\n${text}`);
  const old = new Map(updateFiles.map(([s, text]) => [s, parseIntentFile(text).frontmatter] as const));
  const guidePath = join(o.root, "intent", "README.md");
  const template = existsSync(guidePath) ? await Bun.file(guidePath).text() : await Bun.file(join(import.meta.dir, "..", "..", "templates", "intent-README.md")).text();
  const base = await chatTemplate(o.root, "write-intent");
  let problems = "";
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = renderChatPrompt(base, {
      brief: o.handoff.brief, existing: existingList(existing), template,
      updates: updateTexts.join("\n\n"), problems,
    });
    const r = await runChatAgent({
      root: o.root, cfg: o.cfg, trace: o.trace, name: "write-intent", prompt, schema: WriterResult,
      model: o.cfg.stages.design.model, maxBudgetUsd: Math.max(0.01, o.maxBudgetUsd - cost),
    });
    cost += r.costUsd;
    if (!r.ok) return { ok: false, costUsd: cost, problem: "The writer could not finish." };
    if (r.value.status === "fail") return { ok: false, costUsd: cost, problem: r.value.summary || "The writer said the brief is too thin to write up." };
    const rendered = r.value.intents.map((d) => {
      const before = old.get(d.slug);
      return renderDraft(d, { author: before?.author || o.author, opened: before?.opened || undefined, via: o.via });
    });
    const found = draftProblems(r.value.intents, rendered, existing, o.handoff.updates);
    if (!found.length) {
      return {
        ok: true, costUsd: cost, summary: r.value.summary,
        intents: r.value.intents.map((d, i) => ({ slug: d.slug, title: d.title.trim(), text: rendered[i]!, update: existing.has(d.slug) })),
      };
    }
    problems = found.map((p) => `- ${p}`).join("\n");
  }
  return { ok: false, costUsd: cost, problem: `What the writer returned had problems twice: ${problems.split("\n").map((l) => l.replace(/^- /, "")).join(" ")}` };
}
