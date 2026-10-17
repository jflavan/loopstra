import { dismiss, toasts } from "../store";

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && <button type="button" class="btn" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
