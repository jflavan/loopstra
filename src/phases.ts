import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SLUG, limitOf, MIN_SESSION_USD, roomBeside, staleBefore, startOfToday } from "./budget";
import { runPhase, unavailable, type FailureReason, type PermissionMode } from "./claude";
import { modelFor, type Config, type ModelRef } from "./config";
import { badModelNote, STEP_KEYS, stepModel, type StepKey } from "./models";
import { BUILTIN_AGENTS, isEmptySetup, resolveSetup, setupLines, type AgentSetup } from "./agents";
import { findAgent, setupSession, userHome, type AgentDefinition, type Where } from "./agent-files";
import type { Trace } from "./trace";
import { GitTimeout } from "./git";
import { acceptanceFiles, CRASH_NOTE, TIMEOUT_NOTE, type StepContext } from "./context";
import { Envelopes, jsonSchemaFor, type Envelope, type PhaseName } from "./envelopes";
import { promptPath, renderPrompt, type PromptVars } from "./prompts";
import { standardsBlock } from "./standards-prompt";
import { issuesText, tracedSession } from "./sessions";
import { commandTimeoutMs, errorText, runCommand, type CommandResult } from "./shell";
import { clearPause } from "./heartbeat";
import { assertNoCheckoutLock, assertNoLock } from "./lanes";
import { changeEnv } from "./resources";
import { AssistantUnavailable, Cancelled, endsStepQuietly, LoopBudgetReached, QuestionAsked, SessionStopped, StopRequested, throwIfCancelled, throwIfStopping } from "./stop";
import { answerFor, answerPrompt, askedAt, closeQuestion, MAX_QUESTIONS, NO_MORE_QUESTIONS, questionIn, recordQuestion, TOO_MANY_NOTE, type Question } from "./questions";
import { readConversation } from "./conversation";
import { hookSettings } from "./package";
import { fromMain, mainProjectAt } from "./main-project";
import { steerable } from "./console/steerable";
import { deliverInbox } from "./steering";
import { changeStoppedBy } from "./inbox";
import { toolTarget } from "./tools";

/**
 * read: look only. read+git: look, plus read-only git (the reviewer). read+commands: look, the
 * configured project commands except install, and read-only git (verify, done-check). build:
 * `claude.allowed_tools` plus every configured project command, install included.
 */
type ToolSet = "read" | "read+git" | "read+commands" | "build";

/** The tool sets whose sessions may run the project's commands. */
const RUNS_COMMANDS: ReadonlySet<ToolSet> = new Set(["read+commands", "build"]);

export interface AgentPhaseSpec {
  name: PhaseName;
  /** Name used in the trace and the phase directory. Defaults to `name` (e.g. fix-1 for the fix phase). */
  traceName?: string;
  /** Runs on this named model instead of the step's (see phaseModel); only the cheaper judge sets it. */
  model?: ModelRef;
  permissionMode: PermissionMode;
  tools: ToolSet;
  vars: PromptVars;
  /** Run in this directory (the worktree for build phases). Defaults to the step's snapshot of main (see StepContext.snapshot). */
  cwd?: string;
  /** Resume this session id. */
  resume?: string;
  /** Extra environment for the claude process (e.g. LOOPSTRA_PHASE=fix). */
  env?: Record<string, string>;
  /** Names of skills to mention at the top of the prompt. */
  skills?: string[];
  /** false: a timeout or crash is not tried again (the cheaper judge: the strong judge stands behind it). Default true. */
  retry?: boolean;
  /** false: getting through does not end an outage pause, since another model may still be out (the cheaper judge). Default true. */
  endsPause?: boolean;
}

export type AgentPhaseResult<N extends PhaseName> =
  /** `model`: the CLI model the session ran on, as read when it started (see phaseModel). */
  | { ok: true; envelope: Envelope<N>; sessionId: string | null; costUsd: number; model: string; seq?: number }
  | { ok: false; reason: FailureReason; note: string; sessionId: string | null };

const READ_TOOLS = ["Read", "Glob", "Grep"];
/** Git commands that only read, so a judge can see the change it is judging. */
const GIT_READ = ["git diff", "git log", "git show", "git status"].map((c) => `Bash(${c} *)`);
/** Removed from read-only sessions outright (a bare name in --disallowedTools removes the tool). */
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];
/**
 * Removed from every session: on Windows the CLI also offers a PowerShell tool, which the Bash(...)
 * allow rules do not cover. Without it the agent uses Bash, where the rules apply.
 */
const NO_POWERSHELL = ["PowerShell"];

/**
 * The parts of a chained command (`a && b || c; d`), split outside quotes. A command without a
 * chain operator is its own single part. Pipes are not split: a pipe's right side (`| tee out.log`)
 * would let judges, which are read-only, write files.
 */
function commandParts(cmd: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const op = ["&&", "||", ";"].find((o) => cmd.startsWith(o, i));
    if (!op) continue;
    parts.push(cmd.slice(start, i));
    i += op.length - 1;
    start = i + 1;
  }
  parts.push(cmd.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p);
}

/**
 * Tools a session may use without asking: the set's own, then the step's setup's `tools`, then its
 * `mcp_tools` (see stepSetup), each once. Always a fresh array.
 */
export function toolsFor(ctx: StepContext, set: ToolSet, setup?: AgentSetup): string[] {
  return [...new Set([...setTools(ctx, set), ...(setup?.tools ?? []), ...(setup?.mcpTools ?? [])])];
}

