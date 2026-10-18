import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { noSessionCap, roomBeside } from "./budget";
import { modelFor, type Config, type ModelRef } from "./config";
import type { StepContext } from "./context";
import type { Envelope } from "./envelopes";
import { Git } from "./git";
import { agentPhase, alongsideFirst, phasePrompt, renderedThen, type AgentPhaseResult, type AgentPhaseSpec } from "./phases";
import { AssistantUnavailable } from "./stop";
import { CHEAP, type JudgeRow, type NewJudgeRow } from "./trace";

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
 * judge rejected, if one stopped the count; `auditDue`: the next first-mode call should run as shadow.
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
  const lastShadow = mine.findLastIndex((r) => r.how === "shadow");
  const sinceShadow = mine.slice(lastShadow + 1).filter((r) => r.how !== "shadow").length;
  return {
    earned: caught >= FIRST_NEEDS, caught, miss, auditDue: sinceShadow >= AUDIT_EVERY - 1,
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

/** The model alias each judge runs on: spec-check and plan-challenge always strong; review as configured. */
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
  if (noSessionCap(cfg)) return "with claude.max_budget_usd_per_day set and no claude.max_budget_usd, both judges never run at once; set a session limit";
  return null;
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

/** The verdict a judge gave, and who decided it: the strong judge, or a trusted cheaper judge that passed alone. */
export type JudgeResult<J extends JudgeName> = AgentPhaseResult<J> & { decidedBy: "strong" | "cheap" };

/** One session and how long it took. */
type Timed<J extends JudgeName> = { r: AgentPhaseResult<J>; ms: number };

/** The two sessions of one question: the strong judge's and the cheaper one's, with the prompt both are sent. */
interface Pair<J extends JudgeName> {
  strong: AgentPhaseSpec & { name: J };
  cheap: AgentPhaseSpec & { name: J };
  prompt: string;
}

/**
 * A judge session on `prompt`, the one compared (see comparison); a retry after a crash renders its
 * prompt again, as every phase's does (see agentPhase).
 */
function judgeSession<J extends JudgeName>(ctx: StepContext, spec: AgentPhaseSpec & { name: J }, prompt: string | null): Promise<AgentPhaseResult<J>> {
  return agentPhase(ctx, spec, renderedThen(prompt, () => phasePrompt(ctx, spec)));
}

/** Runs one judge session and times it. */
async function timed<J extends JudgeName>(ctx: StepContext, spec: AgentPhaseSpec & { name: J }, prompt: string): Promise<Timed<J>> {
  const started = Date.now();
  const r = await judgeSession(ctx, spec, prompt);
  return { r, ms: Date.now() - started };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The sha256 of a judge's prompt template (loopstra/prompts/<judge>.md), or null when it is missing. Editing it starts the record over. */
export function templateSha(root: string, judge: JudgeName): string | null {
  const path = join(root, "loopstra", "prompts", `${judge}.md`);
  return existsSync(path) ? sha256(readFileSync(path, "utf8")) : null;
}

/** What a comparison is keyed on: the judge's key and the sha256 of the question (the whole prompt, and the review's commit). */
interface Comparison {
  key: JudgeKey;
  promptSha: string;
}

/**
 * What a comparison is keyed on, or null when there is nothing to compare: the setting is off, the
 * judge does not run on the strong model, both model names are the same, or the prompt is missing
 * (agentPhase then gives today's missing-prompt failure, and no cheaper session starts). `prompt` is
 * the phase's phasePrompt. The review's prompt does not name the commit it judges, so every round of
 * a change would read the same; its commit is added, so each round is its own question.
 */
async function comparison(ctx: StepContext, phase: AgentPhaseSpec & { name: JudgeName }, prompt: string | null): Promise<Comparison | null> {
  const cheap = modelFor(ctx.cfg, "default");
  const strong = modelFor(ctx.cfg, "strong");
  if (ctx.cfg.speed.cheap_judges === "off" || phase.model !== "strong" || cheap === strong) return null;
  const template = templateSha(ctx.root, phase.name);
  if (template === null || prompt === null) return null;
  const question = phase.name === "review" ? `${await new Git(phase.cwd ?? ctx.worktreeDir).headSha()}\n${prompt}` : prompt;
  return { key: { judge: phase.name, cheap_model: cheap, strong_model: strong, template_sha: template }, promptSha: sha256(question) };
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

/** One call's sessions and verdicts, as its judges row records them. */
interface Asked<J extends JudgeName> {
  how: NewJudgeRow["how"];
  cheap: Timed<J> | null;
  cheapVerdict: NewJudgeRow["cheap"];
  strong: Timed<J> | null;
}

/** Writes the judges row (and its event) for one call. Costs and times only for sessions that ended ok. */
function record<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, c: Comparison, a: Asked<J>): void {
  const usd = (t: Timed<J> | null) => (t?.r.ok ? t.r.costUsd : null);
  const ms = (t: Timed<J> | null) => (t?.r.ok ? t.ms : null);
  ctx.trace.judge(ctx.slug, {
    judge: phase.name, trace_name: phase.traceName ?? phase.name, mode: ctx.cfg.speed.cheap_judges === "first" ? "first" : "shadow", how: a.how,
    cheap_model: c.key.cheap_model, strong_model: c.key.strong_model, template_sha: c.key.template_sha, prompt_sha: c.promptSha,
    cheap: a.cheapVerdict, strong: a.strong ? strongVerdict(phase.name, a.strong.r) : null,
    cheap_usd: usd(a.cheap), strong_usd: usd(a.strong), cheap_ms: ms(a.cheap), strong_ms: ms(a.strong),
  });
}

/** What runJudge's options are: see there. */
type JudgeOpts = { alongside?: number; prompt?: string | null };

/**
 * Asks a judge (spec-check, plan-challenge, review) and waits until its comparison is recorded. Off,
 * or with nothing cheaper to compare: the strong judge alone, as always. shadow (and first while not
 * earned, and first's audits): both judges at once on the same prompt, the strong one decides, and the
 * two verdicts are recorded. first, earned: the cheaper judge alone, and only a clean pass stands;
 * otherwise the strong judge runs after it and decides. A due audit that has no room: the strong judge alone.
 *
 * `alongside`: sessions already running next to this call, which shadow needs room beside (the early
 * review beside the verifier passes 1, and so does spec-check beside the plan written ahead), and one
 * session for each other change running a step (see roomBeside).
 * `prompt`: the phase's phasePrompt, when the caller already has it; both judges are sent exactly that.
 */
export async function runJudge<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, opts: JudgeOpts = {}): Promise<JudgeResult<J>> {
  const j = await judgeFirst(ctx, phase, opts);
  await j.rest();
  return j.result;
}

/**
 * A judge's verdict, given as soon as the deciding judge has it (see judgeFirst). `rest` waits for the
 * cheaper judge of a shadow and records the comparison, and throws a stop request that ended it;
 * `cancel` calls it off, and then nothing is recorded.
 */
export interface JudgeAnswer<J extends JudgeName> {
  result: JudgeResult<J>;
  rest: () => Promise<void>;
  cancel: () => void;
}

/** An answer with nothing left to compare. */
function done<J extends JudgeName>(result: JudgeResult<J>): JudgeAnswer<J> {
  return { result, rest: async () => {}, cancel: () => {} };
}

/**
 * runJudge, returning as soon as the deciding judge answered, so the step can record the gate's result
 * first: a stop while the cheaper judge of a shadow still runs then loses only the comparison. `rest`
 * waits for the comparison and records it.
 */
export async function judgeFirst<J extends JudgeName>(ctx: StepContext, phase: AgentPhaseSpec & { name: J }, opts: JudgeOpts = {}): Promise<JudgeAnswer<J>> {
  const prompt = opts.prompt === undefined ? await phasePrompt(ctx, phase) : opts.prompt;
  const c = await comparison(ctx, phase, prompt);
  if (!c || prompt === null) return done({ ...(await judgeSession(ctx, phase, prompt)), decidedBy: "strong" });
  // Same phase (so the same prompt file, LOOPSTRA_PHASE and tools), on the cheaper model, never
  // retried. It never ends an outage pause: the strong model may be the one that is out.
  const pair: Pair<J> = {
    strong: phase,
    cheap: { ...phase, model: "default", traceName: `${phase.traceName ?? phase.name}${CHEAP}`, retry: false, endsPause: false },
    prompt,
  };
  const sessions = 2 + (opts.alongside ?? 0);
  if (ctx.cfg.speed.cheap_judges === "first") {
    const standing = firstStanding(ctx.trace.judgeRows(), c.key);
    if (!standing.earned) judgeEvent(ctx, phase, `first: running as shadow; ${standingWhy(standing)}`);
    // A due audit runs before it decides alone again; until there is room for one, shadow lets the
    // strong judge decide alone.
    else if (mayDecideAlone(ctx.cfg, standing) && !standing.auditDue) return done(await cheapFirst(ctx, pair, c));
    else if (roomBeside(ctx.cfg, ctx.trace, ctx.slug, sessions)) judgeEvent(ctx, phase, "first: this call is an audit; both judges run and the strong judge decides");
  }
  return shadow(ctx, pair, c, sessions);
}

/**
 * Both judges at once; the strong one decides, and its verdict is given as soon as it is in. Without
 * budget room for both, the strong one alone.
 */
async function shadow<J extends JudgeName>(ctx: StepContext, pair: Pair<J>, c: Comparison, sessions: number): Promise<JudgeAnswer<J>> {
  if (!roomBeside(ctx.cfg, ctx.trace, ctx.slug, sessions)) {
    // Shadow always gives way to the judge that decides, to the work already running, and to other changes.
    judgeEvent(ctx, pair.strong, "not compared: today's budget has no room for another session");
    return done({ ...(await judgeSession(ctx, pair.strong, pair.prompt)), decidedBy: "strong" });
  }
  // The cheaper judge is the extra work: an outage or the day's budget drops it, and the strong judge
  // meets the same trouble on its own. It is always wanted, so the comparison is recorded once the
  // strong judge has answered and `rest` is called; a stop, or the strong judge throwing, cancels it.
  const b = await alongsideFirst(ctx, () => timed(ctx, pair.strong, pair.prompt), {
    what: pair.cheap.traceName!, run: () => timed(ctx, pair.cheap, pair.prompt), wanted: () => true,
  });
  const strong = b.result;
  const rest = async () => {
    const cheap = await b.rest();
    if (cheap) record(ctx, pair.strong, c, { how: "shadow", cheap, cheapVerdict: cheapVerdict(pair.strong.name, cheap.r), strong });
  };
  return { result: { ...strong.r, decidedBy: "strong" }, rest, cancel: b.cancel };
}

/**
 * The cheaper judge alone; a clean pass decides. Anything else (a reject, unsure, a failed session, or
 * the cheaper model being unavailable) goes to the strong judge, which runs after it and decides, so a
 * limit on the cheaper model alone never pauses the loop. A stop or the day's budget passes on.
 */
async function cheapFirst<J extends JudgeName>(ctx: StepContext, pair: Pair<J>, c: Comparison): Promise<JudgeResult<J>> {
  const judge = pair.strong.name;
  let cheap: Timed<J> | null = null;
  try {
    cheap = await timed(ctx, pair.cheap, pair.prompt);
  } catch (e) {
    if (!(e instanceof AssistantUnavailable)) throw e; // its phase row already ended interrupted
  }
  const verdict = cheap ? cheapVerdict(judge, cheap.r) : "failed";
  if (cheap && verdict === "pass") {
    record(ctx, pair.strong, c, { how: "alone", cheap, cheapVerdict: verdict, strong: null });
    return { ...cheap.r, decidedBy: "cheap" };
  }
  const strong = await timed(ctx, pair.strong, pair.prompt);
  record(ctx, pair.strong, c, { how: "escalated", cheap, cheapVerdict: verdict, strong });
  return { ...strong.r, decidedBy: "strong" };
}

/**
 * The one rule for whether an earned cheaper judge may decide alone (runJudge also waits for a due
 * audit). It decides alone only while its audits can run: with a daily budget and no session cap they
 * never can, so there it never decides alone, whatever its record says.
 */
function mayDecideAlone(cfg: Config, standing: FirstStanding): boolean {
  return standing.earned && !noSessionCap(cfg);
}

/**
 * First is on and this judge may decide alone now (a kept early review the cheaper judge decided is
 * rechecked with this). A due audit does not drop it: the kept review's own row can be what made it due.
 * `prompt`: the phase's phasePrompt.
 */
export async function cheapMayDecide(ctx: StepContext, phase: AgentPhaseSpec & { name: JudgeName }, prompt: string | null): Promise<boolean> {
  if (ctx.cfg.speed.cheap_judges !== "first") return false;
  const c = await comparison(ctx, phase, prompt);
  return c !== null && mayDecideAlone(ctx.cfg, firstStanding(ctx.trace.judgeRows(), c.key));
}
