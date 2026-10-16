import { loadConfig, type Config } from "../config";
import { JUDGES, judgeReport, shortDay, templateSha, type JudgeName, type JudgeReport, type JudgeReportRow } from "../judges";
import { Trace } from "../trace";

/** The cheaper judges' report, what they have cost, and how many rows the trace holds at all. */
export interface JudgesView extends JudgeReport {
  spentUsd: number;
  /** Every judges row, counted or not. */
  total: number;
}

/** The report over the trace, keyed on each judge's current prompt template. For `loopstra judges` and the dashboard. */
export function judgesView(root: string, cfg: Config, trace: Trace): JudgesView {
  const templates: Partial<Record<JudgeName, string>> = {};
  for (const judge of JUDGES) {
    const sha = templateSha(root, judge);
    if (sha) templates[judge] = sha;
  }
  const rows = trace.judgeRows();
  return { ...judgeReport(cfg, rows, templates), spentUsd: trace.cheapJudgeCost(), total: rows.length };
}

/**
 * The report in words and cells: the one copy `loopstra judges` and the dashboard both show. With
 * nothing compared yet there is no table and no spending line.
 */
export interface JudgesShown {
  /** "Cheaper judges: shadow (sonnet beside opus)". */
  setting: string;
  /** What counts; with nothing compared yet, that (and how to start measuring). */
  note: string;
  /** The header row, then one row per judge; empty with nothing compared. */
  table: string[][];
  spent: string | null;
  /** Why some judges are never compared, each reason once. */
  notCompared: string[];
  /** The false passes, newest first, one line each. */
  falsePasses: string[];
}

/** The report laid out for reading; `falsePasses`: at most that many of them (the dashboard shows five). */
export function judgesShown(v: JudgesView, opts: { falsePasses?: number } = {}): JudgesShown {
  const setting = `Cheaper judges: ${v.setting} (${settingHow(v)})`;
  const notCompared = [...new Set(v.judges.map((j) => j.why).filter((w): w is string => w !== null))];
  if (!v.total) {
    const hint = v.setting === "off" ? " Set speed.cheap_judges to shadow to start measuring." : "";
    return { setting, note: `No comparisons yet.${hint}`, table: [], spent: null, notCompared, falsePasses: [] };
  }
  return {
    setting, note: "Only comparisons with these two models and the current prompts count.", table: table(v), spent: spentLine(v), notCompared,
    falsePasses: v.falsePasses.slice(0, opts.falsePasses ?? Infinity)
      .map((p) => `${shortDay(p.ts)}, ${p.slug}, ${p.trace_name}: ${p.strong_model} rejected, ${p.cheap_model} passed.`),
  };
}

/** `loopstra judges`: how often the cheaper judges agreed with the strong ones. Read-only. */
export async function renderJudges(root: string): Promise<string> {
  const cfg = await loadConfig(root);
  const trace = Trace.open(root);
  try {
    return judgesText(judgesView(root, cfg, trace));
  } finally {
    trace.close();
  }
}

/** The report as plain text: the setting, a table per judge, the spending, and what went wrong. */
export function judgesText(v: JudgesView): string {
  const s = judgesShown(v);
  const lines = s.table.length ? [`${s.setting}. ${s.note}`, ...aligned(s.table), s.spent!] : [`${s.setting}.`, s.note];
  if (s.notCompared.length) lines.push("", "Not compared:", ...s.notCompared.map((w) => `- ${w}`));
  if (s.falsePasses.length) lines.push("", "Passed what the strong judge rejected (newest first):", ...s.falsePasses.map((p) => `- ${p}`));
  return lines.join("\n") + "\n";
}

function settingHow(v: JudgesView): string {
  if (v.setting === "first") return `${v.cheapModel} before ${v.strongModel}`;
  if (v.setting === "shadow") return `${v.cheapModel} beside ${v.strongModel}`;
  return `${v.cheapModel} is not asked`;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

const seconds = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)} min`);

/** "cheaper / strong", or "-" when neither has a value. */
function pair(a: number | null, b: number | null, show: (n: number) => string): string {
  if (a === null && b === null) return "-";
  return `${a === null ? "-" : show(a)} / ${b === null ? "-" : show(b)}`;
}

/** The header, then one row per judge; "Goes first?" only when the setting is shadow or first. */
function table(v: JudgesView): string[][] {
  const goesFirst = v.setting !== "off";
  const headers = ["Judge", "Compared", "Agreed", `Passed what ${v.strongModel} rejected`, `Rejected what ${v.strongModel} passed`, "Unsure", "Could not answer",
    `Avg cost (${v.cheapModel} / ${v.strongModel})`, `Avg time (${v.cheapModel} / ${v.strongModel})`, "First would cost", ...(goesFirst ? ["Goes first?"] : [])];
  const row = (j: JudgeReportRow) => [
    j.judge, ...[j.compared, j.agreed, j.falsePasses, j.falseRejects, j.unsure, j.couldNotAnswer].map(String),
    pair(j.avgCheapUsd, j.avgStrongUsd, money), pair(j.avgCheapMs, j.avgStrongMs, seconds),
    j.firstWouldCost === null ? "-" : `${Math.round(j.firstWouldCost * 100)}%`,
    ...(goesFirst ? [j.why ? "not compared (see below)" : j.goesFirst ?? "-"] : []),
  ];
  return [headers, ...v.judges.map(row)];
}

/** A table's rows as text, its columns padded to line up. */
function aligned(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd());
}

function spentLine(v: JudgesView): string {
  const n = v.notCounted;
  const older = n ? ` ${n} older comparison${n === 1 ? "" : "s"} with other models or prompts ${n === 1 ? "is" : "are"} not counted.` : "";
  return `Spent on cheaper judges so far: ${money(v.spentUsd)}.${older}`;
}