/** The tool set's own tools, before the setup's. */
function setTools(ctx: StepContext, set: ToolSet): string[] {
  if (set === "read") return [...READ_TOOLS];
  if (set === "read+git") return [...READ_TOOLS, ...GIT_READ];
  const { test, lint, build, run, install } = ctx.cfg.commands;
  // `Bash(<cmd> *)` matches the command alone and with arguments. Claude Code checks each part of
  // `a && b` against the rules on its own, so a chained command also allows each of its parts.
  const rules = (cmds: Array<string | undefined>) =>
    cmds.filter((c): c is string => !!c).flatMap((c) => [...new Set([c, ...commandParts(c)])]).map((c) => `Bash(${c} *)`);
  // A build session runs the project's own commands (tests, install) whatever the allow list says.
  if (set === "build") return [...ctx.cfg.claude.allowed_tools, ...rules([test, lint, build, run, install])];
  // The install command is not for judges.
  return [...READ_TOOLS, ...rules([test, lint, build, run]), ...GIT_READ];
}

/**
 * The shell commands a tool set, and the step's setup (see toolsFor), let a session run, for the
 * prompt's `{{commands}}`: "`bun test`, `git diff`" (each with any arguments), "any command" for a
 * bare Bash rule, "none" without Bash.
 */
export function commandsFor(ctx: StepContext, set: ToolSet, setup?: AgentSetup): string {
  const tools = toolsFor(ctx, set, setup);
  if (tools.includes("Bash")) return "any command";
  const cmds = tools.map((t) => /^Bash\((.+?)(?: \*|:\*)?\)$/.exec(t)?.[1]).filter((c): c is string => !!c);
  return cmds.length ? [...new Set(cmds)].map((c) => `\`${c}\``).join(", ") : "none";
}

/** Every prompt ends with these two lines. agentPhase appends them, so a template need not. */
export const CONTRACT_LINES = [
  "Set `status` to fail only if you could not do the task at all; a negative judgement (not approved, criteria unmet) is still status success.",
  "Respond only through the structured output.",
] as const;

/**
 * The rendered prompt with the contract lines at the end. A prompt that already ends with them
 * (a copy stamped by an older `loopstra init`) loses that copy first, so they never appear twice.
 */
export function withContract(rendered: string): string {
  const lines = rendered.trimEnd().split("\n");
  for (const line of [...CONTRACT_LINES].reverse()) {
    while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
    if (lines.at(-1)?.trim() === line) lines.pop();
  }
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
  return `${lines.join("\n")}\n\n${CONTRACT_LINES.join("\n\n")}\n`;
}

/** Tools a session must not have. Read-only sessions lose every file-writing tool; no session has PowerShell. */
export function disallowedFor(set: ToolSet): string[] {
  return set === "build" ? [...NO_POWERSHELL] : [...WRITE_TOOLS, ...NO_POWERSHELL];
}

/** Failures that block the change; an unavailable assistant pauses the loop instead (see unavailable). */
type BlockingReason = Exclude<FailureReason, "environment" | "not-started">;

/** The owner's note when a session hit its spending limit. */
export const SESSION_LIMIT_NOTE = "This step hit its spending limit (claude.max_budget_usd). An engineer can raise or remove it with `loopstra setup budgets`.";

/** One plain sentence per failure reason, for the owner. The raw detail goes to the trace. */
export function ownerNote(reason: BlockingReason): string {
  switch (reason) {
    case "timeout": return `${TIMEOUT_NOTE} An engineer can allow longer with claude.timeout_minutes in loopstra/config.yaml.`;
    case "budget": return SESSION_LIMIT_NOTE;
    case "crash": return CRASH_NOTE;
    case "no-session": return "The assistant could not pick up its earlier work.";
    case "model": return "Claude Code did not accept this step's model. Change it in Settings or `loopstra setup models`, then retry.";
    case "invalid-envelope": return "The assistant's report could not be read.";
    case "missing-prompt": return "A prompt file for this step is missing.";
    case "setup": return "This step's agent setup is not complete on this machine.";
    // The agent's own summary is not written for the owner; it goes to the trace.
    case "agent-fail": return "The assistant reported it could not finish this step.";
  }
}

/** Failures worth one automatic retry (spec §15). Budget failures are not retried. */
const RETRIED: ReadonlySet<FailureReason> = new Set(["timeout", "crash"]);

/** What heads conversation.md in a work session's prompt (the shipped templates say the same). */
export const CONVERSATION_HEADING = "What people told earlier sessions of this change (conversation.md); take it into account:";

const isStepKey = (name: string): name is StepKey => (STEP_KEYS as readonly string[]).includes(name);

/**
 * The agent setup a phase's session gets (see resolveSetup): its step's, from the agent settings as
 * loopstra/config.yaml has them now (see StepContext.models), with the stage's skills the spec names.
 * A phase that is not a step gets the spec's skills alone.
 */
export async function stepSetup(ctx: StepContext, spec: Pick<AgentPhaseSpec, "name" | "skills">): Promise<AgentSetup> {
  return setupOf(await ctx.models(), spec).setup;
}

/**
 * A phase's setup (see stepSetup), and whether it changes how the session runs. A stage's skills alone
 * do not: they are the prompt's first line, as they always were. Once the step's agent settings give it
 * anything, the stage's skills are checked and loaded with the rest (see setupRun).
 */
function setupOf(cfg: Config, spec: Pick<AgentPhaseSpec, "name" | "skills">): { setup: AgentSetup; applies: boolean } {
  const skills = spec.skills ?? [];
  if (!isStepKey(spec.name)) return { setup: { sources: "all", agent: null, subagents: [], teams: [], skills: [...skills], tools: [], mcpTools: [] }, applies: false };
  const agents = cfg.agents;
  return { setup: resolveSetup(agents, spec.name, skills), applies: !isEmptySetup(resolveSetup(agents, spec.name, [])) };
}

