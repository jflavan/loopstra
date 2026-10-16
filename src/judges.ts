import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { neverRoomForTwo, roomFor } from "./budget";
import { modelFor, type Config, type ModelRef } from "./config";
import type { StepContext } from "./context";
import type { Envelope } from "./envelopes";
import { Git } from "./git";
import { agentPhase, optional, phasePrompt, together, type AgentPhaseResult, type AgentPhaseSpec } from "./phases";
import { AssistantUnavailable } from "./stop";
import type { JudgeRow, NewJudgeRow } from "./trace";

/**
 * Cheaper judges (speed.cheap_judges). The spec check, the plan challenge and the review run on the
 * strong model; a cheaper judge (claude.models.default) is asked the same question with the same
 * prompt. shadow: both run, and only the strong judge decides; the two verdicts are recorded. first:
 * once its record has earned it, the cheaper judge runs alone and a pass stands; anything it rejects,
 * or is unsure of, goes to the strong judge, which then decides.
 */
export type JudgeName = "spec-check" | "plan-challenge" | "review";

export const JUDGES: readonly JudgeName[] = ["spec-check", "plan-challenge", "review"];

/** Strong rejections the cheaper judge must also have caught, newest first and with no miss, before it may decide alone. */
export const FIRST_NEEDS = 30;

/** In first, every 5th call of a trusted judge runs as shadow, so drift still shows up as a miss. */
export const AUDIT_EVERY = 5;

/** The gate's rule: does this envelope pass the gate? (review: no important findings; its approved flag is only traced.) */
export function passes<J extends JudgeName>(judge: J, e: Envelope<J>): boolean {
  if (judge === "review") return (e as Envelope<"review">).findings.every((f) => f.severity !== "important");
  return (e as Envelope<"spec-check" | "plan-challenge">).approved;
}

/** A pass that contradicts itself: the cheaper judge is unsure, and first sends it to the strong judge. */
export function contradicts<J extends JudgeName>(judge: J, e: Envelope<J>): boolean {
  if (!passes(judge, e)) return false;
  switch (judge) {
    case "spec-check": return (e as Envelope<"spec-check">).findings.some((f) => !f.met);
    case "plan-challenge": return (e as Envelope<"plan-challenge">).concerns.some((c) => c.blocking);
    default: return !(e as Envelope<"review">).approved;
  }
}

/** Which judges' rows count together: the judge, both model names and the prompt template, all as they are now. */
export interface JudgeKey {
  judge: JudgeName;
  cheap_model: string;
  strong_model: string;
  template_sha: string;
}

function matches(row: JudgeRow, key: JudgeKey): boolean {
  return row.judge === key.judge && row.cheap_model === key.cheap_model && row.strong_model === key.strong_model && row.template_sha === key.template_sha;
}

/**
 * Where a judge stands for first. `caught`: strong rejections the cheaper judge also rejected (or was
 * unsure of), newest first, before any miss; `miss`: the newest row where it passed what the strong
 * judge rejected, if one stopped the count; `auditDue`: the next first-mode call should run as shadow
 * (it stays due until an audit compares: one where either judge failed did not).
 */
export interface FirstStanding {
  earned: boolean;
  caught: number;
  miss: JudgeRow | null;
  auditDue: boolean;
  /**
   * Questions it decided alone, and audits: shadow rows in first right after an alone or escalated
   * row (a call that runs as shadow because first is not earned never follows one).
   */
  alone: number;
  audited: number;
}

/**
 * Evidence is the shadow rows (audits included) where the strong judge rejected and the cheaper one
 * answered; each prompt counts once, at its newest row, and a prompt the cheaper judge ever passed
 * there is a miss. Walking newest first, a miss stops the walk. First is earned when FIRST_NEEDS were
 * caught before any miss.
 */
