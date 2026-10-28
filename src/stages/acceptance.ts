import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ACCEPTANCE, writeArtifact, writeMarker, type Failure, type StepContext } from "../context";
import type { Envelope } from "../envelopes";
import { parseSections } from "../intents";
import { passOn, type Git } from "../git";
import { agentPhase } from "../phases";
import { errorText } from "../shell";
import { isAcceptancePath } from "../test-paths";
import { bullets, KEEP_UNFINISHED, saveWork, type Artifacts } from "./shared";

/** What acceptance.md and the done-check say when the change has no acceptance tests. */
export const NONE_WRITTEN = "No acceptance tests were written for this change.";

/** The heading of acceptance.md's list of tests, which the done-check reads. */
const COVERED = "Covered by tests";

/** acceptance.md's list of tests (see acceptanceRecord), or "" when it has none or there is no acceptance.md. */
export function coveredByTests(acceptanceMd: string | null): string {
  return acceptanceMd === null ? "" : (parseSections(acceptanceMd)[COVERED] ?? "");
}

/**
 * The acceptance step (stages.build.acceptance_tests), run before the build session: a fresh session
 * in the change's worktree writes tests from the owner's Done when list. The runtime commits them on
 * the branch, records acceptance.md on main, and writes the ACCEPTANCE marker with the test files, which
 * the build's sessions may not edit. A session that fails does not block the change: the trace says
 * why, acceptance.md says no tests were written, what it wrote is dropped, and the build goes on as
 * without the setting. Only a commit that fails returns a failure (the build's own would fail too).
 */
export async function writeAcceptance(ctx: StepContext, wt: Git, a: Artifacts): Promise<{ ok: true } | Failure> {
  // What an earlier build left unsaved is kept first, so the acceptance commit holds only the tests.
  const leftover = await saveWork(ctx, wt, KEEP_UNFINISHED);
  if (!leftover.ok) return leftover;
  const before = await wt.headSha();
  const r = await agentPhase(ctx, {
    name: "acceptance", permissionMode: "acceptEdits", tools: "build", cwd: ctx.worktreeDir,
    vars: { done_when: ctx.intent.file.sections["Done when"] ?? "", spec: a.spec, plan: a.plan, test_command: ctx.cfg.commands.test },
    skills: ctx.cfg.stages.build.skills,
  });
  if (!r.ok) {
    ctx.trace.event(ctx.slug, "error", { where: "acceptance", reason: r.reason, note: "the acceptance step did not finish; the build goes on without acceptance tests" });
    await dropUnsaved(ctx, wt);
    await writeArtifact(ctx, "acceptance.md", acceptanceRecord(null, []));
    writeMarker(ctx, ACCEPTANCE, "[]");
    return { ok: true };
  }
  // The session could edit only tests (the hook); anything else changed was written by the commands it ran.
  await dropNonTests(ctx, wt);
  const subject = `loopstra(${ctx.slug}): acceptance tests`;
  const said = r.envelope.commit_message.trim();
  const saved = await saveWork(ctx, wt, said ? `${subject}\n\n${said}` : subject);
  if (!saved.ok) return saved;
  // What git says the session wrote, and the tests it names that are on the branch already (an
  // earlier build's step wrote them, and this one kept them).
  const written = (await wt.run(["diff", "--name-only", "-z", "--diff-filter=d", before, "HEAD", "--"])).out.split("\0").filter(Boolean);
  const tests = r.envelope.tests.map((t) => ({ ...t, file: inRepo(ctx, t.file) }));
  const named = tests.map((t) => t.file).filter((f) => f && existsSync(join(ctx.worktreeDir, f)));
  // Only tests and their fixtures are held: a source file the session named (the module under test) never is.
  const files = [...new Set([...written, ...named])].filter(isAcceptancePath);
  ctx.trace.event(ctx.slug, "command", { command: "acceptance", files, tests: tests.length, not_testable: r.envelope.not_testable.length });
  await writeArtifact(ctx, "acceptance.md", acceptanceRecord({ tests, not_testable: r.envelope.not_testable }, files));
  writeMarker(ctx, ACCEPTANCE, JSON.stringify(files));
  return { ok: true };
}

/** A path the session named, as a path in the repository with forward slashes ("" when it is outside the worktree). */
function inRepo(ctx: StepContext, file: string): string {
  let p = file.trim();
  if (isAbsolute(p)) p = relative(ctx.worktreeDir, p);
  p = p.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p.startsWith("../") || isAbsolute(p) ? "" : p;
}

/** Puts the worktree back as its last commit has it, after a session that failed; a failure is traced, and the build's commit may then include what it left. */
async function dropUnsaved(ctx: StepContext, wt: Git): Promise<void> {
  try {
    await wt.putBack(await wt.changedTrackedFiles());
    await wt.run(["clean", "-f", "-d", "-q"]);
  } catch (e) {
    passOn(e);
    ctx.trace.event(ctx.slug, "error", { where: "acceptance", error: errorText(e), note: "what the acceptance session wrote was not removed; the build's commit may include it" });
  }
}

/**
 * Puts back tracked files that are not tests, and removes new ones, before the acceptance commit:
 * output of the test command the session ran (a coverage folder, a cache), never its own edits. A
 * failure is traced, and the commit may then include that output.
 */
async function dropNonTests(ctx: StepContext, wt: Git): Promise<void> {
  try {
    const changed = (await wt.changedTrackedFiles()).filter((f) => !isAcceptancePath(f));
    if (changed.length) await wt.putBack(changed);
    const added = (await wt.run(["ls-files", "--others", "--exclude-standard", "-z"])).out.split("\0").filter((f) => f && !isAcceptancePath(f));
    for (const f of added) rmSync(join(ctx.worktreeDir, f), { force: true, recursive: true });
  } catch (e) {
    passOn(e);
    ctx.trace.event(ctx.slug, "error", { where: "acceptance", error: errorText(e), note: "files the test command wrote were not removed; the acceptance commit may include them" });
  }
}

/** Ends a sentence with a period unless it has its own ending. */
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * acceptance.md, for the owner: each test by the criterion it covers (the owner's words), then each
 * criterion no test covers and why. `e` is null when the session did not finish; its test files are
 * paths in the repository, and a test whose file is not among `files` is left out.
 */
function acceptanceRecord(e: Pick<Envelope<"acceptance">, "tests" | "not_testable"> | null, files: string[]): string {
  const head = "# Acceptance tests\n\n";
  if (!e) return `${head}${NONE_WRITTEN} The step that writes them from Done when did not finish, so the build went on without them.\n`;
  const held = new Set(files);
  const covered = e.tests
    .filter((t) => held.has(t.file))
    .map((t) => `${t.criterion.trim().replace(/\.$/, "")}: \`${t.file}\`, "${t.test}"`);
  const open = e.not_testable.map((n) => `${n.criterion.trim().replace(/\.$/, "")}: ${sentence(n.why)}`);
  const parts = [covered.length ? "Written from Done when before the build. The build may not change them." : `${NONE_WRITTEN} No criterion in Done when could be checked by a test.`];
  if (covered.length) parts.push(`## ${COVERED}\n${bullets(covered)}`);
  if (open.length) parts.push(`## Not covered by a test\n${bullets(open)}`);
  return `${head}${parts.join("\n\n")}\n`;
}
