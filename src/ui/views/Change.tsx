import { useEffect, useState } from "preact/hooks";
import type { ChangeDetail, DiffView, PhaseView, Stage } from "../../console/types";
import { clock, duration, stepWord, usd } from "../format";
import { barEnd, codeKey, detailKey } from "../change-key";
import { stripFrontmatter } from "../markdown";
import { Actions } from "../parts/Actions";
import { Diff } from "../parts/Diff";
import { Link } from "../parts/Link";
import { Markdown } from "../parts/Markdown";
import { TABS, type Tab } from "../router";
import { changes, getJson, HttpError, now, openDrawer, running } from "../store";
import { COLUMNS } from "./Changes";

const TAB_LABEL: Record<Tab, string> = { overview: "Overview", documents: "Documents", timeline: "Timeline", code: "Code", gates: "Gates" };

export function Change({ slug, tab }: { slug: string; tab: Tab }) {
  const summary = changes.value?.find((c) => c.slug === slug);
  const runningSeqs = running.value?.now.filter((p) => p.slug === slug).map((p) => p.seq).join(",") ?? "";
  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  // "missing": the server said 404. "failed": anything else; the next change of the key reads it again.
  const [problem, setProblem] = useState<"missing" | "failed" | null>(null);
  // Read again when something that matters changed: the summary's "12s" age is rebuilt with every update and must not count.
  const key = detailKey(summary, runningSeqs);
  useEffect(() => {
    let live = true;
    getJson<ChangeDetail>(`/api/changes/${slug}`).then(
      (d) => { if (live) { setDetail(d); setProblem(null); } },
      (e) => { if (live) setProblem(e instanceof HttpError && e.status === 404 ? "missing" : "failed"); },
    );
    return () => { live = false; };
  }, [slug, key]);
  if (problem === "failed" && !detail) {
    return (
      <section class="view">
        <p class="muted">This change could not be read. The console will try again.</p>
      </section>
    );
  }
  if (problem === "missing" && !detail) {
    return (
      <section class="view">
        <h1>No such change</h1>
        <p class="muted">There is no change called {slug}. <Link href="/changes">See every change</Link>.</p>
      </section>
    );
  }
  if (!detail) return <section class="view"><p class="muted">Loading…</p></section>;
  const d = detail;
  // From the summary, which comes with every update: a hold or a release shows at once.
  const held = (summary ?? d).held;
  const question = (summary ?? d).question;
  return (
    <section class="view">
      <div class="view-head">
        <h1>{d.title}</h1>
        <span class={`status ${d.status}`}>{d.plain}</span>
        <span class={`prio ${d.priority}`}>{d.priority}</span>
        {held && <span class="badge warn" title={held}>Held</span>}
        {question && <span class="badge warn" title={question.text}>Has a question</span>}
        {d.running && <span class="pulse" role="img" aria-label="running" />}
        <span class="grow" />
        <button class="btn" onClick={() => openDrawer({ slug: d.slug, title: d.title })}>Ask the orchestrator</button>
      </div>
      {/* The summary comes with every update, so its offers are current; the detail is the fallback before the first one. */}
      <Actions change={summary ?? d} />
      <Stepper stage={d.stage} />
      <nav class="tabs" aria-label="Parts of this change">
        {TABS.map((t) => <Link key={t} href={t === "overview" ? `/c/${slug}` : `/c/${slug}/${t}`} class={`tab${t === tab ? " on" : ""}`} current={t === tab}>{TAB_LABEL[t]}</Link>)}
      </nav>
      {tab === "overview" && <Overview d={d} />}
      {tab === "documents" && <Documents d={d} />}
      {tab === "timeline" && <Timeline d={d} />}
      {tab === "code" && <Code slug={slug} reload={codeKey(summary, runningSeqs)} />}
      {tab === "gates" && <Gates d={d} />}
    </section>
  );
}

function Stepper({ stage }: { stage: Stage }) {
  if (stage === "blocked" || stage === "closed") {
    return <div class="stepper"><span class={`badge${stage === "blocked" ? " bad" : ""}`}>{stage === "blocked" ? "Blocked: it needs a person" : "Closed"}</span></div>;
  }
  const at = COLUMNS.findIndex((s) => s.stage === stage);
  return <div class="stepper">{COLUMNS.map((s, k) => <span key={s.stage} class={`step${k < at ? " done" : k === at ? " now" : ""}`}>{s.label}</span>)}</div>;
}

/** A document's text, read again when the change moves on. */
function useText(url: string | null, version: string | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setText(null);
    const failed = "This document could not be read.";
    fetch(url).then((r) => (r.ok ? r.text() : failed)).catch(() => failed).then((t) => { if (live) setText(t); });
    return () => { live = false; };
  }, [url, version]);
  return text;
}

function Overview({ d }: { d: ChangeDetail }) {
  const intent = useText(`/docs/${d.slug}/intent.md`, d.since);
  return (
    <div class="stack">
      <div class="facts">
        <span>In this status <b>{d.inStatus ?? "–"}</b></span>
        <span>Spent <b>{usd(d.costUsd)}</b></span>
        <span>Steps <b>{d.phases.length}</b></span>
        {d.dependsOn.length > 0 && <span>Depends on <b>{d.dependsOn.join(", ")}</b></span>}
      </div>
      {d.waiting && <span class="badge warn">{d.waiting}</span>}
      {d.note && <div class="panel"><h2>Note</h2><Markdown text={d.note} /></div>}
      <div class="panel">{intent === null ? <p class="muted">Loading the intent…</p> : <Markdown text={stripFrontmatter(intent)} />}</div>
    </div>
  );
}

