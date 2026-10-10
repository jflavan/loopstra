import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../fsutil";
import type { Handoff } from "./schemas";

/** Everything chat keeps lives under `.loopstra/chat/` (gitignored, like the rest of the runtime's state). */
export function chatDir(root: string): string {
  return join(root, ".loopstra", "chat");
}

/** A proposal waiting for a person's yes. */
export type Pending =
  | { kind: "handoff"; handoff: Handoff; by: string; at: string }
  | { kind: "accept"; slug: string; by: string; at: string };

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
}

/** How many messages a thread keeps for display. The conversation itself lives in the session. */
const KEPT_MESSAGES = 200;

export function threadKey(transport: string, thread: string): string {
  return `${transport}:${thread}`;
}

/** A file name for any thread key: readable where it can be, and never two keys on one file. */
function fileName(key: string): string {
  const plain = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `${plain}-${createHash("sha256").update(key).digest("hex").slice(0, 10)}.json`;
}

/** Writes a JSON file whole (temp file, then rename), so a reader never sees half of it. Makes its folder. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}

/** Text on one line, at most `max` characters: for commit subjects and pull request titles. */
export function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

export class ThreadStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    const d = join(chatDir(this.root), "threads");
    mkdirSync(d, { recursive: true });
    return d;
  }

  get(transport: string, thread: string): ThreadState {
    const key = threadKey(transport, thread);
    const found = readJson<ThreadState>(join(this.dir(), fileName(key)));
    return found ?? { key, transport, thread, sessionId: null, pending: null, handoffs: [], lastAnnouncementSeen: 0, messages: [] };
  }

  save(t: ThreadState): void {
    t.messages = t.messages.slice(-KEPT_MESSAGES);
    writeJson(join(this.dir(), fileName(t.key)), t);
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
    return readdirSync(d).filter((n) => n.endsWith(".json")).map((n) => readJson<ThreadState>(join(d, n))).filter((t): t is ThreadState => !!t);
  }
}
