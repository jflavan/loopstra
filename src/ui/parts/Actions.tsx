import { useEffect, useRef, useState } from "preact/hooks";
import { PRIORITY_NAMES, type ChangeSummary, type Offer } from "../../console/types";
import { act, bodyFor, unsentText } from "../requests";
import { requests, toast } from "../store";

/** Actions that open a small form first: a note, a reason, or a confirmation. */
type Form = "send-back" | "hold" | "close";
const FORMS: ReadonlySet<string> = new Set(["send-back", "hold", "close"]);
/** Drawn as the main button. */
const PRIMARY: ReadonlySet<string> = new Set(["approve", "retry", "accept"]);
/** What the inbox shows: what decides where the change goes next. */
const COMPACT: ReadonlySet<string> = new Set(["approve", "send-back", "retry", "accept", "release"]);

/**
 * An open form, with the offer and the change as they were when it opened: what is sent is what the
 * person saw, so a change that moved on while they typed is answered "moved on", not acted on.
 */
interface Open { kind: Form; offer: Offer; seen: ChangeSummary }

/**
 * The controls for one change: its offers as buttons (send back, hold and close open a small form
 * first), and the requests it has waiting for the loop. `compact` shows only the deciding ones.
 */
export function Actions({ change, compact = false }: { change: ChangeSummary; compact?: boolean }) {
  const [form, setForm] = useState<Open | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // The kind of the button that opened the form, to give it the focus back when the form closes.
  const opener = useRef<string | null>(null);
  // The form open now, read after a send: a form the person closed meanwhile is left alone.
  const current = useRef<Open | null>(null);
  current.current = form;
  useEffect(() => {
    if (form) {
      (form.kind === "close" ? confirm.current : field.current)?.focus();
      return;
    }
    const k = opener.current;
    opener.current = null;
    // The button is drawn again once the form closes; it is not there when the change no longer offers it.
    if (k) box.current?.querySelector<HTMLElement>(`[data-kind="${k}"]`)?.focus();
  }, [form?.kind]);
  const waiting = (requests.value ?? []).filter((r) => r.slug === change.slug);
  const shown = change.offers.filter((o) => !compact || COMPACT.has(o.kind));
  // An open form stays, even when the change no longer offers anything: what the person typed is not thrown away.
  if (!shown.length && !waiting.length && !form) return null;
  const close = () => { setForm(null); setText(""); };
  /** Sends `o` for the change `c` as the person saw it; gives whether it was sent. Never throws: a failure is a toast. */
  const run = async (c: ChangeSummary, o: Offer, input: { note?: string; priority?: string; reason?: string } = {}): Promise<boolean> => {
    setBusy(true);
    const label = `${o.label}, ${c.slug}`;
    try {
      return await act(bodyFor(c, o, input), { note: c.note, priority: c.statedPriority }, label);
    } catch (e) {
      console.error(`${label}: it could not be sent`, e);
      toast(unsentText(label), "bad");
      return false;
    } finally {
      setBusy(false);
    }
  };
  /** Sends the open form. It closes once the request was sent; a failed send keeps it open with what was typed. */
  const submit = async (input: { note?: string; reason?: string } = {}) => {
    const opened = form;
    if (!opened) return;
    if ((await run(opened.seen, opened.offer, input)) && current.current === opened) close();
  };
  const open = (o: Offer) => {
    opener.current = o.kind;
    setText("");
    setForm({ kind: o.kind as Form, offer: o, seen: change });
  };
  const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  // A click here is not a click on the inbox item or card around it.
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class="controls" ref={box} onClick={stop}>
      {waiting.length > 0 && <span class="badge warn">Waiting for the loop: {waiting.map((w) => w.label).join(", ")}</span>}
      {form === null && shown.map((o) => o.kind === "priority" ? (
        <label key="priority" class="prio-pick">
          Priority
          <select value={change.priority} disabled={busy} onChange={(e) => { const p = e.currentTarget.value; if (p !== change.priority) void run(change, o, { priority: p }); }}>
            {PRIORITY_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      ) : (
        <button key={`${o.kind}:${o.to ?? ""}`} type="button" disabled={busy} data-kind={o.kind}
          class={`btn${PRIMARY.has(o.kind) ? " primary" : ""}${o.kind === "close" ? " danger" : ""}`}
          onClick={() => (FORMS.has(o.kind) ? open(o) : void run(change, o))}>
          {o.label}
        </button>
      ))}
      {form?.kind === "send-back" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void submit({ note: text }); }} onKeyDown={escape}>
          <textarea ref={field} value={text} placeholder="What should change? The agent gets this note." aria-label="What should change" maxLength={4000} onInput={(e) => setText(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={busy || !text.trim()}>Send back</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form?.kind === "hold" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); void submit({ reason: text }); }} onKeyDown={escape}>
          <input ref={field} type="text" value={text} placeholder="Why? (optional)" aria-label="Why it is held" maxLength={300} onInput={(e) => setText(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={busy}>Hold</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form?.kind === "close" && (
        <div class="control-form" role="group" aria-label="Confirm closing" onKeyDown={escape}>
          <span>Close {form.seen.slug}? It stops for good.</span>
          <button ref={confirm} class="btn danger" type="button" disabled={busy} onClick={() => void submit()}>Close it</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </div>
      )}
    </div>
  );
}
