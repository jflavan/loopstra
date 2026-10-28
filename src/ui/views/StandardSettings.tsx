import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DraftChecked, StandardForm, StandardRow, StandardsView, TriedCheck } from "../../console/types";
import { stripFrontmatter } from "../markdown";
import { Link } from "../parts/Link";
import { Markdown } from "../parts/Markdown";
import { post, sendAgentFiles } from "../requests";
import { BLANK, canSave, EXAMPLES, fieldProblems, isStandardName, opensAsMarkdown, removeText, saveNotice, scopeLine, takenNames } from "../standards";
import type { Submit } from "./AgentSettings";

/*
 * The Standards section of the Settings page: what is wrong with the standards on main, one row per
 * standard, and an editor (a form, or the whole file as Markdown). The server reads every draft
 * (`POST /api/standards/check`) and turns it from form to Markdown and back; a save is an
 * `agent-files` request for loopstra/standards/<name>.md, one at a time, through the page's `submit`.
 */

interface Props {
  view: StandardsView | null;
  failed: boolean;
  /** A change waits for the loop: nothing else may be sent. */
  locked: boolean;
  wait: (key: string) => ComponentChildren;
  submit: Submit;
}

/** Writes a standard's file (null removes it) over the version the page read; `after` hears whether the loop saved it. */
type Write = (name: string, text: string | null, base: string, after: (ok: boolean) => void) => void;

/** What the editor opens on: a standard of main's, or a new one from a form. */
type Target = { row: StandardRow } | { start: StandardForm };
/** What the editor is open on (`n` starts it afresh each time). */
type Opened = Target & { n: number };

const CHECK_MS = 400;
const keyOf = (name: string) => `standard:${name}`;

