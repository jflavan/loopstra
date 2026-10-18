import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TranscriptItem } from "../../console/types";
import { usd } from "../format";
import { diffCounts } from "../diff";
import type { Shown } from "../transcript";
import { Diff } from "./Diff";
import { Markdown } from "./Markdown";
import { memo } from "./memo";

/** How many of the newest rows are drawn before "Show earlier". */
const SHOWN = 1500;
/** Output lines shown before "Show all". */
const OUTPUT_LINES = 200;

type Result = Shown["results"][string] | undefined;

/** A session's transcript. It follows the newest row until the person scrolls up, then offers to jump back. `compact`: a tile's, of a fixed height, with edits closed and shown as counts. */
// Memoised: the session screen redraws for other reasons (its facts, its status) and the rows need not be rebuilt for them.
export const Transcript = memo(function Transcript({ shown, live, done, compact = false }: { shown: Shown; live: boolean; done: boolean; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [all, setAll] = useState(false);
  const skipped = all ? 0 : Math.max(0, shown.items.length - SHOWN);
  // Runs when rows arrive (or following starts), not when a row's own state changes, so a result landing
  // on a tool row the person just opened does not pull the page away from it.
  useLayoutEffect(() => {
    const b = box.current;
    if (!follow || !b) return;
    const toEnd = () => { b.scrollTop = b.scrollHeight; };
    toEnd();
    // Off-screen rows are only estimated in height (content-visibility), so the first scroll can fall short once they are measured.
    const again = requestAnimationFrame(toEnd);
    return () => cancelAnimationFrame(again);
  }, [shown.items.length, live, follow]);
  const onScroll = () => {
    const b = box.current;
    if (b) setFollow(b.scrollHeight - b.scrollTop - b.clientHeight < 80);
  };
  // Opening or closing a row means the person is reading it: stop following the end until they jump back.
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element).closest(".t-head")) setFollow(false);
  };
  return (
    <div class={`transcript-wrap${compact ? " compact" : ""}`}>
      <div class="transcript" ref={box} onScroll={onScroll} onClick={onClick}>
        {skipped > 0 && <button class="link" onClick={() => setAll(true)}>Show {skipped} earlier rows</button>}
        {shown.items.slice(skipped).map((item, k) => <Row key={skipped + k} item={item} result={"id" in item ? shown.results[item.id] : undefined} compact={compact} />)}
        {!shown.items.length && done && <p class="muted">This step left no transcript.</p>}
        {live && <div class="t-live"><span class="pulse" aria-hidden="true" /> Working…</div>}
      </div>
      {!follow && <button class="btn jump" onClick={() => setFollow(true)}>{compact ? "↓ live" : "Jump to live ↓"}</button>}
    </div>
  );
});

function Row({ item, result, compact }: { item: Shown["items"][number]; result: Result; compact: boolean }) {
  switch (item.kind) {
    case "text": return <Markdown text={item.text} />;
    case "tool": return <ToolRow item={item} result={result} />;
    case "edit": return <EditRow item={item} result={result} compact={compact} />;
    case "message":
      return (
        <div class={`msg t-msg${item.redirect ? " redirect" : ""}`}>
          <b class="t-msg-label">{item.redirect ? "Redirect" : "Message"}</b>
          {item.text}
        </div>
      );
    case "result":
      return (
        <div class={`t-result ${item.ok ? "ok" : "bad"}`}>
          <span><b>{item.ok ? "Finished" : "Ended with a problem"}</b>{item.costUsd !== null && <span class="muted"> · {usd(item.costUsd)}</span>}</span>
          {item.summary && <Markdown text={item.summary} />}
        </div>
      );
  }
}

const stateOf = (result: Result): string => (!result ? "pending" : result.ok ? "ok" : "bad");

function ToolRow({ item, result }: { item: Extract<TranscriptItem, { kind: "tool" }>; result: Result }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`t-tool ${stateOf(result)}`}>
      <button class="t-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="t-state" aria-hidden="true" />
        <span class="t-name">{item.tool}</span>
        <span class="t-target">{item.target}</span>
      </button>
      {open && (
        <div class="t-body">
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {result ? <Output text={result.output} /> : <span class="muted">Still running…</span>}
        </div>
      )}
    </div>
  );
}

function EditRow({ item, result, compact }: { item: Extract<TranscriptItem, { kind: "edit" }>; result: Result; compact: boolean }) {
  // A small edit shows at once on the session's page; a whole written file, and any edit on a tile, waits to be opened.
  const [open, setOpen] = useState(!compact && item.tool !== "Write");
  const counts = useMemo(() => (compact ? diffCounts(item.diff) : null), [compact, item.diff]);
  return (
    <div class={`t-edit ${stateOf(result)}`}>
      <button class="t-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="t-state" aria-hidden="true" />
        <span class="t-name">{item.tool === "Write" ? "Wrote" : "Edited"}</span>
        <span class="t-target">{item.path}</span>
        {counts && <span class="t-counts"><span class="add">+{counts.added}</span> <span class="del">−{counts.removed}</span></span>}
      </button>
      {open && (
        <div class="t-body">
          <Diff text={item.diff} />
          {result && !result.ok && <Output text={result.output} />}
        </div>
      )}
    </div>
  );
}

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  return (
    <>
      <pre>{(all ? lines : lines.slice(0, OUTPUT_LINES)).join("\n")}</pre>
      {!all && lines.length > OUTPUT_LINES && <button class="link" onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
    </>
  );
}
