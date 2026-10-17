import { signal } from "@preact/signals";

export type Theme = "system" | "light" | "dark";
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

/** The system's theme, then dark, then light. */
export function cycleTheme(): void {
  const next: Theme = theme.value === "system" ? "dark" : theme.value === "dark" ? "light" : "system";
  theme.value = next;
  applyTheme(next);
  try { localStorage.setItem(KEY, next); } catch { /* kept for this visit only */ }
}
