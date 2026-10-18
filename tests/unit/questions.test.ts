import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { block, PersonChangedStatus, setStatus, StepContext } from "../../src/context";
import { readConversation } from "../../src/conversation";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { agentPhase, alongside } from "../../src/phases";
import { answerQuestion, askedAt, closeStaleQuestion, closeUnusedAnswer, readQuestion, recordQuestion } from "../../src/questions";
import { runStepGuarded } from "../../src/scheduler";
import { runBuildStep } from "../../src/stages/build";
import { runDesignStep } from "../../src/stages/design";
import { writeChangeStop } from "../../src/inbox";
import { QuestionAsked, SessionStopped } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { until } from "../console-helpers";
import { fixture, fixtureDir, setupRepo, tempDir, withEnv } from "../helpers";

const SLUG = "add-numbers";
const ASKS = { text: "Archived too?", why: "The list hides them.", options: ["yes", "no"] };

/** A fixture whose result's structured output carries `question`. */
function asking(name: string, question: unknown): string {
  return fixture(name).split("\n").map((l) => {
    if (!l.includes('"type":"result"')) return l;
    const e = JSON.parse(l) as { structured_output: Record<string, unknown> };
    e.structured_output.question = question;
    return JSON.stringify(e);
  }).join("\n");
}

const design = (ctx: StepContext) => agentPhase(ctx, { name: "design", model: "default", permissionMode: "plan", tools: "read", vars: { intent: ctx.intent.file.body, findings: "" } });
const plan = (ctx: StepContext) => agentPhase(ctx, { name: "plan", model: "default", permissionMode: "plan", tools: "read", vars: { intent: ctx.intent.file.body, spec: "", concerns: "" } });
const build = (ctx: StepContext) => agentPhase(ctx, { name: "build", model: "default", permissionMode: "plan", tools: "read", vars: { plan: "", spec: "", feedback: "", test_command: "echo ok" } });
const fix = (ctx: StepContext, i: number) => agentPhase(ctx, { name: "fix", traceName: `fix-${i}`, model: "default", permissionMode: "plan", tools: "read", vars: { failure_output: `failure ${i}`, test_command: "echo ok" } });

/** The next step's context: one is made per step. */
async function nextStep(ctx: StepContext): Promise<StepContext> {
  return new StepContext(ctx.root, ctx.cfg, ctx.trace, await readIntent(ctx.root, ctx.slug));
}

const ANSWER = { text: "No.", by: "John", via: "the dashboard" };