/**
 * Where a step's named agents and skills are looked for: main as the step reads it, then (with
 * `sources: all`) this machine. The repository's agent files are read from the step's commit of main
 * (see StepContext.readCommit), never a checkout: a session that may write the snapshot (an added dir)
 * could otherwise rewrite the agent a later session of the step runs as. Its skills are the snapshot's.
 */
async function setupWhere(ctx: StepContext, setup: AgentSetup): Promise<Where> {
  // Agents come from the commit, so only skills need the snapshot on disk: a writing step that names no
  // skill makes none (its session runs in the change's worktree, and `repo` is then never read).
  const repo = setup.skills.length ? await ctx.snapshot() : ctx.root;
  return { repo, home: userHome(), sources: setup.sources, commit: { git: ctx.git, sha: await ctx.readCommit() } };
}

/** Each subagent's and team member's description, from its file (see setupWhere), for the prompt's lines; null when it has none. */
async function describer(ctx: StepContext, setup: AgentSetup): Promise<(name: string) => string | null> {
  const names = new Set([...setup.subagents, ...setup.teams.flatMap((t) => t.members)].filter((n) => !BUILTIN_AGENTS.has(n)));
  if (!names.size) return () => null;
  const where = await setupWhere(ctx, setup);
  const found = new Map<string, AgentDefinition>();
  for (const name of names) {
    const def = await findAgent(name, where);
    if (def) found.set(name, def);
  }
  return (name) => found.get(name)?.description || null;
}

/** A note a phase's prompt must carry: `text` is added at its end when there is a `note` and the prompt file has no `{{variable}}` to carry it. */
export type PromptNote = { variable: string; note: string; text: string };

/**
 * The prompt a phase would be sent, or null when neither the repository nor the package has its
 * prompt. A work session (see steerable) gets conversation.md as {{conversation}}; a repository's
 * override that leaves that variable out gets the record at its end instead, when there is one.
 * `vars.standards` (see stageStandards) arrives as standardsBlock, the same way: the shipped prompts
 * have no {{standards}}, so with standards it is always added at the end, and without them never.
 * `extra` reaches the prompt the same way (see PromptNote): an override may leave its variable out.
 */
export async function phasePrompt(ctx: StepContext, spec: AgentPhaseSpec, extra?: PromptNote): Promise<string | null> {
  const path = promptPath(ctx.root, spec.name);
  if (path === null) return null;
  // With only skills, or none, this is the skills line prompts always had.
  const cfg = await ctx.models();
  const { setup } = setupOf(cfg, spec);
  const setupText = setupLines(setup, await describer(ctx, setup));
  const record: PromptVars = steerable(spec.name) ? { conversation: readConversation(ctx.root, ctx.slug) } : {};
  const vars: PromptVars = { slug: ctx.slug, main_branch: ctx.cfg.main_branch, commands: commandsFor(ctx, spec.tools, setup), ...record, ...spec.vars };
  // The standards come with what this phase does with them, in place of {{standards}} or at the end.
  // Without standards nothing is added: the prompt is what it was before standards existed.
  const standards = standardsBlock(spec.name, vars.standards ?? "");
  if (standards) vars.standards = standards;
  const template = await Bun.file(path).text();
  let rendered = setupText + renderPrompt(template, vars);
  const said = vars.conversation?.trim() ?? "";
  if (said && !template.includes("{{conversation}}")) rendered = `${rendered.trimEnd()}\n\n${CONVERSATION_HEADING}\n\n${said}\n`;
  if (standards && !template.includes("{{standards}}")) rendered = `${rendered.trimEnd()}\n\n${standards}\n`;
  const contracted = withContract(rendered);
  const prompt = extra?.note && !template.includes(`{{${extra.variable}}}`) ? `${contracted}\n\n${extra.text}\n` : contracted;
  ctx.rememberPrompt(prompt, cfg);
  return prompt;
}

/**
 * A renderer that gives `first` (a prompt the caller rendered already, to match it against work kept
 * from earlier) the first time, and renders afresh with `render` every time after: a retry then has
 * what people told the attempt before it.
 */
export function renderedThen(first: string | null, render: () => Promise<string | null>): () => Promise<string | null> {
  let used = false;
  return async () => {
    if (used) return render();
    used = true;
    return first;
  };
}

/**
 * Runs an agent phase, retried once on a timeout or crash. `render`: the function that renders its
 * prompt, when not phasePrompt. A retry renders its prompt again, so it has what people told the crashed attempt.
 *
 * An asker (see ASKERS) may ask a person a question: it is recorded and QuestionAsked is thrown, so the step
 * ends quietly and the change waits. Once it is answered, the step's first session of the kind of phase that
 * asked resumes the asking session with the answer, when the change has not changed status since (see
 * answerFor; one that cannot be resumed starts fresh with the normal prompt). With MAX_QUESTIONS asked
 * in this stay at the status the prompt says no more may be, and one more fails the phase. Work run alongside never
 * asks: a question fails it, and that work is just not used.
 */