export function firstStanding(rows: readonly JudgeRow[], key: JudgeKey): FirstStanding {
  const mine = rows.filter((r) => matches(r, key));
  const evidence = mine.filter((r) => r.how === "shadow" && r.strong === "reject" && r.cheap !== "failed");
  const misses = new Map(evidence.filter((r) => r.cheap === "pass").map((r) => [r.prompt_sha, r]));
  const seen = new Set<string>();
  let caught = 0;
  let miss: JudgeRow | null = null;
  for (const r of [...evidence].reverse()) {
    if (seen.has(r.prompt_sha)) continue;
    seen.add(r.prompt_sha);
    miss = misses.get(r.prompt_sha) ?? null;
    if (miss) break;
    caught++;
  }
  // Calls since the last shadow row that compared. One where either judge failed compared nothing, so
  // it is no audit: a cheaper judge that keeps failing its audits never decides alone again.
  const lastCompared = mine.findLastIndex((r) => r.how === "shadow" && r.cheap !== "failed" && r.strong !== "failed");
  const sinceCompared = mine.slice(lastCompared + 1).filter((r) => r.how !== "shadow").length;
  return {
    earned: caught >= FIRST_NEEDS, caught, miss, auditDue: sinceCompared >= AUDIT_EVERY - 1,
    alone: mine.filter((r) => r.how === "alone").length,
    audited: mine.filter((r, i) => r.how === "shadow" && r.mode === "first" && i > 0 && mine[i - 1]!.how !== "shadow").length,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct": a row's day, in local time. */
export function shortDay(ts: string): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Why a judge that has not earned first still runs as shadow, in words. */
export function standingWhy(s: FirstStanding): string {
  if (s.miss) return `it passed something the strong judge rejected on ${shortDay(s.miss.ts)} (${s.miss.slug}), so it needs ${FIRST_NEEDS} newer ones (${s.caught} so far)`;
  return `the cheaper judge decides alone only after it has also rejected the last ${FIRST_NEEDS} things the strong judge rejected (${s.caught} so far)`;
}

/**
 * The model alias each judge runs on: spec-check and plan-challenge always strong; review as configured.
 * The stages ask this too, so what runs and what the report says can be compared never differ.
 */
export function judgeModel(cfg: Config, judge: JudgeName): ModelRef {
  return judge === "review" ? cfg.stages.review.model : "strong";
}

/** Why a cheaper judge is never compared with this one, in words, or null when it can be. */
export function notComparable(cfg: Config, judge: JudgeName): string | null {
  const ref = judgeModel(cfg, judge);
  if (ref !== "strong") return `${judge} already runs on ${modelFor(cfg, ref)}; there is nothing cheaper to compare`;
  if (modelFor(cfg, "default") === modelFor(cfg, "strong")) return `the cheaper and the strong model are both ${modelFor(cfg, "strong")}; there is nothing cheaper to compare`;
  const gate = judge === "spec-check" ? "spec" : judge === "plan-challenge" ? "plan" : null;
  if (gate && !cfg.gates[gate].agent) return `the ${gate} gate has no judge (gates.${gate}.agent is false)`;
  return budgetWhy(cfg);
}

/** Why today's budget never lets both judges run at once, in words, or null when it can (see neverRoomForTwo). */
function budgetWhy(cfg: Config): string | null {
  if (!neverRoomForTwo(cfg)) return null;
  const { max_budget_usd_per_day: day, max_budget_usd: cap } = cfg.claude;
  if (cap === undefined) return "with claude.max_budget_usd_per_day set and no claude.max_budget_usd, both judges never run at once; set a session limit";
  return `claude.max_budget_usd_per_day ($${day!.toFixed(2)}) is less than two sessions of claude.max_budget_usd ($${cap.toFixed(2)} each), so both judges never run at once; lower the session limit or raise the day's`;
}

/** One judge's line of `loopstra judges` and the dashboard. Averages and costs are null with nothing to average. */
export interface JudgeReportRow {
  judge: JudgeName;
  /** Why it cannot be compared (see notComparable), or null. */
  why: string | null;
  /** Shadow rows where neither side failed: agreed + falsePasses + falseRejects. */
  compared: number;
  agreed: number;
  /** The cheaper judge passed what the strong one rejected (the dangerous case). */
  falsePasses: number;
  /** The cheaper judge rejected, or was unsure of, what the strong one passed. */
  falseRejects: number;
  unsure: number;
  /** Shadow rows where the cheaper judge failed. */
  couldNotAnswer: number;
  avgCheapUsd: number | null;
  avgStrongUsd: number | null;
  avgCheapMs: number | null;
  avgStrongMs: number | null;
  /** What first would cost against the strong judge alone, as a fraction, measured over the shadow rows. */
  firstWouldCost: number | null;
  /** Whether it goes first, in words; null when the setting is off or it cannot be compared. */
  goesFirst: string | null;
}

export interface JudgeReport {
  setting: Config["speed"]["cheap_judges"];
  cheapModel: string;
  strongModel: string;
  judges: JudgeReportRow[];
  /** Rows with other models or prompts than now: not counted anywhere. */
  notCounted: number;
  /** Counted shadow rows where the cheaper judge passed what the strong one rejected, newest first. */
  falsePasses: JudgeRow[];
}

function average(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Whether the judge goes first, in words, for the report. */
function goesFirstText(setting: JudgeReport["setting"], s: FirstStanding): string | null {
  if (setting === "off") return null;
  if (s.earned) return setting === "first" ? `yes (decided alone ${s.alone} times, audited ${s.audited})` : `it would: it caught the last ${s.caught} rejections`;
  if (s.miss) return `no: missed one on ${shortDay(s.miss.ts)} (${s.miss.slug}); ${s.caught} of ${FIRST_NEEDS} caught since`;
  return `not yet: ${s.caught} of ${FIRST_NEEDS} rejections caught`;
}

/** One judge's counts over its rows with the current key. */
function reportRow(key: JudgeKey | null, rows: readonly JudgeRow[]): { row: Omit<JudgeReportRow, "judge" | "why" | "goesFirst">; standing: FirstStanding } {
  const mine = key ? rows.filter((r) => matches(r, key)) : [];
  const shadow = mine.filter((r) => r.how === "shadow");
  const compared = shadow.filter((r) => r.cheap !== "failed" && r.strong !== "failed");
  const costed = shadow.filter((r) => r.cheap_usd !== null && r.strong_usd !== null);
  const strongSum = costed.reduce((a, r) => a + r.strong_usd!, 0);
  const firstSum = costed.reduce((a, r) => a + r.cheap_usd! + (r.cheap === "pass" ? 0 : r.strong_usd!), 0);
  const standing = key ? firstStanding(rows, key) : { earned: false, caught: 0, miss: null, auditDue: false, alone: 0, audited: 0 };
  return {
    standing,
    row: {
      compared: compared.length,
      agreed: compared.filter((r) => (r.cheap === "pass") === (r.strong === "pass")).length,
      falsePasses: compared.filter((r) => r.cheap === "pass" && r.strong === "reject").length,
      falseRejects: compared.filter((r) => r.cheap !== "pass" && r.strong === "pass").length,
      unsure: compared.filter((r) => r.cheap === "unsure").length,
      couldNotAnswer: shadow.filter((r) => r.cheap === "failed").length,
      avgCheapUsd: average(mine.map((r) => r.cheap_usd)),
      avgStrongUsd: average(mine.map((r) => r.strong_usd)),
      avgCheapMs: average(mine.map((r) => r.cheap_ms)),
      avgStrongMs: average(mine.map((r) => r.strong_ms)),
      firstWouldCost: strongSum > 0 ? firstSum / strongSum : null,
    },
  };
}

/**
 * What the cheaper judges did, for `loopstra judges` and the dashboard. Only rows with today's two
 * model names and each judge's current prompt template (`templates`: its sha256, missing when the
 * prompt file is) count; the rest are only counted as not counted.
 */
export function judgeReport(cfg: Config, rows: readonly JudgeRow[], templates: Partial<Record<JudgeName, string>>): JudgeReport {
  const cheapModel = modelFor(cfg, "default");
  const strongModel = modelFor(cfg, "strong");
  const keyOf = (judge: JudgeName): JudgeKey | null => {
    const template_sha = templates[judge];
    return template_sha === undefined ? null : { judge, cheap_model: cheapModel, strong_model: strongModel, template_sha };
  };
  const counted = (r: JudgeRow) => {
    const key = JUDGES.includes(r.judge as JudgeName) ? keyOf(r.judge as JudgeName) : null;
    return key !== null && matches(r, key);
  };
  const setting = cfg.speed.cheap_judges;
  return {
    setting, cheapModel, strongModel,
    judges: JUDGES.map((judge) => {
      const { row, standing } = reportRow(keyOf(judge), rows);
      const why = notComparable(cfg, judge);
      return { judge, why, ...row, goesFirst: why ? null : goesFirstText(setting, standing) };
    }),
    notCounted: rows.filter((r) => !counted(r)).length,
    falsePasses: rows.filter((r) => counted(r) && r.how === "shadow" && r.cheap === "pass" && r.strong === "reject").reverse(),
  };
}

/**
 * The verdict a judge gave, and who decided it: the strong judge, or a trusted cheaper judge that passed
 * alone. `alone`: with keepAlone, the row of a pass the cheaper judge decided alone, not yet written;
 * the caller writes it (ctx.trace.judge) once the verdict is used.
 */
export type JudgeResult<J extends JudgeName> = AgentPhaseResult<J> & { decidedBy: "strong" | "cheap"; alone?: NewJudgeRow };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Template shas by path, kept while the file's size and times are unchanged: the dashboard asks on every poll. */
const templateShas = new Map<string, { stamp: string; sha: string }>();

/**
 * The sha256 of a judge's prompt template (loopstra/prompts/<judge>.md), or null when it is missing or
 * cannot be read (not a file, no permission). Editing it starts the record over.
 */
export function templateSha(root: string, judge: JudgeName): string | null {
  const path = join(root, "loopstra", "prompts", `${judge}.md`);
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = templateShas.get(path);
    if (hit?.stamp === stamp) return hit.sha;
    const sha = sha256(readFileSync(path, "utf8"));
    templateShas.set(path, { stamp, sha });
    return sha;
  } catch {
    return null;
  }
}

/** What a comparison is keyed on: the judge's key and the sha256 of the question (the whole prompt, and the review's commit). */
interface Comparison {
  key: JudgeKey;
  promptSha: string;
  /** The rendered prompt, given to both sessions so neither renders it again. */
  prompt: string;
}

/**
 * What a comparison is keyed on, or null when there is nothing to compare: the setting is off, the
 * judge does not run on the strong model, both model names are the same, or the prompt is missing
 * (agentPhase then gives today's missing-prompt failure, and no cheaper session starts). The review's
 * prompt does not name the commit it judges, so every round of a change would read the same; its
 * commit (`commit`, else HEAD where it runs) is added, so each round is its own question.
 */
async function comparison(ctx: StepContext, phase: AgentPhaseSpec & { name: JudgeName }, commit?: string): Promise<Comparison | null> {
  const cheap = modelFor(ctx.cfg, "default");
  const strong = modelFor(ctx.cfg, "strong");
  if (ctx.cfg.speed.cheap_judges === "off" || phase.model !== "strong" || cheap === strong) return null;
  const template = templateSha(ctx.root, phase.name);
  const prompt = phase.prompt ?? await phasePrompt(ctx, phase);
  if (template === null || prompt === null) return null;
  const question = phase.name === "review" ? `${commit ?? await new Git(phase.cwd ?? ctx.worktreeDir).headSha()}\n${prompt}` : prompt;
  return { key: { judge: phase.name, cheap_model: cheap, strong_model: strong, template_sha: template }, promptSha: sha256(question), prompt };
}

/** The strong judge's verdict: failed when its session did not end ok. */
function strongVerdict<J extends JudgeName>(judge: J, r: AgentPhaseResult<J>): "pass" | "reject" | "failed" {
  if (!r.ok) return "failed";
  return passes(judge, r.envelope) ? "pass" : "reject";
}

/** The cheaper judge's verdict: unsure is a pass that contradicts itself. */
function cheapVerdict<J extends JudgeName>(judge: J, r: AgentPhaseResult<J>): "pass" | "unsure" | "reject" | "failed" {
  if (!r.ok) return "failed";
  if (!passes(judge, r.envelope)) return "reject";
  return contradicts(judge, r.envelope) ? "unsure" : "pass";
}

/** A `judge` event with no row: why a call was not compared, or why first ran as shadow. */
function judgeEvent(ctx: StepContext, phase: AgentPhaseSpec, note: string): void {
  ctx.trace.event(ctx.slug, "judge", { note, judge: phase.name, trace_name: phase.traceName ?? phase.name });
}

/**
 * One call's verdicts, as its judges row records them, and the sessions that gave them here (null: it
 * did not run in this call, or threw).
 */
interface Asked<J extends JudgeName> {
  how: NewJudgeRow["how"];
  cheap: AgentPhaseResult<J> | null;
  cheapVerdict: NewJudgeRow["cheap"];
  strong: AgentPhaseResult<J> | null;
  strongVerdict: NewJudgeRow["strong"];
}

/** The cheaper side of a call, known before the strong judge runs. */
type CheapSide<J extends JudgeName> = Pick<Asked<J>, "how" | "cheap" | "cheapVerdict">;

/** One call's judges row. Costs and times only for sessions that ran in this call and ended ok. */
function judgeRow<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, c: Comparison, a: Asked<J>): NewJudgeRow {
  const usd = (r: AgentPhaseResult<J> | null) => (r?.ok ? r.costUsd : null);
  const ms = (r: AgentPhaseResult<J> | null) => (r?.ok ? r.ms ?? null : null);
  return {
    judge: phase.name, trace_name: phase.traceName ?? phase.name, mode: ctx.cfg.speed.cheap_judges === "first" ? "first" : "shadow", how: a.how,
    cheap_model: c.key.cheap_model, strong_model: c.key.strong_model, template_sha: c.key.template_sha, prompt_sha: c.promptSha,
    cheap: a.cheapVerdict, strong: a.strongVerdict,
    cheap_usd: usd(a.cheap), strong_usd: usd(a.strong), cheap_ms: ms(a.cheap), strong_ms: ms(a.strong),
  };
}

/** Writes the judges row (and its event) for one call. */
function record<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, c: Comparison, a: Asked<J>): void {
  ctx.trace.judge(ctx.slug, judgeRow(ctx, phase, c, a));
}

