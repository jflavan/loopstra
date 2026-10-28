import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { localUser } from "../chat/transports/shared";
import type { Config } from "../config";
import { Git, statusPaths } from "../git";
import { isOpen } from "../actions";
import { changeExists, readIntent, scanRepo, SLUG } from "../intents";
import { runDir } from "../paths";
import { CONSOLE, submitRequest } from "../requests";
import { fileVersion } from "../settings";
import { planFiles } from "../stages/shared";
import {
  applying, formToMarkdown, parseStandards, problemText, readOutcomeStandards, readStandards, readStandardsSection, standardsFilesAt, standardToForm,
  STANDARD_NAME, STANDARDS_DIR, type Applying, type Scope, type Standard,
} from "../standards";
import { programsIn } from "../shell";
import { baseAware, checkOnMain } from "../standards-check";
import { exceptionsToApprove, parseRecord, scopeOf, STANDARDS_RECORD } from "../standards-record";
import type { Trace } from "../trace";
import { loopNow } from "./model";
import { json, refuse } from "./routes";
import { readConfig } from "./settings";
import type { ChangeStandardsView, DraftCheck, StandardForm, StandardsProblem, DraftChecked, ExceptionRow, ScopeRow, StandardRow, StandardsView, TriedCheck } from "./types";

/*
 * The standards routes' server side: Settings › Standards (`/api/standards`), a draft checked
 * (`/api/standards/check`), a check tried on main (`/api/standards/try`), what people decided about
 * standards across changes (`/api/standards/exceptions`), and a standard added to or removed from one
 * change (`/api/standards/scope`, a `standards-scope` request for the loop). Standard files themselves
 * are written through `/api/agents/files`. The console never writes the repository.
 */

const MAX_NAME = 64;
const MAX_TEXT = 200_000;
const MAX_NOTE = 4_000;
const SAMPLES = 3;
/** The marker the merge gate writes in a change's run folder (see STANDARDS_APPLIED in src/stages/merge.ts). */
const APPLIED_MARKER = "standards.applied";

const FormShape: z.ZodType<StandardForm> = z.strictObject({
  name: z.string().max(MAX_NAME),
  title: z.string().max(500),
  patterns: z.array(z.string().max(1_000)).max(200),
  needsPerson: z.boolean(),
  check: z.string().max(10_000),
  rules: z.array(z.strictObject({ label: z.string().max(100), text: z.string().max(MAX_TEXT) })).max(500),
  context: z.string().max(MAX_TEXT),
});

/** Main's last commit and the config, or why there is none. */
async function onMain(root: string): Promise<{ cfg: Config; git: Git; commit: string } | { problem: string }> {
  const loaded = await readConfig(root);
  if ("problem" in loaded) return { problem: `loopstra/config.yaml does not load: ${loaded.problem}` };
  const git = new Git(root);
  const commit = await git.commitOf(loaded.cfg.main_branch);
  if (!commit) return { problem: `${loaded.cfg.main_branch} has no commit yet.` };
  return { cfg: loaded.cfg, git, commit };
}

/** The files on main, by path as git has them. */
async function treeOf(git: Git, commit: string): Promise<string[]> {
  return (await git.run(["ls-tree", "-r", "-z", "--name-only", commit])).out.split("\0").filter(Boolean);
}

const scopeText = (s: Standard): string => (s.appliesTo ? `Files matching ${s.appliesTo.join(", ")}` : "Every change");

function matchCount(s: Standard, tree: string[]): number | null {
  if (!s.appliesTo) return null;
  const globs = s.appliesTo.map((p) => new Bun.Glob(p));
  return tree.filter((f) => globs.some((g) => g.match(f))).length;
}

