import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext } from "../../src/context";
import { readConversation } from "../../src/conversation";
import { Git } from "../../src/git";
import { readIntent } from "../../src/intents";
import { agentPhase, alongside } from "../../src/phases";
import { answerQuestion, readQuestion } from "../../src/questions";
import { runDesignStep } from "../../src/stages/design";
import { QuestionAsked } from "../../src/stop";
import type { Trace } from "../../src/trace";
import { fixture, fixtureDir, setupRepo, withEnv } from "../helpers";

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
        const r = await design(ctx);
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
        const r = await design(ctx);
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
});
