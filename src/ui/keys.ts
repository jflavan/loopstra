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

/**
 * Whether an input method (Japanese, Chinese, ...) is picking a character with this key: there Enter
 * confirms the character, not the message. Some browsers say so only with keyCode 229.
 */
const composing = (e: { isComposing: boolean; keyCode: number }): boolean => e.isComposing || e.keyCode === 229;

/** Whether a key press is Enter meant for the page (the palette picks its row on it): never while an input method is picking a character. */
export function enterPressed(e: { key: string; isComposing: boolean; keyCode: number }): boolean {
  return !composing(e) && e.key === "Enter";
}

/** Whether a key press in a message box sends it: Ctrl or Cmd with Enter, never while an input method is picking a character. */
export function sendsMessage(e: { key: string; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode: number }): boolean {
  return !composing(e) && e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

/**
 * Whether a key press in a box where Enter alone sends (the orchestrator's, a tile's one-line box)
 * sends it: Enter without Shift (Shift with Enter is a line break), never while an input method is
 * picking a character.
 */
export function sendsOnEnter(e: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }): boolean {
  return !composing(e) && e.key === "Enter" && !e.shiftKey;
}

/** What a key press does: one of the page's actions, the screen's own handler for that key, or nothing. */
type Decision = { kind: "action"; action: string } | { kind: "screen" } | { kind: "nothing" };

const NOTHING: Decision = { kind: "nothing" };

/**
 * Decides what a key press does. `press` is the page's matcher, asked only for keys that may count
 * (it keeps the sequence in progress). In a text box letters are typing, so only Ctrl or Cmd
 * shortcuts and Escape count there. A screen's keys (the inbox's j, k, o, a) count only outside a
 * box and while nothing is in front of the screen (`overlay`: the palette or the keys help).
 */
export function decide(name: string | null, press: (name: string) => string | null, at: { typing: boolean; overlay: boolean; screenKey: boolean }): Decision {
  if (!name) return NOTHING;
  if (at.typing && !name.startsWith("mod+") && name !== "escape") return NOTHING;
  const action = press(name);
  if (action) return { kind: "action", action };
  return at.screenKey && !at.typing && !at.overlay ? { kind: "screen" } : NOTHING;
}

/** Something that can take the keyboard's focus: a button, or a box with tabIndex -1. */
interface Focusable { focus(): void; disabled?: boolean }

/**
 * Gives the focus to `first` when it is there and can take it (not disabled), else to `fallback`: after
 * a form closes, its button when it is still there, else the box around it, so the focus is never lost.
 */
export function focusOr(first: Focusable | null | undefined, fallback: Focusable | null | undefined): void {
  if (first && !first.disabled) first.focus();
  else fallback?.focus();
}

/** Whether a key press lands in something a person types into. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName ?? ""));
}

/** Whether this is an Apple platform, where the shortcut key is Cmd and not Ctrl. Read once: it cannot change during a visit. */
export const onMac: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || "");
})();

/** A binding's keys as a person reads them: "Ctrl K" (or the Command sign on a Mac), "G L", "Esc". */
export function keyLabel(keys: string, mac: boolean): string {
  return keys
    .split(" ")
    .map((k) => {
      if (k === "escape") return "Esc";
      if (k.startsWith("mod+")) return `${mac ? "⌘" : "Ctrl "}${k.slice(4).toUpperCase()}`;
      return k.toUpperCase();
    })
    .join(" ");
}
