import { signal } from "@preact/signals";
import { parseRoute, type Route } from "./router";

/** The screen the page shows. */
export const route = signal<Route>(parseRoute(location.pathname));

/** Goes to `path` without reloading the page. */
export function navigate(path: string): void {
  if (path !== location.pathname) history.pushState(null, "", path);
  route.value = parseRoute(location.pathname);
  document.getElementById("main")?.scrollTo(0, 0);
}

/** Follows the browser's back and forward buttons. */
export function listenToHistory(): void {
  addEventListener("popstate", () => { route.value = parseRoute(location.pathname); });
}