export async function agentPhase<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }, render: () => Promise<string | null> = () => phasePrompt(ctx, spec)): Promise<AgentPhaseResult<N>> {
  const prompt = await render();
  if (prompt === null) {
    ctx.trace.event(ctx.slug, "error", { where: spec.traceName ?? spec.name, reason: "missing-prompt", detail: `the prompt ${spec.name}.md is missing from the repository and the package; reinstall Loopstra` });
    return { ok: false, reason: "missing-prompt", note: `${ownerNote("missing-prompt")} An engineer needs to reinstall Loopstra.`, sessionId: null };
  }

  const traceName = spec.traceName ?? spec.name;
  const here = ASKERS.has(spec.name) && !cancelSignal();
  const atLimit = here && askedAt(ctx) >= MAX_QUESTIONS;
  const ask: AskRule | null = !ASKERS.has(spec.name) ? null : !here ? { refuse: "It asked a question" } : atLimit ? { refuse: TOO_MANY_NOTE } : {};
  const limited = (p: string) => (atLimit ? `${p.trimEnd()}\n\n${NO_MORE_QUESTIONS}\n` : p);
  // One run of the phase on `p`, retried once on a timeout or crash. `normal`: `p` is the phase's own
  // prompt, rendered here; the retry renders it again, so it has what people told the crashed attempt.
  const tries = async (p: string, resume: string | undefined, normal: boolean): Promise<Attempted<N>> => {
    const s = { ...spec, resume };
    const first = await attempt(ctx, s, limited(p), traceName, ask, ctx.renderedWith(p));
    if (first.ok || spec.retry === false || !RETRIED.has(first.reason)) return first;
    ctx.trace.event(ctx.slug, "error", { where: traceName, retry: true, reason: first.reason });
    const again = normal ? ((await render()) ?? p) : p;
    return attempt(ctx, s, limited(again), `${traceName}-retry`, ask, ctx.renderedWith(again));
  };

  let r: Attempted<N>;
  const answered = answerFor(ctx, spec.name, here);
  if (answered) {
    // The answer goes to the session that asked; one that cannot be resumed starts fresh with the normal prompt.
    r = answered.sessionId ? await tries(answerPrompt(answered), answered.sessionId, false) : await tries(prompt, spec.resume, true);
    if (!r.ok && r.reason === "no-session") r = await tries(prompt, undefined, true);
    closeQuestion(ctx.root, ctx.slug, answered);
  } else {
    r = await tries(prompt, spec.resume, true);
  }
  if (!r.ok) return r;
  const { asked, ...ok } = r;
  // Recorded already, as its session ended (see attempt).
  if (asked) throw new QuestionAsked(spec.name, asked.text);
  return ok;
}

/** The phases whose sessions may ask a person a question (see src/questions.ts). */
const ASKERS: ReadonlySet<string> = new Set(["intake", "design", "plan", "build", "revise"]);

/**
 * What a session of an asker does with a question in its report: it is recorded (no `refuse`), or the
 * session fails with `refuse` as its note (work run alongside, or a step that asked the most it may).
 */
type AskRule = { refuse?: string };

/** A successful attempt, with its question when it asked one (recorded already: see attempt). */
type Asking<N extends PhaseName> = Extract<AgentPhaseResult<N>, { ok: true }> & { asked?: Question };
/** One attempt's result (see attempt). */
type Attempted<N extends PhaseName> = Extract<AgentPhaseResult<N>, { ok: false }> | Asking<N>;

/**
 * Two pieces of work running at once (see alongside): the models its sessions got through on, whether
 * it has decided about the pause (both ended), and the group it runs inside of, if any (a judge's
 * shadow inside the early review, or inside spec-check beside the plan written ahead).
 */
interface Group { reached: Set<string>; decided?: boolean; parent?: Group }

/**
 * The group the current call runs in, and the signal that cancels its work (none for the main work
 * of a group that is not itself cancellable). Kept per call chain, not per process: work outside the
 * group (another change's phases) never sees it.
 */
const inGroup = new AsyncLocalStorage<{ group: Group; signal?: AbortSignal }>();

/** What cancels the current call's sessions and commands: set for the extra work of alongside, and for work inside it. */
function cancelSignal(): AbortSignal | undefined {
  return inGroup.getStore()?.signal;
}

/**
 * A session reached the assistant on `model`, so the loop's pause ends unless another model is out;
 * inside a group, alongside decides once both ended. A group that already decided passes it on (a
 * shadow's comparison can end after the work of the group it ran in: see judgeFirst).
 */
function assistantReached(ctx: StepContext, model: string): void {
  let g = inGroup.getStore()?.group;
  while (g?.decided) g = g.parent;
  if (g) g.reached.add(model);
  else clearPause(ctx.root, ctx.slug, new Date(), model); // the assistant is back: the next outage starts the back-off afresh (see clearPause)
}

/**
 * The judges may run alongside each other: speed.overlap_judges is on and the day's budget has room
 * for two sessions, beside one for each other change running a step (see roomBeside).
 */
export function mayOverlap(ctx: StepContext): boolean {
  return ctx.cfg.speed.overlap_judges && roomBeside(ctx.cfg, ctx.trace, ctx.slug, 2);
}

/**
 * Runs `main` and, at the same time, `extra.run`: work that never reads main's result and that main
 * does not need (lessons beside the done-check, round 1's review beside the verifier). Returns both
 * results; extra's is null when it was dropped or cancelled.
 *
 * - Extra work is optional: anything it throws but a stop request or a person's stop of its session
 *   (SessionStopped) is dropped, traced, and never ends the step; main meets the same trouble on its own.
 *   A question it asks is not recorded (see agentPhase), so that work is just not used.
 * - Once main ends, extra is cancelled (its session or command killed) unless `extra.wanted` says
 *   main's result still uses it; also when main throws.
 * - It waits for both, so each phase ends its own row; then it throws a stop request from either (so
 *   the loop stops rather than pauses), else the extra's SessionStopped (the step ends quietly), else main's error.
 * - A session that succeeded inside ends the loop's pause, unless main found the assistant
 *   unavailable: the scheduler then counts that outage on top of the pause before it.
 * - It may run inside another alongside or alongsideFirst (a judge's shadow inside the early review,
 *   or inside spec-check beside the plan written ahead): cancelling the outer extra cancels both, and
 *   a success inside counts for the outer group, which decides about the pause.
 */
