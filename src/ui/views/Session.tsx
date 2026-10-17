import { useEffect, useState } from "preact/hooks";
import type { ChangeDetail, PhaseView, SessionMessage, TranscriptItem } from "../../console/types";
import { clock, costSoFar, duration, shortModel, usd } from "../format";
import { Link } from "../parts/Link";
import { Transcript } from "../parts/Transcript";
import { changes, getJson, meta, now, openDrawer, running } from "../store";
import { addItems, EMPTY, type Shown } from "../transcript";

type Phase = Extract<SessionMessage, { type: "phase" }>;

export function Session({ slug, seq }: { slug: string; seq: number }) {
  const [shown, setShown] = useState<Shown>(EMPTY);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [ended, setEnded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [detail, setDetail] = useState<PhaseView | null>(null);

  useEffect(() => {
    setShown(EMPTY);
    setPhase(null);
    setEnded(false);
    setMissing(false);
    let buffer: TranscriptItem[] = [];
    // Rows arrive in bursts; drawing them ten times a second keeps a long session smooth.
    const flush = setInterval(() => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setShown((s) => addItems(s, batch));
    }, 100);
    const source = new EventSource(`/api/sessions/${encodeURIComponent(slug)}/${seq}/stream`);
    source.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string) as SessionMessage;
      if (m.type === "item") buffer.push(m.item);
      else if (m.type === "phase") setPhase(m);
      else {
        setEnded(true);
        source.close();
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setMissing(true);
    };
    return () => {
      clearInterval(flush);
      source.close();
    };
  }, [slug, seq]);

  // The step's cost, files and refused commands, read again when its status changes. Chat has no change page.
  const status = phase?.status;
  useEffect(() => {
    if (slug.startsWith("_")) return;
    let live = true;
    getJson<ChangeDetail>(`/api/changes/${slug}`).then((d) => { if (live) setDetail(d.phases.find((p) => p.seq === seq) ?? null); }, () => {});
    return () => { live = false; };
  }, [slug, seq, status]);

  if (missing && !phase) {
    return (
      <section class="view">
        <h1>No such step</h1>
        <p class="muted">There is no step {seq} for {slug}. <Link href={`/c/${slug}`}>Open the change</Link>.</p>
      </section>
    );
  }
  const t = now.value;
  const card = running.value?.now.find((p) => p.slug === slug && p.seq === seq);
  const title = changes.value?.find((c) => c.slug === slug)?.title ?? slug;
  const live = phase?.status === "running" && !ended;
  const elapsed = phase ? (phase.ended ? Date.parse(phase.ended) : t) - Date.parse(phase.started) : 0;
  return (
    <section class="view">
      <div class="view-head">
        <h1>
          {slug.startsWith("_") ? title : <Link href={`/c/${slug}`}>{title}</Link>}
          <span class="muted"> › {phase?.name ?? `step ${seq}`}</span>
        </h1>
        {phase && <span class={`status ${phase.status}`}>{phase.status}</span>}
        {live && <span class="pulse" aria-label="live" />}
      </div>
      <div class="session">
        {/* Keyed by session so following and "show all" start over when the person moves to another one. */}
        <Transcript key={`${slug}/${seq}`} shown={shown} live={live} />
        <aside class="side">
          {shown.todos && shown.todos.length > 0 && (
            <div class="panel">
              <h2>Its todo list</h2>
              <ul class="todos">{shown.todos.map((td, k) => <li key={k} class={td.state}>{td.text}</li>)}</ul>
            </div>
          )}
          <div class="panel">
            <dl>
              {card?.model && <><dt>Model</dt><dd>{shortModel(card.model)}</dd></>}
              {phase && <><dt>Started</dt><dd>{clock(phase.started, t)}</dd></>}
              {phase && <><dt>{live ? "Running for" : "Took"}</dt><dd>{duration(elapsed)}</dd></>}
              <dt>Cost</dt>
              <dd>{live && phase ? usd(costSoFar(phase.started, t, meta.value?.usdPerMinute ?? 0.2), true) : usd(detail?.costUsd ?? 0)}</dd>
              {detail?.error && <><dt>Problem</dt><dd>{detail.error}</dd></>}
            </dl>
            {detail && detail.denied.length > 0 && <p class="muted">Not allowed: {detail.denied.join(", ")}</p>}
            {detail && detail.files.length > 0 && <p>{detail.files.map((f) => <a key={f.name} href={f.url} target="_blank" rel="noopener noreferrer" class="chip">{f.name}</a>)}</p>}
          </div>
          {!slug.startsWith("_") && <button class="btn" onClick={() => openDrawer(title)}>Ask the orchestrator about this</button>}
        </aside>
      </div>
    </section>
  );
}
