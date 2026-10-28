import { join } from "node:path";
import { z } from "zod";
import { acceptanceFiles, block, readArtifact, readMarker, setStatus, writeArtifact, type Failure, type StepContext, type StepResult } from "../context";
import type { Envelope } from "../envelopes";
import { passOn, withDetachedWorktree } from "../git";
import { loopstraDir } from "../paths";
import { agentPhase, alongside, mayOverlap, phasePrompt, projectCommand, type AgentPhaseSpec } from "../phases";
import { besideWork, EARLY } from "../trace";
import { coveredByTests, NONE_WRITTEN } from "./acceptance";
import { STANDARDS_APPLIED } from "./merge";
import { artifacts, bullets, humanNote, planFiles, runHookCommands, stageStandards, toolChecks } from "./shared";
import { errorText } from "../shell";
import { renderStandards, type Applying } from "../standards";
import type { ChangeStandards } from "../standards-record";

const JUDGE_FAILED = "The final check could not be completed; an engineer should look.";
export const NEEDS_PERSON_DONE_NOTE = "Done. A few results need a person to confirm; see outcome.md.";
export const UNMET_NOTE = "The change merged, but the final check found Done when criteria that are not met. The details are in outcome.md. Decide whether to open a follow-up change, then set this one to done or closed.";

export const STANDARDS_UNMET_NOTE = "The change merged, but the final check found engineering rules it does not keep. The details are in outcome.md. An engineer should decide whether to open a follow-up change, then set this one to done or closed.";

/** What the done-check is told about the acceptance tests when its prompt has no {{acceptance}} (a repository's older done-check.md). */
const ACCEPTANCE_RULE = "These acceptance tests were written from the owner's Done when before the build. A criterion covered by an acceptance test that passes in this copy of main is met, with the test as its evidence:";

const NO_CHECK_OUTCOME = "# Outcome\n\n## Outcome\nThe change is merged.\n\n## Evidence\nNo automatic check of the Done when criteria is configured. A person may want to confirm them.\n";

type Item = Envelope<"done-check">["evidence"][number];

/**
 * Stage 6 for one intent. The work runs while the status is merged (so a restart resumes it):
 * the done-check in a clean copy of main, outcome.md (always written by the runtime), lessons, and
 * the verify commands. Then: no person on the done gate → done; a person → verifying, which only
 * ever means "the outcome is written, waiting for a person". Unmet criteria block.
 */
