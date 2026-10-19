import { useEffect, useState } from "preact/hooks";

/**
 * Whether a closing panel gives the focus back to what had it before it opened. A modal dialog (no
 * `panel` given) always does: nothing else could have taken the focus while it was shown. A panel
 * that is not modal (the drawer) does only when the focus is inside it, or nowhere (`body`), as it
 * closes: a person who went on to something else on the page keeps the focus there. A panel whose box
 * is already gone (null) cannot hold the focus, so only a focus that is nowhere is taken back.
 */
export function givesFocusBack<T>(active: T | null, body: T, panel?: { contains(node: T | null): boolean } | null): boolean {
  if (panel === undefined) return true;
  return active === null || active === body || !!panel?.contains(active);
}

/**
 * What a panel opening now gives the focus back to when it closes: what a closing dialog handed over
 * (see handFocusOver), or else what has the focus now.
 */
export function returnTarget<T>(handed: T | null, active: T | null): T | null {
  return handed ?? active;
}

/** The element handed over by a closing dialog to the panel it opens, taken by that panel as it is first drawn. */
let handedOver: HTMLElement | null = null;

/**
 * Called by a dialog that opens a panel as it closes (the palette's Ask opens the drawer): the panel
 * gives the focus back to `to`, what had it before the dialog, and not to the dialog's own box, which
 * has the focus as the panel is drawn but is gone by the time the panel closes.
 */
export function handFocusOver(to: HTMLElement | null): void {
  handedOver = to;
}

/**
 * While the calling dialog is shown, remembers what had the focus and gives it back when the dialog
 * goes, so a keyboard user is not sent to the top of the page. Read as the dialog is first drawn,
 * before anything inside it (a box that takes the cursor when it mounts) has moved the focus, or
 * taken from the dialog that opened it (see handFocusOver). A panel that is not modal passes its box
 * as `panel`, and the focus is given back only as givesFocusBack says. Gives back what it remembered.
 */
export function useReturnFocus(panel?: { readonly current: HTMLElement | null }): HTMLElement | null {
  const [before] = useState(() => {
    const target = returnTarget(handedOver, document.activeElement as HTMLElement | null);
    handedOver = null;
    return target;
  });
  useEffect(() => () => {
    // Decided now, while the closing panel is still in the page: once it is gone, a focus that was
    // inside it has fallen to the body and could not be told from one that was nowhere.
    if (!givesFocusBack(document.activeElement, document.body, panel ? panel.current : undefined)) return;
    // After every cleanup of the closing dialog has run, the page's inert one included (see
    // useInertPage): focus() on an element that is still inert does nothing.
    queueMicrotask(() => {
      if (before && before !== document.body && document.contains(before)) before.focus();
    });
  }, []);
  return before;
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
