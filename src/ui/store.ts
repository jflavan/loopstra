import { computed, signal } from "@preact/signals";
import type { About } from "./chat";
import type { ActivityItem, Meta, Sections, StreamMessage } from "../console/types";

export interface State {
  meta: Meta | null; sections: Partial<Sections>; activity: ActivityItem[];
  /** How many times the stream said the page missed events it could not be sent; a screen showing history reloads it when this changes. */
  gaps: number;
}

/** The most live events the page keeps. */
export const ACTIVITY_MAX = 500;
/** How long the stream may be silent (pings included) before the page says it is reconnecting and opens a new one. */
export const STALE_MS = 20_000;

/** What one stream message does to the state. Sections it does not touch keep their identity. */
export function applyMessage(s: State, msg: StreamMessage): State {
  switch (msg.type) {
    case "snapshot": return { ...s, meta: msg.meta, sections: { ...msg.sections } };
    case "section": return { ...s, sections: { ...s.sections, [msg.name]: msg.value } };
    case "event":
      if (s.activity.some((a) => a.id === msg.item.id)) return s;
      return { ...s, activity: [...s.activity, msg.item].slice(-ACTIVITY_MAX) };
    case "gap": return { ...s, gaps: s.gaps + 1 };
    // A newer server may send kinds this page does not know; they must not break it.
    default: return s;
  }
}

export const state = signal<State>({ meta: null, sections: {}, activity: [], gaps: 0 });
export const meta = computed(() => state.value.meta);
export const loop = computed(() => state.value.sections.loop ?? null);
export const inbox = computed(() => state.value.sections.inbox ?? null);
export const changes = computed(() => state.value.sections.changes ?? null);
export const running = computed(() => state.value.sections.running ?? null);
export const totals = computed(() => state.value.sections.totals ?? null);
export const activity = computed(() => state.value.activity);
export const gaps = computed(() => state.value.gaps);

export type Connection = "connecting" | "live" | "stale";
export const connection = signal<Connection>("connecting");
/** The time, refreshed every second, for clocks and ages. */
export const now = signal(Date.now());

/** The orchestrator's drawer; `about` is the change it was opened from, or null. */
export const drawer = signal<{ open: boolean; about: About | null }>({ open: false, about: null });
export const paletteOpen = signal(false);
export const helpOpen = signal(false);

export function openDrawer(about: About | null = null): void {
  drawer.value = { open: true, about };
}

export interface Toast { id: number; text: string; kind: "info" | "bad" }
export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, 6000);
}

/** A reply that was not a success; the page tells "not found" from "the server failed" by the status. */
export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`${status} ${url}`);
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new HttpError(r.status, url);
  return await r.json() as T;
}

/**
 * Opens the live stream; gives back the function that closes it. EventSource reconnects by itself
 * (sending the newest id it saw, so the server can send the events it missed). When it gives up, or
 * the stream has been silent for STALE_MS (a connection can die without an error), this closes it
 * and opens a new one, waiting 1, 2, 4, then 8 seconds. A new EventSource sends no Last-Event-ID,
 * so the newest id the page has seen goes in ?after= instead.
 */
export function connect(): () => void {
  let last = Date.now();
  let wait = 1000;
  let newest = 0;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const reopen = () => {
    source?.close();
    source = null;
    if (retry) return;
    retry = setTimeout(() => { retry = null; open(); }, wait);
    wait = Math.min(wait * 2, 8000);
  };
  const open = () => {
    // The silence is counted from now, so a new stream gets its own STALE_MS to say something.
    last = Date.now();
    const s = new EventSource(newest > 0 ? `/api/stream?after=${newest}` : "/api/stream");
    source = s;
    const alive = () => {
      last = Date.now();
      wait = 1000;
      connection.value = "live";
    };
    s.onmessage = (ev) => {
      alive();
      const id = Number(ev.lastEventId);
      if (Number.isFinite(id) && id > newest) newest = id;
      try { state.value = applyMessage(state.value, JSON.parse(ev.data as string) as StreamMessage); } catch { /* a bad frame is skipped */ }
    };
    s.addEventListener("ping", alive);
    s.onerror = () => {
      if (s !== source) return;
      connection.value = "stale";
      if (s.readyState === EventSource.CLOSED) reopen();
    };
  };
  open();
  const tick = setInterval(() => {
    now.value = Date.now();
    if (source && Date.now() - last > STALE_MS) {
      connection.value = "stale";
      reopen();
    }
  }, 1000);
  return () => {
    clearInterval(tick);
    if (retry) clearTimeout(retry);
    retry = null;
    source?.close();
    source = null;
  };
}
