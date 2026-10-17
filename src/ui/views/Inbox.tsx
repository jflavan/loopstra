import { useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../attention";
import { navigate } from "../nav";
import { Link } from "../parts/Link";
import { screenKeys } from "../shortcuts";
import { inbox, openDrawer } from "../store";

/** Kinds that mean something is wrong rather than waiting: drawn in red. */
const BAD = new Set(["blocked", "health", "unreadable", "config"]);

export function Inbox() {
  const items = inbox.value;
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const sel = Math.min(at, Math.max(0, (items?.length ?? 1) - 1));
  atRef.current = sel;
  useEffect(() => {
    const last = () => Math.max(0, (inbox.value?.length ?? 1) - 1);
    screenKeys.set("j", () => setAt((k) => Math.min(k + 1, last())));
    screenKeys.set("k", () => setAt((k) => Math.max(Math.min(k, last()) - 1, 0)));
    screenKeys.set("o", () => {
      const it = inbox.value?.[atRef.current];
      if (it?.slug) navigate(`/c/${it.slug}`);
    });
    return () => { for (const k of ["j", "k", "o"]) screenKeys.delete(k); };
  }, []);
  useEffect(() => { document.getElementById(`inbox-${sel}`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  if (!items) return <section class="view"><p class="muted">Connecting…</p></section>;
  return (
    <section class="view">
      <div class="view-head">
        <h1>Inbox</h1>
        {items.length > 0 && <span class="muted">{items.length} {items.length === 1 ? "thing needs" : "things need"} you</span>}
      </div>
      {items.length === 0 ? <div class="calm">Nothing needs you right now.</div> : (
        <div class="inbox">
          {items.map((it, k) => <Item key={`${it.kind}:${it.slug ?? ""}:${it.title}`} it={it} index={k} selected={k === sel} onSelect={() => setAt(k)} />)}
        </div>
      )}
      {items.length > 0 && <p class="muted"><kbd>J</kbd> <kbd>K</kbd> move, <kbd>O</kbd> opens the change.</p>}
    </section>
  );
}

function Item({ it, index, selected, onSelect }: { it: AttentionItem; index: number; selected: boolean; onSelect: () => void }) {
  return (
    <article id={`inbox-${index}`} aria-current={selected ? "true" : undefined} class={`inbox-item${BAD.has(it.kind) ? " bad" : ""}${selected ? " selected" : ""}`} onClick={onSelect}>
      <span class="kind">{it.label}</span>
      <b>{it.slug ? <Link href={`/c/${it.slug}`}>{it.title}</Link> : it.title}</b>
      <span>{it.what}</span>
      <div class="actions">
        {it.slug && <Link href={`/c/${it.slug}`} class="btn">Open</Link>}
        <button class="btn" onClick={(e) => { e.stopPropagation(); openDrawer(it.title); }}>Ask the orchestrator</button>
      </div>
    </article>
  );
}
