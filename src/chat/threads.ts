import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJson } from "../fsutil";
import type { RequestShape } from "../actions";
import type { RequestBody } from "../requests";
import type { Handoff } from "./schemas";
import { readStateFile } from "./statefile";

/** Everything chat keeps lives under `.loopstra/chat/` (gitignored, like the rest of the runtime's state). */
export function chatDir(root: string): string {
  return join(root, ".loopstra", "chat");
}

/** A proposal waiting for a person's yes. */
export type Pending =
  | { kind: "handoff"; handoff: Handoff; by: string; at: string }
  | { kind: "accept"; slug: string; by: string; at: string }
  /** An action on a change, as it will be submitted; `ask` is the question the person was asked. */
  | { kind: "action"; request: RequestBody & RequestShape; ask: string; by: string; at: string };

/** One hand-off made from a thread, and what became of it. */
export interface HandoffRecord {
  title: string;
  slugs: string[];
  at: string;
  by: string;
  /** With a remote: the pull request. `state` is updated as it is noticed. */
  pr: { number: number; url: string; branch: string; state: "OPEN" | "MERGED" | "CLOSED" } | null;
  /** Without a remote: left for the loop to add to intent/. */
  local: boolean;
}

export interface ChatMessage {
  id: number;
  from: "person" | "loopstra";
  author?: string;
  text: string;
  ts: string;
}

export interface ThreadState {
  /** `<transport>:<thread id>`. */
  key: string;
  transport: string;
  thread: string;
  sessionId: string | null;
  pending: Pending | null;
  handoffs: HandoffRecord[];
  /** The newest announcement this thread's conversation has been told about. */
  lastAnnouncementSeen: number;
  /** The newest messages, for the dashboard panel. */
  messages: ChatMessage[];
  /**
   * What happened since the agent's last turn that it was not part of (a yes it never saw, what the
   * loop did with a request), one short line each, for the next turn's context. A thread saved
   * before this existed has none.
   */
  since: string[];
}

/**
 * A thread's file as it is read back: what the store itself relies on is checked (the arrays it
 * pushes to, the ids it counts from), and what a thread saved by an older Loopstra has not got is
 * filled in. A proposal's own body (the hand-off, the request) is the store's own write and is
 * taken as it is.
 */
const ThreadStateSchema = z.object({
  key: z.string(),
  transport: z.string(),
  thread: z.string(),
  sessionId: z.string().nullable().default(null),
  pending: z.looseObject({ kind: z.enum(["handoff", "accept", "action"]), by: z.string(), at: z.string() }).nullable().default(null),
  handoffs: z.array(z.object({
    title: z.string(), slugs: z.array(z.string()), at: z.string(), by: z.string(),
    pr: z.object({ number: z.number(), url: z.string(), branch: z.string(), state: z.enum(["OPEN", "MERGED", "CLOSED"]) }).nullable().default(null),
    local: z.boolean().default(false),
  })).default([]),
  lastAnnouncementSeen: z.number().default(0),
  messages: z.array(z.object({ id: z.number(), from: z.enum(["person", "loopstra"]), author: z.string().optional(), text: z.string(), ts: z.string() })).default([]),
  since: z.array(z.string()).default([]),
});

/** How many messages a thread keeps for display. The conversation itself lives in the session. */
const KEPT_MESSAGES = 200;
/** How many lines of what happened since the agent's last turn a thread keeps (the newest). */
const KEPT_SINCE = 10;

export function threadKey(transport: string, thread: string): string {
  return `${transport}:${thread}`;
}

/** A file name for any thread key: readable where it can be, and never two keys on one file. */
function fileName(key: string): string {
  const plain = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `${plain}-${createHash("sha256").update(key).digest("hex").slice(0, 10)}.json`;
}

/** A thread's files are JSON; one moved aside as damaged (`.json.bad-<time>`) is not one of them. */
const THREAD_FILE = /\.json$/;

export class ThreadStore {
  /** `log`: where a damaged thread file is reported (see readStateFile). */
  constructor(private readonly root: string, private readonly log: (line: string) => void = (l) => console.error(l)) {}

  private dir(): string {
    const d = join(chatDir(this.root), "threads");
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** The thread saved at `path`, or null when there is none (or the file was damaged: it is moved aside, see readStateFile). */
  private read(path: string): ThreadState | null {
    const t = readStateFile(path, ThreadStateSchema, this.log);
    return t ? { ...t, pending: t.pending as Pending | null } : null;
  }

  get(transport: string, thread: string): ThreadState {
    const key = threadKey(transport, thread);
    const found = this.read(join(this.dir(), fileName(key)));
    return found ? { ...found, key, transport, thread } : { key, transport, thread, sessionId: null, pending: null, handoffs: [], lastAnnouncementSeen: 0, messages: [], since: [] };
  }

  save(t: ThreadState): void {
    t.messages = t.messages.slice(-KEPT_MESSAGES);
    writeJson(join(this.dir(), fileName(t.key)), t);
  }

  /** Notes a line of what happened for the agent's next turn (see ThreadState.since); only the newest are kept. */
  noteSince(t: ThreadState, line: string): void {
    t.since = [...t.since, line].slice(-KEPT_SINCE);
  }

  /** Appends a message to the thread's display log and returns it. */
  addMessage(t: ThreadState, m: Omit<ChatMessage, "id" | "ts">): ChatMessage {
    const msg: ChatMessage = { ...m, id: (t.messages.at(-1)?.id ?? 0) + 1, ts: new Date().toISOString() };
    t.messages.push(msg);
    return msg;
  }

  all(): ThreadState[] {
    const d = this.dir();
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((n) => THREAD_FILE.test(n)).map((n) => this.read(join(d, n))).filter((t): t is ThreadState => !!t);
  }
}
