import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attention } from "../attention";
import { loadConfig, type Config } from "../config";
import { scanRepo, type Status } from "../intents";
import { errorText } from "../shell";
import { Trace } from "../trace";
import { chatDir, readJson, writeJson } from "./threads";

/** One announcement: what Loopstra told people without being asked. */
export interface Announcement { id: number; ts: string; text: string; slug: string | null }

/**
 * The shared log of announcements, `.loopstra/chat/announcements.jsonl`. One process writes it (the
 * one holding the announcer lock); every chat process reads it and passes new entries to its own
 * surfaces: bots post them to their announcement channel, the terminal prints them, the dashboard
 * panel shows them.
 */
export class AnnouncementLog {
  constructor(private readonly root: string) {}

  private path(): string { return join(chatDir(this.root), "announcements.jsonl"); }

  all(): Announcement[] {
    if (!existsSync(this.path())) return [];
    const out: Announcement[] = [];
    for (const line of readFileSync(this.path(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Announcement); } catch { /* a half-written last line */ }
    }
    return out;
  }

  since(id: number): Announcement[] { return this.all().filter((a) => a.id > id); }
  lastId(): number { return this.all().at(-1)?.id ?? 0; }

  append(text: string, slug: string | null): Announcement {
    mkdirSync(chatDir(this.root), { recursive: true });
    const a: Announcement = { id: this.lastId() + 1, ts: new Date().toISOString(), text, slug };
    appendFileSync(this.path(), JSON.stringify(a) + "\n");
    return a;
  }
}

/** What the announcer remembers between polls. */
interface AnnouncerState {
  /** Attention items that were showing at the last poll (announced once each while they last). */
  active: string[];
  /** Each change's status at the last poll, to notice merges and finished changes. */
  statuses: Record<string, Status>;
}

/** How long a lock holder may go without polling before another process takes over. */
const LOCK_STALE_MS = 5 * 60_000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

/**
 * Takes or keeps the announcer lock, `.loopstra/chat/announcer.lock`: true when this process is the
 * one that writes announcements. A holder that died, or stopped polling, loses it.
 */
export function holdAnnouncerLock(root: string, pid = process.pid, now = Date.now()): boolean {
  mkdirSync(chatDir(root), { recursive: true });
  const path = join(chatDir(root), "announcer.lock");
  const held = readJson<{ pid: number; at: string }>(path);
  const free = !held || held.pid === pid || !alive(held.pid) || now - Date.parse(held.at) > LOCK_STALE_MS;
  if (!free) return false;
  writeJson(path, { pid, at: new Date(now).toISOString() });
  // Two processes may have taken it at once: whoever's write stands holds it.
  return readJson<{ pid: number }>(path)?.pid === pid;
}

const IN_MAIN: ReadonlySet<Status> = new Set(["merged", "verifying", "done"]);

/**
 * Compares what needs a person now with the last poll, and appends what is new to the log: each
 * new "Needs attention" item (the same words as `loopstra status`), a change reaching the main
 * code, and a change finishing. Code, not an agent: no cost. Only the lock holder writes.
 */
export async function announce(root: string, log = new AnnouncementLog(root)): Promise<Announcement[]> {
  if (!holdAnnouncerLock(root)) return [];
  let config: Config | { problem: string };
  try { config = await loadConfig(root); } catch (e) { config = { problem: errorText(e) }; }
  const statePath = join(chatDir(root), "announcer.json");
  const prev = readJson<AnnouncerState>(statePath);
  const trace = Trace.open(root, () => {});
  const out: Announcement[] = [];
  try {
    const items = await attention(root, config, trace);
    const keyOf = (i: { kind: string; slug: string | null; what: string }) => `${i.kind}|${i.slug ?? ""}|${i.what}`;
    const was = new Set(prev?.active ?? []);
    for (const i of items) {
      if (was.has(keyOf(i))) continue;
      out.push(log.append(`${i.label}: ${i.title}. ${i.what}`, i.slug));
    }
    const scan = await scanRepo(root);
    const statuses: Record<string, Status> = {};
    for (const i of scan.intents) {
      const now = i.file.frontmatter.status;
      statuses[i.slug] = now;
      const before = prev?.statuses[i.slug];
      // Nothing to compare on the first poll: what was already merged is not news.
      if (!prev || before === undefined || before === now) continue;
      const title = i.file.title || i.slug;
      if (now === "done") out.push(log.append(`Done: ${title}. It is finished and checked.`, i.slug));
      else if (IN_MAIN.has(now) && !IN_MAIN.has(before)) out.push(log.append(`Merged: ${title}. It is in the main code now.`, i.slug));
    }
    writeJson(statePath, { active: items.map(keyOf), statuses } satisfies AnnouncerState);
  } finally {
    trace.close();
  }
  return out;
}
