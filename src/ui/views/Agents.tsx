import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentMessage } from "../../console/types";
import { apply, parseTarget, prune, slots, type Tile } from "../agents";
import type { About } from "../chat";
import { duration } from "../format";
import { route } from "../nav";
import { AgentTile, ChatTile, QuestionTile, tileId } from "../parts/AgentTile";
import { changes, loop, meta, now } from "../store";
import { follow } from "../stream";

/** How long a tile a link pointed at stays highlighted. */
const FLASH_MS = 1600;

export function Agents() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [down, setDown] = useState(false);
  // Whether the stream has said which sessions run: until then the screen cannot say none does.
  const [synced, setSynced] = useState(false);
  const [about, setAbout] = useState<{ about: About; label: string } | null>(null);
  // The tile a link pointed at, until it has been shown (it may arrive after the page opens). Read again
  // on every navigation, since the palette can point at another tile while this screen is open.
  const target = useRef<ReturnType<typeof parseTarget>>(null);
  const r = route.value;
  useEffect(() => { target.current = parseTarget(location.hash); }, [r]);

  useEffect(() => {
    let buffer: AgentMessage[] = [];
    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setTiles((t) => apply(t, batch, Date.now()));
      // Said only once the tiles sent before it are applied, so the screen never says no agent works while their opens wait here.
      if (batch.some((m) => m.type === "sync")) setSynced(true);
    };
    // Rows arrive in bursts; drawing them ten times a second keeps many sessions smooth.
    const timer = setInterval(flush, 100);
    // A stream opened again sends every running session from its start (see streamAgents), so it resumes from nothing.
    const stop = follow(() => "/api/agents/stream", {
      message(data) {
        try {
          const msg = JSON.parse(data) as AgentMessage;
          buffer.push(msg);
          // The sync settles what runs at once, with the opens that came before it.
          if (msg.type === "sync") flush();
        } catch { /* a bad frame is skipped */ }
      },
      live() { setDown(false); },
      down() { setDown(true); },
    });
    return () => {
      clearInterval(timer);
      stop();
    };
  }, []);

  const t = now.value;
  // Finished tiles leave after a while, checked on the clock's tick.
  useEffect(() => { setTiles((x) => prune(x, Date.now())); }, [t]);

  const chatOn = !!meta.value?.chat;
  const shown = slots(tiles, changes.value, chatOn);

  // Once the tile a link named is there: scroll to it, highlight it, and for Message put the cursor in its box
  // (without a jump of its own, which would cut the smooth scroll short).
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flash.current) clearTimeout(flash.current); }, []);
  useEffect(() => {
    const want = target.current;
    if (!want) return;
    const el = document.getElementById(tileId(want.key));
    if (!el) return;
    target.current = null;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.add("flash");
    if (flash.current) clearTimeout(flash.current);
    flash.current = setTimeout(() => el.classList.remove("flash"), FLASH_MS);
    if (want.message) el.querySelector<HTMLInputElement>(".steer input")?.focus({ preventScroll: true });
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
      {synced && !down && !working && !asking && (
        <div class="empty">No agent is working.{l?.nextCheck ? ` The next check is in ${duration(Math.max(0, Date.parse(l.nextCheck) - t))}.` : ""}</div>
      )}
      <div class="agent-grid">
        {shown.map((s) => (s.kind === "question" ? <QuestionTile key={`q:${s.change.slug}`} change={s.change} />
          : s.kind === "agent" ? <AgentTile key={s.tile.key} tile={s.tile} onAsk={chatOn ? ask(s.tile) : null} />
          : <ChatTile key="chat" about={about?.about ?? null} label={about?.label ?? null} onClear={() => setAbout(null)} />))}
      </div>
    </section>
  );
}
