import type { LoopSection } from "../console/types";

/** "$0.81"; "~$0.81" for an estimate; "$0" for nothing worth a cent. */
export function usd(n: number, estimate = false): string {
  const v = n < 0.005 ? "$0" : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
  return estimate ? `~${v}` : v;
}

/** "45s", "6m 12s", "2h 3m", "4d 4h"; a dash for a time that could not be read. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long ago, short: "now", "4s", "3m", "2h", "5d"; a dash for a time that could not be read. */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** "14:02" in local time, with the day in front when it is not today. */
export function clock(iso: string, now: number): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

/** A running session's estimated cost: the minutes so far times the rate (the CLI reports cost only at the end). */
export function costSoFar(started: string, now: number, usdPerMinute: number): number {
  return Math.max(0, (now - Date.parse(started)) / 60_000) * usdPerMinute;
}

/** "claude-sonnet-5-5" as "sonnet 5.5". */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)(?:-\d{8})?$/, " $1.$2").replace(/-/g, " ");
}

const STATE: Record<LoopSection["state"], string> = { running: "Running", paused: "Paused", stopped: "Stopped", "not-responding": "Not responding" };

/** The loop pill's words: its state and how many agents work. The full sentence goes in its tooltip. */
export function pillText(loop: Pick<LoopSection, "state" | "text"> & { working: unknown[] }): string {
  if (loop.text.startsWith("Stopping")) return "Stopping";
  const n = loop.working.length;
  return n ? `${STATE[loop.state]} · ${n} ${n === 1 ? "agent" : "agents"}` : STATE[loop.state];
}
