import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { focusOr, onMac, sendsMessage, sendsOnEnter } from "../keys";
import { steer, type steerOffer } from "../requests";

type SteerOffer = NonNullable<ReturnType<typeof steerOffer>>;

/**
 * The box on a running session's page: tell the session something (a message it reads at its next
 * step, or a redirect that replaces what it was doing), or stop it after an inline confirm. A check
 * can only be stopped; `offer.note` says why. What was typed stays after a failed send. `compact`:
 * one line, for a tile on the Agents screen, with `extra` beside its buttons.
 */
export function Steer({ slug, seq, offer, compact = false, extra }: { slug: string; seq: number; offer: SteerOffer; compact?: boolean; extra?: ComponentChildren }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Whether the confirm was open, so closing it (and only that) gives the Stop button its focus back;
  // once the session is stopping that button is disabled, so the box takes the focus instead.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) {
      wasConfirming.current = true;
      confirmButton.current?.focus();
    } else if (wasConfirming.current) {
      wasConfirming.current = false;
      focusOr(stopButton.current, box.current);
    }
  }, [confirming]);

  const send = async (kind: "message" | "redirect") => {
    const said = text.trim();
    if (!said || busy || stopping) return;
    setBusy(true);
    try {
      // Cleared only when sent, and only if the person has not typed something else meanwhile.
      if (await steer(slug, seq, kind, said)) setText((now) => (now.trim() === said ? "" : now));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      if (await steer(slug, seq, "stop")) setStopping(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirming(false); };
  const sendKey = `${onMac ? "⌘" : "Ctrl"}+Enter`;

  const stopButtonEl = (
    <button ref={stopButton} type="button" class="btn danger" disabled={busy || stopping || confirming} onClick={() => setConfirming(true)}>
      {stopping ? "Stopping…" : compact ? "Stop" : "Stop session"}
    </button>
  );
  // On a tile the box is one line, and Enter sends, with or without Shift: there is no room, or need, for a long message there.
  const field = compact ? (
    <input
      type="text" value={text} maxLength={4000} disabled={stopping}
      placeholder="Tell the agent something"
      aria-label="Tell the agent something"
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={(e) => { if (sendsOnEnter(e, { oneLine: true })) { e.preventDefault(); void send("message"); } }}
    />
  ) : (
    <textarea
      value={text} maxLength={4000} disabled={stopping}
      placeholder="Tell the agent something. It reads it at its next step, and it is kept in conversation.md."
      aria-label="Tell the agent something"
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={(e) => { if (sendsMessage(e)) { e.preventDefault(); void send("message"); } }}
    />
  );
  return (
    <div ref={box} class={`panel steer${compact ? " compact" : ""}`} role="region" aria-label="Steer this session" tabIndex={-1}>
      {offer.message && !compact && field}
      <div class="steer-row">
        {offer.message && compact && field}
        {offer.message ? (
          <>
            <button type="button" class="btn primary" disabled={busy || stopping || !text.trim()} onClick={() => void send("message")}>{compact ? "Send" : "Send message"}</button>
            <button type="button" class="btn" disabled={busy || stopping || !text.trim()} title="The text replaces what the session was doing" onClick={() => void send("redirect")}>Redirect</button>
            {!compact && <span class="muted hide-narrow">{sendKey} sends the message</span>}
          </>
        ) : <span class="muted">{offer.note}</span>}
        <span class="grow" />
        {extra}
        {stopButtonEl}
      </div>
      {confirming && (
        <div class="control-form" role="group" aria-label="Confirm stopping" onKeyDown={escape}>
          <span>Stop this session? The change is held until someone releases it.</span>
          <button ref={confirmButton} type="button" class="btn danger" disabled={busy} onClick={() => void stop()}>Stop it</button>
          <button type="button" class="btn" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
