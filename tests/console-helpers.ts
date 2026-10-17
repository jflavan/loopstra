import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configPath } from "../src/config";
import type { Scan } from "../src/intents";
import { buildModel, type Model } from "../src/console/model";
import { Trace } from "../src/trace";

const BODY = "# Intent: {title}\n\n## Problem\np\n\n## Proposed outcome\no\n\n## Done when\n- d\n";

/** Writes intent/<slug>/intent.md with the given frontmatter lines. */
export async function intent(root: string, slug: string, fm: string, title = slug): Promise<void> {
  mkdirSync(join(root, "intent", slug), { recursive: true });
  await Bun.write(join(root, "intent", slug, "intent.md"), `---\n${fm}\n---\n${BODY.replace("{title}", title)}`);
}

/** Writes loopstra/config.yaml: a test command, then `extra` YAML. */
export async function config(root: string, extra = ""): Promise<void> {
  mkdirSync(join(root, "loopstra"), { recursive: true });
  await Bun.write(configPath(root), `version: 1\ncommands:\n  test: echo ok\n${extra}`);
}

/** Moves a phase's start (and end, once it has ended) time, which the trace otherwise stamps with the real clock. */
export function setStarted(root: string, slug: string, seq: number, iso: string): void {
  const db = new Database(join(root, ".loopstra", "trace.db"));
  try {
    // A running phase keeps no end time: giving it one would make it look finished to every query.
    db.run("UPDATE phases SET started = ?, ended = CASE WHEN ended IS NULL THEN NULL ELSE ? END WHERE slug = ? AND seq = ?", [iso, iso, slug, seq]);
  } finally {
    db.close();
  }
}

/** Runs `fn` with the repository's trace open, and closes it however `fn` ends (Windows keeps an open file locked). */
export function withTrace<T>(root: string, fn: (trace: Trace) => T): T {
  const trace = Trace.open(root);
  try { return fn(trace); } finally { trace.close(); }
}

/** The console's model of a repository, with a trace opened and closed around it. */
export async function model(root: string, now: Date = new Date(), opts: { chat?: boolean; scan?: Scan } = {}): Promise<Model> {
  const trace = Trace.open(root);
  try { return await buildModel(root, trace, now, opts); } finally { trace.close(); }
}

/** Waits until `check` holds, or throws after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

/** One SSE frame's fields; `data` parsed from JSON. */
export interface Frame { id: string | null; event: string | null; data: unknown }

export function parseFrames(text: string): Frame[] {
  return text.split("\n\n").filter((f) => f.trim()).map((f) => {
    const field = (name: string) => f.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
    const data = field("data");
    return { id: field("id"), event: field("event"), data: data === null ? null : JSON.parse(data) as unknown };
  });
}

/** The first `count` frames carrying data on an SSE stream (fewer if it ends); the request is aborted after. */
export async function sseFrames(url: string, count: number, headers: Record<string, string> = {}): Promise<Frame[]> {
  const ac = new AbortController();
  const r = await fetch(url, { signal: ac.signal, headers });
  if (!r.body) throw new Error(`no stream: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const end = text.lastIndexOf("\n\n");
      const frames = parseFrames(end < 0 ? "" : text.slice(0, end + 2)).filter((f) => f.data !== null);
      if (frames.length >= count) return frames.slice(0, count);
      const { value, done } = await reader.read();
      if (done) return frames;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    ac.abort();
  }
}
