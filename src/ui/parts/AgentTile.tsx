import type { ChangeSummary } from "../../console/types";
import type { Tile } from "../agents";
import type { About } from "../chat";
import { costSoFar, duration, shortModel, stepWord, usd } from "../format";
import { steerOffer } from "../requests";
import { meta, now, running } from "../store";
import { lastCost } from "../transcript";
import { Actions } from "./Actions";
import { Chat } from "./Drawer";
import { Icon } from "./Icon";
import { Link } from "./Link";
import { Steer } from "./Steer";
import { Transcript } from "./Transcript";

/** The element id of a session's tile, for links and focus. */
export const tileId = (key: string): string => `agent-${key.replace(":", "-")}`;

/**
 * One session: its live transcript and its controls; once it has ended, greyed, with how it ended.
 * `onAsk`: points the orchestrator at it (null when chat is off).
 */
export function AgentTile({ tile, onAsk }: { tile: Tile; onAsk: (() => void) | null }) {
  const t = now.value;
  const a = tile.agent;
  const ended = tile.endedAt !== null;
  // A session that ended while the page was away never sent its last phase: the steps just finished say how it went.
  const finished = ended ? running.value?.recent.find((r) => r.slug === a.slug && r.seq === a.seq) : undefined;
  const status = tile.phase && tile.phase.status !== "running" ? tile.phase.status : finished?.status ?? "running";
  const offer = steerOffer(a.name, status, ended);
  const endedAt = tile.phase?.ended ?? finished?.ended;
  const until = endedAt ? Date.parse(endedAt) : ended ? tile.endedAt! : t;
  const rate = meta.value?.usdPerMinute;
  // A running session's cost is an estimate until it ends; then the trace (or its result row) says what it was.
  const cost = ended ? finished?.costUsd ?? lastCost(tile.shown) : rate === undefined ? null : costSoFar(a.started, t, rate);
  return (
    <article id={tileId(tile.key)} class={`card agent-tile${ended ? " ended" : " live"}`} aria-label={`${a.title}, ${a.name}`}>
      <div class="card-head">
        <Link href={`/c/${a.slug}`} class="card-title">{a.title}</Link>
        <span class="muted nowrap">› {a.name}{a.model ? ` · ${shortModel(a.model)}` : ""}</span>
        <span class="grow" />
        <span class="muted nowrap tabular">{duration(until - Date.parse(a.started))}{cost !== null ? ` · ${usd(cost, !ended)}` : ""}</span>
        <Link href={`/s/${a.slug}/${a.seq}`} class="ghost" title="Open the session's page"><Icon name="open" /></Link>
      </div>
      {/* Always drawn, even while it has no rows (a stream that came back sends them again), so its scroll and "show earlier" stay. */}
      <Transcript shown={tile.shown} live={!ended} done={ended} compact />
      {ended ? (
        <p class="muted note">{status === "running" ? "Ended" : `It ${stepWord(status)}.`}</p>
      ) : offer && (
        <Steer slug={a.slug} seq={a.seq} offer={offer} compact
          extra={onAsk && <button type="button" class="btn" title="Ask the orchestrator about this agent" aria-label="Ask the orchestrator about this agent" onClick={onAsk}><Icon name="ask" /></button>} />
      )}
    </article>
  );
}

/** A change whose agent asked a question: the question, and Answer (the inbox's form). */
export function QuestionTile({ change }: { change: ChangeSummary }) {
  const q = change.question!;
  return (
    <article class="card agent-tile asks" aria-label={`${change.title} asks a question`}>
      <div class="card-head">
        <Link href={`/c/${change.slug}`} class="card-title">{change.title}</Link>
        <span class="muted nowrap">› {q.phase}</span>
        <span class="grow" />
        <span class="badge warn">Asks a question</span>
      </div>
      <div class="question">
        <b>{q.text}</b>
        {q.why && <span class="muted">{q.why}</span>}
      </div>
      <Actions change={change} compact />
    </article>
  );
}

/** The orchestrator, and what a tile pointed it at (`label`), which the person can clear. */
export function ChatTile({ about, label, onClear }: { about: About | null; label: string | null; onClear: () => void }) {
  return (
    <article id="agent-chat" class="card agent-tile chat-tile" aria-label="The orchestrator">
      <div class="card-head">
        <b class="card-title">Orchestrator</b>
        <span class="grow" />
        {label && (
          <span class="chip">
            About {label}
            <button type="button" class="ghost" aria-label="Stop asking about this" onClick={onClear}><Icon name="close" /></button>
          </span>
        )}
      </div>
      <Chat about={about} autoFocus={false} />
    </article>
  );
}
