import { GITHUB_SIGNAL } from "../github";
import { plainStatus, STATUSES, type Status } from "../intents";
import { Cancelled } from "../stop";
import type { EventRow, Trace } from "../trace";
import type { ActivityItem } from "./types";

type Payload = Record<string, unknown>;

/** A trace event's payload as an object; anything else (a bare value, bad JSON) under `value`. */
export function parsePayload(text: string): Payload {
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
const sentence = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);
/** The first of `vs` with something in it, so an empty field does not hide a later one. */
const first = (...vs: unknown[]): unknown => vs.find((v) => v != null && str(v).trim() !== "");

/** The first non-blank line of `v`, trimmed and cut to `n` characters. */
function firstLine(v: unknown, n = 160): string {
  const line = str(v).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

const ENDED: Record<string, string> = { success: "passed", fail: "failed", interrupted: "was interrupted", asked: "asked a question" };
const HEALTH: Record<string, string> = { pass: "pass", fail: "fail", error: "could not be checked", waiting: "are waiting" };
const GATE: Record<string, string> = { pass: "passed", fail: "failed", waiting: "waiting" };

/** The note a project command gets when work run alongside no longer needed its result (see projectCommand). */
const CANCELLED = new Cancelled().message;
/** The fields of that event; an informational one may carry the same note among others. */
const CANCELLED_FIELDS = new Set(["command", "note", "where"]);

/** A `command` event: a project command that ran or was stopped, or a step the loop took, with what came of it. */
function commandText(p: Payload): string {
  const command = firstLine(p.command, 80);
  const what = command || "a command";
  if (typeof p.code === "number") return p.code === 0 ? `Ran ${what}.` : `Ran ${what}: exit code ${p.code}.`;
  if (p.note === CANCELLED && Object.keys(p).every((k) => CANCELLED_FIELDS.has(k))) return `Stopped ${what}.`;
  // What happened, in the call site's own words: a note, what it waits for, or why it kept something.
  const said = firstLine(first(p.note, p.waiting, p.reason));
  if (said) return sentence(command ? `${capital(command)}: ${said}` : capital(said));
  return command ? sentence(capital(command)) : "Ran a command.";
}

/**
 * An `error` event: whichever field its call site used for what went wrong, and where. One that names
 * both what failed (`what`, `problem` or `note`) and the error itself (a cleanup that could not remove a
 * worktree, say) says both.
 */
function errorLine(p: Payload): string {
  const where = p.where ? ` (${str(p.where)})` : "";
  const failed = first(p.what, p.problem, p.note);
  const why = failed && first(p.error) ? firstLine(p.error) : "";
  const what = firstLine(why ? `${firstLine(failed)}: ${why}` : first(p.what, p.problem, p.error, p.note, p.reason, p.detail, p.value));
  if (what) return sentence(`Problem${where}: ${what}`);
  if (p.expected !== undefined && p.actual !== undefined) return `Problem${where}: expected ${str(p.expected)}, found ${str(p.actual)}.`;
  return `Problem${where}.`;
}

/** A `steer` event: a person's message, redirect or stop that reached a running session (see src/steering.ts). */
function steerText(e: EventRow, p: Payload, phaseName: (slug: string, seq: number) => string | undefined): string {
  const who = str(p.by) || "Someone";
  const seq = typeof p.seq === "number" ? p.seq : e.phase_seq;
  const name = seq !== null ? phaseName(e.slug, seq) : undefined;
  const session = name ? `the ${name} session` : "a session";
  const said = str(p.text).replace(/\s+/g, " ").trim();
  const text = said.length > 120 ? `${said.slice(0, 119)}…` : said;
  if (p.kind === "stop") return `${who} stopped ${session}.`;
  if (p.kind === "redirect") return sentence(`${who} redirected ${session}${text ? `: ${text}` : ""}`);
  return sentence(`${who} sent ${session} a message${text ? `: ${text}` : ""}`);
}

/**
 * An event in plain words, for the console's Activity, or null when it only matters to an engineer
 * (ticks, raw session events). `phaseName` names the phase an event belongs to.
 */
export function describeEvent(e: EventRow, phaseName: (slug: string, seq: number) => string | undefined = () => undefined): string | null {
  const p = parsePayload(e.payload);
  switch (e.type) {
    case "status_change": return p.to ? `${capital(plain(p.to))}.` : null;
    case "phase_start": return `Started ${str(p.name)}.`;
    case "phase_end": {
      const name = e.phase_seq !== null ? phaseName(e.slug, e.phase_seq) : undefined;
      const why = p.status === "fail" && p.error ? `: ${firstLine(p.error)}` : "";
      return sentence(`${capital(name ?? "a step")} ${ENDED[str(p.status)] ?? str(p.status)}${money(p.cost_usd)}${why}`);
    }
    case "question": {
      const name = e.phase_seq !== null ? phaseName(e.slug, e.phase_seq) : undefined;
      return sentence(`${capital(name ?? "a step")} asked: ${firstLine(p.question)}`);
    }
    case "gate_check": return `${capital(str(p.gate))} gate, ${str(p.check)}: ${GATE[str(p.result)] ?? str(p.result)}.`;
    case "command": return commandText(p);
    case "error": return errorLine(p);
    case "signal":
      if (p.name === "main_health") return `The tests on main ${HEALTH[str(p.result)] ?? str(p.result)}.`;
      // gh's own words when GitHub did not answer.
      if (p.name === GITHUB_SIGNAL && p.result === "fail") return sentence(`GitHub did not answer about pull requests: ${firstLine(p.output)}`);
      return p.output ? firstLine(p.output) : `${str(p.name)}: ${str(p.result)}.`;
    case "steer": return steerText(e, p, phaseName);
    case "stop": return p.by ? `${str(p.by)} stopped the session; the change keeps its status.` : "The loop is stopping.";
    case "pause": {
      const why = firstLine(first(p.reason, p.note));
      return why ? sentence(`Paused: ${why}`) : "Paused.";
    }
    case "person-changed-status":
      if (p.to === "deleted") return "A person deleted the change while a step ran, so the step wrote nothing.";
      return `A person set the status to ${plain(p.to)} while a step ran, so the step wrote nothing.`;
    case "stale-lock-removed": return "Removed a lock a stopped process left behind.";
    case "chat-message": return `${str(p.from) || "Someone"} wrote in chat.`;
    case "chat-request":
      if (p.result === "accepted") return `${str(p.by)} accepted it from ${str(p.via) || "chat"}.`;
      return p.kind === "new" ? `Chat wrote this change up for ${str(p.by)}.` : `A chat request was not applied (${str(p.result)}).`;
    case "request": {
      const who = str(p.by) || "Someone";
      const where = p.via ? ` from ${str(p.via)}` : "";
      if (p.result === "applied") return `${capital(str(p.what) || str(p.kind))} by ${who}${where}.`;
      if (p.result === "moved-on") return `${who}'s ${str(p.kind)}${where} was not applied: the change had moved on${p.status ? ` to ${str(p.status)}` : ""}.`;
      return `${who}'s ${str(p.kind)}${where} was not applied.`;
    }
    case "chat-pr": return "Chat's pull request of new intents changed.";
    case "judge": return firstLine(p.note) || null;
    default: return null;
  }
}

/** The event as one technical line: its type and its payload's fields, like `loopstra tail`. */
export function technicalText(e: EventRow): string {
  const fields = Object.entries(parsePayload(e.payload))
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
