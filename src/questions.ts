import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJson } from "./chat/threads";
import { commitRecord, type StepContext } from "./context";
import { conversationPath, readConversation, withEntry } from "./conversation";
import { readIntent, writeIntent, type Status } from "./intents";

/**
 * Questions an agent asks a person. The asking session's id, the phase, the question and the step's
 * question count live in `.loopstra/runs/<slug>/question.json`; `question: open` in intent.md says the
 * change waits for the answer (the scheduler skips it). The answer resumes the asking session.
 */

/** One question a session asked, and its answer once a person gave one. */
export interface Asked {
  phase: string;
  traceName: string;
  seq: number;
  sessionId: string | null;
  text: string;
  why: string;
  options: string[];
  at: string;
  answer?: { text: string; by: string; via: string; at: string };
}

/** `count`: the questions asked at `status` in this step; it starts again at 0 at another status. */
export interface QuestionState { status: Status; count: number; open: Asked | null }

/** A question as an envelope carries it. */
export interface Question { text: string; why: string; options: string[] }

/** The most questions one step may ask (spec: "A limit"). */
export const MAX_QUESTIONS = 3;
export const NO_MORE_QUESTIONS = `You have asked ${MAX_QUESTIONS} questions in this step, the most allowed. Do not ask another question: decide, and say in your summary what you decided and why.`;
export const TOO_MANY_NOTE = "The assistant kept asking questions on this step. Read conversation.md, and add what it needs to the intent.";

function statePath(root: string, slug: string): string {
  return join(root, ".loopstra", "runs", slug, "question.json");
}

function writeState(root: string, slug: string, state: QuestionState): void {
  const path = statePath(root, slug);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, state);
}

export function readQuestion(root: string, slug: string): QuestionState | null {
  return readJson<QuestionState>(statePath(root, slug));
}

/** The questions asked so far at this status (0 at another). */
export function askedAt(root: string, slug: string, status: Status): number {
  const s = readQuestion(root, slug);
  return s && s.status === status ? s.count : 0;
}

/** The question in an envelope, or null: intake's string (non-empty asks), or the others' object. */
export function questionIn(envelope: Record<string, unknown>): Question | null {
  const q = envelope.question;
  if (typeof q === "string") return q.trim() ? { text: q.trim(), why: "", options: [] } : null;
  if (q && typeof q === "object" && typeof (q as { text?: unknown }).text === "string" && (q as { text: string }).text.trim()) {
    const o = q as { text: string; why?: string; options?: string[] };
    return { text: o.text.trim(), why: (o.why ?? "").trim(), options: (o.options ?? []).map((x) => String(x).trim()).filter(Boolean) };
  }
  return null;
}

/**
 * Records a question a session asked: question.json, then `question: open` and the conversation.md entry
 * in one commit. The change then waits (the scheduler skips it). The session's row already ended asked,
 * with the question traced as an event of its own (see tracedSession).
 */
export async function recordQuestion(ctx: StepContext, a: Omit<Asked, "at" | "answer">): Promise<void> {
  const status = ctx.intent.file.frontmatter.status;
  const at = new Date();
  writeState(ctx.root, ctx.slug, { status, count: askedAt(ctx.root, ctx.slug, status) + 1, open: { ...a, at: at.toISOString() } });
  await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, `${a.phase} asks a question`, async () => {
    const fresh = await readIntent(ctx.root, ctx.slug);
    await writeIntent(fresh, { question: "open" });
    ctx.intent.file = fresh.file;
    await Bun.write(conversationPath(ctx.root, ctx.slug), withEntry(readConversation(ctx.root, ctx.slug), { kind: "question", phase: a.phase, text: a.text, why: a.why, options: a.options, at }));
  });
}

/** Stores the answer for the session that asked (the `answer` request does this, with the record; see src/apply.ts). */
export function answerQuestion(root: string, slug: string, answer: { text: string; by: string; via: string }): boolean {
  const s = readQuestion(root, slug);
  if (!s?.open) return false;
  writeState(root, slug, { ...s, open: { ...s.open, answer: { ...answer, at: new Date().toISOString() } } });
  return true;
}

/** The prompt that resumes the asking session with its answer. */
export function answerPrompt(a: Asked): string {
  return `${a.answer!.by} answered your question: ${a.answer!.text.trim()}\n\nCarry on.`;
}

/** The answered question is done with: the count stays for this step's limit. */
export function closeQuestion(root: string, slug: string): void {
  const s = readQuestion(root, slug);
  if (s) writeState(root, slug, { ...s, open: null });
}