/**
 * What the cheaper judge already said to this very question, when the call that asked it never got
 * the strong judge's answer (it failed, or the loop paused or stopped while it ran): that newest row's
 * verdict, used again instead of paying for the cheaper session twice. Null otherwise.
 */
function earlierCheap(rows: readonly JudgeRow[], c: Comparison): NewJudgeRow["cheap"] | null {
  const last = rows.findLast((r) => matches(r, c.key) && r.prompt_sha === c.promptSha);
  return last && last.strong === "failed" && last.cheap !== "failed" ? last.cheap : null;
}

/**
 * Whether today's budget has room for shadow's two sessions beside `alongside` other sessions that
 * start with the judge. A caller that starts other work beside a judge asks this before starting any
 * of it: a session that has started already holds its share of the day, so asking after would count
 * it twice or not, depending on which session started first.
 */
export function shadowRoom(ctx: StepContext, alongside = 0): boolean {
  return roomFor(ctx.cfg, ctx.trace, 2 + alongside);
}

export interface JudgeOptions {
  /** Room for shadow (see shadowRoom), from a caller that starts other work beside the judge. Default: shadowRoom now, with nothing beside. */
  room?: boolean;
  /** The review's commit, when the caller already has it (see comparison). */
  commit?: string;
  /** A pass the cheaper judge decides alone is handed back (JudgeResult.alone), not written, for a caller that may not use it. */
  keepAlone?: boolean;
}

