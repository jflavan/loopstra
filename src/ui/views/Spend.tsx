import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SpendView } from "../../console/types";
import { usd } from "../format";
import { Link } from "../parts/Link";
import { getJson } from "../store";

export function Spend() {
  const [v, setV] = useState<SpendView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    // A failed read shows the numbers already on screen; the next tick tries again.
    const load = () => getJson<SpendView>("/api/spend").then((x) => { if (live) { setV(x); setFailed(false); } }, () => { if (live) setFailed(true); });
    void load();
    // Wrapped: a timer given the promise-returning load would lose a rejection (both outcomes are handled above, so none is expected).
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!v) return <section class="view"><p class="muted">{failed ? "Spend could not be read." : "Loading…"}</p></section>;
  const topHour = Math.max(0.01, ...v.byHour.map((h) => h.costUsd));
  return (
    <section class="view">
      <div class="view-head"><h1>Spend</h1><span class="muted">On a subscription these are estimates. Chat is included.</span></div>
      <div class="tiles">
        <div class="tile"><span class="muted">Today</span><span class="v">{usd(v.totals.todayUsd)}</span></div>
        <div class="tile"><span class="muted">This week</span><span class="v">{usd(v.totals.weekUsd)}</span></div>
        <div class="tile"><span class="muted">All time</span><span class="v">{usd(v.totals.allUsd)}</span></div>
        <div class="tile"><span class="muted">Chat, all time</span><span class="v">{usd(v.chatUsd)}</span></div>
      </div>
      <h2>The last 48 hours</h2>
      {v.byHour.every((h) => h.costUsd <= 0)
        ? <p class="muted">Nothing spent in the last 48 hours.</p>
        : (
          <div class="hours" role="img" aria-label="Spend per hour over the last 48 hours">
            {v.byHour.map((h) => (
              <i key={h.hour} style={{ height: `${(h.costUsd / topHour) * 100}%` }}
                title={`${new Date(h.hour).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: ${usd(h.costUsd)}`} />
            ))}
          </div>
        )}
      <h2>By change</h2>
      <Bars rows={v.perChange.map((c) => ({ key: c.slug, label: <Link href={`/c/${c.slug}`}>{c.title}</Link>, value: c.costUsd }))} />
      <h2>By kind of step</h2>
      <Bars rows={v.perPhase.map((p) => ({ key: p.name, label: <span>{p.name} <span class="muted">×{p.count}</span></span>, value: p.costUsd }))} />
      {v.judges && <Judges j={v.judges} />}
    </section>
  );
}

function Bars({ rows }: { rows: Array<{ key: string; label: ComponentChildren; value: number }> }) {
  if (!rows.length) return <p class="muted">Nothing spent yet.</p>;
  const top = Math.max(0.01, ...rows.map((r) => r.value));
  return (
    <div class="bars">
      {rows.map((r) => (
        <div key={r.key} class="bar-row">
          <span>{r.label}</span>
          <span class="bar-track"><span class="bar-fill" style={{ width: `${(r.value / top) * 100}%`, display: "block" }} /></span>
          <span class="num">{usd(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Judges({ j }: { j: NonNullable<SpendView["judges"]> }) {
  return (
    <>
      <h2>Cheaper judges</h2>
      <p class="muted">How often {j.cheapModel}, asked the same question, agreed with {j.strongModel} (setting: {j.setting}). They have cost {usd(j.spentUsd)}.</p>
      <div class="table-wrap">
        <table class="list">
          <thead><tr><th>Judge</th><th class="num">Compared</th><th class="num">Agreed</th><th class="num">Passed what the strong judge rejected</th><th>Goes first</th></tr></thead>
          <tbody>
            {j.judges.map((r) => (
              <tr key={r.judge}>
                <td>{r.judge}</td>
                <td class="num">{r.compared}</td>
                <td class="num">{r.agreed}</td>
                <td class="num">{r.falsePasses}</td>
                <td>{r.goesFirst ?? r.why ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
