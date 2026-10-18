import { useEffect, useRef, useState } from "preact/hooks";
import { PRIORITY_NAMES, type ChangeSummary, type Offer } from "../../console/types";
import { focusOr } from "../keys";
import { act, beforeOf, bodyFor, stopChange, unsentText } from "../requests";
import { requests, toast } from "../store";

/** Actions that open a small form first: a note, a reason, an answer, or a confirmation. `stop` is not an offer: a running change has it. */
type Form = "send-back" | "hold" | "close" | "answer" | "stop";
const FORMS: ReadonlySet<string> = new Set(["send-back", "hold", "close", "answer"]);
/** Drawn as the main button. */
const PRIMARY: ReadonlySet<string> = new Set(["approve", "retry", "accept", "answer"]);
/** What the inbox shows: what decides where the change goes next. */
const COMPACT: ReadonlySet<string> = new Set(["approve", "send-back", "retry", "accept", "release", "answer"]);
/** Forms whose first focus is their confirm button, not a field. */
const CONFIRMS: ReadonlySet<Form> = new Set(["close", "stop"]);

/**
 * An open form, with the offer and the change as they were when it opened: what is sent is what the
 * person saw, so a change that moved on while they typed is answered "moved on", not acted on. A stop
 * has no offer.
 */
interface Open { kind: Form; offer: Offer | null; seen: ChangeSummary }

/**
 * The controls for one change: its offers as buttons (send back, hold, close and answer open a small
 * form first), Stop while it runs (after a confirm), and the requests it has waiting for the loop.
 * `compact` shows only the deciding ones, and Stop.
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
      (CONFIRMS.has(form.kind) ? confirm.current : field.current)?.focus();
      return;
    }
    const k = opener.current;
    opener.current = null;
    // The button is drawn again once the form closes; it is not there when the change no longer offers it
    // (Stop, once the change stopped running): the controls take the focus then, so it is not lost.
    if (k) focusOr(box.current?.querySelector<HTMLButtonElement>(`[data-kind="${k}"]`), box.current);
  }, [form?.kind]);
  const waiting = (requests.value ?? []).filter((r) => r.slug === change.slug);
  const shown = change.offers.filter((o) => !compact || COMPACT.has(o.kind));
  // An open form stays, even when the change no longer offers anything: what the person typed is not thrown away.
  if (!shown.length && !waiting.length && !form && !change.running) return null;
  const close = () => { setForm(null); setText(""); };
  /** Sends `o` for the change `c` as the person saw it; gives whether it was sent. Never throws: a failure is a toast. */
  const run = async (c: ChangeSummary, o: Offer, input: { note?: string; priority?: string; reason?: string } = {}): Promise<boolean> => {
    setBusy(true);
    const label = `${o.label}, ${c.slug}`;
    try {
      return await act(bodyFor(c, o, input), beforeOf(c), label);
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
    if (!opened?.offer) return;
    if ((await run(opened.seen, opened.offer, input)) && current.current === opened) close();
  };
  /** Stops the change's running sessions (the confirm's button). Never throws: a failure is a toast. */
  const stopRunning = async () => {
    const opened = form;
    if (!opened) return;
    const label = `Stop, ${opened.seen.slug}`;
    setBusy(true);
    try {
      if ((await stopChange(opened.seen.slug)) && current.current === opened) close();
    } catch (e) {
      console.error(`${label}: it could not be sent`, e);
      toast(unsentText(label), "bad");
    } finally {
      setBusy(false);
    }
  };
  const open = (o: Offer | null, kind: Form = o?.kind as Form) => {
    opener.current = kind;
    setText("");
    setForm({ kind, offer: o, seen: change });
  };
  const question = form?.kind === "answer" ? form.seen.question : null;
  const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  // A click here is not a click on the inbox item or card around it.
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class="controls" ref={box} tabIndex={-1} onClick={stop}>
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
      {form === null && change.running && (
        <button key="stop" type="button" class="btn danger" disabled={busy} data-kind="stop" onClick={() => open(null, "stop")}>Stop</button>
      )}
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
      {form?.kind === "answer" && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void submit({ note: text }); }} onKeyDown={escape}>
          {question && (
            <div class="question">
              <b>{question.text}</b>
              {question.why && <span class="muted">{question.why}</span>}
              {question.options.length > 0 && (
                <div class="options" role="group" aria-label="Its options: each fills in the answer">
                  {question.options.map((opt) => <button key={opt} type="button" class="btn" onClick={() => { setText(opt); field.current?.focus(); }}>{opt}</button>)}
                </div>
              )}
            </div>
          )}
          <textarea ref={field} value={text} placeholder="Your answer. The agent carries on with it." aria-label="Your answer" maxLength={4000} onInput={(e) => setText(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={busy || !text.trim()}>Send answer</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </form>
      )}
      {form?.kind === "stop" && (
        <div class="control-form" role="group" aria-label="Confirm stopping" onKeyDown={escape}>
          <span>Stop {form.seen.slug}'s running session? The change is held until someone releases it.</span>
          <button ref={confirm} class="btn danger" type="button" disabled={busy} onClick={() => void stopRunning()}>Stop it</button>
          <button class="btn" type="button" onClick={close}>Cancel</button>
        </div>
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
