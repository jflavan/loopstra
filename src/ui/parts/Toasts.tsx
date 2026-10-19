import { dismiss, toasts, type Toast } from "../store";

/**
 * The toasts, in two live regions that are always there (a region added with its first message is
 * not read out): a polite one for news, which waits for a pause, and an alert for what went wrong,
 * which is read at once.
 */
export function Toasts() {
  const all = toasts.value;
  return (
    <div class="toasts">
      <div role="status" aria-live="polite">{all.filter((t) => t.kind !== "bad").map(one)}</div>
      <div role="alert">{all.filter((t) => t.kind === "bad").map(one)}</div>
    </div>
  );
}

function one(t: Toast) {
  return (
    <div key={t.id} class={`toast ${t.kind}`}>
      <span>{t.text}</span>
      {t.action && <button type="button" class="btn" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
    </div>
  );
}
