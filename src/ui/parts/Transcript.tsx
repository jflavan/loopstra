import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TranscriptItem } from "../../console/types";
import { usd } from "../format";
import type { Shown } from "../transcript";
import { Diff } from "./Diff";
import { Markdown } from "./Markdown";

/** How many of the newest rows are drawn before "Show earlier". */
const SHOWN = 1500;
/** Output lines shown before "Show all". */
const OUTPUT_LINES = 200;

type Result = Shown["results"][string] | undefined;

/** A session's transcript. It follows the newest row until the person scrolls up, then offers to jump back. */
export function Transcript({ shown, live }: { shown: Shown; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [all, setAll] = useState(false);
  const skipped = all ? 0 : Math.max(0, shown.items.length - SHOWN);
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);
  const onScroll = () => {
    const b = box.current;
    if (b) setFollow(b.scrollHeight - b.scrollTop - b.clientHeight < 80);
  };
  return (
    <div class="transcript-wrap">
      <div class="transcript" ref={box} onScroll={onScroll}>
        {skipped > 0 && <button class="link" onClick={() => setAll(true)}>Show {skipped} earlier rows</button>}
        {shown.items.slice(skipped).map((item, k) => <Row key={skipped + k} item={item} result={"id" in item ? shown.results[item.id] : undefined} />)}
        {!shown.items.length && !live && <p class="muted">This step left no transcript.</p>}
        {live && <div class="t-live"><span class="pulse" aria-hidden="true" /> Working…</div>}
      </div>
      {!follow && <button class="btn jump" onClick={() => setFollow(true)}>Jump to live ↓</button>}
    </div>
  );
}

function Row({ item, result }: { item: Shown["items"][number]; result: Result }) {
  switch (item.kind) {
    case "text": return <Markdown text={item.text} />;
    case "tool": return <ToolRow item={item} result={result} />;
    case "edit": return <EditRow item={item} result={result} />;
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

function EditRow({ item, result }: { item: Extract<TranscriptItem, { kind: "edit" }>; result: Result }) {
  // A small edit shows at once; a whole written file waits to be opened.
  const [open, setOpen] = useState(item.tool !== "Write");
  return (
    <div class={`t-edit ${stateOf(result)}`}>
      <button class="t-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="t-state" aria-hidden="true" />
        <span class="t-name">{item.tool === "Write" ? "Wrote" : "Edited"}</span>
        <span class="t-target">{item.path}</span>
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
