import { useState } from "preact/hooks";
import type { ChangeSummary, Stage } from "../../console/types";
import { splitFinished } from "../board";
import { usd } from "../format";
import { fuzzyScore } from "../palette";
import { Connecting } from "../parts/Connecting";
import { Link } from "../parts/Link";
import { changes, now } from "../store";

export const COLUMNS: Array<{ stage: Stage; label: string }> = [
  { stage: "draft", label: "Draft" }, { stage: "design", label: "Design" }, { stage: "plan", label: "Plan" }, { stage: "build", label: "Build" },
  { stage: "review", label: "Review" }, { stage: "merge", label: "Merge" }, { stage: "verify", label: "Verify" }, { stage: "done", label: "Done" },
];

const VIEW_KEY = "loopstra-changes-view";
type View = "board" | "list";

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"; } catch { return "board"; }
}

export function Changes() {
  const all = changes.value;
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>(readView);
  if (!all) return <Connecting />;
  const shown = query.trim() ? all.filter((c) => fuzzyScore(query, `${c.title} ${c.slug}`) !== null) : all;
  const pick = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* kept for this visit only */ }
  };
  // The page's clock, so the fold moves with its tick and not with every draw.
  const { open, earlier, closed } = splitFinished(shown, now.value);
  const blocked = open.filter((c) => c.stage === "blocked");
  const folded = [...earlier, ...closed];
  return (
    <section class="view" style={{ maxWidth: "none" }}>
      <div class="view-head"><h1>Changes</h1><span class="muted">{all.length} in all</span></div>
      <div class="toolbar">
        <input type="search" placeholder="Filter by name" value={query} onInput={(e) => setQuery(e.currentTarget.value)} aria-label="Filter changes" />
        <span class="grow" />
        <button class={`btn${view === "board" ? " on" : ""}`} aria-pressed={view === "board"} onClick={() => pick("board")}>Board</button>
        <button class={`btn${view === "list" ? " on" : ""}`} aria-pressed={view === "list"} onClick={() => pick("list")}>List</button>
      </div>
      {view === "board" ? (
        <div class="board">
          {COLUMNS.map((col) => <Column key={col.stage} label={col.label} items={open.filter((c) => c.stage === col.stage)} />)}
          {blocked.length > 0 && <Column label="Blocked" items={blocked} bad />}
        </div>
      ) : <ListView items={open} />}
      {folded.length > 0 && (
        <details class="folded">
          <summary>{[earlier.length && `${earlier.length} finished over a week ago`, closed.length && `${closed.length} closed`].filter(Boolean).join(" · ")}</summary>
          <ListView items={folded} />
        </details>
      )}
    </section>
  );
}

function Column({ label, items, bad }: { label: string; items: ChangeSummary[]; bad?: boolean }) {
  return (
    <div class={`column${bad ? " blocked" : ""}`}>
      <div class="col-head"><span>{label}</span><span>{items.length}</span></div>
      {items.map((c) => <Card key={c.slug} c={c} />)}
    </div>
  );
}

function Card({ c }: { c: ChangeSummary }) {
  return (
    <Link href={`/c/${c.slug}`} class={`ccard${c.running ? " running" : ""}`}>
      <span class="ccard-title">{c.running && <span class="pulse" role="img" aria-label="running" />}{c.title}</span>
      <span class="ccard-meta"><span><span class={`prio ${c.priority}`}>{c.priority}</span>{c.held && <> <span class="badge warn" title={c.held}>Held</span></>}</span><span>{c.plain}</span></span>
      {c.question && <span class="badge warn" title={c.question.text}>Has a question</span>}
      <span class="ccard-meta"><span>{c.inStatus ? `for ${c.inStatus}` : ""}</span><span>{usd(c.costUsd)}</span></span>
      {c.waiting && <span class="badge warn">{c.waiting}</span>}
    </Link>
  );
}

function ListView({ items }: { items: ChangeSummary[] }) {
  if (!items.length) return <p class="muted">No changes here.</p>;
  return (
    <div class="table-wrap">
      <table class="list">
        <thead><tr><th>Change</th><th>Priority</th><th>Where it is</th><th>For</th><th class="num">Cost</th><th>Note</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.slug}>
              <td><Link href={`/c/${c.slug}`}><b>{c.title}</b></Link></td>
              <td><span class={`prio ${c.priority}`}>{c.priority}</span>{c.held && <> <span class="badge warn" title={c.held}>Held</span></>}{c.question && <> <span class="badge warn" title={c.question.text}>Has a question</span></>}</td>
              <td>{c.plain}</td>
              <td>{c.inStatus ?? ""}</td>
              <td class="num">{usd(c.costUsd)}</td>
              <td class="muted">{[c.waiting, c.shownNote].filter(Boolean).join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