export function StandardSettings(p: Props) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Another editor asked for while this one has changes not saved: it opens once the person says to drop them.
  const [asking, setAsking] = useState<Target | null>(null);
  const dirty = useRef(false);
  const v = p.view;
  if (!v) return <><h2>Standards</h2><p class="muted">{p.failed ? "The standards could not be read." : "Loading…"}</p></>;
  const write: Write = (name, text, base, after) => void p.submit(keyOf(name), (done) => sendAgentFiles({ op: "standard", name, text, base }, done), after);
  const go = (o: Target | null) => {
    dirty.current = false;
    setAsking(null);
    setOpened(o && { ...o, n: (opened?.n ?? 0) + 1 });
  };
  const open = (o: Target) => { if (opened && dirty.current) setAsking(o); else go(o); };
  const titleOf = (o: Target) => ("row" in o ? o.row.path : o.start.title || "a blank standard");
  const editor = (o: Opened) => (
    <>
      {asking && (
        <div class="control-form" role="group" aria-label="Confirm dropping changes">
          <span>Drop the changes not saved to {"row" in o ? o.row.path : "the new standard"}, and open {titleOf(asking)}?</span>
          <button type="button" class="btn danger" onClick={() => go(asking)}>Drop them</button>
          <button type="button" class="btn" onClick={() => setAsking(null)}>Keep editing</button>
        </div>
      )}
      <Editor key={o.n} row={"row" in o ? o.row : null} start={"start" in o ? o.start : null} taken={"row" in o ? [] : takenNames(v)}
        locked={p.locked} wait={p.wait} write={write} dirty={dirty} close={() => go(null)} />
    </>
  );
  const notes = [
    ...v.problems,
    ...v.uncommitted.map((f) => `${f} has changes in the main checkout that are not committed, so they are not in force. Commit them, or undo them to edit it here.`),
    ...v.ignored.map((f) => `${f} is ignored: a standard is a <name>.md file directly in loopstra/standards/.`),
  ];
  return (
    <div class="standards">
      <h2>Standards</h2>
      <p class="muted">The rules each change is held to, from loopstra/standards/ on main. <Link href="/settings/exceptions">Exceptions granted</Link></p>
      {p.failed && <p class="muted">The latest read of the standards failed; this may be out of date.</p>}
      {notes.length > 0 && <div class={`callout${v.problems.length ? " bad" : ""}`} role="status"><ul class="agent-problems">{notes.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
      {!v.standards.length && <p class="muted">No standards yet.</p>}
      {v.standards.map((s) => (
        <div key={s.name} class="set-group">
          <div class="set-row set-head">
            <span><strong>{s.title}</strong> <code class="muted">{s.path}</code></span>
            {s.needsPerson && <span class="chip">needs a person</span>}
            <button type="button" class="btn" disabled={p.locked} onClick={() => open({ row: s })}>Edit</button>
            <button type="button" class="btn danger" disabled={p.locked} onClick={() => setRemoving(s.name)}>Remove</button>
          </div>
          <div class="std-facts muted">
            <span>{scopeLine(s)}</span>
            <span>{s.check ? <>Tool check <code>{s.check}</code></> : "No tool check"}</span>
            <span>{s.rules.length} rule{s.rules.length === 1 ? "" : "s"}</span>
            <span title={s.inProgress.join(", ") || undefined}>{s.inProgress.length ? `${s.inProgress.length} change${s.inProgress.length === 1 ? "" : "s"} in progress` : "No change in progress"}</span>
          </div>
          {removing === s.name && (
            <div class="control-form" role="group" aria-label="Confirm removing">
              <span>{removeText(s)}</span>
              <button type="button" class="btn danger" disabled={p.locked} onClick={() => write(s.name, null, s.version, (ok) => { if (ok) setRemoving(null); })}>Remove it</button>
              <button type="button" class="btn" onClick={() => setRemoving(null)}>Cancel</button>
              {p.wait(keyOf(s.name))}
            </div>
          )}
          {opened && "row" in opened && opened.row.name === s.name && editor(opened)}
        </div>
      ))}
      <details class="folded">
        <summary>New standard</summary>
        <div class="control-form">
          <button type="button" class="btn" disabled={p.locked} onClick={() => open({ start: BLANK })}>Blank</button>
          {EXAMPLES.map((e) => <button key={e.label} type="button" class="btn" disabled={p.locked} onClick={() => open({ start: e.form })}>Example: {e.label}</button>)}
        </div>
      </details>
      {opened && "start" in opened && editor(opened)}
    </div>
  );
}

/** A problem shown next to its field. */
const Problem = ({ text }: { text: string | undefined }) => (text ? <span class="std-problem" role="alert">{text}</span> : null);

/**
 * One standard, as a form or as its whole file. Each edit is checked by the server after a pause
 * (the file both ways, the problems, the patterns' matches); Save waits for a check with no problems.
 */
function Editor(p: { row: StandardRow | null; start: StandardForm | null; taken: string[]; locked: boolean; wait: Props["wait"]; write: Write; dirty: { current: boolean }; close: () => void }) {
  const [name, setName] = useState(p.row?.name ?? p.start?.name ?? "");
  const [mode, setMode] = useState<"form" | "md">("form");
  const [form, setForm] = useState<StandardForm | null>(p.start);
  // An edit opens on main's file, read once into a form; see the first effect.
  const [opening, setOpening] = useState(p.row !== null);
  const [text, setText] = useState(p.row?.text ?? "");
  // The server's answer, with the draft it is about: it counts only while the draft is still that one.
  const [checked, setChecked] = useState<{ key: string; c: DraftChecked } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // Whether the person changed anything (an edit with nothing changed offers no Save), and whether main's file is not written as the form writes it.
  const [dirty, setDirty] = useState(false);
  const [rewrites, setRewrites] = useState(false);
  const asked = useRef(0);
  useEffect(() => { p.dirty.current = dirty; }, [dirty]);
  // Main's file is read into a form, and the form written back: it opens as the form only when that gives
  // the file as it is, and otherwise as Markdown, so text outside the form's parts is never dropped unasked.
  useEffect(() => {
    const row = p.row;
    if (!row) return;
    let alive = true;
    void (async () => {
      const read = await post("/api/standards/check", { name: row.name, text: row.text });
      const f = read.ok ? (read.data as unknown as DraftChecked).form : null;
      const back = f ? await post("/api/standards/check", { name: row.name, form: f }) : null;
      if (!alive) return;
      if (!read.ok) setRefused(read.error);
      if (f && !opensAsMarkdown(row.text, back?.ok ? (back.data as unknown as DraftChecked).text : null)) setForm(f);
      else { setRewrites(f !== null); setMode("md"); }
      setOpening(false);
    })();
    return () => { alive = false; };
  }, []);
  const draft = mode === "form" && form ? { name, form: { ...form, name } } : { name, text };
  const draftKey = JSON.stringify(draft);
  const check = checked?.key === draftKey ? checked.c : null;
  useEffect(() => {
    // Any answer still on its way is for an older draft.
    const n = ++asked.current;
    if (opening) return;
    setRefused(null);
    if (!isStandardName(name)) return;
    const t = setTimeout(() => void post("/api/standards/check", draft).then((r) => {
      if (n !== asked.current) return;
      if (!r.ok) { setRefused(r.error); return; }
      const c = r.data as unknown as DraftChecked;
      setChecked({ key: draftKey, c });
      if (mode === "form") setText(c.text);
    }), checked ? CHECK_MS : 0);
    return () => clearTimeout(t);
  }, [draftKey, opening]);

  const shown = mode === "form" ? form : check?.form ?? null;
  const probs = form ? fieldProblems({ ...form, name }, check?.problems ?? [], p.taken) : {};
  const nameProblem = fieldProblems({ ...(shown ?? BLANK), name }, [], p.taken).name;
  const save = (dirty || !p.row) && shown !== null && check !== null && !nameProblem && canSave({ ...shown, name }, check) && check.text !== p.row?.text;
  const set = (patch: Partial<StandardForm>) => { setDirty(true); setForm((f) => (f ? { ...f, ...patch } : f)); };
  const notice = saveNotice(p.row?.inProgress ?? []);
  return (
    <div class="std-editor agent-form">
      <div class="control-form">
        <strong>{p.row ? `Editing ${p.row.path}` : "New standard"}</strong>
        <button type="button" class="btn" disabled={mode === "md" ? !check?.form : !check} title={mode === "md" && check && !check.form ? "The file must read as a standard to go back to the form." : undefined}
          onClick={() => { if (mode === "md" && check?.form) { setForm(check.form); setMode("form"); } else if (mode === "form" && check) { setText(check.text); setMode("md"); } }}>
          {mode === "form" ? "Edit as Markdown" : "Edit as a form"}
        </button>
      </div>
      <label>Name <input type="text" value={name} disabled={!!p.row} placeholder="security" autocomplete="off" spellcheck={false} onInput={(e) => { setDirty(true); setName(e.currentTarget.value.trim()); }} /></label>
      <Problem text={nameProblem} />
      {opening ? <p class="muted">Reading the file…</p> : mode === "md" ? (
        <>
          {rewrites && <p class="muted">This file is not written the way the form writes it, so it opens as Markdown. The form would rewrite it, and drop any text outside the title, the context and the rules.</p>}
          <label>The file <textarea class="std-md" value={text} spellcheck={false} onInput={(e) => { setDirty(true); setText(e.currentTarget.value); }} /></label>
          {check && check.problems.length > 0 && <ul class="agent-problems std-problem">{check.problems.map((x, i) => <li key={i}>{x.text}.</li>)}</ul>}
          <details class="folded" open><summary>Preview</summary><Markdown text={stripFrontmatter(text)} /></details>
        </>
      ) : !form ? null : (
        <>
          <label>Title <input type="text" value={form.title} placeholder="Service architecture" onInput={(e) => set({ title: e.currentTarget.value })} /></label>
          <Problem text={probs.title} />
          <fieldset class="std-set">
            <legend>Applies to</legend>
            {!form.patterns.length && <span class="muted">Every change. Add a pattern to hold only changes that touch matching files to it.</span>}
            {form.patterns.map((pat, i) => {
              const m = check?.matches.find((x) => x.pattern === pat);
              return (
                <div key={i} class="control-form">
                  <input type="text" aria-label={`Pattern ${i + 1}`} value={pat} placeholder="services/**" spellcheck={false} onInput={(e) => { const x = e.currentTarget.value; set({ patterns: form.patterns.map((o, j) => (j === i ? x : o)) }); }} />
                  {m && (
                    <details class="std-files">
                      <summary>{m.count} file{m.count === 1 ? "" : "s"} on main</summary>
                      {m.sample.map((f) => <div key={f}><code>{f}</code></div>)}
                      {m.count > m.sample.length && <span class="muted">and {m.count - m.sample.length} more</span>}
                    </details>
                  )}
                  <button type="button" class="btn" onClick={() => set({ patterns: form.patterns.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              );
            })}
            <Problem text={probs.patterns} />
            <div><button type="button" class="btn" onClick={() => set({ patterns: [...form.patterns, ""] })}>Add a pattern</button></div>
          </fieldset>
          <label class="agent-check"><input type="checkbox" checked={form.needsPerson} onChange={(e) => set({ needsPerson: e.currentTarget.checked })} /> Needs a person before merging</label>
          <label>Tool check <input type="text" value={form.check} placeholder='gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"' spellcheck={false} autocomplete="off" onInput={(e) => set({ check: e.currentTarget.value })} /></label>
          <Problem text={probs.check} />
          {form.check.trim() && <TryIt key={form.check} draft={draft} ready={check !== null && !check.problems.length} use={(c) => set({ check: c })} />}
          <fieldset class="std-set">
            <legend>Rules</legend>
            {form.rules.map((r, i) => (
              <div key={i} class="std-rule">
                <input type="text" aria-label={`Label of rule ${i + 1}`} value={r.label} placeholder="ARCH-1" spellcheck={false} autocomplete="off"
                  onInput={(e) => { const label = e.currentTarget.value.trim(); set({ rules: form.rules.map((o, j) => (j === i ? { ...o, label } : o)) }); }} />
                <textarea aria-label={`Rule ${i + 1}`} value={r.text} placeholder="What the rule asks"
                  onInput={(e) => { const x = e.currentTarget.value; set({ rules: form.rules.map((o, j) => (j === i ? { ...o, text: x } : o)) }); }} />
                <button type="button" class="btn" onClick={() => set({ rules: form.rules.filter((_, j) => j !== i) })}>Remove</button>
                <Problem text={probs[`rule:${i}`]} />
              </div>
            ))}
            <Problem text={probs.rules} />
            <div><button type="button" class="btn" onClick={() => set({ rules: [...form.rules, { label: "", text: "" }] })}>Add a rule</button></div>
          </fieldset>
          <label>Context <textarea value={form.context} placeholder="Why these rules exist, links to the design records, examples of the right way." onInput={(e) => set({ context: e.currentTarget.value })} /></label>
          <Problem text={probs.file} />
        </>
      )}
      {refused && <p class="callout bad">{refused}</p>}
      <div class="control-form">
        <button type="button" class="btn primary" disabled={p.locked || !save} onClick={() => check && p.write(name, check.text, p.row?.version ?? "absent", (ok) => { if (ok) p.close(); })}>Save</button>
        <button type="button" class="btn" onClick={p.close}>Cancel</button>
        {isStandardName(name) && !check && !refused && <span class="muted">Checking…</span>}
        {notice && <span class="muted">{notice}</span>}
        {p.wait(keyOf(name))}
      </div>
    </div>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Try it on main: the draft's check in a throwaway checkout of main, with how it went. `use` puts a base-aware form in the field. */
function TryIt({ draft, ready, use }: { draft: unknown; ready: boolean; use: (check: string) => void }) {
  const [state, setState] = useState<"running" | { r: TriedCheck } | { error: string } | null>(null);
  const run = async () => {
    setState("running");
    const r = await post("/api/standards/try", draft);
    setState(r.ok ? { r: r.data as unknown as TriedCheck } : { error: r.error });
  };
  const r = state && typeof state === "object" && "r" in state ? state.r : null;
  const said = !r ? null
    : r.ok ? `It passed on main in ${seconds(r.durationMs)}.`
    : r.timedOut ? "It did not finish on main within claude.timeout_minutes."
    : r.installFailed ? `commands.install failed on main (exit ${r.code}), so the check did not run.`
    : r.missingProgram ? `${r.missingProgram} is not installed or not on PATH, so the check did not run.`
    : `It failed on main (exit ${r.code}) after ${seconds(r.durationMs)}.`;
  return (
    <div class="std-try">
      <div class="control-form">
        <button type="button" class="btn" disabled={!ready || state === "running"} onClick={() => void run()}>{state === "running" ? "Running on main…" : "Try it on main"}</button>
        {said && <span>{said}</span>}
      </div>
      {state && typeof state === "object" && "error" in state && <p class="callout bad">{state.error}</p>}
      {r?.failsOnMain && (
        <div class="callout bad" role="status">
          {r.failsOnMain}
          {r.baseAware && <> For this scanner, that form is <code>{r.baseAware}</code> <button type="button" class="btn" onClick={() => use(r.baseAware!)}>Use it</button></>}
        </div>
      )}
      {r?.lastLines && <pre class="std-out">{r.lastLines}</pre>}
    </div>
  );
}