export async function alongside<M, E>(ctx: StepContext, main: () => Promise<M>, extra: Extra<M, E>): Promise<[M, E | null]> {
  return startAlongside(ctx, main, extra).both;
}

/** The work run beside main (see alongside): its name in the trace, the work, and whether main's result uses it. */
type Extra<M, E> = { what: string; run: () => Promise<E>; wanted: (m: M) => boolean };

/**
 * alongside, returning as soon as main ends with a result that uses the extra work, so the step can
 * record that result first (spec-check's pass is committed while the plan written beside it still
 * runs, so a stop meanwhile loses only the plan). `rest` then waits for the extra (null when dropped)
 * and throws a stop request that ended it; `cancel` calls it off. A result that does not use the
 * extra, or an error, waits for both as alongside does.
 */
export async function alongsideFirst<M, E>(
  ctx: StepContext, main: () => Promise<M>, extra: Extra<M, E>,
): Promise<{ result: M; rest: () => Promise<E | null>; cancel: () => void }> {
  const s = startAlongside(ctx, main, extra);
  let result: M;
  try {
    result = await s.main;
  } catch (e) {
    await s.both; // throws: a stop request from either, else main's error
    throw e;
  }
  if (!extra.wanted(result)) {
    const [, x] = await s.both;
    return { result, rest: async () => x, cancel: () => {} };
  }
  return { result, rest: () => s.both.then(([, x]) => x), cancel: s.cancel };
}

/** Starts main and the extra work in one group (see alongside). `main` is main's result; `both` ends once both have, with alongside's rules. */
function startAlongside<M, E>(ctx: StepContext, main: () => Promise<M>, extra: Extra<M, E>) {
  // Both pieces would think they hold the lock, so neither would wait for the other.
  assertNoLock(`The ${extra.what} work run alongside`);
  const outer = inGroup.getStore();
  const group: Group = { reached: new Set(), parent: outer?.group };
  const cancel = new AbortController();
  const extraSignal = outer?.signal ? AbortSignal.any([outer.signal, cancel.signal]) : cancel.signal;
  const member = <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => inGroup.run({ group, signal }, fn);
  const mainDone = member(main, outer?.signal).then(
    (m) => { if (!extra.wanted(m)) cancel.abort(); return m; },
    (e: unknown) => { cancel.abort(); throw e; },
  );
  const extraDone = member(extra.run, extraSignal).catch((e: unknown) => {
    if (e instanceof StopRequested || e instanceof SessionStopped) throw e;
    ctx.trace.event(ctx.slug, "command", { command: extra.what, note: e instanceof Cancelled ? e.message : `dropped: ${errorText(e)}` });
    return null;
  });
  const both = Promise.allSettled([mainDone, extraDone]).then(([m, x]): [M, E | null] => {
    // Inside another group this marks that group, which decides about the pause once its work ended.
    if (!(m.status === "rejected" && m.reason instanceof AssistantUnavailable)) for (const model of group.reached) assistantReached(ctx, model);
    group.decided = true;
    const stop = [x, m].find((r) => r.status === "rejected" && r.reason instanceof StopRequested);
    if (stop?.status === "rejected") throw stop.reason;
    if (x.status === "rejected") throw x.reason; // only ever a person's stop of its session
    if (m.status === "rejected") throw m.reason;
    return [m.value, x.value];
  });
  both.catch(() => {}); // awaited by the caller; never an unhandled rejection meanwhile
  return { main: mainDone, both, cancel: () => cancel.abort() };
}

/**
 * Starts a loop phase's row. With claude.max_budget_usd_per_day set, the phase holds what it may
 * spend of what is left of the loop's day (every change together, not chat), and does not start when
 * too little is left. `capUsd` is the session's cap (Infinity: none); `fromDay`: the cap is what was
 * left of the day, less than claude.max_budget_usd (or that is not set), so hitting it is the day's.
 */
function startPhase(ctx: StepContext, traceName: string): { seq: number; capUsd: number; fromDay: boolean } {
  const c = ctx.cfg.claude;
  if (c.max_budget_usd_per_day === undefined) return { seq: ctx.trace.phaseStart(ctx.slug, traceName, "agent"), capUsd: limitOf(c.max_budget_usd), fromDay: false };
  const held = ctx.trace.phaseStartWithin(ctx.slug, traceName, "agent", {
    since: startOfToday(), limitUsd: c.max_budget_usd_per_day, capUsd: limitOf(c.max_budget_usd), floorUsd: MIN_SESSION_USD,
    pool: { except: CHAT_SLUG }, runningSince: staleBefore(ctx.cfg),
  });
  if (!held) throw new LoopBudgetReached();
  return { seq: held.seq, capUsd: held.heldUsd, fromDay: held.heldUsd < limitOf(c.max_budget_usd) };
}

/**
 * The named model a phase's session runs on, and the CLI model it names: the spec's own, else its
 * step's (see stepModel), from the model settings as loopstra/config.yaml has them now (see
 * StepContext.models), or, given the phase's `prompt`, as they were when it was rendered: the
 * settings its session runs on (see StepContext.renderedWith).
 */
export async function phaseModel(ctx: StepContext, spec: Pick<AgentPhaseSpec, "name" | "model">, prompt?: string | null): Promise<{ ref: ModelRef; name: string }> {
  return modelOf((prompt ? ctx.renderedWith(prompt) : undefined) ?? await ctx.models(), spec);
}