/** The files a change's standards are judged by: what the merge gate recorded, else the plan's Files that change, else none known yet. */
function judgedFiles(root: string, slug: string): { names: Map<string, { why: Applying["why"]; files: string[] }>; files: string[] } | { files: string[] } {
  const marker = join(runDir(root, slug), APPLIED_MARKER);
  if (existsSync(marker)) {
    try {
      const m = z.object({ applying: z.array(z.object({ name: z.string(), why: z.enum(["every", "files", "added"]), files: z.array(z.string()).default([]) })) }).parse(JSON.parse(readFileSync(marker, "utf8")));
      return { names: new Map(m.applying.map((a) => [a.name, { why: a.why, files: a.files }])), files: [] };
    } catch { /* not what the gate writes: as no marker */ }
  }
  const plan = join(root, "intent", slug, "plan.md");
  return { files: existsSync(plan) ? planFiles(readFileSync(plan, "utf8")) : [] };
}

/**
 * The standards that apply to a change now, with why. The merge gate's marker when there is one;
 * otherwise the plan's Files that change; with neither, only the standards for every change (and
 * those people added). Cheap: no diff is read, only files of the change's own folder.
 */
function applyingTo(root: string, slug: string, standards: Standard[], record = parseRecord(readText(join(root, "intent", slug, STANDARDS_RECORD)))): Applying[] {
  const judged = judgedFiles(root, slug);
  const scope: Scope = scopeOf(record);
  if ("names" in judged) {
    const marked = judged.names;
    const out: Applying[] = standards.filter((s) => marked.has(s.name) && !scope.removed.includes(s.name)).map((standard) => ({ standard, why: marked.get(standard.name)?.why ?? "files", files: marked.get(standard.name)?.files ?? [] }));
    for (const a of applying(standards, [], { added: scope.added, removed: scope.removed })) if (a.why === "added" && !out.some((o) => o.standard.name === a.standard.name)) out.push(a);
    return out;
  }
  return applying(standards, judged.files, scope);
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** Open changes each standard applies to now (see applyingTo for how that is decided). */
async function inProgressBy(root: string, standards: Standard[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const i of (await scanRepo(root)).intents) {
    if (!isOpen(i.file.frontmatter.status)) continue;
    for (const a of applyingTo(root, i.slug, standards)) out.set(a.standard.name, [...(out.get(a.standard.name) ?? []), i.slug]);
  }
  return out;
}

/** A sentence for each standard whose check runs a program this machine does not have. */
function missingPrograms(standards: Standard[]): string[] {
  return standards.flatMap((s) => (s.check ? [...new Set(programsIn(s.check))].filter((p) => !Bun.which(p)).map((p) => `The check of ${s.title} runs ${p}, which is not installed on this machine, so the check cannot run here.`) : []));
}

/** What cannot be read in the open changes' standards.md, each with its change. A standard no longer on main is one of them. */
async function recordProblems(root: string, standards: Standard[]): Promise<string[]> {
  const known = new Set(standards.map((s) => s.name));
  const out: string[] = [];
  for (const i of (await scanRepo(root)).intents) {
    if (!isOpen(i.file.frontmatter.status)) continue;
    out.push(...parseRecord(readText(join(root, "intent", i.slug, STANDARDS_RECORD)), known).problems.map((p) => `${i.slug}: ${p}`));
  }
  return out;
}

/** Settings › Standards: every standard on main, what is wrong with the folder, and files with changes not committed yet. */
export async function standardsView(root: string): Promise<StandardsView> {
  const empty: StandardsView = { standards: [], problems: [], ignored: [], uncommitted: [] };
  const m = await onMain(root);
  if ("problem" in m) return { ...empty, problems: [m.problem] };
  const { files, folders } = await standardsFilesAt(m.git, m.commit);
  const read = parseStandards(files);
  const [tree, busy] = [await treeOf(m.git, m.commit), await inProgressBy(root, read.standards)];
  const texts = new Map(files.map((f) => [f.path, f.text]));
  // -z: names as they are (spaces, other alphabets), and both paths of a rename.
  const status = await m.git.run(["--literal-pathspecs", "status", "--porcelain", "-z", "--untracked-files=all", "--", `${STANDARDS_DIR}/`], { allowFail: true });
  const uncommitted = status.code === 0 ? statusPaths(status.out) : [];
  const standards = read.standards.map((s): StandardRow => {
    const text = texts.get(s.path) ?? "";
    return {
      name: s.name, path: s.path, title: s.title, scope: scopeText(s), matches: matchCount(s, tree), needsPerson: s.needsPerson, check: s.check,
      rules: s.rules.map((r) => ({ label: r.label, text: r.text })), inProgress: (busy.get(s.name) ?? []).sort(), text, version: fileVersion(text),
    };
  });
  const problems = [...read.problems.map(problemText), ...missingPrograms(read.standards), ...(await recordProblems(root, read.standards))];
  return { standards, problems, ignored: [...read.ignored, ...folders], uncommitted };
}

/** The draft's name from a body, or why it is not one. */
function draftName(b: Record<string, unknown>): string | { error: string } {
  const name = b.name;
  if (typeof name !== "string" || name.length > MAX_NAME || !STANDARD_NAME.test(name)) return { error: "A standard's name is lowercase words joined by dashes, like security." };
  return name;
}

/** The draft's file text from a body: its `text`, or its `form` rendered. */
function draftText(b: Record<string, unknown>): string | { error: string } {
  if (typeof b.text === "string") return b.text.length <= MAX_TEXT ? b.text : { error: "The standard is too long." };
  if (b.form !== undefined) {
    const form = FormShape.safeParse(b.form);
    return form.success ? formToMarkdown(form.data) : { error: "The form is not a standard's parts." };
  }
  return { error: "Send the standard's text or its form." };
}

/** main's other standards together with the draft, read as one set; the draft's own problems and, if it reads, its standard. */
async function readDraft(m: { git: Git; commit: string }, name: string, text: string): Promise<{ problems: StandardsProblem[]; standard: Standard | null }> {
  const path = `${STANDARDS_DIR}/${name}.md`;
  const { files } = await standardsFilesAt(m.git, m.commit);
  const read = parseStandards([...files.filter((f) => f.path !== path), { path, text }]);
  return { problems: read.problems.filter((p) => p.path === path), standard: read.standards.find((s) => s.name === name) ?? null };
}

/** `POST /api/standards/check`: the draft's problems and matches, and the draft both as Markdown and as a form. */
export async function checkDraft(root: string, body: Record<string, unknown>): Promise<Response> {
  const name = draftName(body);
  if (typeof name !== "string") return refuse(name.error, 400);
  const text = draftText(body);
  if (typeof text !== "string") return refuse(text.error, 400);
  const m = await onMain(root);
  if ("problem" in m) return refuse(m.problem);
  const draft = await readDraft(m, name, text);
  const tree = draft.standard?.appliesTo ? await treeOf(m.git, m.commit) : [];
  const matches: DraftCheck["matches"] = (draft.standard?.appliesTo ?? []).map((pattern) => {
    const glob = new Bun.Glob(pattern);
    const hit = tree.filter((f) => glob.match(f));
    return { pattern, count: hit.length, sample: hit.slice(0, SAMPLES) };
  });
  const parsedForm = body.form !== undefined ? FormShape.safeParse(body.form) : null;
  const form = draft.standard ? standardToForm(draft.standard) : parsedForm?.success ? parsedForm.data : null;
  const answer: DraftChecked = { problems: draft.problems, matches, text, form };
  return json(answer);
}

/**
 * `POST /api/standards/try`: the check of one standard on main (`{ name }`), or of a draft
 * (`{ name, text }`), tried in a throwaway checkout. Only that standard's own `check` ever runs;
 * any command in the body is never read.
 */
export async function tryCheck(root: string, body: Record<string, unknown>): Promise<Response> {
  const name = draftName(body);
  if (typeof name !== "string") return refuse(name.error, 400);
  const m = await onMain(root);
  if ("problem" in m) return refuse(m.problem);
  let standard: Standard | null;
  if (body.text === undefined && body.form === undefined) {
    standard = (await readStandards(m.git, m.commit)).standards.find((s) => s.name === name) ?? null;
    if (!standard) return refuse(`There is no standard called ${name} on main.`, 404);
  } else {
    const text = draftText(body);
    if (typeof text !== "string") return refuse(text.error, 400);
    const draft = await readDraft(m, name, text);
    standard = draft.standard;
    if (!standard) return refuse(draft.problems.map(problemText).join(" ") || `${name} cannot be read.`);
  }
  if (!standard.check) return refuse(`${standard.title} has no check to try.`, 400);
  try {
    const r = await checkOnMain(root, m.cfg, standard.check, standard.title);
    const tried: TriedCheck = { ...r, baseAware: r.failsOnMain ? baseAware(standard.check) : null };
    return json(tried);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

/** The standards on main now; none when main cannot be read. */
async function mainStandards(root: string): Promise<Standard[]> {
  const m = await onMain(root);
  return "problem" in m ? [] : (await readStandards(m.git, m.commit)).standards;
}

/** `GET /api/standards/exceptions`: what people decided about standards across the changes, newest first. */
export async function exceptionsView(root: string): Promise<{ exceptions: ExceptionRow[]; scope: ScopeRow[] }> {
  // A rule's standard, as main has it; a label or name main no longer has is shown alone.
  const standards = await mainStandards(root);
  const ofLabel = new Map(standards.flatMap((s) => s.rules.map((r) => [r.label, s] as const)));
  const byName = new Map(standards.map((s) => [s.name, s]));
  const exceptions: ExceptionRow[] = [];
  const scope: ScopeRow[] = [];
  for (const i of (await scanRepo(root)).intents) {
    const text = readText(join(root, "intent", i.slug, STANDARDS_RECORD));
    if (text === null) continue;
    const r = parseRecord(text);
    const change = i.file.title || i.slug;
    for (const e of r.exceptions) exceptions.push({ label: e.label, title: ofLabel.get(e.label)?.title ?? "", standard: ofLabel.get(e.label)?.name ?? "", change, slug: i.slug, reason: e.reason, by: e.by, via: e.via, date: e.date, gate: e.gate });
    for (const [action, list] of [["added", r.added], ["removed", r.removed]] as const) {
      for (const d of list) scope.push({ name: d.name, title: byName.get(d.name)?.title ?? "", change, slug: i.slug, action, note: d.note, by: d.by, via: d.via, date: d.date });
    }
  }
  const newest = <T extends { date: string; slug: string }>(a: T, b: T) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);
  return { exceptions: exceptions.sort(newest), scope: scope.sort(newest) };
}

/** `POST /api/standards/scope`: adds a standard to one change or removes it (a `standards-scope` request). */
export async function scopeAction(root: string, body: Record<string, unknown>): Promise<Response> {
  const { slug, action, name } = body;
  if (typeof slug !== "string" || !SLUG.test(slug)) return refuse("Unknown change.", 400);
  if (action !== "add" && action !== "remove") return refuse("Say add or remove.", 400);
  if (typeof name !== "string" || name.length > MAX_NAME || !STANDARD_NAME.test(name)) return refuse("Say which standard.", 400);
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_NOTE)) return refuse(`A note is at most ${MAX_NOTE} characters.`, 400);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (action === "remove" && !note) return refuse("Say why this standard does not apply to this change.", 400);
  if (!changeExists(root, slug)) return refuse(`There is no change called ${slug}.`, 404);
  let status;
  try { status = (await readIntent(root, slug)).file.frontmatter.status; } catch { return refuse(`${slug}'s intent.md cannot be read.`); }
  if (!isOpen(status)) return refuse(`${slug} is ${status}; nothing changed.`);
  const m = await onMain(root);
  if ("problem" in m) return refuse(m.problem);
  if (!(await readStandards(m.git, m.commit)).standards.some((s) => s.name === name)) return refuse(`There is no standard called ${name} on main.`, 404);
  const user = localUser();
  const sent = submitRequest(root, { kind: "standards-scope", slug, expect: status, action, name, note, by: user, byName: user, via: "the dashboard", transport: CONSOLE, thread: "" });
  return json({ id: sent.id, loop: loopNow(root, m.cfg.poll_seconds, new Date()).state.state }, 202);
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const WHY: Record<Applying["why"], (a: Applying, by: string | undefined) => string> = {
  every: () => "It applies to every change.",
  files: (a) => (a.files.length ? `The change touches ${a.files.slice(0, 5).join(", ")}${a.files.length > 5 ? " and more" : ""}.` : "The change's files match its patterns."),
  added: (_a, by) => (by ? `Added by ${by}.` : "A person added it to this change."),
};

/** A line of review.md's "Findings against the standards": `- important · SEC-3 · src/pay.ts:42: text`. */
const FINDING = /^- (\S+) · (\S+) · (.+)$/;

function findingsByLabel(review: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (review === null) return out;
  const lines = review.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Findings against the standards\s*$/.test(l));
  if (start < 0) return out;
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    const m = FINDING.exec(l);
    if (m) out.set(m[2] ?? "", [...(out.get(m[2] ?? "") ?? []), `${m[1] ?? ""} · ${m[3] ?? ""}`]);
  }
  return out;
}