/** Each line of a LOOPSTRA_FAKE_* log, parsed. */
function logLines<T>(path: string): T[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

function questionPath(root: string): string {
  return join(root, ".loopstra", "runs", SLUG, "question.json");
}

function questionEvents(trace: Trace): Array<{ seq: number | null; question: string }> {
  return trace.events(SLUG).filter((e) => e.type === "question").map((e) => ({ seq: e.phase_seq, ...(JSON.parse(e.payload) as { question: string }) }));
}

describe("questions", () => {
  test("a design session that asks: the phase is asked, the question is recorded, question: open is set, and the step ends quietly", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ design: asking("design", ASKS) });
    try {
      const e = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, () => design(ctx).then(() => null, (err: unknown) => err));
      expect(e).toBeInstanceOf(QuestionAsked);
      expect((e as QuestionAsked).text).toBe("Archived too?");
      const row = trace.phases(SLUG).at(-1)!;
      expect(row).toMatchObject({ name: "design", status: "asked", error: null });
      expect(questionEvents(trace)).toEqual([{ seq: row.seq, question: "Archived too?" }]);
      const i = await readIntent(repo.path, SLUG);
      expect(i.file.frontmatter.question).toBe("open");
      expect(i.file.frontmatter.status).toBe("designing");
      expect(readConversation(repo.path, SLUG)).toMatch(/## [0-9-]+ [0-9:]+ · design asks\nArchived too\?\nWhy: The list hides them\.\nOptions: yes · no\n/);
      expect(readQuestion(repo.path, SLUG)).toMatchObject({ status: "designing", count: 1, open: { phase: "design", traceName: "design", seq: row.seq, text: "Archived too?", why: "The list hides them.", options: ["yes", "no"], sessionId: "fake-design" } });
      // One commit has the question and the record.
      const log = await new Git(repo.path).run(["log", "-1", "--format=%s", "--name-only"]);
      expect(log.out).toContain("loopstra(add-numbers): design asks a question");
      expect(log.out).toContain("intent/add-numbers/conversation.md");
      expect(log.out).toContain("intent/add-numbers/intent.md");
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("once answered, the next design session resumes the asking session with the answer", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-1": asking("design", ASKS), design: fixture("design") });
    const calls = join(fixtures.path, "calls.jsonl");
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await design(ctx).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, { text: "No.", by: "John", via: "the dashboard" })).toBe(true);
        const r = await design(await nextStep(ctx));
        expect(r.ok).toBe(true);
      });
      const last = logLines<string[]>(calls).at(-1)!;
      expect(last[last.indexOf("--resume") + 1]).toBe("fake-design");
      expect(logLines<{ prompt: string }>(prompts).at(-1)!.prompt).toBe("John answered your question: No.\n\nCarry on.");
      const state = readQuestion(repo.path, SLUG)!;
      expect(state.open).toBeNull();
      expect(state.count).toBe(1);
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("an answered question whose session is gone starts a fresh session with the normal prompt", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-1": asking("design", ASKS), design: fixture("design") });
    const calls = join(fixtures.path, "calls.jsonl");
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await design(ctx).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        const state = JSON.parse(readFileSync(questionPath(repo.path), "utf8")) as { open: { sessionId: string } };
        state.open.sessionId = "missing-session";
        await Bun.write(questionPath(repo.path), JSON.stringify(state));
        expect(answerQuestion(repo.path, SLUG, { text: "No.", by: "John", via: "the dashboard" })).toBe(true);
        const r = await design(await nextStep(ctx));
        expect(r.ok).toBe(true);
      });
      const args = logLines<string[]>(calls);
      expect(args).toHaveLength(3);
      expect(args[1]![args[1]!.indexOf("--resume") + 1]).toBe("missing-session");
      expect(args[2]).not.toContain("--resume");
      const last = logLines<{ prompt: string }>(prompts).at(-1)!.prompt;
      expect(last).toContain("# Intent: add numbers");
      expect(last).not.toContain("answered your question");
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
      expect(trace.phases(SLUG).map((p) => [p.name, p.status])).toEqual([["design", "asked"], ["design", "fail"], ["design", "success"]]);
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("a fix that asked as fix-2 resumes as the next step's first fix session, whatever its number", async () => {
    const { repo, ctx, trace } = await setupRepo("building");
    const fixtures = fixtureDir({ "fix-1": asking("fix", ASKS), fix: fixture("fix") });
    const calls = join(fixtures.path, "calls.jsonl");
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await fix(ctx, 2).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        expect((await fix(await nextStep(ctx), 1)).ok).toBe(true);
      });
      expect(logLines<string[]>(calls).at(-1)).toContain("--resume");
      expect(logLines<{ prompt: string }>(prompts).at(-1)!.prompt).toBe("John answered your question: No.\n\nCarry on.");
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("an answer waits for the step's first session of the asking kind: a build before it skips it, and a later fix starts fresh", async () => {
    const { repo, ctx, trace } = await setupRepo("building");
    const fixtures = fixtureDir({ "fix-1": asking("fix", ASKS), fix: fixture("fix"), build: fixture("build") });
    const calls = join(fixtures.path, "calls.jsonl");
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await fix(ctx, 2).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        // The next step starts with a build: another kind of phase. It neither takes the answer nor closes it.
        const step = await nextStep(ctx);
        expect((await build(step)).ok).toBe(true);
        expect(readQuestion(repo.path, SLUG)!.open?.answer?.text).toBe("No.");
        // The step's first fix resumes the asking session with the answer.
        expect((await fix(step, 1)).ok).toBe(true);
        expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
        // A later fix of the same step starts fresh, with its own failure.
        expect((await fix(step, 2)).ok).toBe(true);
      });
      const sent = logLines<{ phase: string; args: string[]; prompt: string }>(prompts);
      expect(sent.map((p) => p.phase)).toEqual(["fix", "build", "fix", "fix"]);
      expect(sent[1]!.prompt).not.toContain("answered your question");
      expect(sent[2]!.prompt).toBe("John answered your question: No.\n\nCarry on.");
      expect(sent[2]!.args).toContain("--resume");
      expect(sent[3]!.prompt).toContain("failure 2");
      expect(sent[3]!.prompt).not.toContain("answered your question");
      // A fresh session still reads the question and its answer, in conversation.md.
      expect(sent[3]!.prompt).toContain("Archived too?");
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("design that asked resumes when the next design step runs: intake before it skips the answer", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-1": asking("design", ASKS), design: fixture("design") });
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await runDesignStep(ctx).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        expect((await runDesignStep(await nextStep(ctx))).ok).toBe(true);
      });
      const designs = logLines<{ phase: string; args: string[]; prompt: string }>(prompts).filter((p) => p.phase === "design");
      expect(designs).toHaveLength(2);
      expect(designs[1]!.args[designs[1]!.args.indexOf("--resume") + 1]).toBe("fake-design");
      expect(designs[1]!.prompt).toBe("John answered your question: No.\n\nCarry on.");
      expect(trace.phases(SLUG).map((p) => [p.name, p.status]).slice(0, 4)).toEqual([["intake", "success"], ["design", "asked"], ["intake", "success"], ["design", "success"]]);
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("a fix that asked during the test loop resumes as the next step's first fix, after the build", async () => {
    const { repo, ctx, trace } = await setupRepo("plan-approved", { commands: { test: "exit 1" }, config: "stages:\n  build:\n    max_fix_loops: 1\n" });
    await Bun.write(join(repo.path, "intent", SLUG, "spec.md"), "# Spec\n\n## Summary\ns\n");
    await Bun.write(join(repo.path, "intent", SLUG, "plan.md"), "# Plan: add\n\n## Files that change\n- src/add.ts (new)\n- tests/add.test.ts (new)\n");
    await new Git(repo.path).commitAll("artifacts");
    await ctx.reload();
    // The asking fix has its own session id, so its resume is told apart from fix's usual resume of the build.
    const fixtures = fixtureDir({ "fix-1": asking("fix", ASKS).replaceAll("fake-build", "fake-fix-asked"), fix: fixture("fix") });
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await runBuildStep(ctx).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        await runBuildStep(await nextStep(ctx));
      });
      const fixes = logLines<{ phase: string; args: string[]; prompt: string }>(prompts).filter((p) => p.phase === "fix");
      expect(fixes).toHaveLength(2);
      expect(fixes[1]!.args[fixes[1]!.args.indexOf("--resume") + 1]).toBe("fake-fix-asked");
      expect(fixes[1]!.prompt).toBe("John answered your question: No.\n\nCarry on.");
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("an answered question nothing in the step used is closed when the step ends; one the step asked stays open", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-1": asking("design", ASKS), "intake-2": fixture("agent-fail") });
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, async () => {
        expect(await runStepGuarded(ctx)).toEqual({ ok: true, asked: true });
        expect(readQuestion(repo.path, SLUG)!.open).toMatchObject({ phase: "design", text: "Archived too?" });
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        // Intake fails before design runs: the step ends without using the answer.
        expect((await runStepGuarded(await nextStep(ctx))).ok).toBe(false);
      });
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("an answer is not given to a session after the change's status changed", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-1": asking("design", ASKS), design: fixture("design"), plan: fixture("plan") });
    const calls = join(fixtures.path, "calls.jsonl");
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await design(ctx).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        await setStatus(await nextStep(ctx), "planning");
        const step = await nextStep(ctx);
        expect((await plan(step)).ok).toBe(true);
        // Not used: it is closed as the step ends.
        closeUnusedAnswer(step);
      });
      expect(logLines<string[]>(calls).at(-1)).not.toContain("--resume");
      expect(logLines<{ prompt: string }>(prompts).at(-1)!.prompt).not.toContain("answered your question");
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("an answer is not given to a session once the change came back to the same status (sent back, or blocked and retried)", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-1": asking("design", ASKS), design: fixture("design") });
    const calls = join(fixtures.path, "calls.jsonl");
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_CALLS: calls, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        expect(await design(ctx).then(() => null, (err: unknown) => err)).toBeInstanceOf(QuestionAsked);
        expect(answerQuestion(repo.path, SLUG, ANSWER)).toBe(true);
        await setStatus(await nextStep(ctx), "spec-review");
        await setStatus(await nextStep(ctx), "designing");
        const step = await nextStep(ctx);
        expect((await design(step)).ok).toBe(true);
        closeUnusedAnswer(step);
      });
      expect(logLines<string[]>(calls).at(-1)).not.toContain("--resume");
      expect(logLines<{ prompt: string }>(prompts).at(-1)!.prompt).not.toContain("answered your question");
      expect(readQuestion(repo.path, SLUG)!.open).toBeNull();
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("at a step's start, a question from another stay at a status is closed; one from this stay is kept", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    try {
      await recordQuestion(ctx, { phase: "design", traceName: "design", seq: 1, sessionId: "s1", ...ASKS });
      closeStaleQuestion(await nextStep(ctx));
      expect(readQuestion(repo.path, SLUG)!.open).toMatchObject({ text: "Archived too?" });
      // A person sent it back and it came round again: the question was asked in an earlier stay.
      trace.statusChange(SLUG, "designing", "spec-review", "");
      trace.statusChange(SLUG, "spec-review", "designing", "sent back");
      closeStaleQuestion(await nextStep(ctx));
      expect(readQuestion(repo.path, SLUG)).toMatchObject({ status: "designing", count: 1, open: null });
    } finally { trace.close(); repo.cleanup(); }
  }, 90_000);

  test("a status change to the same status (a spec written again) does not start a stay: the question and the count stay", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    try {
      await recordQuestion(ctx, { phase: "design", traceName: "design", seq: 1, sessionId: "s1", ...ASKS });
      // What artifact.ts does before a rewrite: the same status, with a new note.
      await setStatus(await nextStep(ctx), "designing", "The first spec did not pass its automatic check, so it is being written again.");
      const step = await nextStep(ctx);
      closeStaleQuestion(step);
      expect(readQuestion(repo.path, SLUG)!.open).toMatchObject({ text: "Archived too?" });
      expect(askedAt(step)).toBe(1);
    } finally { trace.close(); repo.cleanup(); }
  }, 90_000);

  test("the question count starts again once the status changes: three asked, blocked and retried, the next question is allowed", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ design: asking("design", ASKS) });
    try {
      await Bun.write(questionPath(repo.path), JSON.stringify({ status: "designing", since: 0, count: 3, open: null }));
      await block(await nextStep(ctx), "Something went wrong.");
      await setStatus(await nextStep(ctx), "designing");
      const e = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, async () => design(await nextStep(ctx)).then(() => null, (err: unknown) => err));
      expect(e).toBeInstanceOf(QuestionAsked);
      expect(readQuestion(repo.path, SLUG)).toMatchObject({ status: "designing", count: 1, open: { text: "Archived too?" } });
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("with three asked in a step the prompt says no more; a fourth blocks", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ "design-2": asking("design", ASKS), design: fixture("design") });
    const prompts = join(fixtures.path, "prompts.jsonl");
    try {
      await Bun.write(questionPath(repo.path), JSON.stringify({ status: "designing", count: 3, open: null }));
      await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path, LOOPSTRA_FAKE_PROMPTS: prompts }, async () => {
        const first = await design(ctx);
        expect(first.ok).toBe(true);
        expect(logLines<{ prompt: string }>(prompts).at(-1)!.prompt).toContain("Do not ask another question");
        const fourth = await design(ctx);
        expect(fourth).toMatchObject({ ok: false, reason: "agent-fail" });
        expect(!fourth.ok && fourth.note).toContain("The assistant kept asking questions on this step");
      });
      expect(readQuestion(repo.path, SLUG)).toEqual({ status: "designing", count: 3, open: null });
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.question).toBe("");
      expect(trace.phases(SLUG).at(-1)!.status).toBe("fail");
      expect(questionEvents(trace)).toEqual([]);
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("intake's question asks instead of blocking", async () => {
    const { repo, ctx, trace } = await setupRepo("accepted");
    try {
      await Bun.write(join(repo.path, "loopstra", "prompts", "intake.md"), "{{intent}} FIXTURE:intake-question");
      const e = await runDesignStep(ctx).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(QuestionAsked);
      const i = await readIntent(repo.path, SLUG);
      expect(i.file.frontmatter.status).not.toBe("blocked");
      expect(i.file.frontmatter.question).toBe("open");
      expect(trace.phases(SLUG).map((p) => [p.name, p.status])).toEqual([["intake", "asked"]]);
      expect(readQuestion(repo.path, SLUG)!.open).toMatchObject({ phase: "intake", text: "Which portal page should show the status?", why: "", options: [], sessionId: "q" });
      expect(readConversation(repo.path, SLUG)).toContain("· intake asks\nWhich portal page should show the status?\n");
    } finally { trace.close(); repo.cleanup(); }
  }, 90_000);

  test("a question whose commit fails leaves no open question.json behind", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    try {
      // A lock on main's ref: the commit fails.
      writeFileSync(join(repo.path, ".git", "refs", "heads", `${ctx.cfg.main_branch}.lock`), "");
      const e = await recordQuestion(ctx, { phase: "design", traceName: "design", seq: 1, sessionId: "s1", ...ASKS }).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(Error);
      expect(existsSync(questionPath(repo.path))).toBe(false);
      // What it wrote is put back, so the next commit (a block, say) never commits an open question without question.json.
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.question).toBe("");
      expect(readConversation(repo.path, SLUG)).toBe("");
      expect((await new Git(repo.path).run(["status", "--porcelain", "--", "intent"])).out.trim()).toBe("");
      rmSync(join(repo.path, ".git", "refs", "heads", `${ctx.cfg.main_branch}.lock`));
      await recordQuestion(ctx, { phase: "design", traceName: "design", seq: 1, sessionId: "s1", ...ASKS });
      expect(readQuestion(repo.path, SLUG)).toMatchObject({ status: "designing", count: 1, open: { text: "Archived too?", sessionId: "s1" } });
      expect(readConversation(repo.path, SLUG).match(/design asks/g)).toHaveLength(1);
    } finally { trace.close(); repo.cleanup(); }
  }, 90_000);

  test("a question whose commit fails leaves a person's uncommitted edit as it is", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    try {
      const path = join(repo.path, "intent", SLUG, "intent.md");
      writeFileSync(path, `${readFileSync(path, "utf8")}\nA line a person added.\n`);
      writeFileSync(join(repo.path, ".git", "refs", "heads", `${ctx.cfg.main_branch}.lock`), "");
      const e = await recordQuestion(ctx, { phase: "design", traceName: "design", seq: 1, sessionId: "s1", ...ASKS }).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(Error);
      expect(readFileSync(path, "utf8")).toContain("A line a person added.");
      // conversation.md held nothing of the person's: it is put back.
      expect(readConversation(repo.path, SLUG)).toBe("");
    } finally { trace.close(); repo.cleanup(); }
  }, 90_000);

  test("a question is not recorded over a status a person set while the session ran", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    try {
      const path = join(repo.path, "intent", SLUG, "intent.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("status: designing", "status: closed"));
      const e = await recordQuestion(ctx, { phase: "design", traceName: "design", seq: 1, sessionId: "s1", ...ASKS }).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(PersonChangedStatus);
      const i = await readIntent(repo.path, SLUG);
      expect(i.file.frontmatter.status).toBe("closed");
      expect(i.file.frontmatter.question).toBe("");
      expect(existsSync(questionPath(repo.path))).toBe(false);
    } finally { trace.close(); repo.cleanup(); }
  }, 90_000);

  test("a question from work run alongside (the plan written ahead) is not recorded; that work is just not used", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const fixtures = fixtureDir({ plan: asking("plan", ASKS) });
    try {
      const [m, x] = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, () => alongside(ctx, async () => 1, { what: "plan ahead", run: () => plan(ctx), wanted: () => true }));
      expect(m).toBe(1);
      expect(x).toMatchObject({ ok: false, reason: "agent-fail", note: "It asked a question" });
      expect(existsSync(questionPath(repo.path))).toBe(false);
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.question).toBe("");
      expect(readConversation(repo.path, SLUG)).toBe("");
      expect(trace.phases(SLUG).map((p) => [p.name, p.status])).toEqual([["plan", "fail"]]);
      expect(questionEvents(trace)).toEqual([]);
    } finally { trace.close(); fixtures.cleanup(); repo.cleanup(); }
  }, 90_000);

  test("a question asked by a session that ends as the change is stopped is still recorded; the stop ends the step", async () => {
    const { repo, ctx, trace } = await setupRepo("designing");
    const t = tempDir();
    const gate = join(t.path, "go").replaceAll("\\", "/");
    const [init, ...rest] = asking("design", ASKS).split("\n");
    const fixtures = fixtureDir({ design: [init, JSON.stringify({ type: "fake_action", wait_for: gate }), ...rest].join("\n") });
    try {
      const e = await withEnv({ LOOPSTRA_FAKE_FIXTURE_DIR: fixtures.path }, async () => {
        const run = design(ctx).then(() => null, (err: unknown) => err);
        await until(() => trace.phases(SLUG).some((p) => p.name === "design" && p.status === "running"));
        writeChangeStop(repo.path, SLUG, "John");
        writeFileSync(gate, "");
        return run;
      });
      expect(e).toBeInstanceOf(SessionStopped);
      expect(trace.phases(SLUG).at(-1)).toMatchObject({ name: "design", status: "asked" });
      expect(readQuestion(repo.path, SLUG)).toMatchObject({ count: 1, open: { phase: "design", text: "Archived too?" } });
      expect((await readIntent(repo.path, SLUG)).file.frontmatter.question).toBe("open");
      expect(readConversation(repo.path, SLUG)).toContain("· design asks\nArchived too?\n");
    } finally { trace.close(); fixtures.cleanup(); t.cleanup(); repo.cleanup(); }
  }, 90_000);
});