/** phaseModel's answer from a config already read. */
function modelOf(cfg: Config, spec: Pick<AgentPhaseSpec, "name" | "model">): { ref: ModelRef; name: string } {
  const ref = spec.model ?? stepModel(cfg, spec.name);
  return { ref, name: modelFor(cfg, ref) };
}

/** The error on a phase row a stop request interrupted, and the note of the step's `stop` event. */
export const STOPPED_NOTE = "stopped by request; the step resumes on the next start";

/**
 * One traced run of a phase (see tracedSession). In the spec's `cwd`, or else the step's snapshot of
 * main, made the first time a session of the step asks. Never under a checkout lock: a session takes
 * minutes, and every record, sync and merge would wait for it (under the merge lock is fine: the
 * merge checks run fix sessions).
 */
async function attempt<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }, prompt: string, traceName: string, ask: AskRule | null, rendered: Config | undefined): Promise<Attempted<N>> {
  assertNoCheckoutLock(`The ${traceName} session`);
  throwIfStopping();
  const signal = cancelSignal();
  throwIfCancelled(signal);
  throwIfChangeStopped(ctx);
  const cwd = spec.cwd ?? (await ctx.snapshot());
  // Read once, as the prompt was rendered (`rendered`), else now: a model or agent setting a person
  // changed since the step began applies from here, and the prompt and the session agree on it.
  const cfg = rendered ?? await ctx.models();
  const model = modelOf(cfg, spec);
  const { setup, applies } = setupOf(cfg, spec);
  const extra = applies ? await setupRun(ctx, spec, setup, cwd) : null;
  if (extra && "missing" in extra) {
    ctx.trace.event(ctx.slug, "error", { where: traceName, reason: "setup", detail: extra.missing });
    return { ok: false, reason: "setup", note: `${ownerNote("setup")} ${extra.missing}`, sessionId: null };
  }
  // A session in a branch's files takes Claude Code's project setup from main's commit (see fromMain),
  // in a folder of its own that goes when the session does.
  const made = spec.cwd !== undefined ? await mainProjectAt(ctx.git, ctx.root, await ctx.readCommit()) : null;
  try {
    const main = spec.cwd !== undefined ? fromMain(made?.project ?? null, setup.sources, extra?.run.settings ?? hookSettings()) : null;
    const { seq, capUsd, fromDay } = startPhase(ctx, traceName);
    if (extra) {
      ctx.trace.event(ctx.slug, "agent_setup", {
        agent: setup.agent, subagents: setup.subagents, teams: setup.teams.map((t) => t.name),
        team_members: Object.fromEntries(setup.teams.map((t) => [t.name, t.members])), skills: setup.skills,
        tools: setup.tools, mcp_tools: setup.mcpTools, sources: setup.sources, models: extra.models,
      }, seq);
    }
    const dir = join(ctx.runDir, "phases", `${seq}-${traceName}`);
    // The protect-tests hook writes here the test files it refused to let a session edit.
    const protectedLog = join(dir, "protected-tests.txt");
    // The session's question, when it asked one (see agentPhase); `refused`: the note when it may not ask.
    let asked: Question | null = null;
    let refused: string | null = null;
    const out = await tracedSession({
      trace: ctx.trace, slug: ctx.slug, seq, dir, capUsd, stoppedNote: STOPPED_NOTE, ref: model.ref,
      run: {
        cwd,
        prompt,
        schema: jsonSchemaFor(spec.name),
        model: model.name,
        permissionMode: spec.permissionMode,
        allowedTools: toolsFor(ctx, spec.tools, setup),
        // With the setup's and main's: no edits in main's snapshot when the session may read it as an added dir.
        disallowedTools: [...new Set([...disallowedFor(spec.tools), ...(extra?.deny ?? []), ...(main?.deny ?? [])])],
        // The test-protection hook, from the installed package; it acts only in sessions that write (see the hook).
        settings: hookSettings(),
        // The step's agent setup (see setupRun), which may also replace the settings.
        ...extra?.run,
        // Main's project setup, its settings with the setup's (see fromMain); main's snapshot is the setup's added dir too.
        ...main?.run,
        timeoutMs: ctx.cfg.claude.timeout_minutes * 60_000,
        maxBudgetUsd: capUsd,
        resume: spec.resume,
        // A session that may run the project's commands gets the change's slot, temp folder and ports, as its commands do.
        // LOOPSTRA_ACCEPTANCE: the tests written from Done when, which the hook keeps the build's sessions from editing.
        env: {
          LOOPSTRA_PHASE: spec.name, LOOPSTRA_SLUG: ctx.slug, LOOPSTRA_BASE: ctx.cfg.main_branch, LOOPSTRA_PROTECTED_LOG: protectedLog,
          LOOPSTRA_ACCEPTANCE: JSON.stringify(acceptanceFiles(ctx)),
          ...(RUNS_COMMANDS.has(spec.tools) ? await changeEnv(ctx) : {}), ...main?.env, ...(spec.env ?? {}),
        },
        signal,
        // Live: what people send this session while it runs reaches it (see src/steering.ts).
        live: { attach: (ctl) => deliverInbox(ctx, seq, spec.name, ctl) },
      },
      onEvent: (e) => { if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e, cwd), seq); },
      read: (output) => {
        const parsed = Envelopes[spec.name].safeParse(output);
        if (!parsed.success) return { ok: false, reason: "invalid-envelope", detail: issuesText(parsed.error.issues) };
        const envelope = parsed.data as Envelope<N>;
        if (envelope.status === "fail") return { ok: false, reason: "agent-fail", detail: envelope.summary };
        const q = ask ? questionIn(envelope) : null;
        if (!q) return { ok: true, value: envelope };
        if (ask?.refuse) {
          refused = ask.refuse;
          return { ok: false, reason: "agent-fail", detail: `${ask.refuse}: ${q.text}` };
        }
        asked = q;
        return { ok: true, value: envelope, endAs: "asked", note: q.text };
      },
      // Not this phase's failure: it is interrupted, and the scheduler pauses the loop (an unavailable
      // assistant), or the step resumes once there is budget again (the loop's day, not its own limit).
      interrupt: (r) => unavailable(r.reason)
        ? { error: new AssistantUnavailable(r.detail, { phase: spec.name, line: r.matched ?? r.detail, model: model.name }), note: `${r.reason}: ${r.detail}` }
        : r.reason === "budget" && fromDay ? { error: new LoopBudgetReached(), note: "budget: the loop's daily budget ran out during this session" } : null,
    });
    // A question the session asked is recorded first, so a stop of the change meanwhile never loses it:
    // its row already ended asked (see tracedSession).
    const question = out.ok ? (asked as Question | null) : null;
    if (question) await recordQuestion(ctx, { phase: spec.name, traceName, seq, sessionId: out.sessionId, ...question });
    // A person stopped the change while this session ran: the step ends here, whatever the session did.
    throwIfChangeStopped(ctx);
    if (!out.ok) {
      if (refused !== null && out.reason === "agent-fail") return { ok: false, reason: "agent-fail", note: refused, sessionId: out.sessionId };
      const reason = out.reason as BlockingReason;
      // The step's own words: which named model, which CLI name, which step.
      if (reason === "model") return { ok: false, reason, note: badModelNote(model.ref, model.name, spec.name), sessionId: out.sessionId };
      // What the session did not load, in the init check's words (see initProblem).
      if (reason === "setup") return { ok: false, reason, note: `${ownerNote(reason)} ${out.detail}`, sessionId: out.sessionId };
      const tests = protectedTests(protectedLog);
      return { ok: false, reason, note: tests.length ? `${ownerNote(reason)} ${protectedNote(ctx, tests)}` : ownerNote(reason), sessionId: out.sessionId };
    }
    if (spec.endsPause !== false) assistantReached(ctx, model.name);
    return { ok: true, envelope: out.value, sessionId: out.sessionId, costUsd: out.costUsd, model: model.name, seq, ...(question ? { asked: question } : {}) };
  } finally {
    made?.remove();
  }
}