export async function runVerifyStep(ctx: StepContext): Promise<StepResult> {
  if (ctx.intent.file.frontmatter.status === "verifying") {
    if (ctx.cfg.gates.done.human !== "none") return { ok: true };
    // Nobody is on the gate any more (config changed, or set by hand): finish if the outcome is written.
    if (ctx.intent.artifacts.has("outcome.md")) {
      await setStatus(ctx, "done");
      return { ok: true };
    }
  }

  const before = await runHookCommands(ctx, "before", "verify");
  if (!before.ok) return before;
  const a = await artifacts(ctx);
  // The standards the merged change was held to (null in a repository without standards), read once
  // here: an unreadable standard stops the step before any session is spent.
  const held = await heldStandards(ctx, a.plan);

  // The fix history lessons is shown: the phases that failed, less work that ran beside the one that
  // decided (work run alongside, a cheaper judge; see besideWork), whose failures never mattered to the change.
  const history = () => ctx.trace.phases(ctx.slug).filter((p) => p.status === "fail" && !besideWork(p.name)).map((p) => `${p.name}: ${p.error ?? ""}`).join("\n");
  const learn = (traceName?: string) => agentPhase(ctx, {
    name: "lessons", traceName, permissionMode: "default", tools: "read",
    vars: { review: a.review, previous: history() }, skills: ctx.cfg.stages.verify.skills,
  });
  // Lessons never reads the done-check's result, so the two may run at the same time. Alongside, it
  // is optional: an unavailable assistant or the day's budget leaves it to run after the done-check.
  const historyBefore = history();
  const [judged, early] = mayOverlap(ctx)
    ? await alongside(ctx, () => doneCheck(ctx, a, held), { what: "lessons", run: () => learn(`${EARLY}lessons`), wanted: (j) => j.ok })
    : [await doneCheck(ctx, a, held), null];
  if (!judged.ok) return block(ctx, judged.note, judged);
  const unmet = judged.items.filter((i) => i.result === "unmet");
  const forPerson = judged.items.filter((i) => i.result === "needs-person");
  // The rules, judged or (without a done-check agent) listed as not checked.
  const rules = held ? judgeRules(held.list, held.record, judged.rules) : [];
  const unmetRules = rules.filter((r) => r.result === "unmet");
  const rulesForPerson = rules.filter((r) => r.result === "needs-person");
  if (held && judged.rules && rules.length) ctx.trace.gate(ctx.slug, "done", "standards", unmetRules.length ? "fail" : "pass", ruleEvidence(rules, unmetRules));

  // Lessons that ran alongside saw the history as it was when the done-check started; when a
  // done-check attempt failed meanwhile (and its retry passed), they run again with it.
  const lessons = early !== null && history() === historyBefore ? early : await learn();
  // outcome.md is for the owner; lessons.md is for engineers (`loopstra apply-lessons` reads it).
  let outcome = (judged.outcome || NO_CHECK_OUTCOME).trimEnd();
  if (unmet.length) outcome += `\n\n## Not met\n${bullets(unmet.map(line))}`;
  if (forPerson.length || rulesForPerson.length) outcome += `\n\n## For a person to confirm\n${bullets([...forPerson.map(line), ...rulesForPerson.map((r) => `${r.label} ${r.evidence}`.trim())])}`;
  if (held) outcome += standardsSection(held.commit, rules, held.list, held.record, held.checks, held.titles);
  await writeArtifact(ctx, "outcome.md", outcome);
  await writeArtifact(ctx, "lessons.md", lessons.ok
    ? `# Lessons\n\n## Lessons\n${bullets(lessons.envelope.lessons) || "- None recorded."}\n\n## Proposed CLAUDE.md additions\n${lessons.envelope.claude_md_additions.trim() || "None."}\n`
    : "# Lessons\n\n## Lessons\n- The lessons step did not finish.\n");

  const after = await runHookCommands(ctx, "after", "verify");
  if (!after.ok) return after;

  if (unmet.length || unmetRules.length) {
    const note = !unmetRules.length ? UNMET_NOTE : !unmet.length ? STANDARDS_UNMET_NOTE : UNMET_NOTE.replace("Done when criteria", "Done when criteria and engineering rules");
    return block(ctx, note, { detail: { unmet: [...unmet.map(line), ...unmetRules.map((r) => `${r.label} ${r.evidence}`.trim())] } });
  }
  const human = ctx.cfg.gates.done.human;
  if (human !== "none") {
    ctx.trace.gate(ctx.slug, "done", "human", "waiting", "waiting for a person to confirm the outcome");
    await setStatus(ctx, "verifying", humanNote("outcome.md", "done", human));
    return { ok: true };
  }
  await setStatus(ctx, "done", forPerson.length || rulesForPerson.length ? NEEDS_PERSON_DONE_NOTE : "");
  return { ok: true };
}

function line(i: Item): string {
  return `${i.criterion} ${i.evidence}`.trim();
}

/**
 * The done-check judge, run in a throwaway detached worktree of main so nothing it builds or runs
 * touches the owner's checkout. It is given the acceptance tests written from Done when, if any.
 * Pass means no unmet items; needs-person items never block.
 */
