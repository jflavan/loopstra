import { useMemo } from "preact/hooks";
import { parseDiff } from "../diff";

export function Diff({ text }: { text: string }) {
  const rows = useMemo(() => parseDiff(text), [text]);
  if (!rows.length) return <p class="muted">No changes.</p>;
  return <div class="diff">{rows.map((r, k) => <div key={k} class={`d-${r.kind}`}>{r.text || " "}</div>)}</div>;
}
