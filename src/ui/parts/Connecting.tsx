/** What the page says where the stream's first snapshot has not come yet. */
export const CONNECTING = "Connecting…";

/** A screen waiting for the stream's first snapshot; `pad`: inside the drawer, which has no view padding of its own. */
export function Connecting({ pad = false }: { pad?: boolean }) {
  if (pad) return <p class="pad muted">{CONNECTING}</p>;
  return <section class="view"><p class="muted">{CONNECTING}</p></section>;
}
