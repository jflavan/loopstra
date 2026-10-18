import type { ChangeSummary, RunningPhase } from "../../console/types";
import type { Status } from "../../intents";
import { ago, costSoFar, duration, shortModel, stepWord, usd } from "../format";
import { Link } from "../parts/Link";
import { changes, loop, meta, now, running } from "../store";

/** Changes waiting their turn: in progress, or approved and ready for their next step. */
const WAITING: ReadonlySet<Status> = new Set<Status>(["accepted", "designing", "spec-approved", "planning", "plan-approved", "building", "reviewing", "merge-approved", "merged", "verifying"]);

export function Live() {
  const r = running.value;
  const list = changes.value;
  const l = loop.value;
  const m = meta.value;
  const t = now.value;
  if (!r || !list || !l || !m) return <section class="view"><p class="muted">Connecting…</p></section>;
  const busy = new Set(r.now.map((p) => p.slug));
  const next = list.filter((c) => !busy.has(c.slug) && WAITING.has(c.status as Status)).slice(0, 6);
  const when = (iso: string) => {
    const a = ago(iso, t);
    return a === "now" ? "just now" : `${a} ago`;
  };
  return (
    <section class="view">
      <div class="view-head">
        <h1>Live</h1>
        <span class="muted">{r.now.length ? `${r.now.length} ${r.now.length === 1 ? "agent is" : "agents are"} working` : l.text}</span>
      </div>
      {r.now.length ? (
        <div class="cards">{r.now.map((p) => <AgentCard key={`${p.slug}:${p.seq}`} p={p} t={t} rate={m.usdPerMinute} asks={list.find((c) => c.slug === p.slug)?.question ?? null} />)}</div>
      ) : (
        <div class="empty">Nothing is running.{l.nextCheck ? ` The next check is in ${duration(Math.max(0, Date.parse(l.nextCheck) - t))}.` : ""}</div>
      )}
      <h2>Up next</h2>
      {next.length ? (
        <ul class="rows">
          {next.map((c) => (
            <li key={c.slug}>
              <Link href={`/c/${c.slug}`}><b>{c.title}</b></Link>
              <span class="muted">{c.plain}</span>
              {c.waiting && <span class="badge warn">{c.waiting}</span>}
              {c.question && <span class="badge warn" title={c.question.text}>Has a question</span>}
              <span class="when">{c.inStatus ? `for ${c.inStatus}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : <p class="muted">Nothing is waiting its turn.</p>}
      <h2>Just finished</h2>
      {r.recent.length ? (
        <ul class="rows">
          {r.recent.map((p) => (
            <li key={`${p.slug}:${p.seq}`}>
              <span class={`status ${p.status}`}>{stepWord(p.status)}</span>
              <Link href={`/s/${p.slug}/${p.seq}`}>{p.slug} · {p.name}</Link>
              <span class="when">{duration(p.durationMs)} · {usd(p.costUsd)} · {when(p.ended)}</span>
            </li>
          ))}
        </ul>
      ) : <p class="muted">No step has finished yet.</p>}
    </section>
  );
}

/** One running session. `asks`: its change's question waiting for a person, if any. */
function AgentCard({ p, t, rate, asks }: { p: RunningPhase; t: number; rate: number; asks: ChangeSummary["question"] }) {
  return (
    <article class="card live">
      <div class="card-head">
        <Link href={`/c/${p.slug}`} class="card-title">{p.title}</Link>
        <span class="grow" />
        <span class="chip">{p.name}{p.model ? ` · ${shortModel(p.model)}` : ""}</span>
      </div>
      {asks && <span class="badge warn" title={asks.text}>Has a question</span>}
      <div class="card-now" title={p.now}><span class="pulse" aria-hidden="true" />{p.now}</div>
      <div class="strip" aria-hidden="true">{p.strip.map((k, i) => <i key={i} class={k} />)}</div>
      <div class="card-foot">
        <span title="Running for">{duration(t - Date.parse(p.started))}</span>
        <span title="An estimate: the real cost is recorded when the step ends">{usd(costSoFar(p.started, t, rate), true)}</span>
        <span class="grow" />
        {p.steerable && <Link href={`/s/${p.slug}/${p.seq}`} class="link" title="Send this session a message from its page">Message</Link>}
        <Link href={`/s/${p.slug}/${p.seq}`} class="btn">Watch</Link>
      </div>
    </article>
  );
}
