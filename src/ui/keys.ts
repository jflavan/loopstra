export interface Binding { keys: string; action: string }

/**
 * Turns key names into actions. A sequence ("g l") must be finished within `windowMs`; a second key
 * that does not continue one starts over with that key on its own.
 */
export function keyMatcher(bindings: Binding[], windowMs = 1000): (key: string, now: number) => string | null {
  let pending: { keys: string[]; at: number } | null = null;
  return (key, now) => {
    const prefix = pending && now - pending.at <= windowMs ? pending.keys : [];
    for (const seq of prefix.length ? [[...prefix, key], [key]] : [[key]]) {
      const joined = seq.join(" ");
      const exact = bindings.find((b) => b.keys === joined);
      if (exact) {
        pending = null;
        return exact.action;
      }
      if (bindings.some((b) => b.keys.startsWith(`${joined} `))) {
        pending = { keys: seq, at: now };
        return null;
      }
    }
    pending = null;
    return null;
  };
}

/** Keys that only change another key; pressed on their own they start a combination, so they are not shortcuts. */
const MODIFIERS = new Set(["shift", "control", "alt", "altgraph", "meta", "os", "capslock", "numlock", "scrolllock", "fn", "fnlock", "hyper", "super", "symbol", "symbollock"]);

/** "mod+k" for Ctrl or Cmd with K, "escape", "j"; null with Alt, which the page leaves to the browser, and for a modifier on its own. */
export function keyName(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.altKey || MODIFIERS.has(e.key.toLowerCase())) return null;
  const key = e.key.toLowerCase();
  return e.ctrlKey || e.metaKey ? `mod+${key}` : key;
}

/** Whether a key press lands in something a person types into. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName ?? ""));
}
