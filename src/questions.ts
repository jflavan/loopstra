import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJson } from "./chat/threads";
import { phaseKind } from "./console/steerable";
import { commitRecord, writeForStep, type StepContext } from "./context";
import { conversationPath, readConversation, withEntryOnce } from "./conversation";
import { Git } from "./git";
import { asAtHead, fileHash, matchesHead } from "./headfiles";
import { hasQuestion, type Intent, type Status } from "./intents";
import { onCheckout } from "./lanes";
import { errorText } from "./shell";

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

/**
 * `status` and `since`: the change's stay at a status the question and the count belong to (`since`: the
 * id of the trace's newest status change to another status then, 0 when there was none; see stayAt).
 * `count`: the questions asked in that stay; it starts again at 0 once the status changes, even back to
 * the same one (a block and a retry, a send back). A status change to the same status, which only
 * rewrites the note (a spec written again), does not start a stay.
 */
export interface QuestionState { status: Status; since?: number; count: number; open: Asked | null }

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

/**
 * The change's present stay at its status: the status, and the id of the trace's newest status change
 * to another status (0: none). One to the same status only rewrote the note, so it does not count.
 */
export function stayAt(ctx: StepContext): { status: Status; since: number } {
  return { status: ctx.intent.file.frontmatter.status, since: ctx.trace.lastStatusMove(ctx.slug) };
}

/** True when the state belongs to the change's present stay at its status (see stayAt). */
function inStay(s: QuestionState, stay: { status: Status; since: number }): boolean {
  return s.status === stay.status && (s.since ?? 0) === stay.since;
}

/** The questions asked so far in the change's present stay at its status (0 once it changed). */
export function askedAt(ctx: StepContext): number {
  const s = readQuestion(ctx.root, ctx.slug);
  return s && inStay(s, stayAt(ctx)) ? s.count : 0;
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
 * Records a question a session asked: `question: open` and the conversation.md entry in one commit,
 * then question.json. Written only once the commit landed, so a failed commit never leaves an open
 * question the change does not say it has. A status a person set while the session ran is never
 * written over: PersonChangedStatus is thrown, as the step's own writes do. The change then waits (the scheduler skips it). The
 * session's row already ended asked, with the question traced as an event of its own (see tracedSession).
 */
export async function recordQuestion(ctx: StepContext, a: Omit<Asked, "at" | "answer">): Promise<void> {
  const stay = stayAt(ctx);
  const at = new Date();
  const count = askedAt(ctx) + 1;
  const files = [`intent/${ctx.slug}/intent.md`, `intent/${ctx.slug}/conversation.md`];
  /** The hash of what was written, by file, for each that held nothing but HEAD's before the write. */
  const written = new Map<string, string>();
  try {
    await commitRecord(ctx.root, ctx.cfg.main_branch, ctx.slug, `${a.phase} asks a question`, async () => {
      const own = await Promise.all(files.map((f) => matchesHead(ctx.root, f)));
      // Never over a status a person set while the session ran (PersonChangedStatus instead).
      await writeForStep(ctx, { question: "open" });
      // An earlier try whose put back failed left the entry on disk: it is not added twice.
      await Bun.write(conversationPath(ctx.root, ctx.slug), withEntryOnce(readConversation(ctx.root, ctx.slug), { kind: "question", phase: a.phase, text: a.text, why: a.why, options: a.options, at }));
      files.forEach((f, i) => {
        const hash = own[i] ? fileHash(join(ctx.root, f)) : null;
        if (hash) written.set(f, hash);
      });
    });
  } catch (e) {
    if (written.size) await putBack(ctx, written);
    throw e;
  }
  writeState(ctx.root, ctx.slug, { ...stay, count, open: { ...a, at: at.toISOString() } });
}

/**
 * Puts back, as HEAD has them, the files a question's failed commit wrote, so the next commit (a block,
 * say) never commits an open question with no question.json; only those that still hold exactly what
 * was written. A problem is traced: the files then stay as they are.
 */
async function putBack(ctx: StepContext, written: Map<string, string>): Promise<void> {
  try {
    await onCheckout(ctx.root, async () => {
      const git = new Git(ctx.root);
      // Off main, HEAD is another branch's: what it holds is not what the write replaced.
      if ((await git.currentBranch()) !== ctx.cfg.main_branch) return;
      for (const [f, hash] of written) if (fileHash(join(ctx.root, f)) === hash) await asAtHead(git, ctx.root, f);
    });
  } catch (e) {
    ctx.trace.event(ctx.slug, "error", { where: "question", error: `what the question wrote could not be put back: ${errorText(e)}` });
  }
}

/** The text of each open question, by change, for the changes whose intent.md says `question: open` (see renderQueue). */
export function openQuestions(root: string, intents: Intent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of intents) {
    const text = hasQuestion(i) ? readQuestion(root, i.slug)?.open?.text : undefined;
    if (text) out.set(i.slug, text);
  }
  return out;
}

