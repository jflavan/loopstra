import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SLUG, limitOf, MIN_SESSION_USD, roomBeside, sessionCost, staleBefore, startOfToday } from "./budget";
import { runPhase, unavailable, type FailureReason, type PermissionMode } from "./claude";
import { modelFor, type Config } from "./config";
import type { Trace } from "./trace";
import { GitTimeout } from "./git";
import { CRASH_NOTE, TIMEOUT_NOTE, type StepContext } from "./context";
import { Envelopes, jsonSchemaFor, type Envelope, type PhaseName } from "./envelopes";
import { renderPrompt, type PromptVars } from "./prompts";
import { commandTimeoutMs, errorText, runCommand, type CommandResult } from "./shell";
import { clearPause } from "./heartbeat";
import { assertNoLock, assertNoMainLock, holdsLock } from "./lanes";
import { AssistantUnavailable, Cancelled, LoopBudgetReached, notTheStepsFault, StopRequested, throwIfCancelled, throwIfStopping } from "./stop";

/**
 * read: look only. read+git: look, plus read-only git (the reviewer). read+commands: look, the
 * configured project commands except install, and read-only git (verify, done-check). build:
 * `claude.allowed_tools` plus every configured project command, install included.
 */
export type ToolSet = "read" | "read+git" | "read+commands" | "build";

export interface AgentPhaseSpec {
  name: PhaseName;
  /** Name used in the trace and the phase directory. Defaults to `name` (e.g. fix-1 for the fix phase). */
  traceName?: string;
  model: "default" | "cheap" | "strong";
  permissionMode: PermissionMode;
  tools: ToolSet;
  vars: PromptVars;
  /** Run in this directory (the worktree for build phases). Defaults to the repo root. */
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
  | { ok: true; envelope: Envelope<N>; sessionId: string | null; costUsd: number }
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
export function commandParts(cmd: string): string[] {
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

/** Tools a session may use without asking. Always a fresh array. */
export function toolsFor(ctx: StepContext, set: ToolSet): string[] {
  if (set === "read") return [...READ_TOOLS];
  if (set === "read+git") return [...READ_TOOLS, ...GIT_READ];
  const { test, lint, build, run, install } = ctx.cfg.commands;
  // `Bash(<cmd> *)` matches the command alone and with arguments. Claude Code checks each part of
  // `a && b` against the rules on its own, so a chained command also allows each of its parts.
  const rules = (cmds: Array<string | undefined>) =>
    cmds.filter((c): c is string => !!c).flatMap((c) => [...new Set([c, ...commandParts(c)])]).map((c) => `Bash(${c} *)`);
  // A build session runs the project's own commands (tests, install) whatever the allow list says.
  if (set === "build") return [...new Set([...ctx.cfg.claude.allowed_tools, ...rules([test, lint, build, run, install])])];
  // The install command is not for judges.
  return [...new Set([...READ_TOOLS, ...rules([test, lint, build, run]), ...GIT_READ])];
}

/**
 * The shell commands a tool set lets a session run, for the prompt's `{{commands}}`: "`bun test`,
 * `git diff`" (each with any arguments), "any command" for a bare Bash rule, "none" without Bash.
 */
export function commandsFor(ctx: StepContext, set: ToolSet): string {
  const tools = toolsFor(ctx, set);
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

/** One plain sentence per failure reason, for the owner. The raw detail goes to the trace. */
export function ownerNote(reason: BlockingReason): string {
  switch (reason) {
    case "timeout": return `${TIMEOUT_NOTE} An engineer can allow longer with claude.timeout_minutes in loopstra/config.yaml.`;
    case "budget": return "This step hit its spending limit (claude.max_budget_usd). An engineer can raise or remove it with `loopstra setup budgets`.";
    case "crash": return CRASH_NOTE;
    case "no-session": return "The assistant could not pick up its earlier work.";
    case "invalid-envelope": return "The assistant's report could not be read.";
    case "missing-prompt": return "A prompt file for this step is missing.";
    // The agent's own summary is not written for the owner; it goes to the trace.
    case "agent-fail": return "The assistant reported it could not finish this step.";
  }
}

/** Failures worth one automatic retry (spec §15). Budget failures are not retried. */
const RETRIED: ReadonlySet<FailureReason> = new Set(["timeout", "crash"]);

/** The prompt a phase would be sent, or null when its prompt file is missing. */
export async function phasePrompt(ctx: StepContext, spec: AgentPhaseSpec): Promise<string | null> {
  const promptPath = join(ctx.root, "loopstra", "prompts", `${spec.name}.md`);
  if (!existsSync(promptPath)) return null;
  const skillsLine = (spec.skills ?? []).length ? `Use these skills: ${(spec.skills ?? []).map((s) => `\`${s}\``).join(", ")}.\n\n` : "";
  const vars = { slug: ctx.slug, main_branch: ctx.cfg.main_branch, commands: commandsFor(ctx, spec.tools), ...spec.vars };
  return withContract(skillsLine + renderPrompt(await Bun.file(promptPath).text(), vars));
}

/** Runs an agent phase, retried once on a timeout or crash. `rendered`: its phasePrompt, when the caller already has it. */
export async function agentPhase<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }, rendered?: string | null): Promise<AgentPhaseResult<N>> {
  const prompt = rendered === undefined ? await phasePrompt(ctx, spec) : rendered;
  if (prompt === null) {
    ctx.trace.event(ctx.slug, "error", { where: spec.traceName ?? spec.name, reason: "missing-prompt", detail: `loopstra/prompts/${spec.name}.md is missing; \`loopstra init\` restores it` });
    return { ok: false, reason: "missing-prompt", note: `${ownerNote("missing-prompt")} An engineer needs to restore it.`, sessionId: null };
  }

  const traceName = spec.traceName ?? spec.name;
  const first = await attempt(ctx, spec, prompt, traceName);
  if (first.ok || spec.retry === false || !RETRIED.has(first.reason)) return first;
  ctx.trace.event(ctx.slug, "error", { where: traceName, retry: true, reason: first.reason });
  return attempt(ctx, spec, prompt, `${traceName}-retry`);
}

