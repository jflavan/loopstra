import { plainStatus, STATUSES, type Status } from "../intents";
import type { EventRow, Trace } from "../trace";
import type { ActivityItem } from "./types";

type Payload = Record<string, unknown>;

function parse(text: string): Payload {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : { value: v };
  } catch {
    return { value: text };
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const plain = (v: unknown): string => ((STATUSES as readonly string[]).includes(str(v)) ? plainStatus(str(v) as Status) : str(v));
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const money = (v: unknown): string => (typeof v === "number" && v >= 0.005 ? ` ($${v.toFixed(2)})` : "");
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The first non-blank line of `v`, cut to `n` characters. */
function firstLine(v: unknown, n = 160): string {
  const line = str(v).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

const ENDED: Record<string, string> = { success: "passed", fail: "failed", interrupted: "was interrupted" };
const HEALTH: Record<string, string> = { pass: "pass", fail: "fail", error: "could not be checked", waiting: "are waiting" };
const GATE: Record<string, string> = { pass: "passed", fail: "failed", waiting: "waiting" };

/**
 * An event in plain words, for the console's Activity, or null when it only matters to an engineer
 * (ticks, raw session events). `phaseName` names the phase an event belongs to.
 */
export function describeEvent(e: EventRow, phaseName: (slug: string, seq: number) => string | undefined = () => undefined): string | null {
  const p = parse(e.payload);
  switch (e.type) {
    case "status_change": return `${capital(plain(p.to))}.`;
    case "phase_start": return `Started ${str(p.name)}.`;
    case "phase_end": {
      const name = e.phase_seq !== null ? phaseName(e.slug, e.phase_seq) : undefined;
      const why = p.status === "fail" && p.error ? `: ${firstLine(p.error)}` : "";
      return sentence(`${capital(name ?? "a step")} ${ENDED[str(p.status)] ?? str(p.status)}${money(p.cost_usd)}${why}`);
    }
    case "gate_check": return `${capital(str(p.gate))} gate, ${str(p.check)}: ${GATE[str(p.result)] ?? str(p.result)}.`;
    case "command":
      if (p.note) return `Stopped ${firstLine(p.command, 80)}.`;
      return p.code === 0 ? `Ran ${firstLine(p.command, 80)}.` : `Ran ${firstLine(p.command, 80)}: exit code ${str(p.code)}.`;
    case "error": return `Problem${p.where ? ` (${str(p.where)})` : ""}: ${firstLine(p.what ?? p.problem ?? p.error ?? p.value)}`;
    case "signal":
      if (p.name === "main_health") return `The tests on main ${HEALTH[str(p.result)] ?? str(p.result)}.`;
      return p.output ? firstLine(p.output) : `${str(p.name)}: ${str(p.result)}.`;
    case "stop": return "The loop is stopping.";
    case "pause": return `Paused: ${firstLine(p.reason)}`;
    case "person-changed-status": return `A person set the status to ${plain(p.to)} while a step ran, so the step wrote nothing.`;
    case "stale-lock-removed": return "Removed a lock a stopped process left behind.";
    case "chat-message": return `${str(p.from) || "Someone"} wrote in chat.`;
    case "chat-request":
      if (p.result === "accepted") return `${str(p.by)} accepted it from chat.`;
      return p.kind === "new" ? `Chat wrote this change up for ${str(p.by)}.` : `A chat request was not applied (${str(p.result)}).`;
    case "chat-pr": return "Chat's pull request of new intents changed.";
    case "judge": return firstLine(p.note) || null;
    default: return null;
  }
}

/** The event as one technical line: its type and its payload's fields, like `loopstra tail`. */
export function technicalText(e: EventRow): string {
  const fields = Object.entries(parse(e.payload))
    .filter(([k]) => k !== "stack")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ").replace(/\s*\r?\n\s*/g, " ");
  const line = `${e.type} ${fields}`.trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

export function activityItem(e: EventRow, phaseName?: (slug: string, seq: number) => string | undefined): ActivityItem {
  return { id: e.id, slug: e.slug, seq: e.phase_seq, ts: e.ts, type: e.type, text: describeEvent(e, phaseName), technical: technicalText(e) };
}

/** Names phases by change and seq, reading a change's phases again only when it meets a seq it has not seen. */
export function phaseNamer(trace: Trace): (slug: string, seq: number) => string | undefined {
  const known = new Map<string, Map<number, string>>();
  return (slug, seq) => {
    let names = known.get(slug);
    if (!names?.has(seq)) {
      names = new Map(trace.phases(slug).map((p) => [p.seq, p.name]));
      known.set(slug, names);
    }
    return names.get(seq);
  };
}

/** How many items one page of Activity holds, and how many events one request reads at most. */
const PAGE = 200;
const SCAN = 2_000;

/**
 * A page of Activity, newest first: up to 200 items older than `before` (from the newest, when 0),
 * only those in plain words unless `technical`, optionally of one slug. `next` is the `before` of
 * the following page, or null at the start of the trace.
 */
export function eventsPage(trace: Trace, before: number, slug: string | undefined, technical: boolean): { items: ActivityItem[]; next: number | null } {
  const name = phaseNamer(trace);
  const items: ActivityItem[] = [];
  let cursor = before;
  for (let scanned = 0; scanned < SCAN && items.length < PAGE;) {
    const rows = trace.eventsBefore(cursor, PAGE, slug);
    if (!rows.length) return { items, next: null };
    for (const e of rows) {
      cursor = e.id;
      const a = activityItem(e, name);
      if (technical || a.text !== null) items.push(a);
      if (items.length >= PAGE) break;
    }
    scanned += rows.length;
  }
  return { items, next: cursor };
}