async function doneCheck(ctx: StepContext, a: { spec: string; review: string }, held: Held | null): Promise<{ ok: true; items: Item[]; outcome: string; rules: RuleItem[] | null } | Failure> {
  if (!ctx.cfg.gates.done.agent) return { ok: true, items: [], outcome: "", rules: null };
  const dir = join(loopstraDir(ctx.root), "verify", ctx.slug);
  // The tests written from Done when before the build (see writeAcceptance); main has them merged.
  // Only while this build's marker names them: acceptance.md from an earlier build (the setting
  // turned off since) lists tests this build was free to change.
  const covered = acceptanceFiles(ctx).length ? coveredByTests(await readArtifact(ctx, "acceptance.md")) : "";
  let r: Awaited<ReturnType<typeof agentPhase<"done-check">>>;
  try {
    r = await withDetachedWorktree(ctx.git, dir, ctx.cfg.main_branch, async (cwd) => {
      const install = ctx.cfg.commands.install;
      if (install) {
        // A judge without the project's dependencies would find criteria unmet that are not.
        const i = await projectCommand(ctx, install, cwd, { where: "done-check copy of main" });
        if (i.code !== 0) throw new Error(`install failed: ${i.lastLine || `exit ${i.code}`}`);
      }
      const phase: AgentPhaseSpec & { name: "done-check" } = {
        name: "done-check", permissionMode: "default", tools: "read+commands", cwd,
        vars: { done_when: ctx.intent.file.sections["Done when"] ?? "", spec: a.spec, review: a.review, acceptance: covered || NONE_WRITTEN, ...(held ? { standards: held.text } : {}) },
        skills: ctx.cfg.stages.verify.skills,
      };
      // The tests reach the judge even through an older done-check.md without {{acceptance}}.
      return agentPhase(ctx, phase, () => phasePrompt(ctx, phase, { variable: "acceptance", note: covered, text: `${ACCEPTANCE_RULE}\n\n${covered}` }));
    }, (e) => ctx.trace.event(ctx.slug, "error", { where: "done-check", what: "removing the copy of main", error: errorText(e) }));
  } catch (e) {
    passOn(e);
    return { ok: false, note: JUDGE_FAILED, detail: `could not prepare a clean copy of main: ${errorText(e)}` };
  }
  if (!r.ok) {
    ctx.trace.gate(ctx.slug, "done", "done-check", "fail", `the judge failed: ${r.reason}`);
    return { ok: false, note: JUDGE_FAILED, detail: `done-check failed: ${r.reason}` };
  }
  const items = r.envelope.evidence;
  const unmet = items.filter((i) => i.result === "unmet");
  ctx.trace.gate(ctx.slug, "done", "done-check", unmet.length ? "fail" : "pass", unmet.length ? unmet.map(line).join("; ") : r.envelope.summary);
  return { ok: true, items, outcome: r.envelope.outcome_markdown, rules: r.envelope.standards ?? [] };
}

type RuleItem = NonNullable<Envelope<"done-check">["standards"]>[number];

/** A rule's line in the outcome: judged, or "not-checked" when the done-check agent is off. */
interface RuleResult { label: string; title: string; result: RuleItem["result"] | "not-checked"; evidence: string }

/** What the done step holds the merged change to: the standards that applied, less the exceptions, and what the record and the gate rows say. */
interface Held { list: Applying[]; record: ChangeStandards; commit: string; checks: string[]; titles: Map<string, string>; text: string }

const AppliedMarker = z.object({ applying: z.array(z.object({ name: z.string(), why: z.enum(["every", "files", "added"]), files: z.array(z.string()) })) });

/**
 * The standards the done step holds the change to: those the merge gate recorded in STANDARDS_APPLIED,
 * read as main has them now (see StepContext.standards), or, with no marker (a change merged before
 * standards, or by hand), those the plan's Files that change bring in. Null in a repository without standards.
 */