/** Run before every phase (agent or code); the scheduler sets it for the duration of a tick. */
type PhaseBoundary = (ctx: StepContext) => Promise<void>;
let phaseBoundary: PhaseBoundary | null = null;

/**
 * Sets (or with null clears) what runs before each phase of a step: the scheduler uses it to merge
 * other changes whose pull requests became ready while this step runs (see the scheduler).
 */
export function setPhaseBoundary(fn: PhaseBoundary | null): void {
  phaseBoundary = fn;
}

/**
 * Two pieces of work running at once (see alongside): how many still run, whether a session in them
 * succeeded, whether it has decided about the pause (both ended), and the group it runs inside of, if
 * any (a judge's shadow inside the early review, or inside spec-check beside the plan written ahead).
 */
interface Group { running: number; succeeded: boolean; decided?: boolean; parent?: Group }

/**
 * The group the current call runs in, and the signal that cancels its work (none for the main work
 * of a group that is not itself cancellable). Kept per call chain, not per process: work outside the
 * group (another change's phases) never sees it.
 */
const inGroup = new AsyncLocalStorage<{ group: Group; signal?: AbortSignal }>();

/** Other work still runs beside this call, in its own group or in one it runs inside of. */
function othersRunning(g: Group | undefined): boolean {
  for (; g; g = g.parent) if (g.running > 1) return true;
  return false;
}

/** The time the phase boundary took inside a call that `ownTime` measures. */
const boundaryClock = new AsyncLocalStorage<{ ms: number }>();

/**
 * Runs the phase boundary, except while other work runs beside this call, or while the step holds the
 * merge lock or a main lock: a merge started there could wait on the lock this step holds while this
 * step waits for it. Every phase runs it first; a step runs it itself before deciding something on
 * main's code (see takePlanAhead).
 */
export async function boundary(ctx: StepContext): Promise<void> {
  if (!phaseBoundary || othersRunning(inGroup.getStore()?.group) || holdsLock()) return;
  const started = Date.now();
  try {
    await phaseBoundary(ctx);
  } finally {
    const clock = boundaryClock.getStore();
    if (clock) clock.ms += Date.now() - started;
  }
}

