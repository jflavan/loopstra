import type { AgentSetupView } from "../console/types";
import { costSoFar } from "./format";

/** What is known of one session: from its stream, from the trace once it is over, and the clock. */
interface SessionKnown {
  /** When it started (ISO). */
  started: string;
  /** When it ended (ISO), as its stream said; null while it runs, or when the stream never said. */
  ended: string | null;
  /** Its status as last heard from its stream: "running" while it runs. */
  status: string;
  /**
   * What is known of it once it is over, from the trace (a finished row, a step's detail) or from its
   * own last rows (a chat turn's cost): null while it runs. Over with nothing known: an empty object.
   */
  finished: { status?: string; ended?: string | null; costUsd?: number | null } | null;
  /** The estimate's rate, in dollars a minute; undefined when the console has none. */
  rate: number | undefined;
  /** The clock, in ms. For a session over with no end time known: when the page heard it end. */
  now: number;
}

/** The facts a session's card, tile and page show: how long, what it cost (an estimate while it runs), and how it stands. */
interface SessionFacts {
  elapsedMs: number;
  /** Null when there is nothing to say: no rate while it runs, nothing recorded once over. */
  cost: number | null;
  estimate: boolean;
  /** Its status: the stream's, or the trace's once the stream only said "running"; "running" when nothing said more. */
  status: string;
}

/**
 * The derivation three places share. A session runs until its stream says otherwise or the trace
 * has its finished row; while it runs its cost is the minutes so far at the rate, and its clock
 * runs; once over, its cost is what was recorded and its clock stops when it ended.
 */
export function sessionFacts(k: SessionKnown): SessionFacts {
  const status = k.status !== "running" ? k.status : k.finished?.status ?? "running";
  const running = status === "running" && k.finished === null;
  const endedAt = k.ended ?? k.finished?.ended ?? null;
  const elapsedMs = (endedAt ? Date.parse(endedAt) : k.now) - Date.parse(k.started);
  const cost = running ? (k.rate === undefined ? null : costSoFar(k.started, k.now, k.rate)) : k.finished?.costUsd ?? null;
  return { elapsedMs, cost, estimate: running && cost !== null, status };
}

/** The label and text of each line a session's facts add for the setup it ran as; none without a setup. Empty lists are left out. */
export function setupFacts(s: AgentSetupView | null): Array<[string, string]> {
  if (!s) return [];
  const lines: Array<[string, string]> = [["Agent", s.agent ?? "none"]];
  const add = (label: string, names: string[]) => { if (names.length) lines.push([label, names.join(", ")]); };
  add("Subagents", s.subagents.map((n) => (s.models[n] ? `${n} (${s.models[n]})` : n)));
  add("Teams", s.teams);
  add("Skills", s.skills);
  add("Tools", s.tools);
  add("MCP tools", s.mcpTools);
  if (s.sources === "repo") lines.push(["Sources", "repo only"]);
  return lines;
}
