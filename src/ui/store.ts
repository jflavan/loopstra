import { computed, signal } from "@preact/signals";
import type { About } from "./chat";
import { follow } from "./stream";
import type { ActivityItem, Meta, Sections, StreamMessage } from "../console/types";

export interface State {
  meta: Meta | null; sections: Partial<Sections>; activity: ActivityItem[];
  /** How many times the stream said the page missed events it could not be sent; a screen showing history reloads it when this changes. */
  gaps: number;
}

/** The most live events the page keeps. */
export const ACTIVITY_MAX = 500;
export { STALE_MS } from "./stream";

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
/** Requests the loop has not finished yet, shown beside their change. */
export const requests = computed(() => state.value.sections.requests ?? null);
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

/** A short message at the bottom of the page, with an optional button (Undo). */
export interface Toast { id: number; text: string; kind: "info" | "bad"; action?: { label: string; run: () => void } }
export const toasts = signal<Toast[]>([]);
let toastId = 0;

/** Shows a toast for `ms` (6 s unless said), with an optional button; gives its id, for dismiss. */
export function toast(text: string, kind: Toast["kind"] = "info", opts: { action?: Toast["action"]; ms?: number } = {}): number {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind, action: opts.action }];
  setTimeout(() => dismiss(id), opts.ms ?? 6000);
  return id;
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
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
 * Opens the live stream (see follow) and starts the clock; gives back the function that closes it.
 * A new stream names the newest event the page saw in ?after=, so the server sends the ones it missed.
 */
export function connect(): () => void {
  const stop = follow((newest) => (newest > 0 ? `/api/stream?after=${newest}` : "/api/stream"), {
    message(data) {
      try { state.value = applyMessage(state.value, JSON.parse(data) as StreamMessage); } catch { /* a bad frame is skipped */ }
    },
    live() { connection.value = "live"; },
    down() { connection.value = "stale"; },
  });
  const tick = setInterval(() => { now.value = Date.now(); }, 1000);
  return () => {
    clearInterval(tick);
    stop();
  };
}
