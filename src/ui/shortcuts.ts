import { composing, decide, keyMatcher, keyName, typingIn, type Binding } from "./keys";
import { navigate } from "./nav";
import { drawer, helpOpen, paletteOpen } from "./store";

export const SHORTCUTS: Array<Binding & { label: string }> = [
  { keys: "mod+k", action: "palette", label: "Search and commands" },
  { keys: "mod+j", action: "drawer", label: "Ask the orchestrator" },
  { keys: "g l", action: "go:/", label: "Go to Live" },
  { keys: "g i", action: "go:/inbox", label: "Go to Inbox" },
  { keys: "g c", action: "go:/changes", label: "Go to Changes" },
  { keys: "g a", action: "go:/activity", label: "Go to Activity" },
  { keys: "g w", action: "go:/agents", label: "Go to Agents" },
  { keys: "g s", action: "go:/spend", label: "Go to Spend" },
  { keys: "?", action: "help", label: "Show these keys" },
  { keys: "escape", action: "escape", label: "Close what is open" },
];

/** Keys one screen handles while it is shown (the inbox's j, k and o): it adds them when it opens and removes them when it closes. */
export const screenKeys = new Map<string, () => void>();

export function installKeys(): void {
  const press = keyMatcher(SHORTCUTS);
  window.addEventListener("keydown", (e) => {
    // Keys that pick a character in an input method (Japanese, Chinese, ...) are not shortcuts.
    if (composing(e)) return;
    const name = keyName(e);
    const what = decide(name, (n) => press(n, Date.now()), { typing: typingIn(e.target), overlay: paletteOpen.value || helpOpen.value, screenKey: !!name && screenKeys.has(name) });
    if (what.kind === "nothing") return;
    e.preventDefault();
    if (what.kind === "screen") {
      screenKeys.get(name!)?.();
      return;
    }
    const action = what.action;
    if (action === "palette") paletteOpen.value = !paletteOpen.value;
    else if (action === "drawer") drawer.value = { ...drawer.value, open: !drawer.value.open };
    else if (action === "help") helpOpen.value = !helpOpen.value;
    else if (action === "escape") {
      paletteOpen.value = false;
      helpOpen.value = false;
      drawer.value = { ...drawer.value, open: false };
    } else if (action.startsWith("go:")) navigate(action.slice(3));
  });
}
