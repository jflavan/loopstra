import { join } from "node:path";
import { block, readArtifact, setStatus, writeArtifact, type Failure, type StepContext, type StepResult } from "../context";
import type { Envelope } from "../envelopes";
import { passOn, withDetachedWorktree } from "../git";
import { loopstraDir } from "../paths";
import { agentPhase, alongside, mayOverlap, phasePrompt, projectCommand, type AgentPhaseSpec } from "../phases";
import { besideWork, EARLY } from "../trace";
import { coveredByTests, NONE_WRITTEN } from "./acceptance";
import { artifacts, bullets, humanNote, runHookCommands } from "./shared";
import { errorText } from "../shell";

const JUDGE_FAILED = "The final check could not be completed; an engineer should look.";
export const NEEDS_PERSON_DONE_NOTE = "Done. A few results need a person to confirm; see outcome.md.";
export const UNMET_NOTE = "The change merged, but the final check found Done when criteria that are not met. The details are in outcome.md. Decide whether to open a follow-up change, then set this one to done or closed.";

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
    ? await alongside(ctx, () => doneCheck(ctx, a), { what: "lessons", run: () => learn(`${EARLY}lessons`), wanted: (j) => j.ok })
    : [await doneCheck(ctx, a), null];
  if (!judged.ok) return block(ctx, judged.note, judged);
  const unmet = judged.items.filter((i) => i.result === "unmet");
  const forPerson = judged.items.filter((i) => i.result === "needs-person");

  // Lessons that ran alongside saw the history as it was when the done-check started; when a
  // done-check attempt failed meanwhile (and its retry passed), they run again with it.
  const lessons = early !== null && history() === historyBefore ? early : await learn();
  // outcome.md is for the owner; lessons.md is for engineers (`loopstra apply-lessons` reads it).
  let outcome = (judged.outcome || NO_CHECK_OUTCOME).trimEnd();
  if (unmet.length) outcome += `\n\n## Not met\n${bullets(unmet.map(line))}`;
  if (forPerson.length) outcome += `\n\n## For a person to confirm\n${bullets(forPerson.map(line))}`;
  await writeArtifact(ctx, "outcome.md", outcome);
  await writeArtifact(ctx, "lessons.md", lessons.ok
    ? `# Lessons\n\n## Lessons\n${bullets(lessons.envelope.lessons) || "- None recorded."}\n\n## Proposed CLAUDE.md additions\n${lessons.envelope.claude_md_additions.trim() || "None."}\n`
    : "# Lessons\n\n## Lessons\n- The lessons step did not finish.\n");

  const after = await runHookCommands(ctx, "after", "verify");
  if (!after.ok) return after;

  if (unmet.length) return block(ctx, UNMET_NOTE, { detail: { unmet: unmet.map(line) } });
  const human = ctx.cfg.gates.done.human;
  if (human !== "none") {
    ctx.trace.gate(ctx.slug, "done", "human", "waiting", "waiting for a person to confirm the outcome");
    await setStatus(ctx, "verifying", humanNote("outcome.md", "done", human));
    return { ok: true };
  }
  await setStatus(ctx, "done", forPerson.length ? NEEDS_PERSON_DONE_NOTE : "");
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
async function doneCheck(ctx: StepContext, a: { spec: string; review: string }): Promise<{ ok: true; items: Item[]; outcome: string } | Failure> {
  if (!ctx.cfg.gates.done.agent) return { ok: true, items: [], outcome: "" };
  const dir = join(loopstraDir(ctx.root), "verify", ctx.slug);
  // The tests written from Done when before the build (see writeAcceptance); main has them merged.
  const covered = coveredByTests(await readArtifact(ctx, "acceptance.md"));
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
        vars: { done_when: ctx.intent.file.sections["Done when"] ?? "", spec: a.spec, review: a.review, acceptance: covered || NONE_WRITTEN },
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
  return { ok: true, items, outcome: r.envelope.outcome_markdown };
}
