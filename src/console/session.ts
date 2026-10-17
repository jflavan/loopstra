import { statSync } from "node:fs";
import { join } from "node:path";
import { Trace, type PhaseRow } from "../trace";
import { runsDir } from "./files";
import { frame, type Send } from "./hub";
import { TranscriptReader } from "./transcript";
import type { SessionMessage } from "./types";

const phaseMessage = (p: PhaseRow): SessionMessage => ({ type: "phase", name: p.name, status: p.status, started: p.started, ended: p.ended });

/** A file's size, or -1 when it is missing. */
function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return -1; }
}

/**
 * Streams one phase's transcript from byte `from`: first the phase, then each item with an offset
 * as its id (see TranscriptReader.read), so a page that reconnects continues there. Checks the file
 * every `intervalMs` (watching a growing file is unreliable on Windows). Once the phase has ended
 * and its file is read to the end, sends the phase again and `end`, then closes. If anything goes
 * wrong it closes too, and never throws. Gives the function that stops it, or null when there is
 * no such phase.
 */
export function streamSession(root: string, slug: string, seq: number, from: number, send: Send, close: () => void, intervalMs = 250): (() => void) | null {
  const trace = Trace.open(root);
  const first = trace.phase(slug, seq);
  if (!first) {
    trace.close();
    return null;
  }
  const path = join(runsDir(root), slug, "phases", `${seq}-${first.name}`, "raw.jsonl");
  const reader = new TranscriptReader(path, from);
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    trace.close();
  };
  const finish = () => {
    if (done) return;
    stop();
    try { close(); } catch { /* the page is already gone */ }
  };
  /** Sends items; false once the page is gone (the stream is then stopped). */
  const sent = (items: ReturnType<TranscriptReader["read"]>): boolean => {
    for (const { item, offset } of items) {
      if (!send(frame({ type: "item", item } satisfies SessionMessage, offset))) {
        stop();
        return false;
      }
    }
    return true;
  };
  /** The file's size when the phase was first seen ended, then at each step after. */
  let endedSize: number | null = null;
  const step = () => {
    if (!sent(reader.read())) return;
    const p = trace.phase(slug, seq);
    if (!p?.ended) return;
    // A phase is recorded as ended a moment before its writer has finished the file, so the end
    // waits for a step in which the file did not grow. Anything still unread is then a last line
    // written without a newline.
    const size = sizeOf(path);
    if (size !== endedSize) {
      endedSize = size;
      return;
    }
    if (!sent(reader.read(undefined, { final: true })) || !reader.atEnd()) return;
    send(frame(phaseMessage(p)));
    send(frame({ type: "end" } satisfies SessionMessage));
    finish();
  };
  /** Runs part of the stream; whatever it throws (an unreadable file, a broken connection) ends the stream instead. */
  const run = (fn: () => void) => {
    if (done) return;
    try { fn(); } catch { finish(); }
  };
  run(() => { send(frame(phaseMessage(first))); });
  if (!done) timer = setInterval(() => run(step), intervalMs);
  run(step);
  return stop;
}