/**
 * Asks a judge (spec-check, plan-challenge, review). Off, or with nothing cheaper to compare: the
 * strong judge alone, as always. shadow (and first while not earned, and first's audits): both judges
 * at once on the same prompt, the strong one decides, and the two verdicts are recorded. first, earned:
 * the cheaper judge alone, and only a clean pass stands; otherwise the strong judge runs after it and
 * decides. A due audit that has no room: the strong judge alone.
 */
export async function runJudge<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, opts: JudgeOptions = {}): Promise<JudgeResult<J>> {
  const c = await comparison(ctx, phase, opts.commit);
  if (!c) return { ...(await agentPhase(ctx, phase)), decidedBy: "strong" };
  const room = opts.room ?? shadowRoom(ctx);
  const strongPhase: AgentPhaseSpec & { name: J } = { ...phase, prompt: c.prompt };
  // Same phase (so the same prompt, LOOPSTRA_PHASE and tools), on the cheaper model, never retried,
  // and its own kind in the trace.
  const cheapPhase: AgentPhaseSpec & { name: J } = { ...strongPhase, model: "default", traceName: `${phase.traceName ?? phase.name}-cheap`, retry: false, kind: "cheap-judge" };
  const rows = ctx.trace.judgeRows();
  const before = earlierCheap(rows, c);
  if (ctx.cfg.speed.cheap_judges === "first") {
    const standing = firstStanding(rows, c.key);
    if (!standing.earned) judgeEvent(ctx, phase, `first: running as shadow; ${standingWhy(standing)}`);
    else if (mayDecideAlone(ctx.cfg, standing)) return cheapFirst(ctx, strongPhase, cheapPhase, c, before, opts.keepAlone ?? false);
    // A due audit runs before it decides alone again; until there is room for one, shadow lets the
    // strong judge decide alone.
    else if (room) judgeEvent(ctx, phase, "first: this call is an audit; both judges run and the strong judge decides");
  }
  return shadow(ctx, strongPhase, cheapPhase, c, before, room);
}

