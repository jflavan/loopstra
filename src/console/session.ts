import { statSync } from "node:fs";
import { join } from "node:path";
import { Trace, type PhaseRow } from "../trace";
import { runsDir } from "../paths";
import { frame, PING, type Send } from "./hub";
import { TranscriptReader } from "./transcript";
import type { SessionMessage } from "./types";

const phaseMessage = (p: PhaseRow): SessionMessage => ({ type: "phase", name: p.name, status: p.status, started: p.started, ended: p.ended });

/** A file's size, or -1 when it is missing. */
function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return -1; }
}

/** What a follower is told: one message, with an item's resume offset; false once whoever reads it is gone (it then stops). */
type Emit = (msg: SessionMessage, offset?: number) => boolean;

/**
 * Streams one phase's transcript to a page (see followSession), each item with its offset as the
 * frame's id, so a page that reconnects continues there. While nothing else is sent it pings every
 * `pingMs`: a session on a long command writes nothing for minutes, and without pings the page
 * could not tell that quiet from a connection that died.
 */
export function streamSession(root: string, slug: string, seq: number, from: number, send: Send, close: () => void, intervalMs = 250, pingMs = 15_000): (() => void) | null {
  let ping: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  // A page that cannot be written to, on any frame, ends the pings at once rather than at the next one.
  const write = (text: string) => {
    const ok = send(text);
    if (!ok) { closed = true; clearInterval(ping); }
    return ok;
  };
  const stop = followSession(root, slug, seq, from, (msg, offset) => write(frame(msg, offset)), () => { closed = true; clearInterval(ping); close(); }, intervalMs);
  if (!stop) return null;
  const end = () => { clearInterval(ping); stop(); };
  // The stream may have ended already (an unreadable file, a page gone): then there is nobody to ping.
  if (!closed) ping = setInterval(() => { if (!write(PING)) end(); }, pingMs);
  return end;
}

/**
 * Follows one phase's transcript from byte `from`: first the phase, then each item with its offset
 * (see TranscriptReader.read). Checks the file every `intervalMs` (watching a growing file is
 * unreliable on Windows). Once the phase has ended and its file is read to the end, emits the phase
 * again and `end`, then closes. If anything goes wrong it closes too, and never throws. Gives the
 * function that stops it, or null when there is no such phase (or the trace or the phase cannot be
 * read).
 */
export function followSession(root: string, slug: string, seq: number, from: number, emit: Emit, close: () => void, intervalMs = 250): (() => void) | null {
  let trace: Trace;
  try { trace = Trace.open(root); } catch { return null; }
  let first: PhaseRow | null = null;
  try { first = trace.phase(slug, seq); } catch { /* unreadable is treated like missing: there is nothing to stream */ }
  if (!first) {
    try { trace.close(); } catch { /* already closed */ }
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
      if (!emit({ type: "item", item }, offset)) {
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
    emit(phaseMessage(p));
    emit({ type: "end" });
    finish();
  };
  /** Runs part of the stream; whatever it throws (an unreadable file, a broken connection) ends the stream instead. */
  const run = (fn: () => void) => {
    if (done) return;
    try { fn(); } catch { finish(); }
  };
  run(() => { emit(phaseMessage(first)); });
  if (!done) timer = setInterval(() => run(step), intervalMs);
  run(step);
  return stop;
}
