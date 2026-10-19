import { agentKey, ANY_SLUG, type AgentMessage, type ChangeSummary, type RunningPhase, type SessionMessage, type TranscriptItem } from "../console/types";
import { addItems, EMPTY, type Shown } from "./transcript";

/** How long a finished session's tile stays, so it does not vanish while someone is typing to it. */
export const FADE_MS = 60_000;

/** One session on the Agents screen. `endedAt`: when the page heard it ended (ms), null while it runs. */
export interface Tile {
  key: string;
  agent: RunningPhase;
  shown: Shown;
  phase: Extract<SessionMessage, { type: "phase" }> | null;
  endedAt: number | null;
}

/** What the grid shows, in its order. */
type Slot =
  | { kind: "question"; change: ChangeSummary }
  | { kind: "agent"; tile: Tile }
  | { kind: "chat" };

/**
 * `tiles` with `msgs` applied, at time `now`; `tiles` itself is left as it was, and comes back as it
 * was when nothing changed. Rows are gathered per tile and added in one go, since a session coming
 * back sends hundreds at once. A new session's tile goes at the end, so no tile moves under the
 * person; `open` for a known one starts its rows over (the stream sends them again from the start).
 */
export function apply(tiles: Tile[], msgs: AgentMessage[], now: number): Tile[] {
  let out = tiles;
  const pending = new Map<string, TranscriptItem[]>();
  const edit = (key: string, fn: (t: Tile) => Tile) => {
    const k = out.findIndex((t) => t.key === key);
    if (k < 0) return;
    if (out === tiles) out = [...tiles];
    out[k] = fn(out[k]!);
  };
  const flush = (key: string) => {
    const rows = pending.get(key);
    if (!rows) return;
    pending.delete(key);
    edit(key, (t) => ({ ...t, shown: addItems(t.shown, rows) }));
  };
  for (const m of msgs) {
    if (m.type === "open") {
      const key = agentKey(m.agent.slug, m.agent.seq);
      pending.delete(key);
      const fresh: Tile = { key, agent: m.agent, shown: EMPTY, phase: null, endedAt: null };
      if (out.some((t) => t.key === key)) edit(key, () => fresh);
      else out = [...out, fresh];
    } else if (m.type === "sync") {
      const live = new Set(m.keys);
      for (const t of out) {
        if (t.endedAt !== null || live.has(t.key)) continue;
        flush(t.key);
        edit(t.key, (x) => ({ ...x, endedAt: now }));
      }
    } else if (m.type === "item") {
      if (!out.some((t) => t.key === m.key)) continue;
      const rows = pending.get(m.key);
      if (rows) rows.push(m.item);
      else pending.set(m.key, [m.item]);
    } else if (m.type === "phase") {
      flush(m.key);
      const { key: _key, ...phase } = m;
      edit(m.key, (t) => ({ ...t, phase }));
    } else if (m.type === "end") {
      flush(m.key);
      edit(m.key, (t) => (t.endedAt === null ? { ...t, endedAt: now } : t));
    }
  }
  for (const key of [...pending.keys()]) flush(key);
  return out;
}

/** `tiles` without the finished ones that have stayed FADE_MS; the same array when none has. */
export function prune(tiles: Tile[], now: number): Tile[] {
  const kept = tiles.filter((t) => t.endedAt === null || now - t.endedAt < FADE_MS);
  return kept.length === tiles.length ? tiles : kept;
}

/**
 * The grid in order: changes with a question first (they need a person), then the tiles as they
 * came, then the orchestrator when chat is on. A change waiting on its question has ended its session;
 * that finished tile is left out, so the change shows once.
 */
export function slots(tiles: Tile[], changes: ChangeSummary[] | null, chat: boolean): Slot[] {
  const asking = (changes ?? []).filter((c) => c.question);
  const asks = new Set(asking.map((c) => c.slug));
  const out: Slot[] = asking.map((change) => ({ kind: "question", change }));
  for (const tile of tiles) if (!(tile.endedAt !== null && asks.has(tile.agent.slug))) out.push({ kind: "agent", tile });
  if (chat) out.push({ kind: "chat" });
  return out;
}

/** The tile a link points at (`#<slug>:<seq>`, or `#<slug>:<seq>:message` to put the cursor in its box), or null. */
export function parseTarget(hash: string): { key: string; message: boolean } | null {
  const m = hash.match(/^#([^:]+):(\d+)(:message)?$/);
  if (!m || !ANY_SLUG.test(m[1]!)) return null;
  return { key: agentKey(m[1]!, Number(m[2])), message: !!m[3] };
}
