import { join } from "node:path";
import { blockWith, blockWithDetail, setStatus, writeArtifact, type Failure, type StepContext, type StepResult } from "../context";
import type { Envelope } from "../envelopes";
import { passOn, withDetachedWorktree } from "../git";
import { agentPhase } from "../phases";
import { commandTimeoutMs, runCommand } from "../shell";
import { artifacts, bullets, humanNote, runHookCommands } from "./shared";

const RECHECK = "To check again, set status to merged.";
const JUDGE_FAILED = `The final check could not be completed; an engineer should look. ${RECHECK}`;
export const NEEDS_PERSON_DONE_NOTE = "Done. A few results need a person to confirm; see outcome.md.";
const UNMET_NOTE = "The change merged, but the final check found Done when criteria that are not met. The details are in outcome.md. Decide whether to open a follow-up change, then set this one to done or closed.";

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

  const judged = await doneCheck(ctx, a);
  if (!judged.ok) return blockWith(ctx, judged);
  const unmet = judged.items.filter((i) => i.result === "unmet");
  const forPerson = judged.items.filter((i) => i.result === "needs-person");

  const lessons = await agentPhase(ctx, {
    name: "lessons", model: "cheap", permissionMode: "default", tools: "read",
    vars: { review: a.review, previous: ctx.trace.phases(ctx.slug).filter((p) => p.status === "fail").map((p) => `${p.name}: ${p.error ?? ""}`).join("\n") },
    skills: ctx.cfg.stages.verify.skills,
  });
  let outcome = (judged.outcome || NO_CHECK_OUTCOME).trimEnd();
  if (unmet.length) outcome += `\n\n## Not met\n${bullets(unmet.map(line))}`;
  if (forPerson.length) outcome += `\n\n## For a person to confirm\n${bullets(forPerson.map(line))}`;
  outcome += lessons.ok
    ? `\n\n## Lessons\n${bullets(lessons.envelope.lessons) || "- None recorded."}\n\n## Proposed CLAUDE.md additions\n${lessons.envelope.claude_md_additions.trim() || "None."}\n`
    : "\n\n## Lessons\n- The lessons step did not finish.\n";
  await writeArtifact(ctx, "outcome.md", outcome);

  const after = await runHookCommands(ctx, "after", "verify");
  if (!after.ok) return after;

  if (unmet.length) return blockWithDetail(ctx, UNMET_NOTE, { unmet: unmet.map(line) });
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
 * touches the owner's checkout. Pass means no unmet items; needs-person items never block.
 */
async function doneCheck(ctx: StepContext, a: { spec: string; review: string }): Promise<{ ok: true; items: Item[]; outcome: string } | Failure> {
  if (!ctx.cfg.gates.done.agent) return { ok: true, items: [], outcome: "" };
  const dir = join(ctx.root, ".loopstra", "verify", ctx.slug);
  let r: Awaited<ReturnType<typeof agentPhase<"done-check">>>;
  try {
    r = await withDetachedWorktree(ctx.git, dir, ctx.cfg.main_branch, async (cwd) => {
      const install = ctx.cfg.commands.install;
      if (install) {
        const res = await runCommand(install, cwd, { env: { LOOPSTRA_SLUG: ctx.slug }, timeoutMs: commandTimeoutMs(ctx.cfg) });
        ctx.trace.event(ctx.slug, "command", { command: install, code: res.code, lastLine: res.lastLine, where: "done-check copy of main" });
      }
      return agentPhase(ctx, {
        name: "done-check", model: "strong", permissionMode: "default", tools: "read+commands", cwd,
        vars: { done_when: ctx.intent.file.sections["Done when"] ?? "", spec: a.spec, review: a.review },
        skills: ctx.cfg.stages.verify.skills,
      });
    });
  } catch (e) {
    passOn(e);
    return { ok: false, note: JUDGE_FAILED, detail: `could not prepare a clean copy of main: ${e instanceof Error ? e.message : String(e)}` };
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
