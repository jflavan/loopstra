import { signal } from "@preact/signals";
import { changesAddress, parseRoute, type Route } from "./router";

/** The screen the page shows. */
export const route = signal<Route>(parseRoute(location.pathname));

/** Goes to `path` without reloading the page. */
export function navigate(path: string): void {
  if (changesAddress(location, path)) history.pushState(null, "", path);
  // A new route value even for the same address, so a screen that reads the part after # (Agents) looks again.
  route.value = parseRoute(location.pathname);
  document.getElementById("main")?.scrollTo(0, 0);
}

/** Follows the browser's back and forward buttons. */
export function listenToHistory(): void {
  addEventListener("popstate", () => { route.value = parseRoute(location.pathname); });
}
