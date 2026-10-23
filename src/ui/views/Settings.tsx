import { useEffect, useRef, useState } from "preact/hooks";
import type { SettingsView } from "../../console/types";
import { ago } from "../format";
import { cancelSetting, sendSetting } from "../requests";
import { pendingText, pickerChoices, nameProblem } from "../settings";
import { getJson, now, toast } from "../store";

/** The change waiting for the loop: where, and what the loop's state says about it. */
interface Pending { id: string; path: string; loop: string }

export function Settings() {
  const [v, setV] = useState<SettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // Counts the reads; a picker or input keyed by it is drawn again, so a refused change shows what the file holds.
  const [rev, setRev] = useState(0);
  const alive = useRef(true);
  // Set at once on a send: a second one (Enter, then the blur it causes) must not follow before the page redraws.
  const busy = useRef(false);

  const load = async (): Promise<void> => {
    try {
      const x = await getJson<SettingsView>("/api/settings");
      if (!alive.current) return;
      setV(x);
      setFailed(false);
      setRev((n) => n + 1);
    } catch {
      if (alive.current) setFailed(true);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, []);

  /** Sends one change; the result is toasted, then the settings are read again so the next change carries the new version. */
  const change = async (path: string, value: string | null): Promise<void> => {
    // A pick while one is saving or read back is not sent; its picker goes back to what the file holds.
    if (busy.current || !v?.version) { setRev((n) => n + 1); return; }
    busy.current = true;
    const r = await sendSetting({ kind: "settings", path, value, version: v.version }, (d) => {
      toast(d.text, d.ok ? "info" : "bad");
      // Everything stays locked until the re-read has settled, so the next pick carries the new version.
      void load().then(() => {
        busy.current = false;
        if (alive.current) setPending(null);
      });
    });
    if (!r.ok) {
      toast(r.error, "bad");
      // A stale page is read again; a refused picker goes back either way.
      void load().then(() => { busy.current = false; });
      return;
    }
    if (alive.current) setPending({ id: r.id, path, loop: r.loop });
  };
  const cancel = async (p: Pending): Promise<void> => {
    if (await cancelSetting(p.id)) {
      toast("Cancelled; nothing changed.");
      void load().then(() => {
        busy.current = false;
        if (alive.current) setPending(null);
      });
    } else {
      toast("The loop has taken it already; it will say how it went.");
    }
  };

  if (!v) return <section class="view"><p class="muted">{failed ? "Settings could not be read." : "Loading…"}</p></section>;
  const locked = pending !== null;
  const wait = (path: string | null) => path !== null && pending?.path === path && (
    <span class="set-wait">
      <span class="muted">{pendingText(pending.loop)}</span>
      <button type="button" class="btn" onClick={() => void cancel(pending)}>Cancel</button>
    </span>
  );
  return (
    <section class="view">
      <div class="view-head"><h1>Settings</h1><span class="muted">Changes apply to sessions that start after they are saved; a session already running finishes on its model.</span></div>
      {failed && <p class="muted">The latest read failed; this may be out of date.</p>}
      {v.problem !== null ? (
        <div class="callout bad" role="alert"><strong>The config does not load.</strong> {v.problem}</div>
      ) : (
        <>
          <h2>Named models</h2>
          <p class="muted">The four names a stage or a step picks from. Each is a model name Claude Code accepts for --model.</p>
          <div class="set-rows">
            {v.models.map((m) => {
              const path = `claude.models.${m.ref}`;
              const send = (el: HTMLInputElement) => {
                const text = el.value.trim();
                if (text === m.name) return;
                const problem = nameProblem(text);
                if (problem) { toast(problem, "bad"); el.value = m.name; return; }
                void change(path, text);
              };
              return (
                <div key={m.ref} class="set-row">
                  <label for={`m-${m.ref}`}>{m.ref}</label>
                  <input id={`m-${m.ref}`} key={`${m.ref}-${rev}`} type="text" defaultValue={m.name} disabled={locked} autocomplete="off" spellcheck={false}
                    onKeyDown={(e) => { if (e.key === "Enter") send(e.currentTarget); }}
                    onBlur={(e) => send(e.currentTarget)} />
                  <span class="muted">{lastRan(m, now.value)}</span>
                  {wait(path)}
                </div>
              );
            })}
          </div>
          <h2>Stages</h2>
          {v.groups.map((g) => (
            <div key={g.group} class="set-group">
              <div class="set-row set-head">
                <label for={`g-${g.group}`}>{g.group}</label>
                <Picker id={`g-${g.group}`} rev={rev} row={{ path: g.path, own: g.model }} value={g.model} disabled={locked} onPick={(x) => void change(g.path, x)} />
                {g.group === "chat" && <span class="muted">orchestrator</span>}
                {wait(g.path)}
              </div>
              {g.steps.filter((s) => s.path !== null).map((s) => (
                <div key={s.key} class="set-row set-step">
                  <label for={`s-${s.key}`}><code>{s.key}</code> <span class="muted">{s.what}</span></label>
                  <Picker id={`s-${s.key}`} rev={rev} row={{ path: s.path, own: s.own }} value={s.own} disabled={locked} onPick={(x) => void change(s.path!, x)} />
                  {s.own === null && <span class="muted">{s.byDefault}</span>}
                  {wait(s.path)}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/** One picker. `max` is offered but never the value unless the file says so. */
function Picker(p: { id: string; rev: number; row: { path: string | null; own: string | null }; value: string | null; disabled: boolean; onPick: (value: string | null) => void }) {
  return (
    <select id={p.id} key={`${p.id}-${p.rev}`} value={p.value ?? ""} disabled={p.disabled}
      onChange={(e) => { const x = e.currentTarget.value; p.onPick(x === "" ? null : x); }}>
      {pickerChoices(p.row).map((c) => <option key={c.label} value={c.value ?? ""}>{c.label}</option>)}
    </select>
  );
}

/** "sonnet → claude-sonnet-5, 4m ago", "failed: not a model" or "not used yet". */
function lastRan(m: SettingsView["models"][number], at: number): string {
  if (!m.last) return "not used yet";
  if (m.last.result === "bad-model") return "failed: not a model";
  const t = ago(m.last.ts, at);
  return `${m.name} → ${m.last.ran ?? m.name}, ${t === "now" || t === "–" ? t : `${t} ago`}`;
}
