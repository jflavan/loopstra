import { loadConfig } from "../config";
import { heartbeatState, readHeartbeat } from "../heartbeat";
import { Trace, type EventRow } from "../trace";

export interface TailCursor {
  /** The newest event id printed so far. */
  lastId: number;
  /** The loop's state, stopping flag, and current change as last printed, to print only changes. */
  loopKey: string | null;
}

/**
 * The lines to print since `cursor` (which it advances): new events, optionally for one change,
 * and a line whenever the loop's heartbeat state changes. The first call prints the last 50 events.
 */
export function tailLines(root: string, trace: Trace, cursor: TailCursor, opts: { slug?: string; pollSeconds: number; now?: Date }): string[] {
  const out: string[] = [];
  const hb = readHeartbeat(root);
  const loop = heartbeatState(hb, opts.pollSeconds, opts.now);
  const key = `${loop.state}|${hb?.stopping ? "stopping" : ""}|${loop.current?.slug ?? ""}`;
  if (key !== cursor.loopKey) {
    out.push(`${clock(opts.now ?? new Date())} ${"loop".padEnd(24)} ${"heartbeat".padEnd(13)} ${loop.text}`);
    cursor.loopKey = key;
  }
  const first = cursor.lastId === 0;
  const rows = opts.slug
    ? (first ? lastOf(trace.events(opts.slug, 0, 100_000), 50) : trace.events(opts.slug, cursor.lastId))
    : trace.recentEvents(cursor.lastId, first ? 50 : 500);
  for (const e of rows) {
    out.push(...format(e));
    cursor.lastId = Math.max(cursor.lastId, e.id);
  }
  return out;
}

/** Streams events until the process is interrupted. */
export async function tail(root: string, slug?: string): Promise<never> {
  const pollSeconds = await loadConfig(root).then((c) => c.poll_seconds, () => 60);
  const trace = Trace.open(root);
  const cursor: TailCursor = { lastId: 0, loopKey: null };
  for (;;) {
    for (const line of tailLines(root, trace, cursor, { slug, pollSeconds })) console.log(line);
    await Bun.sleep(1000);
  }
}

function lastOf<T>(rows: T[], n: number): T[] {
  return rows.slice(Math.max(0, rows.length - n));
}

function clock(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

/** One line per event; a phase that was refused commands gets a second line naming them. */
function format(e: EventRow): string[] {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(e.payload) as Record<string, unknown>; } catch { payload = { payload: e.payload }; }
  const denied = Array.isArray(payload?.denied) ? (payload.denied as string[]) : [];
  const detail = Object.entries(payload ?? {})
    .filter(([k]) => k !== "stack" && k !== "denied")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ").replace(/\s*\r?\n\s*/g, " ").slice(0, 200);
  const head = `${clock(new Date(e.ts))} ${e.slug.padEnd(24)} `;
  const lines = [`${head}${e.type.padEnd(13)} ${detail}`];
  if (denied.length) lines.push(`${head}${"not allowed".padEnd(13)} ${deniedText(denied)}`);
  return lines;
}

/** "2 commands were not allowed: Bash(git tag v1), Bash(git push)". */
export function deniedText(denied: string[]): string {
  return `${denied.length} ${denied.length === 1 ? "command was" : "commands were"} not allowed: ${denied.join(", ")}`;
}
