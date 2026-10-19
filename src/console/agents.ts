import { frame, PING, type Hub, type Send } from "./hub";
import { followSession } from "./session";
import { agentKey, type AgentMessage } from "./types";

interface AgentsOptions {
  /** How often it reads the running sessions, and each follower reads its file (ms). */
  intervalMs?: number;
  /** How often it pings while nothing else is sent, so the page can tell a quiet stream from a dead one (ms). */
  pingMs?: number;
  /**
   * How long a session may be missing from the running ones before its follower is let go (ms). A
   * session that ended is followed to its end in a moment; one still recorded as running but no
   * longer current (its loop was killed) would otherwise be followed for as long as the page is open.
   */
  goneMs?: number;
}

/**
 * The Agents screen's stream: every running change session, each message tagged with the session's
 * key. It keeps the hub looking for as long as it is open (as a page that ignores the hub's frames)
 * and, every `intervalMs`, reads the running sessions from the hub's newest model. A session it has
 * not seen yet is announced with `open` and then followed to its end, the way its own session stream
 * would be (from its start, so a page that comes back gets every row again). After its first look it
 * sends `sync` with the keys it follows. Gives the function that stops it all, once the page is gone.
 */
export async function streamAgents(root: string, hub: Hub, send: Send, opts: AgentsOptions = {}): Promise<() => void> {
  const intervalMs = opts.intervalMs ?? 250;
  const goneMs = opts.goneMs ?? 5000;
  const followers = new Map<string, () => void>();
  const seen = new Set<string>();
  /** When each followed session was first seen missing from the running ones. */
  const missing = new Map<string, number>();
  let done = false;
  let timers: Array<ReturnType<typeof setInterval>> = [];
  let off: (() => Promise<void>) | null = null;
  const stop = () => {
    if (done) return;
    done = true;
    for (const t of timers) clearInterval(t);
    for (const unfollow of followers.values()) unfollow();
    followers.clear();
    void off?.();
  };
  /** Sends one frame; false once the page is gone (everything is then stopped). */
  const write = (text: string): boolean => {
    if (done) return false;
    if (send(text)) return true;
    stop();
    return false;
  };
  const out = (msg: AgentMessage): boolean => write(frame(msg));
  const look = () => {
    const model = hub.latest();
    if (!model) return;
    const running = new Set<string>();
    for (const agent of model.sections.running.now) {
      const key = agentKey(agent.slug, agent.seq);
      running.add(key);
      if (done) return;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!out({ type: "open", agent })) return;
      const unfollow = followSession(root, agent.slug, agent.seq, 0, (msg) => out({ ...msg, key }), () => followers.delete(key), intervalMs);
      // The hub saw it running, but its row cannot be read now: say it ended rather than leave its tile waiting.
      if (!unfollow) out({ type: "end", key });
      else if (done) unfollow();
      else followers.set(key, unfollow);
    }
    const now = Date.now();
    for (const [key, unfollow] of followers) {
      if (running.has(key)) { missing.delete(key); continue; }
      const since = missing.get(key) ?? now;
      missing.set(key, since);
      if (now - since < goneMs) continue;
      unfollow();
      followers.delete(key);
      missing.delete(key);
      if (!out({ type: "end", key })) return;
    }
  };
  off = await hub.connect(() => !done);
  look();
  out({ type: "sync", keys: [...seen] });
  if (!done) timers = [setInterval(look, intervalMs), setInterval(() => write(PING), opts.pingMs ?? 15_000)];
  return stop;
}
