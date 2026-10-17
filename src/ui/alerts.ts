import { effect } from "@preact/signals";
import type { AttentionItem } from "../attention";
import { inbox, loop } from "./store";

const KEY = "loopstra-notify";

export function notificationsOn(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

/** Turns browser notifications on (asking the browser's permission first) or off; gives what they ended up as. */
export async function setNotifications(on: boolean): Promise<boolean> {
  if (on) {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return false;
  }
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* kept for this visit only */ }
  return on;
}

/** An item's identity across updates: its wording ("checked 3 min ago") may change, it does not. */
const itemKey = (it: AttentionItem) => `${it.kind}|${it.slug ?? ""}|${it.title}`;

/** Only what a person must act on is worth a notification; the loop being paused or main being red is on the page when they look. */
export const needsAPerson = (it: AttentionItem): boolean => it.kind === "blocked" || it.kind === "waiting";

const COLOR: Record<string, string> = { running: "#4fd18b", paused: "#f2b84b", stopped: "#737a88", "not-responding": "#ff6b72" };

/** The tab's icon: a ring in the loop's colour, with a red dot while something needs a person. */
let drawn = "";
function setFavicon(state: string, dot: boolean): void {
  // Rebuilding the icon makes the browser fetch and repaint it, so only do that when it would look different.
  const look = `${state}|${dot}`;
  if (look === drawn) return;
  drawn = look;
  const ring = COLOR[state] ?? COLOR.stopped!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="none" stroke="${ring}" stroke-width="5"/>${dot ? '<circle cx="25" cy="7" r="6" fill="#ff6b72"/>' : ""}</svg>`;
  const link = document.getElementById("favicon") as HTMLLinkElement | null;
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Keeps the tab's title ("(3) Loopstra") and icon up to date with the inbox, and, when notifications
 * are on and the tab is in the background, shows one for each item that was not there before.
 */
export function startAlerts(): void {
  let seen: Set<string> | null = null;
  effect(() => {
    const items = inbox.value;
    const state = loop.value?.state ?? "stopped";
    if (!items) return;
    document.title = items.length ? `(${items.length}) Loopstra` : "Loopstra";
    setFavicon(state, items.length > 0);
    if (seen && notificationsOn() && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      for (const it of items) {
        if (!needsAPerson(it) || seen.has(itemKey(it))) continue;
        // Android Chrome throws here (it only allows notifications from a service worker); the title and icon still tell.
        try { new Notification(`${it.label}: ${it.title}`, { body: it.what, tag: itemKey(it) }); } catch { /* no notification on this device */ }
      }
    }
    seen = new Set(items.map(itemKey));
  });
}