function Documents({ d }: { d: ChangeDetail }) {
  // What the person chose; until they choose, the first document that is not the intent (the Overview shows that), picked again if the list changes.
  const [picked, setPicked] = useState("");
  const doc = d.documents.find((x) => x.name === picked) ?? d.documents.find((x) => x.name !== "intent.md") ?? d.documents[0] ?? null;
  const text = useText(doc?.url ?? null, d.since);
  if (!doc) return <p class="muted">No documents yet.</p>;
  return (
    <div>
      <div class="doc-tabs">{d.documents.map((x) => <button key={x.name} class={`btn${x.name === doc.name ? " on" : ""}`} onClick={() => setPicked(x.name)}>{x.name}</button>)}</div>
      <div class="panel">{text === null ? <p class="muted">Loading…</p> : <Markdown text={doc.name === "intent.md" ? stripFrontmatter(text) : text} />}</div>
    </div>
  );
}

function Timeline({ d }: { d: ChangeDetail }) {
  const t = now.value;
  if (!d.phases.length) return <p class="muted">No steps yet.</p>;
  const ends = d.phases.map((p) => barEnd(p, t));
  const start = Math.min(...d.phases.map((p) => Date.parse(p.started)));
  const span = Math.max(1, Math.max(...ends) - start);
  const took = (p: PhaseView) => duration(p.status === "running" ? t - Date.parse(p.started) : p.durationMs);
  return (
    <div class="stack">
      <div class="timeline">
        {d.phases.map((p, k) => {
          const left = ((Date.parse(p.started) - start) / span) * 100;
          const width = Math.min(100 - left, Math.max(0.4, ((ends[k]! - Date.parse(p.started)) / span) * 100));
          const row = (
            <>
              <span class="tl-name" title={p.name}>{p.name}</span>
              <span class="tl-track"><span class={`tl-bar ${p.status}`} style={{ left: `${left}%`, width: `${width}%` }} /></span>
              <span class="tl-meta">{took(p)} · {usd(p.costUsd)}</span>
            </>
          );
          return p.kind === "agent"
            ? <Link key={p.seq} href={`/s/${d.slug}/${p.seq}`} class="tl-row">{row}</Link>
            : <div key={p.seq} class="tl-row">{row}</div>;
        })}
      </div>
      <div class="table-wrap">
        <table class="list">
          <thead><tr><th>Step</th><th>Result</th><th>Started</th><th class="num">Took</th><th class="num">Cost</th><th>Files</th></tr></thead>
          <tbody>
            {d.phases.map((p) => (
              <tr key={p.seq}>
                <td>
                  {p.kind === "agent" ? <Link href={`/s/${d.slug}/${p.seq}`}>{p.name}</Link> : p.name}
                  {p.error && <div class="muted">{p.error}</div>}
                  {p.denied.length > 0 && <div class="muted">Not allowed: {p.denied.join(", ")}</div>}
                </td>
                <td><span class={`status ${p.status}`}>{stepWord(p.status)}</span></td>
                <td>{clock(p.started, t)}</td>
                <td class="num">{took(p)}</td>
                <td class="num">{usd(p.costUsd)}</td>
                <td>{p.files.map((f) => <a key={f.name} href={f.url} target="_blank" rel="noopener noreferrer" class="chip">{f.name}</a>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The branch's diff. A reload keeps the old diff on screen until the new one arrives, so the page does not flash. */
function Code({ slug, reload }: { slug: string; reload: string }) {
  const [diff, setDiff] = useState<DiffView | null>(null);
  useEffect(() => {
    let live = true;
    getJson<DiffView>(`/api/changes/${slug}/diff`).then(
      (v) => { if (live) setDiff(v); },
      () => { if (live) setDiff({ exists: true, stat: "", patch: "", cut: false, problem: "The diff could not be read." }); },
    );
    return () => { live = false; };
  }, [slug, reload]);
  if (!diff) return <p class="muted">Loading the diff…</p>;
  if (diff.problem) return <span class="badge bad">{diff.problem}</span>;
  if (!diff.exists) return <p class="muted">This change has no branch: it has not been built yet, or it was merged and its branch removed.</p>;
  return (
    <div class="stack">
      <pre class="panel mono" style={{ margin: 0, overflowX: "auto" }}>{diff.stat.trim() || "No files changed."}</pre>
      {diff.cut && <span class="badge warn">This diff is long, so only its start is shown.</span>}
      <Diff text={diff.patch} />
    </div>
  );
}

function Gates({ d }: { d: ChangeDetail }) {
  const t = now.value;
  if (!d.gates.length) return <p class="muted">No gate has been checked yet.</p>;
  return (
    <div class="table-wrap">
      <table class="list">
        <thead><tr><th>Gate</th><th>Check</th><th>Result</th><th>When</th><th>Evidence</th></tr></thead>
        <tbody>
          {[...d.gates].reverse().map((g, k) => (
            <tr key={k}>
              <td>{g.gate}</td>
              <td>{g.check}</td>
              <td><span class={`status ${g.result}`}>{g.result}</span></td>
              <td>{clock(g.ts, t)}</td>
              <td><Markdown text={g.evidence} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
