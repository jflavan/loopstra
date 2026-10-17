import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./chat/threads";

/**
 * A running session's inbox, `.loopstra/runs/<slug>/inbox/`: what people send a session while it
 * runs (a message, a stop, a redirect). The console writes; the session's runner reads and delivers
 * (see src/steering.ts). Done ones move to `delivered/`, with how they ended.
 */
export interface InboxMessage { id: string; seq: number; kind: "message" | "stop" | "redirect"; text: string; by: string; via: string; at: string }

/** How an inbox message ended: written to its session, kept in conversation.md for the next one, or dropped (a stop that came too late). */
export type Done = "delivered" | "next session" | "dropped";

const ID = /^\d{15}-\d+-\d{4,}$/;
const KINDS = new Set(["message", "stop", "redirect"]);

export function inboxDir(root: string, slug: string): string {
  return join(root, ".loopstra", "runs", slug, "inbox");
}

let counter = 0;
/** Sorts by when it was sent: the time, then this process's count. */
function newId(): string {
  return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(4, "0")}`;
}

/** Leaves a message for a session. */
export function sendToSession(root: string, slug: string, m: Omit<InboxMessage, "id" | "at">): InboxMessage {
  const full: InboxMessage = { ...m, id: newId(), at: new Date().toISOString() };
  writeJson(join(inboxDir(root, slug), `${full.id}.json`), full);
  return full;
}

/** Every message waiting in a change's inbox, oldest first. A file that is not a message is ignored. */
export function waitingIn(root: string, slug: string): InboxMessage[] {
  const dir = inboxDir(root, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
    .map((n) => [n, readJson<InboxMessage>(join(dir, n))] as const)
    .filter(([n, m]) => !!m && typeof m.id === "string" && ID.test(m.id) && n === `${m.id}.json` && KINDS.has(m.kind) && typeof m.seq === "number" && typeof m.text === "string")
    .map(([, m]) => m!);
}

/** The messages waiting for one session (a phase's seq), oldest first. */
export function inboxFor(root: string, slug: string, seq: number): InboxMessage[] {
  return waitingIn(root, slug).filter((m) => m.seq === seq);
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
