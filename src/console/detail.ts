import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SLUG } from "../budget";
import { judgesView } from "../commands/judges";
import { loadConfig, type Config } from "../config";
import { ARTIFACTS, humanGates, orderQueue, scanRepo } from "../intents";
import { sameFileHolds } from "../scheduler";
import type { Trace } from "../trace";
import { PHASE_FILES, runsDir } from "./files";
import { changeSummary, loopNow, runningRows, totalsOf } from "./model";
import type { ChangeDetail, PhaseView, SpendView } from "./types";

/** One change with everything its page shows, or null when there is no such change. */
export async function changeDetail(root: string, trace: Trace, slug: string, now: Date = new Date()): Promise<ChangeDetail | null> {
  const ordered = orderQueue((await scanRepo(root)).intents);
  const i = ordered.find((x) => x.slug === slug);
  if (!i) return null;
  let cfg: Config | null = null;
  try { cfg = await loadConfig(root); } catch { /* the inbox says what is wrong with the config */ }
  const lanes = cfg?.speed.max_parallel_changes ?? 1;
  const pollSeconds = cfg?.poll_seconds ?? 60;
  const holds = await sameFileHolds(lanes, ordered);
  const rows = trace.phases(slug);
  // The board's rule, so the two never disagree.
  const busy = new Set(runningRows(trace, loopNow(root, pollSeconds, now)).keys());
  const denied = trace.deniedCommands(slug);
  const phases: PhaseView[] = rows.map((p) => {
    const end = p.ended ? Date.parse(p.ended) : now.getTime();
    const dir = `${p.seq}-${p.name}`;
    const files = PHASE_FILES
      .filter((f) => existsSync(join(runsDir(root), slug, "phases", dir, f)))
      .map((f) => ({ name: f, url: `/files/${[slug, "phases", dir, f].map(encodeURIComponent).join("/")}` }));
    return {
      seq: p.seq, name: p.name, kind: p.kind, status: p.status, started: p.started, ended: p.ended,
      durationMs: Math.max(0, end - Date.parse(p.started)), costUsd: p.status === "running" ? 0 : p.cost_usd ?? 0, error: p.error,
      files, denied: denied.get(p.seq) ?? [],
    };
  });
  return {
    ...changeSummary(trace, i, ordered, holds.get(slug), busy, now, humanGates(cfg)),
    dependsOn: i.file.frontmatter.depends_on ?? [],
    documents: ARTIFACTS.filter((a) => i.artifacts.has(a)).map((a) => ({ name: a, url: `/docs/${slug}/${a}` })),
    phases,
    gates: trace.gates(slug),
  };
}

/** How many hours the Spend screen's chart covers. */
const HOURS = 48;

/** What the Spend screen shows. `cfg` is null when the config cannot be read (the judges are then left out). */
export async function spendView(root: string, trace: Trace, cfg: Config | null, now: Date = new Date()): Promise<SpendView> {
  const all = trace.allPhases();
  const titles = new Map((await scanRepo(root)).intents.map((i) => [i.slug, i.file.title || i.slug]));
  const perChange = new Map<string, number>();
  const perPhase = new Map<string, { costUsd: number; count: number }>();
  const firstHour = Math.floor(now.getTime() / 3_600_000) - (HOURS - 1);
  const byHour = Array.from({ length: HOURS }, (_, k) => ({ hour: new Date((firstHour + k) * 3_600_000).toISOString(), costUsd: 0 }));
  let chatUsd = 0;
  for (const p of all) {
    // A running phase counts in its kind's count at no cost (its budget hold is not spending yet),
    // and each phase's whole cost goes in the hour it started, however long it ran.
    const cost = p.status === "running" ? 0 : p.cost_usd ?? 0;
    if (p.slug === CHAT_SLUG) chatUsd += cost;
    else perChange.set(p.slug, (perChange.get(p.slug) ?? 0) + cost);
    // Rounds of the same step count as one kind: fix-1 and fix-2 are both "fix".
    const name = p.slug === CHAT_SLUG ? "chat" : p.name.replace(/-\d+$/, "");
    const kind = perPhase.get(name) ?? { costUsd: 0, count: 0 };
    perPhase.set(name, { costUsd: kind.costUsd + cost, count: kind.count + 1 });
    const h = Math.floor(Date.parse(p.started) / 3_600_000) - firstHour;
    if (h >= 0 && h < HOURS) byHour[h]!.costUsd += cost;
  }
  return {
    totals: totalsOf(all, now),
    chatUsd,
    perChange: [...perChange].map(([slug, costUsd]) => ({ slug, title: titles.get(slug) ?? slug, costUsd })).sort((a, b) => b.costUsd - a.costUsd),
    perPhase: [...perPhase].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    byHour,
    judges: cfg ? judgesState(root, cfg, trace) : null,
  };
}

/** The cheaper judges' report, shown only once they are on or have been compared at all. */
function judgesState(root: string, cfg: Config, trace: Trace): SpendView["judges"] {
  const v = judgesView(root, cfg, trace);
  if (v.setting === "off" && !v.total) return null;
  return { ...v, falsePasses: v.falsePasses.slice(0, 5) };
}
