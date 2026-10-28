import { useEffect, useState } from "preact/hooks";
import type { ExceptionRow, ScopeRow } from "../../console/types";
import { Link } from "../parts/Link";
import { filterExceptions } from "../standards";
import { getJson } from "../store";

/*
 * Exceptions granted: every exception a person approved, read from every change's standards.md, with
 * the standards added to or removed from a change beside it under "Changes to scope". Read-only.
 */

interface Read { exceptions: ExceptionRow[]; scope: ScopeRow[] }

/** A standard's title, or what is left of it once main no longer has it. */
const named = (title: string, name: string) => title || (name ? `${name} (no longer on main)` : "a standard no longer on main");

export function Exceptions() {
  const [v, setV] = useState<Read | null>(null);
  const [failed, setFailed] = useState(false);
  const [standard, setStandard] = useState("");
  const [rule, setRule] = useState("");
  useEffect(() => {
    let alive = true;
    getJson<Read>("/api/standards/exceptions").then((x) => { if (alive) setV(x); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  const head = <div class="view-head"><h1>Exceptions granted</h1><span class="muted"><Link href="/settings">Settings</Link> › Standards</span></div>;
  if (!v) return <section class="view">{head}<p class="muted">{failed ? "The exceptions could not be read." : "Loading…"}</p></section>;
  // Each standard named in either list, by name, with its title.
  const standards = [...new Map([...v.exceptions.map((r) => [r.standard, r.title] as const), ...v.scope.map((r) => [r.name, r.title] as const)]).entries()].filter(([n]) => n).sort((a, b) => a[0].localeCompare(b[0]));
  const rules = [...new Set(v.exceptions.filter((r) => !standard || r.standard === standard).map((r) => r.label))].sort();
  const shown = filterExceptions(v.exceptions, { standard, rule });
  const scope = v.scope.filter((r) => !standard || r.name === standard);
  const change = (r: { slug: string; change: string }) => <Link href={`/c/${r.slug}`}>{r.change || r.slug}</Link>;
  return (
    <section class="view">
      {head}
      <div class="control-form">
        <label>Standard{" "}
          <select value={standard} onChange={(e) => { setStandard(e.currentTarget.value); setRule(""); }}>
            <option value="">all</option>
            {standards.map(([n, t]) => <option key={n} value={n}>{t || n}</option>)}
          </select>
        </label>
        <label>Rule{" "}
          <select value={rule} onChange={(e) => setRule(e.currentTarget.value)}>
            <option value="">all</option>
            {rules.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>
      <div class="std-columns">
        <div>
          <h2>Exceptions</h2>
          {!shown.length ? <p class="muted">{v.exceptions.length ? "None for this filter." : "No exception has been granted."}</p> : (
            <div class="table-wrap">
              <table class="list">
                <thead><tr><th>Rule</th><th>Change</th><th>Reason</th><th>Who</th><th>From where</th><th>When</th><th>Gate</th></tr></thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={i}>
                      <td><code>{r.label}</code> <span class="muted">{named(r.title, r.standard)}</span></td>
                      <td>{change(r)}</td><td>{r.reason}</td><td>{r.by}</td><td>{r.via}</td><td>{r.date}</td><td>{r.gate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h2>Changes to scope</h2>
          {!scope.length ? <p class="muted">No standard has been added to or removed from a change.</p> : (
            <div class="table-wrap">
              <table class="list">
                <thead><tr><th>Standard</th><th>Change</th><th>What</th><th>Note</th><th>Who</th><th>From where</th><th>When</th></tr></thead>
                <tbody>
                  {scope.map((r, i) => (
                    <tr key={i}>
                      <td>{named(r.title, r.name)}</td><td>{change(r)}</td><td>{r.action}</td><td>{r.note}</td><td>{r.by}</td><td>{r.via}</td><td>{r.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