/** Stores the answer for the session that asked (the `answer` request does this, with the record; see src/apply.ts). */
export function answerQuestion(root: string, slug: string, answer: { text: string; by: string; via: string }): boolean {
  const s = readQuestion(root, slug);
  if (!s?.open) return false;
  writeState(root, slug, { ...s, open: { ...s.open, answer: { ...answer, at: new Date().toISOString() } } });
  return true;
}

/** Takes back a stored answer that never landed (an `answer` request given up on; see src/apply.ts): the question waits again. */
export function takeBackAnswer(root: string, slug: string): void {
  const s = readQuestion(root, slug);
  if (!s?.open?.answer) return;
  const { answer: _, ...open } = s.open;
  writeState(root, slug, { ...s, open });
}

/** The prompt that resumes the asking session with its answer. */
export function answerPrompt(a: Asked): string {
  return `${a.answer!.by} answered your question: ${a.answer!.text.trim()}\n\nCarry on.`;
}

/**
 * The question is done with: the count stays for this step's limit. With `which`, only when the open
 * question is still that one (a session resumed with its answer may have asked another since).
 */
export function closeQuestion(root: string, slug: string, which?: Asked): void {
  const s = readQuestion(root, slug);
  if (!s?.open) return;
  if (which && (s.open.at !== which.at || s.open.seq !== which.seq)) return;
  writeState(root, slug, { ...s, open: null });
}

/**
 * The answered question a session of `phase` resumes with, or null. It waits for the step's first
 * session of the kind of phase that asked (fix-2 and fix-1 are both fix), so the sessions of other kinds
 * that run before it (intake before design, build before fix, the review judge before revise) neither
 * take it nor close it. That first session resumes the asking session, when the change is still in the
 * stay at its status the question was asked in (no status change since: not moved on, sent back or
 * retried); later sessions of that kind in the step never do. The caller closes the question once it
 * resumed (see agentPhase); one nothing in the step used is closed when the step ends (see
 * closeUnusedAnswer). `mayResume`: false for a session that may not ask (a judge, work run alongside):
 * it skips the question, and does not count as the first of its kind.
 */
export function answerFor(ctx: StepContext, phase: string, mayResume: boolean): Asked | null {
  if (!mayResume) return null;
  const kind = phaseKind(phase);
  if (ctx.kindsStarted.has(kind)) return null;
  ctx.kindsStarted.add(kind);
  const s = readQuestion(ctx.root, ctx.slug);
  if (!s?.open?.answer) return null;
  return inStay(s, stayAt(ctx)) && phaseKind(s.open.phase) === kind ? s.open : null;
}

/**
 * At a step's end: an answered question asked before the step began that nothing in the step used is
 * closed (one this step asked is left for its answer). Its answer is in conversation.md, so the sessions
 * to come still read it. Never fails: a problem is traced, and the next step's end tries again.
 */
export function closeUnusedAnswer(ctx: StepContext): void {
  try {
    const s = readQuestion(ctx.root, ctx.slug);
    if (s?.open?.answer && Date.parse(s.open.at) < ctx.startedAt) closeQuestion(ctx.root, ctx.slug);
  } catch (e) {
    ctx.trace.event(ctx.slug, "error", { where: "question", error: errorText(e) });
  }
}

/**
 * At a step's start: a question, open or answered, from another stay at a status (the change moved on,
 * or was sent back or retried) is closed. Its entries in conversation.md stay for the sessions to come.
 * Never fails the step: a problem is traced, and the next step's start tries again.
 */
export function closeStaleQuestion(ctx: StepContext): void {
  try {
    const s = readQuestion(ctx.root, ctx.slug);
    if (s?.open && !inStay(s, stayAt(ctx))) closeQuestion(ctx.root, ctx.slug);
  } catch (e) {
    ctx.trace.event(ctx.slug, "error", { where: "question", error: errorText(e) });
  }
}
