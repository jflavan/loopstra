import { frame, type Hub, type Send } from "./hub";
import { followSession } from "./session";
import { agentKey, type AgentMessage } from "./types";

/**
 * The Agents screen's stream: every running change session, each message tagged with the session's
 * key. It keeps the hub looking for as long as it is open (as a page that ignores the hub's frames)
 * and, every `intervalMs`, reads the running sessions from the hub's newest model. A session it has
 * not seen yet is announced with `open` and then followed to its end, the way its own session stream
 * would be (from its start, so a page that comes back gets every row again). After its first look it
 * sends `sync` with the keys it follows. Gives the function that stops it all, once the page is gone.
 */
export async function streamAgents(root: string, hub: Hub, send: Send, intervalMs = 250): Promise<() => void> {
  const followers = new Map<string, () => void>();
  const seen = new Set<string>();
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let off: (() => Promise<void>) | null = null;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    for (const unfollow of followers.values()) unfollow();
    followers.clear();
    void off?.();
  };
  /** Sends one message; false once the page is gone (everything is then stopped). */
  const out = (msg: AgentMessage): boolean => {
    if (done) return false;
    if (send(frame(msg))) return true;
    stop();
    return false;
  };
  const look = () => {
    for (const agent of hub.latest()?.sections.running.now ?? []) {
      const key = agentKey(agent.slug, agent.seq);
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
  };
  off = await hub.connect(() => !done);
  look();
  out({ type: "sync", keys: [...seen] });
  if (!done) timer = setInterval(look, intervalMs);
  return stop;
}
