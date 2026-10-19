import { useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../attention";
import { navigate } from "../nav";
import { stepAt } from "../palette";
import { Actions } from "../parts/Actions";
import { Connecting } from "../parts/Connecting";
import { Link } from "../parts/Link";
import { act, beforeOf, bodyFor } from "../requests";
import { screenKeys } from "../shortcuts";
import { changes, inbox, openDrawer } from "../store";

/** Kinds that mean something is wrong rather than waiting: drawn in red. */
const BAD = new Set(["blocked", "health", "unreadable", "config"]);

export function Inbox() {
  const items = inbox.value;
  const [at, setAt] = useState(0);
  const atRef = useRef(0);
  const sel = Math.min(at, Math.max(0, (items?.length ?? 1) - 1));
  atRef.current = sel;
  useEffect(() => {
    const length = () => inbox.value?.length ?? 0;
    screenKeys.set("j", () => setAt((k) => stepAt(k, 1, length())));
    screenKeys.set("k", () => setAt((k) => stepAt(k, -1, length())));
    screenKeys.set("o", () => {
      const it = inbox.value?.[atRef.current];
      if (it?.slug) navigate(`/c/${it.slug}`);
    });
    // Approves the selected item's change, when it offers Approve.
    screenKeys.set("a", () => {
      const it = inbox.value?.[atRef.current];
      const c = it?.slug ? changes.value?.find((x) => x.slug === it.slug) : undefined;
      const o = c?.offers.find((x) => x.kind === "approve");
      if (c && o) void act(bodyFor(c, o), beforeOf(c), `${o.label}, ${c.slug}`);
    });
    return () => { for (const k of ["j", "k", "o", "a"]) screenKeys.delete(k); };
  }, []);
  useEffect(() => { document.getElementById(`inbox-${sel}`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  if (!items) return <Connecting />;
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
      {items.length > 0 && <p class="muted"><kbd>J</kbd> <kbd>K</kbd> move, <kbd>O</kbd> opens the change, <kbd>A</kbd> approves it.</p>}
    </section>
  );
}

function Item({ it, index, selected, onSelect }: { it: AttentionItem; index: number; selected: boolean; onSelect: () => void }) {
  const change = it.slug ? changes.value?.find((c) => c.slug === it.slug) : undefined;
  return (
    <article id={`inbox-${index}`} aria-current={selected ? "true" : undefined} class={`inbox-item${BAD.has(it.kind) ? " bad" : ""}${selected ? " selected" : ""}`} onClick={onSelect}>
      <span class="kind">{it.label}</span>
      <b>{it.slug ? <Link href={`/c/${it.slug}`}>{it.title}</Link> : it.title}</b>
      <span>{it.what}</span>
      <div class="actions">
        {change && <Actions change={change} compact />}
        {it.slug && <Link href={`/c/${it.slug}`} class="btn">Open</Link>}
        <button class="btn" onClick={(e) => { e.stopPropagation(); openDrawer({ slug: it.slug ?? undefined, title: it.title }); }}>Ask the orchestrator</button>
      </div>
    </article>
  );
}
