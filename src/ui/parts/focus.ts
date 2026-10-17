import { useEffect } from "preact/hooks";

/** While the calling dialog is shown, remembers what had the focus and gives it back when the dialog goes, so a keyboard user is not sent to the top of the page. */
export function useReturnFocus(): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before && before !== document.body && document.contains(before)) before.focus();
    };
  }, []);
}
