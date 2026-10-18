import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { aboutOf, aboutPrefix, addLines, type About, type Line } from "../chat";
import { drawer, meta } from "../store";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

interface ChatMessage { id: number; from: "person" | "loopstra"; text: string }

/** A half-typed message, kept when the drawer is closed and opened again in this tab. */
const draft = signal("");
/** The context (and session) the orchestrator was last told about, so the prefix is said once per opening context and not again after a close and reopen. */
let toldAbout = "";

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
        <span class="muted about">{d.about ? `About ${d.about.title}` : "Ask how things are going, or talk through a new change."}</span>
        <button class="ghost" onClick={close} aria-label="Close"><Icon name="close" /></button>
      </header>
      {meta.value && !meta.value.chat ? <p class="pad muted">Chat is off in this console: it was started with --no-chat.</p> : <Chat about={d.about} />}
    </aside>
  );
}

function Chat({ about }: { about: About | null }) {
  const [thread] = useState(threadId);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const text = draft.value;
  const setText = (v: string | ((cur: string) => string)) => { draft.value = typeof v === "function" ? v(draft.value) : v; };
  const after = useRef(0);
  const announcementsAfter = useRef(-1);
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // The poll and a send can both ask for messages after the same id; one read at a time, and one more afterwards if asked.
  const reading = useRef(false);
  const again = useRef(false);

  const refresh = async () => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        again.current = false;
        await read();
      } while (again.current);
    } finally {
      reading.current = false;
    }
  };
  const read = async () => {
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
      // A line is added once even if the same message arrives in two reads.
      if (more.length) setLines((l) => addLines(l, more));
      setBusy(j.busy);
    } catch { /* the next poll tries again */ }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, []);
  // The cursor is in the box when the drawer opens, and when a button elsewhere reopens it for another change.
  useEffect(() => { box.current?.focus(); }, [about?.slug, about?.title]);
  useEffect(() => { log.current?.scrollTo(0, log.current.scrollHeight); }, [lines, busy]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    // The first message after the drawer was opened from somewhere says what it is about, and sends the
    // change (and session) with it, so the orchestrator hears its context.
    const prefix = aboutPrefix(about);
    const key = prefix ? `${prefix}|${about?.seq ?? ""}` : "";
    const first = !!key && toldAbout !== key;
    const message = first ? `${prefix}${body}` : body;
    const context = first ? aboutOf(about) : null;
    toldAbout = key;
    setText("");
    setBusy(true);
    // A send that never reached the server must not leave the drawer waiting for an answer.
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread, text: message, ...(context ? { about: context } : {}) }) }).catch(() => null);
    if (!r?.ok) {
      // The orchestrator has not heard what this was about yet.
      toldAbout = "";
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
          ref={box}
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
