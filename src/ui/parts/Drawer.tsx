import { useEffect, useRef, useState } from "preact/hooks";
import { drawer, meta } from "../store";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

interface ChatMessage { id: number; from: "person" | "loopstra"; text: string }
interface Line { key: string; kind: "person" | "loopstra" | "announce"; text: string }

/** One conversation per tab, kept across reloads. The server accepts only this plain shape. */
function threadId(): string {
  const fresh = () => `tab-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  try {
    let id = sessionStorage.getItem("loopstra-chat");
    if (!id) {
      id = fresh();
      sessionStorage.setItem("loopstra-chat", id);
    }
    return id;
  } catch {
    return fresh();
  }
}

export function Drawer() {
  const d = drawer.value;
  if (!d.open) return null;
  const close = () => { drawer.value = { ...d, open: false }; };
  return (
    <aside class="drawer" aria-label="The orchestrator">
      <header>
        <b>Orchestrator</b>
        <span class="muted about">{d.about ? `About ${d.about}` : "Ask how things are going, or talk through a new change."}</span>
        <button class="ghost" onClick={close} aria-label="Close"><Icon name="close" /></button>
      </header>
      {meta.value && !meta.value.chat ? <p class="pad muted">Chat is off in this console: it was started with --no-chat.</p> : <Chat about={d.about} />}
    </aside>
  );
}

function Chat({ about }: { about: string | null }) {
  const [thread] = useState(threadId);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const after = useRef(0);
  const announcementsAfter = useRef(-1);
  const toldAbout = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const r = await fetch(`/api/chat?thread=${thread}&after=${after.current}&announcementsAfter=${announcementsAfter.current}`);
      if (!r.ok) return;
      const j = await r.json() as { messages: ChatMessage[]; busy: boolean; announcements: Array<{ id: number; text: string }>; lastAnnouncementId: number };
      const more: Line[] = [
        ...j.messages.map((m) => ({ key: `m${m.id}`, kind: m.from, text: m.text })),
        ...j.announcements.map((a) => ({ key: `a${a.id}`, kind: "announce" as const, text: a.text })),
      ];
      if (j.messages.length) after.current = j.messages.at(-1)!.id;
      announcementsAfter.current = j.lastAnnouncementId;
      if (more.length) setLines((l) => [...l, ...more]);
      setBusy(j.busy);
    } catch { /* the next poll tries again */ }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [lines, busy]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    // The first message after the drawer was opened from somewhere says what it is about.
    const message = about && toldAbout.current !== about ? `About ${about}: ${body}` : body;
    toldAbout.current = about;
    setText("");
    setBusy(true);
    // A send that never reached the server must not leave the drawer waiting for an answer.
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread, text: message }) }).catch(() => null);
    if (!r?.ok) {
      setText((cur) => cur || body);
      const why = r?.status === 409 ? "Still answering your last message." : "That message could not be sent.";
      setLines((l) => [...l, { key: `e${Date.now()}`, kind: "announce", text: why }]);
    }
    await refresh();
  };

  return (
    <>
      <div class="chat-log" ref={log} aria-live="polite">
        {!lines.length && <p class="muted">Try "what's blocked?", "what merged this week?", or describe something new you want built.</p>}
        {lines.map((l) => (l.kind === "loopstra"
          ? <div key={l.key} class="msg loopstra"><Markdown text={l.text} /></div>
          : <div key={l.key} class={`msg ${l.kind}`}>{l.text}</div>))}
        {busy && <div class="msg loopstra muted">Thinking…</div>}
      </div>
      <form class="chat-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea
          rows={2}
          value={text}
          placeholder="Message the orchestrator"
          aria-label="Message the orchestrator"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button class="btn primary" type="submit" disabled={busy || !text.trim()}>Send</button>
      </form>
    </>
  );
}
