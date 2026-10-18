import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentMessage } from "../../console/types";
import { apply, parseTarget, prune, slots, type Tile } from "../agents";
import type { About } from "../chat";
import { duration } from "../format";
import { route } from "../nav";
import { AgentTile, ChatTile, QuestionTile, tileId } from "../parts/AgentTile";
import { changes, loop, meta, now } from "../store";

/** How long the page waits before opening the agents stream again after the browser gave up on it. */
const RETRY_MS = 2000;
/** How long a tile a link pointed at stays highlighted. */
const FLASH_MS = 1600;

export function Agents() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [down, setDown] = useState(false);
  const [about, setAbout] = useState<{ about: About; label: string } | null>(null);
  // The tile a link pointed at, until it has been shown (it may arrive after the page opens). Read again
  // on every navigation, since the palette can point at another tile while this screen is open.
  const target = useRef<ReturnType<typeof parseTarget>>(null);
  const r = route.value;
  useEffect(() => { target.current = parseTarget(location.hash); }, [r]);

  useEffect(() => {
    let buffer: AgentMessage[] = [];
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setTiles((t) => apply(t, batch, Date.now()));
    };
    // Rows arrive in bursts; drawing them ten times a second keeps many sessions smooth.
    const timer = setInterval(flush, 100);
    const open = () => {
      const s = new EventSource("/api/agents/stream");
      source = s;
      s.onopen = () => setDown(false);
      s.onmessage = (ev) => {
        try { buffer.push(JSON.parse(ev.data as string) as AgentMessage); } catch { /* a bad frame is skipped */ }
      };
      s.onerror = () => {
        if (s !== source) return;
        setDown(true);
        // The browser reconnects by itself unless it gave up; then the page opens a new stream.
        if (s.readyState === EventSource.CLOSED && !retry) retry = setTimeout(() => { retry = null; open(); }, RETRY_MS);
      };
    };
    open();
    return () => {
      clearInterval(timer);
      if (retry) clearTimeout(retry);
      source?.close();
      source = null;
    };
  }, []);

  const t = now.value;
  // Finished tiles leave after a while, checked on the clock's tick.
  useEffect(() => { setTiles((x) => prune(x, Date.now())); }, [t]);

  const chatOn = !!meta.value?.chat;
  const shown = slots(tiles, changes.value, chatOn);

  // Once the tile a link named is there: scroll to it, highlight it, and for Message put the cursor in its box.
  useEffect(() => {
    const want = target.current;
    if (!want) return;
    const el = document.getElementById(tileId(want.key));
    if (!el) return;
    target.current = null;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), FLASH_MS);
    if (want.message) el.querySelector<HTMLInputElement>(".steer input")?.focus();
  }, [tiles, r]);

  const ask = (tile: Tile) => () => {
    const a = tile.agent;
    setAbout({ about: { slug: a.slug, title: a.title, seq: a.seq }, label: `${a.title} › ${a.name}` });
    document.getElementById("agent-chat")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const working = tiles.filter((x) => x.endedAt === null).length;
  const asking = shown.some((s) => s.kind === "question");
  const l = loop.value;
  return (
    <section class="view wide">
      <div class="view-head">
        <h1>Agents</h1>
        {working > 0 && <span class="muted">{working} {working === 1 ? "agent is" : "agents are"} working</span>}
      </div>
      {down && <p class="muted" role="status">Reconnecting…</p>}
      {!working && !asking && (
        <div class="empty">No agent is working.{l?.nextCheck ? ` The next check is in ${duration(Math.max(0, Date.parse(l.nextCheck) - t))}.` : ""}</div>
      )}
      <div class="tiles">
        {shown.map((s) => (s.kind === "question" ? <QuestionTile key={`q:${s.change.slug}`} change={s.change} />
          : s.kind === "agent" ? <AgentTile key={s.tile.key} tile={s.tile} onAsk={chatOn ? ask(s.tile) : null} />
          : <ChatTile key="chat" about={about?.about ?? null} label={about?.label ?? null} onClear={() => setAbout(null)} />))}
      </div>
    </section>
  );
}