/**
 * Runs the strong judge. If it throws (an outage, the day's budget, a stop), the call's row is written
 * first, with the strong verdict failed, so what the cheaper judge said is kept; then it passes on.
 */
async function strongJudge<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, c: Comparison, side: CheapSide<J>): Promise<AgentPhaseResult<J>> {
  try {
    return await agentPhase(ctx, phase);
  } catch (e) {
    record(ctx, phase, c, { ...side, strong: null, strongVerdict: "failed" });
    throw e;
  }
}

/**
 * Both judges at once; the strong one decides. Without budget room for both, the strong one alone. A
 * cheaper verdict this question already got (`before`) is used again, and only the strong judge runs.
 */
async function shadow<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, cheapPhase: AgentPhaseSpec & { name: J }, c: Comparison, before: NewJudgeRow["cheap"] | null, room: boolean): Promise<JudgeResult<J>> {
  if (before) {
    const side: CheapSide<J> = { how: "shadow", cheap: null, cheapVerdict: before };
    const strong = await strongJudge(ctx, phase, c, side);
    record(ctx, phase, c, { ...side, strong, strongVerdict: strongVerdict(phase.name, strong) });
    return { ...strong, decidedBy: "strong" };
  }
  if (!room) {
    // Shadow always gives way to the judge that decides and to the work already running.
    judgeEvent(ctx, phase, "not compared: today's budget has no room for another session");
    return { ...(await agentPhase(ctx, phase)), decidedBy: "strong" };
  }
  // The cheaper judge is optional: an outage or the day's budget drops it, and the strong judge meets
  // the same trouble on its own. If the strong judge throws, the cheaper verdict is still recorded once
  // both have ended; then the error passes on (a stop request first, as together does).
  let threw: { e: unknown } | null = null;
  const [strong, cheap] = await together(ctx, [
    () => agentPhase(ctx, phase).catch((e: unknown) => { threw = { e }; return null; }),
    () => optional(ctx, cheapPhase.traceName!, () => agentPhase(ctx, cheapPhase)),
  ] as const);
  if (cheap) record(ctx, phase, c, { how: "shadow", cheap, cheapVerdict: cheapVerdict(phase.name, cheap), strong, strongVerdict: strong ? strongVerdict(phase.name, strong) : "failed" });
  if (threw) throw (threw as { e: unknown }).e;
  return { ...strong!, decidedBy: "strong" };
}