async function heldStandards(ctx: StepContext, plan: string): Promise<Held | null> {
  const read = await ctx.standards();
  if (!read.standards.length) return null;
  const record = ctx.standardsRecord();
  const raw = readMarker(ctx, STANDARDS_APPLIED);
  let marked: z.infer<typeof AppliedMarker> | null = null;
  try { const m = AppliedMarker.safeParse(raw === null ? null : JSON.parse(raw)); if (m.success) marked = m.data; } catch { /* not JSON: as no marker */ }
  const list: Applying[] = marked
    ? marked.applying.flatMap((m) => { const standard = read.standards.find((s) => s.name === m.name); return standard ? [{ standard, why: m.why, files: m.files }] : []; })
    : (await stageStandards(ctx, planFiles(plan))).list;
  const excepted = record.exceptions.map((e) => ({ label: e.label, reason: e.reason }));
  const checks = toolChecks(list.filter((x) => ctx.trace.lastGate(ctx.slug, "merge", `check:${x.standard.name}`)?.result === "pass")).map((c) => c.title);
  const passed = checks.length ? `\n\nChecks of standards that passed at merge:\n${checks.map((t) => `- ${t}`).join("\n")}` : "";
  return {
    list, record, checks, commit: await ctx.readCommit(),
    titles: new Map(read.standards.map((s) => [s.name, s.title])),
    text: list.length ? `${renderStandards(list, { excepted })}${passed}` : "",
  };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * One result for each rule of the standards that applied, less those under an approved exception, in
 * the standards' order. A label the judge gives that is not one of them is ignored; a rule it leaves
 * out is for a person ("not judged"). `items` null: no judge ran, so nothing was checked.
 */
function judgeRules(list: Applying[], record: ChangeStandards, items: RuleItem[] | null): RuleResult[] {
  const excepted = new Set(record.exceptions.map((e) => e.label));
  return list.flatMap((a) => a.standard.rules.filter((r) => !excepted.has(r.label)).map((r): RuleResult => {
    const title = a.standard.title;
    if (!items) return { label: r.label, title, result: "not-checked", evidence: "" };
    const i = items.find((x) => x.label === r.label);
    // Never empty, so the line in outcome.md has its evidence and reads back (see readOutcomeStandards).
    return i ? { label: r.label, title, result: i.result, evidence: oneLine(i.evidence) || "no detail given" } : { label: r.label, title, result: "needs-person", evidence: "not judged" };
  }));
}

function ruleEvidence(rules: RuleResult[], unmet: RuleResult[]): string {
  return unmet.length ? unmet.map((r) => `${r.label} ${r.evidence}`.trim()).join("; ") : `${rules.length} ${rules.length === 1 ? "rule" : "rules"} judged, none unmet`;
}

/**
 * The outcome's `## Standards` section, in the runtime's own format (readOutcomeStandards reads it back):
 * a sentence naming the version of the standards (`commit`, shortened to 7 characters), a line for each
 * judged rule, each exception a person approved, each tool check that passed at merge, and each
 * standard a person added to the change or removed from it. `titles` names standards that do not apply (removed).
 */
function standardsSection(commit: string, items: RuleResult[], applying: Applying[], record: ChangeStandards, checks: string[], titles: ReadonlyMap<string, string> = new Map()): string {
  // Exceptions are listed only for standards that applied (an exception for a rule that did not apply is not shown).
  const title = (name: string): string => titles.get(name) ?? applying.find((a) => a.standard.name === name)?.standard.title ?? name;
  const lines = [
    ...items.map((i) => i.result === "not-checked" ? `- ${i.label} (${i.title}): not checked automatically` : `- ${i.label} (${i.title}): ${i.result}: ${i.evidence}`.trimEnd()),
    ...applying.flatMap((a) => a.standard.rules.flatMap((r) => record.exceptions.filter((e) => e.label === r.label).slice(0, 1).map((e) => `- ${r.label} (${a.standard.title}): exception, approved by ${e.by} at the ${e.gate}: ${oneLine(e.reason)}`))),
    ...checks.map((t) => `- Check of ${t}: passed at merge`),
    ...record.added.map((d) => `- ${title(d.name)} was added to this change by ${d.by}: ${oneLine(d.note)}`),
    ...record.removed.map((d) => `- ${title(d.name)} was removed from this change by ${d.by}: ${oneLine(d.note)}`),
  ];
  if (!lines.length) return "";
  return `\n\n## Standards\nThe engineering rules this change was checked against (the standards as of commit ${commit.slice(0, 7)}):\n\n${lines.join("\n")}\n`;
}