const KIND_WORDS = { keeps: "", "not-applicable": "Does not apply: ", exception: "Exception: " } as const;

/**
 * The change page's standards panel: what applies (see applyingTo), each rule with what the spec
 * and plan said, the review's findings and the outcome's result, the merge gate's tool-check rows,
 * the exceptions nobody approved yet, and the change's own record. Null in a repository without standards.
 */
export async function changeStandards(root: string, trace: Trace, slug: string): Promise<ChangeStandardsView | null> {
  const m = await onMain(root);
  if ("problem" in m) return null;
  const read = await readStandards(m.git, m.commit);
  if (!read.standards.length) return null;
  const doc = (name: "spec.md" | "plan.md" | "review.md" | "outcome.md") => readText(join(root, "intent", slug, name));
  const record = parseRecord(readText(join(root, "intent", slug, STANDARDS_RECORD)), new Set(read.standards.map((s) => s.name)));
  const [spec, plan, review, outcome] = [doc("spec.md"), doc("plan.md"), doc("review.md"), doc("outcome.md")];
  const section = (text: string | null) => new Map((text === null ? [] : readStandardsSection(text) ?? []).map((b) => [b.label, `${KIND_WORDS[b.kind]}${b.text}`]));
  const [inSpec, inPlan, found] = [section(spec), section(plan), findingsByLabel(review)];
  const results = new Map((outcome === null ? [] : readOutcomeStandards(outcome)).map((o) => [o.label, o.result]));
  const gates = trace.gates(slug);
  const list = applyingTo(root, slug, read.standards, record);
  const atSpec = spec === null ? [] : exceptionsToApprove(spec, "spec", record);
  const atPlan = plan === null ? [] : exceptionsToApprove(plan, "plan", record);
  return {
    applying: list.map((a) => {
      const row = gates.filter((g) => g.gate === "merge" && g.check === `check:${a.standard.name}`).at(-1);
      return {
        name: a.standard.name, title: a.standard.title, why: WHY[a.why](a, record.added.find((d) => d.name === a.standard.name)?.by),
        rules: a.standard.rules.map((r) => ({
          label: r.label, text: r.text, ...(inSpec.has(r.label) ? { spec: inSpec.get(r.label) } : {}), ...(inPlan.has(r.label) ? { plan: inPlan.get(r.label) } : {}),
          findings: found.get(r.label) ?? [], ...(results.has(r.label) ? { result: results.get(r.label) } : {}),
        })),
        ...(row ? { check: oneLine(`${row.result}${row.evidence ? `: ${row.evidence}` : ""}`) } : {}),
      };
    }),
    waiting: [...atSpec, ...atPlan.filter((b) => !atSpec.some((x) => x.label === b.label && oneLine(x.text) === oneLine(b.text)))],
    record,
  };
}