/**
 * The cheaper judge alone; a clean pass decides. Anything else (a reject, unsure, a failed session, or
 * the cheaper model being unavailable) goes to the strong judge, which runs after it and decides, so a
 * limit on the cheaper model alone never pauses the loop. A stop or the day's budget passes on. A
 * reject or unsure this question already got (`before`) goes straight to the strong judge.
 */
async function cheapFirst<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, cheapPhase: AgentPhaseSpec & { name: J }, c: Comparison, before: NewJudgeRow["cheap"] | null, keepAlone: boolean): Promise<JudgeResult<J>> {
  let cheap: AgentPhaseResult<J> | null = null;
  let verdict: NewJudgeRow["cheap"];
  if (before && before !== "pass") {
    verdict = before;
  } else {
    try {
      cheap = await agentPhase(ctx, cheapPhase);
    } catch (e) {
      if (!(e instanceof AssistantUnavailable)) throw e; // its phase row already ended interrupted
    }
    verdict = cheap ? cheapVerdict(phase.name, cheap) : "failed";
    if (cheap?.ok && verdict === "pass") {
      const row = judgeRow(ctx, phase, c, { how: "alone", cheap, cheapVerdict: verdict, strong: null, strongVerdict: null });
      if (keepAlone) return { ...cheap, decidedBy: "cheap", alone: row };
      ctx.trace.judge(ctx.slug, row);
      return { ...cheap, decidedBy: "cheap" };
    }
  }
  const side: CheapSide<J> = { how: "escalated", cheap, cheapVerdict: verdict };
  const strong = await strongJudge(ctx, phase, c, side);
  record(ctx, phase, c, { ...side, strong, strongVerdict: strongVerdict(phase.name, strong) });
  return { ...strong, decidedBy: "strong" };
}

/**
 * The one rule for whether a cheaper judge may decide alone now: it has earned first, no audit is due
 * (a due audit runs first), and its audits can run at all. When today's budget never has room for both
 * judges (see neverRoomForTwo) they never can, so there it never decides alone, whatever its record says.
 */
function mayDecideAlone(cfg: Config, standing: FirstStanding): boolean {
  return standing.earned && !standing.auditDue && !neverRoomForTwo(cfg);
}

/** First is on and this judge may decide alone now (a kept early review the cheaper judge decided is rechecked with this). */
export async function cheapMayDecide(ctx: StepContext, phase: AgentPhaseSpec & { name: JudgeName }, commit?: string): Promise<boolean> {
  if (ctx.cfg.speed.cheap_judges !== "first") return false;
  const c = await comparison(ctx, phase, commit);
  return c !== null && mayDecideAlone(ctx.cfg, firstStanding(ctx.trace.judgeRows(), c.key));
}