/**
 * What a session's run gets from its step's setup when that is not empty, and the models of its
 * inline agents for the trace; `missing`, instead, when an agent it names is not found.
 * - `tools` and `mcp_tools` go on the allow list (see toolsFor).
 * - Every agent it names is read from main (see setupWhere), never the change's branch; the rest is
 *   setupSession's: inline agents, `--agent`, settings sources, `--add-dir` (and the rules that keep the
 *   session from editing it), subagent text, the init check.
 */
async function setupRun(ctx: StepContext, spec: AgentPhaseSpec, setup: AgentSetup, cwd: string): ReturnType<typeof setupSession> {
  return setupSession(setup, spec.name, ctx.cfg.main_branch, cwd, JSON.parse(hookSettings()) as Record<string, unknown>, () => setupWhere(ctx, setup));
}

/**
 * Throws SessionStopped when a person stopped the change (see writeChangeStop in src/inbox.ts): checked
 * before each phase starts and once it ends, so a stop ends the step whichever phase it came in.
 */
function throwIfChangeStopped(ctx: StepContext): void {
  const by = changeStoppedBy(ctx.root, ctx.slug);
  if (by !== null) throw new SessionStopped(by);
}

/** The test files the protect-tests hook refused during a phase, once each, in the order refused. */
function protectedTests(log: string): string[] {
  try {
    return [...new Set(readFileSync(log, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** A path as the hook compares it: forward slashes, and without case where the file system ignores it. */
function samePath(p: string): string {
  const s = p.replace(/\\/g, "/");
  return process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s;
}

/**
 * Names the protected test files a failed session wanted to edit, so a person can make the edit instead
 * of a rebuild: tests written from Done when (see ACCEPTANCE in context.ts), and tests a fix may not change.
 */
function protectedNote(ctx: StepContext, files: string[]): string {
  const list = (fs: string[]) => fs.map((f) => `\`${f}\``).join(", ");
  const accepted = new Set(acceptanceFiles(ctx).map(samePath));
  const fromDoneWhen = files.filter((f) => accepted.has(samePath(f)));
  const others = files.filter((f) => !accepted.has(samePath(f)));
  const said: string[] = [];
  if (others.length) said.push(`It was not allowed to edit ${others.length === 1 ? "this test file" : "these test files"}, which this branch did not add or edit: ${list(others)}.`);
  if (fromDoneWhen.length) said.push(`It was not allowed to edit ${fromDoneWhen.length === 1 ? "the acceptance test" : "the acceptance tests"} ${list(fromDoneWhen)}, written from Done when before the build.`);
  return `${said.join(" ")} If the test is wrong, an engineer can fix it on the branch ${ctx.branch}.`;
}

const PROBE_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const PROBE_PROMPT = "This is only a check that you can be reached. Do not use any tools. Answer with ok set to true.";
/** At most this long, and never longer than a phase may take. */
const PROBE_TIMEOUT_MS = 2 * 60_000;
/** What a probe may spend: on the cheap model, and on any other (a stronger model's first answer costs more). */
const PROBE_CAP_CHEAP_USD = 0.05;
const PROBE_CAP_USD = 0.25;

/**
 * One tiny session (no tools, a trivial prompt) to tell an outage from a phase that keeps failing with
 * words that look like one. On `model`, the one that failed (the cheap model when unknown), at
 * $0.05 on the cheap model and $0.25 on another. Traced as a `probe` phase of the change.
 * `reached`: the assistant answered (going over the cap counts: it answered); otherwise `detail` says why not.
 */
export async function probeAssistant(root: string, cfg: Config, trace: Trace, slug: string, model: string = modelFor(cfg, "cheap")): Promise<{ reached: boolean; detail: string }> {
  const seq = trace.phaseStart(slug, "probe", "agent");
  let r: Awaited<ReturnType<typeof runPhase>>;
  try {
    r = await runPhase({
      cwd: root, prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, model, permissionMode: "default",
      allowedTools: [], disallowedTools: ["Bash", ...WRITE_TOOLS, ...NO_POWERSHELL],
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, cfg.claude.timeout_minutes * 60_000),
      maxBudgetUsd: model === modelFor(cfg, "cheap") ? PROBE_CAP_CHEAP_USD : PROBE_CAP_USD,
      env: { LOOPSTRA_PHASE: "probe", LOOPSTRA_SLUG: slug },
    });
  } catch (e) {
    trace.phaseEnd(slug, seq, { status: e instanceof StopRequested ? "interrupted" : "fail", error: errorText(e) });
    throw e;
  }
  const overCap = !r.ok && r.reason === "budget";
  const reached = overCap || (r.ok && (r.structuredOutput as { ok?: unknown } | undefined)?.ok === true);
  const detail = overCap ? "the assistant answered the probe (over its cap)" : reached ? "the assistant answered the probe" : r.ok ? "the probe's answer was not ok: true" : `${r.reason}: ${r.detail}`;
  trace.phaseEnd(slug, seq, { status: reached ? "success" : "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: reached ? undefined : detail });
  return { reached, detail };
}

/** A raw session event, cut down for the trace: tools with their targets, text, the model, the result. */
export function summarize(e: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  if (e.type === "assistant") {
    const content = (e as { message?: { content?: Array<{ type: string; name?: string; text?: string; input?: unknown }> } }).message?.content ?? [];
    return {
      type: "assistant",
      items: content.map((c) => c.type === "tool_use" ? `tool:${c.name ?? "?"}` : c.type === "text" ? `text:${(c.text ?? "").slice(0, 120)}` : c.type),
      targets: content.map((c) => c.type === "tool_use" ? toolTarget(c.name ?? "", c.input, cwd) : ""),
    };
  }
  if (e.type === "result") return { type: "result", subtype: e.subtype, cost: e.total_cost_usd };
  if (e.type === "system" && e.subtype === "init") return { type: "system", subtype: "init", model: typeof e.model === "string" ? e.model : null };
  return { type: e.type, subtype: e.subtype };
}

/**
 * Runs a configured project command in `cwd` with the configured time limit, and traces it as a
 * `command` event of `on.slug` (under phase `seq` when given). `env` defaults to LOOPSTRA_SLUG and
 * the change's own resources (see changeEnv).
 * `signal` cancels it (Cancelled is thrown); it defaults to the one for work run alongside.
 */
export async function projectCommand(
  on: { root: string; trace: Trace; cfg: Config; slug: string }, command: string, cwd: string,
  opts: { env?: Record<string, string>; seq?: number; where?: string; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const where = opts.where ? { where: opts.where } : {};
  let r: CommandResult;
  try {
    r = await runCommand(command, cwd, { env: opts.env ?? { LOOPSTRA_SLUG: on.slug, ...(await changeEnv(on)) }, timeoutMs: commandTimeoutMs(on.cfg), signal: opts.signal ?? cancelSignal() });
  } catch (e) {
    if (e instanceof Cancelled) on.trace.event(on.slug, "command", { command, note: e.message, ...where }, opts.seq);
    throw e;
  }
  on.trace.event(on.slug, "command", { command, code: r.code, lastLine: r.lastLine, durationMs: r.durationMs, ...where }, opts.seq);
  return r;
}

/** `detail`: what went wrong, for the trace (the caller words the owner's note). */
type CodePhaseResult<T> = ({ ok: true } & T) | { ok: false; detail: string };

/**
 * Runs deterministic work as a traced phase. Exceptions become a failed phase, never a crash; a stop
 * request (or a cancel, or a session inside that a person stopped or that asked a question) is marked
 * interrupted and passed on. A change a person stopped (see throwIfChangeStopped) does not start it,
 * and once it ended, success or failure, ends the step.
 */
export async function codePhase<T extends object>(ctx: StepContext, name: string, fn: (seq: number) => Promise<{ ok: true } & T>): Promise<CodePhaseResult<T>> {
  throwIfChangeStopped(ctx);
  const seq = ctx.trace.phaseStart(ctx.slug, name, "code");
  let r: { ok: true } & T;
  try {
    r = await fn(seq);
  } catch (e) {
    if (e instanceof StopRequested || e instanceof Cancelled || endsStepQuietly(e)) {
      ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", error: e instanceof StopRequested ? STOPPED_NOTE : e.message });
      throw e;
    }
    const msg = errorText(e);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: msg });
    // A hung git command is reported the same way wherever it happens (see the scheduler).
    if (e instanceof GitTimeout) throw e;
    throwIfChangeStopped(ctx);
    return { ok: false, detail: `The ${name} step failed: ${msg.split("\n")[0] ?? msg}` };
  }
  ctx.trace.phaseEnd(ctx.slug, seq, { status: "success" });
  throwIfChangeStopped(ctx);
  return r;
}
