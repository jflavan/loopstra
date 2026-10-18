import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./paths";
import { ID, newId } from "./ids";
import { readJson, writeJson } from "./fsutil";

/**
 * A running session's inbox, `.loopstra/runs/<slug>/inbox/`: what people send a session while it
 * runs (a message, a stop, a redirect). The console writes; the session's runner reads and delivers
 * (see src/steering.ts). Done ones move to `delivered/`, with how they ended.
 */
export interface InboxMessage { id: string; seq: number; kind: "message" | "stop" | "redirect"; text: string; by: string; via: string; at: string }

/** How an inbox message ended: written to its session, kept in conversation.md for the next one, or dropped (a stop that came too late). */
export type Done = "delivered" | "next session" | "dropped";

const KINDS = new Set(["message", "stop", "redirect"]);

export function inboxDir(root: string, slug: string): string {
  return join(runDir(root, slug), "inbox");
}


/** Leaves a message for a session. */
export function sendToSession(root: string, slug: string, m: Omit<InboxMessage, "id" | "at">): InboxMessage {
  const full: InboxMessage = { ...m, id: newId(), at: new Date().toISOString() };
  writeJson(join(inboxDir(root, slug), `${full.id}.json`), full);
  return full;
}

function deliveredDir(root: string, slug: string): string {
  return join(inboxDir(root, slug), "delivered");
}

/** The file names in delivered/: the messages done with (a folder there is not one). */
function doneNames(root: string, slug: string): Set<string> {
  const dir = deliveredDir(root, slug);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name));
}

/**
 * Every message waiting in a change's inbox, oldest first. A file that is not a message is ignored, and
 * so is one whose copy is in delivered/ already (see leaveDelivered): that stale original is removed
 * when it can be.
 */
export function waitingIn(root: string, slug: string): InboxMessage[] {
  const dir = inboxDir(root, slug);
  if (!existsSync(dir)) return [];
  const done = doneNames(root, slug);
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
    .filter((n) => {
      if (!done.has(n)) return true;
      try { rmSync(join(dir, n), { force: true }); } catch { /* held open: passed over all the same */ }
      return false;
    })
    .map((n) => [n, readJson<InboxMessage>(join(dir, n))] as const)
    .filter(([n, m]) => !!m && typeof m.id === "string" && ID.test(m.id) && n === `${m.id}.json` && KINDS.has(m.kind) && typeof m.seq === "number" && typeof m.text === "string")
    .map(([, m]) => m!);
}

/** The messages waiting for one session (a phase's seq), oldest first. */
export function inboxFor(root: string, slug: string, seq: number): InboxMessage[] {
  return waitingIn(root, slug).filter((m) => m.seq === seq);
}

/**
 * `.loopstra/runs/<slug>/stop.json` (`{ by, at }`): a person stopped the change. Only agent sessions
 * read their inbox, so a stop also leaves this, which every phase reads before it starts and once it
 * ends (see agentPhase and codePhase): a code phase, or a stop that crosses into the next phase, still
 * ends the step. The next step's start clears it; the hold left with it keeps the change from starting.
 */
function changeStopPath(root: string, slug: string): string {
  return join(runDir(root, slug), "stop.json");
}

/** Leaves the change's stop (see changeStopPath). */
export function writeChangeStop(root: string, slug: string, by: string): void {
  writeJson(changeStopPath(root, slug), { by, at: new Date().toISOString() });
}

/** Who stopped the change, while its stop stands; null when none does. */
export function changeStoppedBy(root: string, slug: string): string | null {
  const path = changeStopPath(root, slug);
  if (!existsSync(path)) return null;
  const s = readJson<{ by?: unknown }>(path);
  return typeof s?.by === "string" && s.by.trim() ? s.by : "a person";
}

/** Clears the change's stop: the step it was for has ended. */
export function clearChangeStop(root: string, slug: string): void {
  rmSync(changeStopPath(root, slug), { force: true });
}

/**
 * A message whose move to delivered/ failed (a file held open on Windows) is done with all the same: its
 * delivered copy is written there, and the original removed when it can be (waitingIn passes over it
 * meanwhile, and removes it later). Throws when the copy cannot be written.
 */
export function leaveDelivered(root: string, slug: string, m: InboxMessage, how: Done): void {
  writeJson(join(deliveredDir(root, slug), `${m.id}.json`), { ...m, how, delivered: new Date().toISOString() });
  try { rmSync(join(inboxDir(root, slug), `${m.id}.json`), { force: true }); } catch { /* see waitingIn */ }
}

/** Moves a message to delivered/ with how it ended; false when it was gone already (done by someone else). */
export function markDone(root: string, slug: string, m: InboxMessage, how: Done): boolean {
  const from = join(inboxDir(root, slug), `${m.id}.json`);
  const to = join(inboxDir(root, slug), "delivered", `${m.id}.json`);
  mkdirSync(join(inboxDir(root, slug), "delivered"), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    return false;
  }
  writeJson(to, { ...m, how, delivered: new Date().toISOString() });
  return true;
}
