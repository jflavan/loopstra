import { join } from "node:path";
import { Trace, type PhaseRow } from "../trace";
import { runsDir } from "./files";
import { frame, type Send } from "./hub";
import { TranscriptReader } from "./transcript";
import type { SessionMessage } from "./types";

const phaseMessage = (p: PhaseRow): SessionMessage => ({ type: "phase", name: p.name, status: p.status, started: p.started, ended: p.ended });

/**
 * Streams one phase's transcript from byte `from`: first the phase, then each item with the offset
 * after its line as its id, so a page that reconnects continues there. Checks the file every
 * `intervalMs` (watching a growing file is unreliable on Windows). Once the phase has ended and its
 * file is read to the end, sends the phase again and `end`, then closes. Gives the function that
 * stops it, or null when there is no such phase.
 */
export function streamSession(root: string, slug: string, seq: number, from: number, send: Send, close: () => void, intervalMs = 250): (() => void) | null {
  const trace = Trace.open(root);
  const first = trace.phase(slug, seq);
  if (!first) {
    trace.close();
    return null;
  }
  const reader = new TranscriptReader(join(runsDir(root), slug, "phases", `${seq}-${first.name}`, "raw.jsonl"), from);
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    trace.close();
  };
  const step = () => {
    if (done) return;
    for (const { item, offset } of reader.read()) {
      if (!send(frame({ type: "item", item } satisfies SessionMessage, offset))) return stop();
    }
    const p = trace.phase(slug, seq);
    if (p?.ended && reader.atEnd()) {
      send(frame(phaseMessage(p)));
      send(frame({ type: "end" } satisfies SessionMessage));
      stop();
      close();
    }
  };
  send(frame(phaseMessage(first)));
  timer = setInterval(step, intervalMs);
  step();
  return stop;
}
