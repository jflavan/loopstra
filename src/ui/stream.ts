/*
 * One live stream from the console, kept open for as long as the screen that reads it is shown.
 * The page's three streams (the hub's, the Agents screen's, a session's) all come through here, so
 * they come back from the same troubles the same way.
 */

/** How long a stream may be silent (pings included) before the page says it is reconnecting and opens a new one. */
export const STALE_MS = 20_000;

export interface Handlers {
  /** One message's data, as the server sent it (JSON). */
  message(data: string): void;
  /** The stream said something, so it is alive. */
  live?(): void;
  /**
   * The stream is down: the browser is reconnecting it by itself (`retrying`), the browser gave up
   * (`closed`), or nothing came for STALE_MS (`silent`). Say `stop` to end the stream for good
   * instead of opening a new one, as when a closed stream means there is nothing to stream.
   */
  down?(why: "retrying" | "closed" | "silent"): "stop" | void;
}

/**
 * Opens the stream at `urlFor(0)`; gives back the function that closes it for good. The browser's
 * EventSource reconnects by itself (sending the newest id it saw, so the server continues from
 * there). When it gives up, or the stream has been silent for STALE_MS (a connection can die without
 * an error, as when a laptop slept), this closes it and opens a new one, waiting 1, 2, 4, then 8
 * seconds. A new EventSource sends no Last-Event-ID, so `urlFor` gets the newest id the page has
 * seen (0 when none) to name in the address instead.
 */
export function follow(urlFor: (newest: number) => string, h: Handlers): () => void {
  let last = Date.now();
  let wait = 1000;
  let newest = 0;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ended = false;
  const tick = setInterval(() => {
    if (!source || Date.now() - last <= STALE_MS) return;
    if (h.down?.("silent") === "stop") stop();
    else reopen();
  }, 1000);
  const stop = () => {
    ended = true;
    clearInterval(tick);
    if (retry) clearTimeout(retry);
    retry = null;
    source?.close();
    source = null;
  };
  const reopen = () => {
    source?.close();
    source = null;
    if (retry) return;
    retry = setTimeout(() => { retry = null; open(); }, wait);
    wait = Math.min(wait * 2, 8000);
  };
  const open = () => {
    if (ended) return;
    // The silence is counted from now, so a new stream gets its own STALE_MS to say something.
    last = Date.now();
    const s = new EventSource(urlFor(newest));
    source = s;
    const alive = () => {
      last = Date.now();
      wait = 1000;
      h.live?.();
    };
    s.onmessage = (ev) => {
      if (s !== source) return;
      alive();
      const id = Number(ev.lastEventId);
      if (Number.isFinite(id) && id > newest) newest = id;
      h.message(ev.data as string);
    };
    s.addEventListener("ping", alive);
    s.onerror = () => {
      if (s !== source) return;
      const closed = s.readyState === EventSource.CLOSED;
      if (h.down?.(closed ? "closed" : "retrying") === "stop") stop();
      else if (closed) reopen();
    };
  };
  open();
  return stop;
}
