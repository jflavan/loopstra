import { useEffect, useState } from "preact/hooks";
import type { ChangeDetail, PhaseView, SessionMessage, TranscriptItem } from "../../console/types";
import { clock, costSoFar, duration, shortModel, stepWord, usd } from "../format";
import { Link } from "../parts/Link";
import { Steer } from "../parts/Steer";
import { Transcript } from "../parts/Transcript";
import { steerOffer } from "../requests";
import { changes, getJson, meta, now, openDrawer, running } from "../store";
import { follow } from "../stream";
import { addItems, EMPTY, lastCost, type Shown } from "../transcript";

type Phase = Extract<SessionMessage, { type: "phase" }>;

// The screen is keyed by session (see app.tsx), so every piece of state here starts over when the person opens another one.
export function Session({ slug, seq }: { slug: string; seq: number }) {
  const [shown, setShown] = useState<Shown>(EMPTY);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [ended, setEnded] = useState(false);
  const [down, setDown] = useState(false);
  const [missing, setMissing] = useState(false);
  const [detail, setDetail] = useState<PhaseView | null>(null);
  const chat = slug.startsWith("_");

  useEffect(() => {
    let buffer: TranscriptItem[] = [];
    let gotPhase = false;
    const flushNow = () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      setShown((s) => addItems(s, batch));
    };
    // Rows arrive in bursts; drawing them ten times a second keeps a long session smooth.
    const flush = setInterval(flushNow, 100);
    // A stream opened again continues from the last row's offset (see follow); each row's id is one.
    const stop = follow((from) => `/api/sessions/${encodeURIComponent(slug)}/${seq}/stream${from > 0 ? `?from=${from}` : ""}`, {
      message(data) {
        let m: SessionMessage;
        try { m = JSON.parse(data) as SessionMessage; } catch { return; }
        if (m.type === "item") {
          buffer.push(m.item);
          return;
        }
        // A phase or the end settles what is shown at once, so "no transcript" is never said while rows wait in the buffer.
        flushNow();
        if (m.type === "phase") {
          gotPhase = true;
          setPhase(m);
        } else if (m.type === "end") {
          setEnded(true);
          stop();
        }
      },
      live() { setDown(false); },
      down(why) {
        // Closed before it said what the step is: there is no such step. (Closed later, it is opened again.)
        if (why === "closed" && !gotPhase) {
          setMissing(true);
          return "stop";
        }
        setDown(true);
      },
    });
    return () => {
      clearInterval(flush);
      stop();
    };
  }, [slug, seq]);

  // The step's cost, files and refused commands, read once the stream has said what the step is and again when its status changes. Chat has no change page.
  const status = phase?.status;
  useEffect(() => {
    if (chat || status === undefined) return;
    let live = true;
    getJson<ChangeDetail>(`/api/changes/${slug}`).then((d) => { if (live) setDetail(d.phases.find((p) => p.seq === seq) ?? null); }, () => {});
    return () => { live = false; };
  }, [slug, seq, status]);

  if (missing && !phase) {
    return (
      <section class="view">
        <h1>No such step</h1>
        <p class="muted">
          There is no step {seq} for {chat ? "that" : slug}. {chat ? <Link href="/activity">Open Activity</Link> : <Link href={`/c/${slug}`}>Open the change</Link>}.
        </p>
      </section>
    );
  }
  const card = running.value?.now.find((p) => p.slug === slug && p.seq === seq);
  const title = slug === "_chat" ? "Chat" : changes.value?.find((c) => c.slug === slug)?.title ?? slug;
  const live = phase?.status === "running" && !ended;
  // What a person may do to the running session; chat's sessions are not a change's, so they are not steered here.
  const offer = phase && !chat ? steerOffer(phase.name, phase.status, ended) : null;
  return (
    <section class="view">
      <div class="view-head">
        <h1>
          {chat ? title : <Link href={`/c/${slug}`}>{title}</Link>}
          <span class="muted"> › {phase?.name ?? `step ${seq}`}</span>
        </h1>
        {phase && <span class={`status ${phase.status}`}>{stepWord(phase.status)}</span>}
        {live && <span class="pulse" role="img" aria-label="live" />}
      </div>
      {down && !ended && <p class="muted" role="status">Reconnecting… the transcript may be behind.</p>}
      {offer && <Steer slug={slug} seq={seq} offer={offer} />}
      <div class="session">
        <Transcript shown={shown} live={live} done={ended} />
        <aside class="side">
          {shown.todos && shown.todos.length > 0 && (
            <div class="panel">
              <h2>Its todo list</h2>
              <ul class="todos">{shown.todos.map((td, k) => <li key={k} class={td.state}>{td.text}</li>)}</ul>
            </div>
          )}
          <div class="panel">
            <Facts phase={phase} live={live} model={card?.model ?? null} detail={detail} chatCost={chat ? lastCost(shown) : null} />
            {detail && detail.denied.length > 0 && <p class="muted">Not allowed: {detail.denied.join(", ")}</p>}
            {detail && detail.files.length > 0 && <p>{detail.files.map((f) => <a key={f.name} href={f.url} target="_blank" rel="noopener noreferrer" class="chip">{f.name}</a>)}</p>}
          </div>
          {!chat && <button class="btn" onClick={() => openDrawer({ slug, title, seq })}>Ask the orchestrator about this</button>}
        </aside>
      </div>
    </section>
  );
}

/** The facts that move with the clock. They read the time here, so a tick redraws these lines and not the transcript. */
function Facts({ phase, live, model, detail, chatCost }: { phase: Phase | null; live: boolean; model: string | null; detail: PhaseView | null; chatCost: number | null }) {
  const t = now.value;
  const rate = meta.value?.usdPerMinute;
  const elapsed = phase ? (phase.ended ? Date.parse(phase.ended) : t) - Date.parse(phase.started) : 0;
  let cost = "–";
  if (live && phase) {
    if (rate !== undefined) cost = usd(costSoFar(phase.started, t, rate), true);
  } else if (chatCost !== null) cost = usd(chatCost);
  else if (detail) cost = usd(detail.costUsd);
  return (
    <dl>
      {model && <><dt>Model</dt><dd>{shortModel(model)}</dd></>}
      {phase && <><dt>Started</dt><dd>{clock(phase.started, t)}</dd></>}
      {phase && <><dt>{live ? "Running for" : "Took"}</dt><dd>{duration(elapsed)}</dd></>}
      <dt>Cost</dt>
      <dd>{cost}</dd>
      {detail?.error && <><dt>Problem</dt><dd>{detail.error}</dd></>}
    </dl>
  );
}
