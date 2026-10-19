import { useEffect, useState } from "preact/hooks";

/**
 * While the calling dialog is shown, remembers what had the focus and gives it back when the dialog
 * goes, so a keyboard user is not sent to the top of the page. Read as the dialog is first drawn,
 * before anything inside it (a box that takes the cursor when it mounts) has moved the focus.
 */
export function useReturnFocus(): void {
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => {
    // After every cleanup of the closing dialog has run, the page's inert one included (see
    // useInertPage): focus() on an element that is still inert does nothing.
    queueMicrotask(() => {
      if (before && before !== document.body && document.contains(before)) before.focus();
    });
  }, []);
}

/** How many dialogs are in front of the page, so the page is let go only when the last one closes. */
let dialogs = 0;

/**
 * While the calling dialog (aria-modal) is shown, the rest of the page is inert: Tab stays inside
 * the dialog, and nothing behind it takes a click or a key. The toasts stay live: one may say
 * something is wrong while the dialog is open, and an Undo on one must still work.
 */
export function useInertPage(): void {
  useEffect(() => {
    const rest = () => document.querySelectorAll(".shell > :not(.overlay):not(.toasts)");
    if (++dialogs === 1) for (const el of rest()) el.setAttribute("inert", "");
    return () => {
      if (--dialogs === 0) for (const el of rest()) el.removeAttribute("inert");
    };
  }, []);
}
