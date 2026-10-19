import { signal } from "@preact/signals";

type Theme = "system" | "light" | "dark";
const KEY = "loopstra-theme";

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export const theme = signal<Theme>(read());

export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/**
 * The theme the button goes to next. From "system" the first click shows the opposite of what the
 * system looks like now (a click that changed nothing would feel broken); then the system's own look, then "system" again.
 */
export function nextTheme(current: Theme, systemDark: boolean): Theme {
  if (current === "system") return systemDark ? "light" : "dark";
  const own: Theme = systemDark ? "dark" : "light";
  return current === own ? "system" : own;
}

export function cycleTheme(): void {
  const systemDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const next = nextTheme(theme.value, systemDark);
  const swap = () => {
    theme.value = next;
    applyTheme(next);
  };
  // The page cross-fades into the new theme, where the browser can, instead of flashing from dark to light.
  if (typeof document.startViewTransition === "function") document.startViewTransition(swap);
  else swap();
  try { localStorage.setItem(KEY, next); } catch { /* kept for this visit only */ }
}
