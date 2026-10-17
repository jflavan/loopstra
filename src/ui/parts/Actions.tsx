import { useEffect, useRef, useState } from "preact/hooks";
import { PRIORITY_NAMES, type ChangeSummary, type Offer } from "../../console/types";
import { act, bodyFor } from "../requests";
import { requests } from "../store";

/** Actions that open a small form first: a note, a reason, or a confirmation. */
type Form = "send-back" | "hold" | "close";
const FORMS: ReadonlySet<string> = new Set(["send-back", "hold", "close"]);
/** Drawn as the main button. */
const PRIMARY: ReadonlySet<string> = new Set(["approve", "retry", "accept"]);
/** What the inbox shows: what decides where the change goes next. */
const COMPACT: ReadonlySet<string> = new Set(["approve", "send-back", "retry", "accept", "release"]);

/**
 * The controls for one change: its offers as buttons (send back, hold and close open a small form
 * first), and the requests it has waiting for the loop. `compact` shows only the deciding ones.
 */
export function Actions({ change, compact = false }: { change: ChangeSummary; compact?: boolean }) {
  const [form, setForm] = useState<Form | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, [form]);
  const waiting = (requests.value ?? []).filter((r) => r.slug === change.slug);
  const shown = change.offers.filter((o) => !compact || COMPACT.has(o.kind));
  if (!shown.length && !waiting.length) return null;
  const close = () => { setForm(null); setText(""); };
  const run = async (o: Offer, input: { note?: string; priority?: string; reason?: string } = {}) => {
    setBusy(true);
    try {
      await act(bodyFor(change, o, input), { note: change.note, priority: change.priority }, `${o.label}, ${change.slug}`);
    } finally {
      setBusy(false);
      close();
    }
  };
  const offer = (kind: string) => shown.find((o) => o.kind === kind)!;
  const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  // A click here is not a click on the inbox item or card around it.
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class="controls" onClick={stop}>
      {waiting.length > 0 && <span class="badge warn">Waiting for the loop: {waiting.map((w) => w.label).join(", ")}</span>}
      {form === null && shown.map((o) => o.kind === "priority" ? (
        <label key="priority" class="prio-pick">
          Priority
          <select value={change.priority} disabled={busy} onChange={(e) => { const p = e.currentTarget.value; if (p !== change.priority) void run(o, { priority: p }); }}>
            {PRIORITY_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      ) : (
        <button key={`${o.kind}:${o.to ?? ""}`} type="button" disabled={busy}
          class={`btn${PRIMARY.has(o.kind) ? " primary" : ""}${o.kind === "close" ? " danger" : ""}`}
          onClick={() => (FORMS.has(o.kind) ? setForm(o.kind as Form) : void run(o))}>
          {o.label}
        </button>
      ))}
      {form === "send-back" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(offer("send-back"), { note: text }); }}>
          <textarea ref={field} value={text} placeholder="What should change? The agent gets this note." aria-label="What should change" maxLength={4000} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={escape} />
          <button class="btn primary" type="submit" disabled={busy || !text.trim()}>Send back</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form === "hold" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); void run(offer("hold"), { reason: text }); }}>
          <input ref={field} type="text" value={text} placeholder="Why? (optional)" aria-label="Why it is held" maxLength={300} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={escape} />
          <button class="btn primary" type="submit" disabled={busy}>Hold</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form === "close" && (
        <div class="control-form" role="group" aria-label="Confirm closing">
          <span>Close {change.slug}? It stops for good.</span>
          <button class="btn danger" type="button" disabled={busy} onClick={() => void run(offer("close"))}>Close it</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </div>
      )}
    </div>
  );
}