/**
 * Runs `fn` and says how long it took, less the phase boundary run inside it (merging other changes
 * whose pull requests became ready), so a session's time is its own (the cheaper judges' report).
 */
export async function ownTime<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const clock = { ms: 0 };
  const started = Date.now();
  const value = await boundaryClock.run(clock, fn);
  return { value, ms: Date.now() - started - clock.ms };
}

/** What cancels the current call's sessions and commands: set for the extra work of alongside, and for work inside it. */
function cancelSignal(): AbortSignal | undefined {
  return inGroup.getStore()?.signal;
}

/**
 * A session reached the assistant, so the loop's pause ends; inside a group, alongside decides once
 * both ended. A group that already decided passes it on (a shadow's comparison can end after the work
 * of the group it ran in: see judgeFirst).
 */
function assistantReached(ctx: StepContext): void {
  let g = inGroup.getStore()?.group;
  while (g?.decided) g = g.parent;
  if (g) g.succeeded = true;
  else clearPause(ctx.root, ctx.slug); // the assistant is back: the next outage starts the back-off afresh (see clearPause)
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
 * - The phase boundary (the between-phases merge) runs once, before them, and inside only for a phase
 *   that starts after the other work ended, so no merge touches main while two phases run.
 * - Extra work is optional: anything it throws but a stop request is dropped, traced, and never ends
 *   the step; main meets the same trouble on its own.
 * - Once main ends, extra is cancelled (its session or command killed) unless `extra.wanted` says
 *   main's result still uses it; also when main throws.
 * - It waits for both, so each phase ends its own row; then it throws a stop request from either (so
 *   the loop stops rather than pauses), else main's error.
 * - A session that succeeded inside ends the loop's pause, unless main found the assistant
 *   unavailable: the scheduler then counts that outage on top of the pause before it.
 * - It may run inside another alongside or alongsideFirst (a judge's shadow inside the early review,
 *   or inside spec-check beside the plan written ahead): no boundary runs while the outer work runs,
 *   cancelling the outer extra cancels both, and a success inside counts for the outer group, which
 *   decides about the pause.
 */
export async function alongside<M, E>(ctx: StepContext, main: () => Promise<M>, extra: Extra<M, E>): Promise<[M, E | null]> {
  return (await startAlongside(ctx, main, extra, false)).both;
}

/** The work run beside main (see alongside): its name in the trace, the work, and whether main's result uses it. */
type Extra<M, E> = { what: string; run: () => Promise<E>; wanted: (m: M) => boolean };

/**
 * alongside, returning as soon as main ends with a result that uses the extra work, so the step can
 * record that result first (spec-check's pass is committed while the plan written beside it still
 * runs, so a stop meanwhile loses only the plan). `rest` then waits for the extra (null when dropped)
 * and throws a stop request that ended it; `cancel` calls it off. Until `rest` is called, the group
 * still counts main as running, so no phase boundary (a merge) runs in the extra while the step works
 * on main: the caller calls `rest` before any other phase. A result that does not use the extra, or an
 * error, waits for both as alongside does.
 */
export async function alongsideFirst<M, E>(
  ctx: StepContext, main: () => Promise<M>, extra: Extra<M, E>,
): Promise<{ result: M; rest: () => Promise<E | null>; cancel: () => void }> {
  const s = await startAlongside(ctx, main, extra, true);
  let result: M;
  try {
    result = await s.main;
  } catch (e) {
    s.release();
    await s.both; // throws: a stop request from either, else main's error
    throw e;
  }
  if (!extra.wanted(result)) {
    s.release();
    const [, x] = await s.both;
    return { result, rest: async () => x, cancel: () => {} };
  }
  return { result, rest: () => { s.release(); return s.both.then(([, x]) => x); }, cancel: s.cancel };
}

/**
 * Starts main and the extra work in one group (see alongside). `main` is main's result; `both` ends
 * once both have, with alongside's rules. With `hold`, main counts as running until `release`.
 */
async function startAlongside<M, E>(ctx: StepContext, main: () => Promise<M>, extra: Extra<M, E>, hold: boolean) {
  // Both pieces would think they hold the lock, so neither would wait for the other.
  assertNoLock(`The ${extra.what} work run alongside`);
  await boundary(ctx);
  const outer = inGroup.getStore();
  const group: Group = { running: 2, succeeded: false, parent: outer?.group };
  const cancel = new AbortController();
  const extraSignal = outer?.signal ? AbortSignal.any([outer.signal, cancel.signal]) : cancel.signal;
  let held = hold;
  const release = () => { if (held) { held = false; group.running--; } };
  const member = <T>(fn: () => Promise<T>, signal?: AbortSignal, holds = false): Promise<T> =>
    inGroup.run({ group, signal }, async () => { try { return await fn(); } finally { if (!holds) group.running--; } });
  const mainDone = member(main, outer?.signal, hold).then(
    (m) => { if (!extra.wanted(m)) cancel.abort(); return m; },
    (e: unknown) => { cancel.abort(); throw e; },
  );
  const extraDone = member(extra.run, extraSignal).catch((e: unknown) => {
    if (e instanceof StopRequested) throw e;
    ctx.trace.event(ctx.slug, "command", { command: extra.what, note: e instanceof Cancelled ? e.message : `dropped: ${errorText(e)}` });
    return null;
  });
  const both = Promise.allSettled([mainDone, extraDone]).then(([m, x]): [M, E | null] => {
    // Inside another group this marks that group, which decides about the pause once its work ended.
    if (group.succeeded && !(m.status === "rejected" && m.reason instanceof AssistantUnavailable)) assistantReached(ctx);
    group.decided = true;
    if (x.status === "rejected") throw x.reason; // only ever a stop request
    if (m.status === "rejected") throw m.reason;
    return [m.value, x.value];
  });
  both.catch(() => {}); // awaited by the caller; never an unhandled rejection meanwhile
  return { main: mainDone, both, release, cancel: () => cancel.abort() };
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

/** The error on a phase row a stop request interrupted, and the note of the step's `stop` event. */
export const STOPPED_NOTE = "stopped by request; the step resumes on the next start";

/**
 * One traced run of a phase. The phase row always ends (never left running) and the raw log is always
 * closed. Never under a main lock: a session takes minutes, and every other change's git in the main
 * checkout would wait for it (under the merge lock is fine: the merge checks run fix sessions).
 */
async function attempt<N extends PhaseName>(ctx: StepContext, spec: AgentPhaseSpec & { name: N }, prompt: string, traceName: string): Promise<AgentPhaseResult<N>> {
  assertNoMainLock(`The ${traceName} session`);
  await boundary(ctx);
  throwIfStopping();
  const signal = cancelSignal();
  throwIfCancelled(signal);
  const { seq, capUsd, fromDay } = startPhase(ctx, traceName);
  const started = Date.now();
  // Commands the session was not allowed to run: on the phase in the trace, so an engineer can add allow rules.
  let denied: string[] = [];
  const failed = (reason: BlockingReason, detail: string, sessionId: string | null, costUsd = 0): AgentPhaseResult<N> => {
    const refused = denied.length ? `; not allowed: ${denied.join(", ")}` : "";
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", costUsd, sessionId: sessionId ?? undefined, error: `${reason}: ${detail}${refused}`, denied });
    const tests = protectedTests(protectedLog);
    return { ok: false, reason, note: tests.length ? `${ownerNote(reason)} ${protectedNote(ctx, tests)}` : ownerNote(reason), sessionId };
  };
  let raw: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  const dir = join(ctx.runDir, "phases", `${seq}-${traceName}`);
  // The protect-tests hook writes here the test files it refused to let a fix session edit.
  const protectedLog = join(dir, "protected-tests.txt");
  // What the session cost, once it ended (null until then): kept if the phase fails after it.
  let costUsd: number | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "prompt.md"), prompt);
    const writer = Bun.file(join(dir, "raw.jsonl")).writer();
    raw = writer;

    const r = await runPhase({
      cwd: spec.cwd ?? ctx.root,
      prompt,
      schema: jsonSchemaFor(spec.name),
      model: modelFor(ctx.cfg, spec.model),
      permissionMode: spec.permissionMode,
      allowedTools: toolsFor(ctx, spec.tools),
      disallowedTools: disallowedFor(spec.tools),
      timeoutMs: ctx.cfg.claude.timeout_minutes * 60_000,
      maxBudgetUsd: capUsd,
      resume: spec.resume,
      env: { LOOPSTRA_PHASE: spec.name, LOOPSTRA_SLUG: ctx.slug, LOOPSTRA_BASE: ctx.cfg.main_branch, LOOPSTRA_PROTECTED_LOG: protectedLog, ...(spec.env ?? {}) },
      signal,
      onEvent: (e) => {
        writer.write(JSON.stringify(e) + "\n");
        if (e.type !== "system" || e.subtype === "init") ctx.trace.event(ctx.slug, "claude_event", summarize(e), seq);
      },
    });

    denied = r.denied;
    costUsd = sessionCost(r, r.durationMs, capUsd);
    if (!r.ok) {
      if (unavailable(r.reason)) {
        // Not this phase's failure: it is interrupted, and the scheduler pauses the loop.
        ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", costUsd, sessionId: r.sessionId ?? undefined, error: `${r.reason}: ${r.detail}`, denied });
        throw new AssistantUnavailable(r.detail, { phase: spec.name, line: r.matched ?? r.detail });
      }
      if (r.reason === "budget" && fromDay) {
        // The loop's day ran out, not this step's own limit: the loop pauses and the step resumes later.
        ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", costUsd, sessionId: r.sessionId ?? undefined, error: "budget: the loop's daily budget ran out during this session", denied });
        throw new LoopBudgetReached();
      }
      return failed(r.reason, r.detail, r.sessionId, costUsd);
    }
    const parsed = Envelopes[spec.name].safeParse(r.structuredOutput);
    await Bun.write(join(dir, "envelope.json"), JSON.stringify({ valid: parsed.success, output: r.structuredOutput }, null, 2));
    if (!parsed.success) {
      const err = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return failed("invalid-envelope", err, r.sessionId, r.costUsd);
    }
    const envelope = parsed.data as Envelope<N>;
    if (envelope.status === "fail") return failed("agent-fail", envelope.summary, r.sessionId, r.costUsd);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, denied });
    if (spec.endsPause !== false) assistantReached(ctx);
    return { ok: true, envelope, sessionId: r.sessionId, costUsd: r.costUsd };
  } catch (e) {
    if (e instanceof StopRequested || e instanceof Cancelled) {
      // A session the stop (or a cancel) killed never reported its cost.
      const spent = costUsd ?? sessionCost({ costUsd: 0, costReported: false }, Date.now() - started, capUsd);
      ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", costUsd: spent, error: e instanceof Cancelled ? e.message : STOPPED_NOTE });
      throw e;
    }
    // Its phase row is already ended.
    if (notTheStepsFault(e)) throw e;
    return failed("crash", `runtime error: ${errorText(e)}`, null, costUsd ?? 0);
  } finally {
    if (raw) { try { await raw.end(); } catch { /* already closed */ } }
  }
}

