import { appendFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attention } from "../attention";
import { loadConfig, type Config } from "../config";
import { scanRepo, type Status } from "../intents";
import { errorText } from "../shell";
import { Trace } from "../trace";
import { chatDir, readJson, writeJson } from "./threads";

/** One announcement: what Loopstra told people without being asked. */
export interface Announcement { id: number; ts: string; text: string; slug: string | null }

/** The log as last read, by path: the dashboard asks for it every couple of seconds. */
const cache = new Map<string, { size: number; mtimeMs: number; items: Announcement[] }>();

/**
 * The shared log of announcements, `.loopstra/chat/announcements.jsonl`. One process writes it (the
 * one holding the announcer lock); every chat process reads it and passes new entries to its own
 * surfaces: bots post them to their announcement channel, the terminal prints them, the dashboard
 * panel shows them.
 */
export class AnnouncementLog {
  constructor(private readonly root: string) {}

  private path(): string { return join(chatDir(this.root), "announcements.jsonl"); }

  /** Every announcement. Read again only when the file changed since the last read in this process. */
  all(): Announcement[] {
    const path = this.path();
    let st: { size: number; mtimeMs: number };
    try { st = statSync(path); } catch { return []; }
    const hit = cache.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.items;
    const items: Announcement[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line) as Announcement); } catch { /* a half-written last line */ }
    }
    cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, items });
    return items;
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
 * one that writes announcements. Taking it is atomic: the file is created only if it does not exist.
 * A holder that died, or stopped polling, loses it: its lock is first moved aside (a rename only one
 * process can win), checked to be the stale one it read, and only then is a new one created.
 */
export function holdAnnouncerLock(root: string, pid = process.pid, now = Date.now()): boolean {
  mkdirSync(chatDir(root), { recursive: true });
  const path = join(chatDir(root), "announcer.lock");
  const text = JSON.stringify({ pid, at: new Date(now).toISOString() });
  const create = (): boolean => {
    try { writeFileSync(path, text, { flag: "wx" }); return true; } catch { return false; }
  };
  if (create()) return true;
  const held = readJson<{ pid: number; at: string }>(path);
  if (held?.pid === pid) {
    // Ours: refreshed whole (temp file, then rename), so a reader never sees half of it.
    writeJson(path, JSON.parse(text));
    return true;
  }
  if (!held) {
    // Being written this moment, or damaged: damaged only once it has stayed unreadable a while.
    try { if (now - statSync(path).mtimeMs < LOCK_STALE_MS) return false; } catch { return create(); }
  } else if (alive(held.pid) && now - Date.parse(held.at) <= LOCK_STALE_MS) {
    return false;
  }
  const aside = `${path}.stale-${pid}-${now}`;
  try { renameSync(path, aside); } catch { return false; }
  const moved = readJson<{ pid: number; at: string }>(aside);
  if (held && (moved?.pid !== held.pid || moved?.at !== held.at)) {
    // Someone took it between the read and the rename: put theirs back (unless yet another is there) and step aside.
    try { linkSync(aside, path); } catch { /* another lock is there now */ }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return create();
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
