import { useState } from "preact/hooks";
import type { ChangeDetail, ChangeStandardsView, ChangeSummary, StandardsView } from "../../console/types";
import { act, beforeOf, bodyFor, sendScope, unsentText } from "../requests";
import { addChoices, approveLabel, panelRows, removeChoices, scopeCanSend, scopeChoice, scopeDialog, scopeProblem, type PanelRow } from "../standards";
import { getJson, toast } from "../store";
import { Markdown } from "./Markdown";

type Waiting = Extract<PanelRow, { kind: "waiting" }>;

/** A waiting exception: the person allows it (the change's own Approve) or sends the change back with a note. */
function WaitingException({ w, change }: { w: Waiting; change: ChangeSummary }) {
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Approve and send back are the change's own offers, so they show only while the change is in that review.
  const approve = change.offers.find((o) => o.kind === "approve");
  const back = change.offers.find((o) => o.kind === "send-back");
  const run = async (kind: "approve" | "send-back") => {
    const offer = kind === "approve" ? approve : back;
    if (!offer) return;
    const label = `${offer.label}, ${change.slug}`;
    setBusy(true);
    try {
      const sent = await act(bodyFor(change, offer, kind === "send-back" ? { note } : {}), beforeOf(change), label);
      if (sent) { setSending(false); setNote(""); }
    } catch (e) {
      console.error(`${label}: it could not be sent`, e);
      toast(unsentText(label), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="panel warn-panel">
      <b>{w.label}</b>{w.title && <span class="muted"> ({w.title})</span>}
      <p>Exception asked for in the {w.gate}: {w.reason}</p>
      {approve && !sending && (
        <div class="controls">
          <button class="btn primary" type="button" disabled={busy} onClick={() => void run("approve")}>{approveLabel(w.gate)}</button>
          {back && <button class="btn" type="button" disabled={busy} onClick={() => setSending(true)}>Send back</button>}
        </div>
      )}
      {sending && (
        <form class="control-form" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run("send-back"); }}>
          <textarea value={note} placeholder="What should change? The agent gets this note." aria-label="What should change" maxLength={4000} onInput={(e) => setNote(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={busy || !note.trim()}>Send back</button>
          <button class="btn" type="button" onClick={() => setSending(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

/** The add / remove dialog: names the standard, asks for a note, sends it and shows the loop's answer. */
function ScopeDialog({ action, status, slug, choices, onClose }: { action: "add" | "remove"; status: string; slug: string; choices: { name: string; title: string }[]; onClose: () => void }) {
  const [picked, setName] = useState(choices[0]?.name ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  // The choices change when the change's standards do: a standard no longer offered is not sent.
  const name = scopeChoice(picked, choices);
  const words = scopeDialog(action, status);
  const problem = scopeProblem(action, note);
  const done = said?.ok === true;
  const send = async () => {
    if (!scopeCanSend({ busy, said, problem, name })) return;
    setBusy(true);
    setSaid(null);
    const r = await sendScope({ slug, action, name, note: note.trim() }, (d) => { setSaid(d); setBusy(false); });
    if (!r.ok) { setSaid({ ok: false, text: r.error }); setBusy(false); }
  };
  return (
    <form class="control-form" aria-label={action === "add" ? "Add a standard" : "Remove a standard"} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {done ? null : choices.length === 0 ? <span class="muted">{action === "add" ? "Every standard already applies." : "No standard applies."}</span> : (
        <>
          <label>Standard <select value={name} onChange={(e) => setName(e.currentTarget.value)}>{choices.map((c) => <option key={c.name} value={c.name}>{c.title || c.name}</option>)}</select></label>
          {words.notice && <p class="muted">{words.notice}</p>}
          <textarea value={note} placeholder={words.ask} aria-label={words.ask} maxLength={2000} onInput={(e) => setNote(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={!scopeCanSend({ busy, said, problem, name })}>{action === "add" ? "Add it" : "Remove it"}</button>
        </>
      )}
      <button class="btn" type="button" onClick={onClose}>{said ? "Close" : "Cancel"}</button>
      {!done && problem && note.length > 0 && <span class="muted">{problem}</span>}
      {said && <span class={`badge${said.ok ? "" : " bad"}`} role="status">{said.text}</span>}
    </form>
  );
}

/** What the change is held to: which standards apply and why, how it stands on each rule, exceptions waiting for a person, and add / remove for this change. */
export function StandardsPanel({ d, change }: { d: ChangeDetail; change: ChangeSummary }) {
  const [dialog, setDialog] = useState<"add" | "remove" | null>(null);
  const [all, setAll] = useState<StandardsView["standards"] | null>(null);
  const v: ChangeStandardsView | undefined = d.standards;
  if (!v) return null;
  const rows = panelRows(v, change.status);
  const openAdd = () => {
    setDialog("add");
    getJson<StandardsView>("/api/standards").then((s) => setAll(s.standards), () => { setAll([]); toast("The standards could not be read.", "bad"); });
  };
  return (
    <div class="stack">
      <div class="view-head">
        <h2>Standards</h2>
        <span class="grow" />
        <button class="btn" type="button" onClick={openAdd}>Add a standard…</button>
        <button class="btn" type="button" onClick={() => setDialog("remove")}>Remove…</button>
      </div>
      {dialog === "add" && (all === null ? <p class="muted">Loading…</p> : <ScopeDialog action="add" status={change.status} slug={d.slug} choices={addChoices(all, v)} onClose={() => setDialog(null)} />)}
      {dialog === "remove" && <ScopeDialog action="remove" status={change.status} slug={d.slug} choices={removeChoices(v)} onClose={() => setDialog(null)} />}
      {rows.map((r, k) => r.kind === "waiting" ? <WaitingException key={`w:${r.label}:${k}`} w={r} change={change} /> : (
        <div class="panel" key={r.name}>
          <b>{r.title}</b> <span class="muted">{r.name}</span>
          <p class="muted">{r.why}</p>
          {r.rules.length === 0 ? <p class="muted">It has no rules.</p> : (
            <ul>
              {r.rules.map((rule) => (
                <li key={rule.label}>
                  <b>{rule.label}</b> {rule.text}
                  {rule.spec && <div class="muted">Spec: {rule.spec}</div>}
                  {rule.plan && <div class="muted">Plan: {rule.plan}</div>}
                  {rule.findings.map((f, i) => <div key={i} class="muted">Review: <Markdown text={f} /></div>)}
                  {rule.result && <div>Final result: {rule.result}</div>}
                </li>
              ))}
            </ul>
          )}
          {r.check && <p>Check: {r.check}</p>}
        </div>
      ))}
      {v.record.problems.map((p) => <span key={p} class="badge warn">{p}</span>)}
    </div>
  );
}