/** The test files the protect-tests hook refused during a phase, once each, in the order refused. */
function protectedTests(log: string): string[] {
  try {
    return [...new Set(readFileSync(log, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Names the protected test files a failed fix wanted to edit, so a person can make the edit instead of a rebuild. */
export function protectedNote(ctx: StepContext, files: string[]): string {
  const list = files.map((f) => `\`${f}\``).join(", ");
  return `It was not allowed to edit ${files.length === 1 ? "this test file" : "these test files"}, which this branch did not add or edit: ${list}. If the test is wrong, an engineer can fix it on the branch ${ctx.branch}.`;
}

const PROBE_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const PROBE_PROMPT = "This is only a check that you can be reached. Do not use any tools. Answer with ok set to true.";
/** At most this long, and never longer than a phase may take. */
const PROBE_TIMEOUT_MS = 2 * 60_000;

/**
 * One tiny session (cheap model, $0.05, no tools, a trivial prompt) to tell an outage from a phase
 * that keeps failing with words that look like one. Traced as a `probe` phase of the change.
 * `reached`: the assistant answered; otherwise `detail` says why not.
 */
export async function probeAssistant(root: string, cfg: Config, trace: Trace, slug: string): Promise<{ reached: boolean; detail: string }> {
  const seq = trace.phaseStart(slug, "probe", "agent");
  let r: Awaited<ReturnType<typeof runPhase>>;
  try {
    r = await runPhase({
      cwd: root, prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, model: modelFor(cfg, "cheap"), permissionMode: "default",
      allowedTools: [], disallowedTools: ["Bash", ...WRITE_TOOLS, ...NO_POWERSHELL],
      timeoutMs: Math.min(PROBE_TIMEOUT_MS, cfg.claude.timeout_minutes * 60_000), maxBudgetUsd: 0.05,
      env: { LOOPSTRA_PHASE: "probe", LOOPSTRA_SLUG: slug },
    });
  } catch (e) {
    trace.phaseEnd(slug, seq, { status: e instanceof StopRequested ? "interrupted" : "fail", error: errorText(e) });
    throw e;
  }
  const reached = r.ok && (r.structuredOutput as { ok?: unknown } | undefined)?.ok === true;
  const detail = reached ? "the assistant answered the probe" : r.ok ? "the probe's answer was not ok: true" : `${r.reason}: ${r.detail}`;
  trace.phaseEnd(slug, seq, { status: reached ? "success" : "fail", costUsd: r.costUsd, sessionId: r.sessionId ?? undefined, error: reached ? undefined : detail });
  return { reached, detail };
}

function summarize(e: Record<string, unknown>): Record<string, unknown> {
  if (e.type === "assistant") {
    const content = (e as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content ?? [];
    return { type: "assistant", items: content.map((c) => c.type === "tool_use" ? `tool:${c.name}` : c.type === "text" ? `text:${(c.text ?? "").slice(0, 120)}` : c.type) };
  }
  if (e.type === "result") return { type: "result", subtype: e.subtype, cost: e.total_cost_usd };
  return { type: e.type, subtype: e.subtype };
}

/**
 * Runs a configured project command in `cwd` with the configured time limit, and traces it as a
 * `command` event of `on.slug` (under phase `seq` when given). `env` defaults to LOOPSTRA_SLUG.
 * `signal` cancels it (Cancelled is thrown); it defaults to the one for work run alongside.
 */
export async function projectCommand(
  on: { trace: Trace; cfg: Config; slug: string }, command: string, cwd: string,
  opts: { env?: Record<string, string>; seq?: number; where?: string; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  const where = opts.where ? { where: opts.where } : {};
  let r: CommandResult;
  try {
    r = await runCommand(command, cwd, { env: opts.env ?? { LOOPSTRA_SLUG: on.slug }, timeoutMs: commandTimeoutMs(on.cfg), signal: opts.signal ?? cancelSignal() });
  } catch (e) {
    if (e instanceof Cancelled) on.trace.event(on.slug, "command", { command, note: e.message, ...where }, opts.seq);
    throw e;
  }
  on.trace.event(on.slug, "command", { command, code: r.code, lastLine: r.lastLine, durationMs: r.durationMs, ...where }, opts.seq);
  return r;
}

/** `detail`: what went wrong, for the trace (the caller words the owner's note). */
export type CodePhaseResult<T> = ({ ok: true } & T) | { ok: false; detail: string };

/** Runs deterministic work as a traced phase. Exceptions become a failed phase, never a crash; a stop request (or a cancel) is marked interrupted and passed on. */
export async function codePhase<T extends object>(ctx: StepContext, name: string, fn: (seq: number) => Promise<{ ok: true } & T>): Promise<CodePhaseResult<T>> {
  await boundary(ctx);
  const seq = ctx.trace.phaseStart(ctx.slug, name, "code");
  try {
    const r = await fn(seq);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "success" });
    return r;
  } catch (e) {
    if (e instanceof StopRequested || e instanceof Cancelled) {
      ctx.trace.phaseEnd(ctx.slug, seq, { status: "interrupted", error: e instanceof Cancelled ? e.message : STOPPED_NOTE });
      throw e;
    }
    const msg = errorText(e);
    ctx.trace.phaseEnd(ctx.slug, seq, { status: "fail", error: msg });
    // A hung git command is reported the same way wherever it happens (see the scheduler).
    if (e instanceof GitTimeout) throw e;
    return { ok: false, detail: `The ${name} step failed: ${msg.split("\n")[0]}` };
  }
}
