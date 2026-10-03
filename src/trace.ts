import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { errorText } from "./shell";

export type EventType =
  | "tick" | "phase_start" | "claude_event" | "command" | "gate_check"
  | "status_change" | "phase_end" | "error" | "signal" | "stop" | "person-changed-status" | "pause" | "stale-lock-removed"
  | "chat-message" | "chat-request" | "chat-pr";

export interface EventRow {
  id: number; slug: string; phase_seq: number | null; type: EventType; ts: string; payload: string;
}

export interface IntentSummary {
  slug: string; status: string; priority: string; updated: string;
  costUsd: number; lastPhase: string | null; lastPhaseStatus: string | null; lastActivity: string | null;
}

export interface PhaseRow {
  slug: string; seq: number; name: string; kind: string; status: string;
  started: string; ended: string | null; cost_usd: number; session_id: string | null; error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (slug TEXT PRIMARY KEY, status TEXT NOT NULL, priority TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phases (slug TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, cost_usd REAL NOT NULL DEFAULT 0, session_id TEXT, error TEXT,
  PRIMARY KEY (slug, seq));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, phase_seq INTEGER,
  type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_slug ON events (slug, id);
CREATE TABLE IF NOT EXISTS gates (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, gate TEXT NOT NULL,
  "check" TEXT NOT NULL, result TEXT NOT NULL, evidence TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ts TEXT NOT NULL,
  result TEXT NOT NULL, output TEXT NOT NULL);
`;

const now = () => new Date().toISOString();

/**
 * Puts the database in WAL mode, or, where the file system cannot do WAL (some network drives, an
 * in-memory database), in the default DELETE mode. Returns a note saying so, or null for WAL. A lock
 * is thrown, as before.
 */
export function useJournal(db: Database): string | null {
  let got: string;
  try {
    got = String((db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null)?.journal_mode ?? "");
  } catch (e) {
    if (/SQLITE_BUSY|locked/i.test(`${(e as { code?: string })?.code ?? ""} ${errorText(e)}`)) throw e;
    got = errorText(e);
  }
  if (got.toLowerCase() === "wal") return null;
  try { db.exec("PRAGMA journal_mode = DELETE"); } catch { /* keep the mode it has */ }
  return `the trace database could not use WAL journal mode (${got || "no answer"}), so it uses journal_mode=DELETE`;
}

/** The WAL fallback is traced once per process, not on every open. */
let journalNoted = false;

/** Opens and prepares the database; closes it again when that fails. */
function connect(path: string): { db: Database; note: string | null } {
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const note = useJournal(db);
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA);
    db.query("SELECT COUNT(*) AS n FROM events").get();
    return { db, note };
  } catch (e) {
    try { db.close(); } catch { /* already unusable */ }
    throw e;
  }
}

/** True for errors that mean the file is not a usable database (as opposed to, say, a lock). */
function damaged(e: unknown): boolean {
  const text = `${(e as { code?: string })?.code ?? ""} ${errorText(e)}`;
  return /SQLITE_(CORRUPT|NOTADB)|not a database|malformed/i.test(text);
}

/** Whose phases a budget counts: one slug's, or every slug's but one (the loop's day leaves chat out). */
export type BudgetPool = { slug: string } | { except: string };

export class Trace {
  private constructor(private readonly root: string, private readonly db: Database) {}

  /**
   * Opens the trace database. A damaged one (not a database, or malformed) is moved aside to
   * `trace.db.corrupt-<time>` and a fresh one is started, with a plain console line and an event in
   * the new one, so the loop and the dashboard keep working. Any other problem (a lock) is thrown.
   */
  static open(root: string, say: (line: string) => void = (l) => console.log(l)): Trace {
    const dir = join(root, ".loopstra");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "trace.db");
    try {
      return Trace.noted(root, connect(path));
    } catch (e) {
      if (!damaged(e)) throw e;
      const moved = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(path, moved);
      for (const side of ["-wal", "-shm"]) if (existsSync(path + side)) renameSync(path + side, moved + side);
      say(`The trace database could not be read, so it was moved to .loopstra/${basename(moved)} and a new one was started.`);
      const trace = Trace.noted(root, connect(path));
      trace.event("_loop", "error", { where: "trace", what: "trace.db could not be read; it was moved aside and a new one started", movedTo: moved, error: errorText(e) });
      return trace;
    }
  }

  /** A Trace on a fresh connection, with the journal-mode note traced the first time there is one. */
  private static noted(root: string, c: { db: Database; note: string | null }): Trace {
    const trace = new Trace(root, c.db);
    if (c.note && !journalNoted) {
      journalNoted = true;
      trace.event("_loop", "error", { where: "trace", what: c.note });
    }
    return trace;
  }

  close(): void { this.db.close(); }

  event(slug: string, type: EventType, payload: unknown, phaseSeq: number | null = null): void {
    const ts = now();
    const json = JSON.stringify(payload ?? {});
    this.db.run("INSERT INTO events (slug, phase_seq, type, ts, payload) VALUES (?, ?, ?, ?, ?)", [slug, phaseSeq, type, ts, json]);
    const dir = join(this.root, ".loopstra", "runs", slug);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ ts, slug, phase_seq: phaseSeq, type, payload: payload ?? {} }) + "\n");
  }

  upsertIntent(slug: string, status: string, priority: string): void {
    this.db.run(
      "INSERT INTO intents (slug, status, priority, updated) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET status = excluded.status, priority = excluded.priority, updated = excluded.updated",
      [slug, status, priority, now()],
    );
  }

  statusChange(slug: string, from: string, to: string, note = ""): void {
    this.event(slug, "status_change", { from, to, note });
  }

  /**
   * Starts a phase. The sequence number is chosen and the row inserted in one statement, so two
   * processes starting phases of the same slug at once (chat in the dashboard and in `loopstra chat`)
   * never pick the same number.
   */
  phaseStart(slug: string, name: string, kind: "agent" | "code" | "human", costUsd = 0): number {
    const seq = this.db.query<{ seq: number }, [string, string, string, string, number, string]>(
      "INSERT INTO phases (slug, seq, name, kind, status, started, cost_usd) SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, 'running', ?4, ?5 FROM phases WHERE slug = ?6 RETURNING seq",
    ).get(slug, name, kind, now(), costUsd, slug)!.seq;
    this.event(slug, "phase_start", { name, kind }, seq);
    return seq;
  }

  /**
   * Starts a phase that holds part of a daily budget until it ends: in one transaction, works out
   * what is left of `limitUsd` since `since` (phases still running count at what they hold), and,
   * when at least `floorUsd` is, starts the phase holding up to `capUsd` of it. `phaseEnd` then
   * records what it really cost. Null when too little is left. Safe across processes. `pool` is whose
   * spending counts against the limit (the slug's own by default); `runningSince` drops holds left by
   * killed processes (see costIn). With no limit and no cap (both Infinity) nothing is held: the row
   * starts at 0.
   */
  phaseStartWithin(slug: string, name: string, kind: "agent" | "code" | "human", budget: { since: string; limitUsd: number; capUsd: number; floorUsd: number; pool?: BudgetPool; runningSince?: string }): { seq: number; heldUsd: number } | null {
    const reserve = this.db.transaction(() => {
      const spent = this.costIn(budget.pool ?? { slug }, budget.since, { runningSince: budget.runningSince });
      const left = budget.limitUsd - spent;
      if (left < budget.floorUsd) return null;
      const heldUsd = Math.min(budget.capUsd, left);
      return { seq: this.phaseStart(slug, name, kind, Number.isFinite(heldUsd) ? heldUsd : 0), heldUsd };
    });
    return reserve.immediate();
  }

  /** Ends a phase. `denied`: commands the session was not allowed to run, kept on the phase_end event. */
  phaseEnd(slug: string, seq: number, r: { status: "success" | "fail" | "interrupted"; costUsd?: number; sessionId?: string; error?: string; denied?: string[] }): void {
    this.db.run("UPDATE phases SET status = ?, ended = ?, cost_usd = ?, session_id = COALESCE(?, session_id), error = ? WHERE slug = ? AND seq = ?",
      [r.status, now(), r.costUsd ?? 0, r.sessionId ?? null, r.error ?? null, slug, seq]);
    this.event(slug, "phase_end", { status: r.status, cost_usd: r.costUsd ?? 0, error: r.error ?? null, ...(r.denied?.length ? { denied: r.denied } : {}) }, seq);
  }

  /** The commands each phase of a change was not allowed to run, by phase seq (phases with none are absent). */
  deniedCommands(slug: string): Map<number, string[]> {
    const rows = this.db.query<{ phase_seq: number; payload: string }, [string]>(
      "SELECT phase_seq, payload FROM events WHERE slug = ? AND type = 'phase_end' AND instr(payload, '\"denied\"') > 0 ORDER BY id").all(slug);
    const out = new Map<number, string[]>();
    for (const r of rows) {
      try { out.set(r.phase_seq, (JSON.parse(r.payload) as { denied: string[] }).denied); } catch { /* unreadable row */ }
    }
    return out;
  }

  gate(slug: string, gate: string, check: string, result: "pass" | "fail" | "waiting", evidence: string): void {
    this.db.run('INSERT INTO gates (slug, gate, "check", result, evidence, ts) VALUES (?, ?, ?, ?, ?, ?)', [slug, gate, check, result, evidence, now()]);
    this.event(slug, "gate_check", { gate, check, result, evidence });
  }

  signal(name: string, result: "pass" | "fail" | "error" | "waiting", output: string): void {
    this.db.run("INSERT INTO signals (name, ts, result, output) VALUES (?, ?, ?, ?)", [name, now(), result, output]);
    this.event("_signals", "signal", { name, result, output });
  }

  events(slug: string, afterId = 0, limit = 500): EventRow[] {
    return this.db.query<EventRow, [string, number, number]>("SELECT * FROM events WHERE slug = ? AND id > ? ORDER BY id LIMIT ?").all(slug, afterId, limit);
  }

  /** The newest event of a type for a slug whose payload contains `contains` (any, when omitted). */
  lastEvent(slug: string, type: EventType, contains = ""): EventRow | null {
    return this.db.query<EventRow, [string, string, string]>(
      "SELECT * FROM events WHERE slug = ? AND type = ? AND instr(payload, ?) > 0 ORDER BY id DESC LIMIT 1").get(slug, type, contains) ?? null;
  }

  /** The newest `limit` events of one slug, oldest first. */
  lastEvents(slug: string, limit: number): EventRow[] {
    return this.db.query<EventRow, [string, number]>("SELECT * FROM events WHERE slug = ? ORDER BY id DESC LIMIT ?").all(slug, limit).reverse();
  }

  recentEvents(afterId = 0, limit = 200): EventRow[] {
    return this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?").all(afterId, limit).reverse();
  }

  phases(slug: string): PhaseRow[] {
    return this.db.query<PhaseRow, [string]>("SELECT * FROM phases WHERE slug = ? ORDER BY seq").all(slug);
  }

  gates(slug: string): Array<{ gate: string; check: string; result: string; evidence: string; ts: string }> {
    return this.db.query<{ gate: string; check: string; result: string; evidence: string; ts: string }, [string]>(
      'SELECT gate, "check", result, evidence, ts FROM gates WHERE slug = ? ORDER BY id').all(slug);
  }

  /** The newest recorded result of one gate check, or null when it never ran. */
  lastGate(slug: string, gate: string, check: string): { result: string; evidence: string; ts: string } | null {
    return this.db.query<{ result: string; evidence: string; ts: string }, [string, string, string]>(
      'SELECT result, evidence, ts FROM gates WHERE slug = ? AND gate = ? AND "check" = ? ORDER BY id DESC LIMIT 1').get(slug, gate, check) ?? null;
  }

  /** The newest result of one signal, optionally skipping errors (a check that could not run). */
  lastSignal(name: string, opts: { excludeErrors?: boolean; result?: string } = {}): { ts: string; result: string; output: string } | null {
    const where = `name = ?${opts.excludeErrors ? " AND result != 'error'" : ""}${opts.result ? " AND result = ?" : ""}`;
    const args: [string] | [string, string] = opts.result ? [name, opts.result] : [name];
    return this.db.query<{ ts: string; result: string; output: string }, typeof args>(`SELECT ts, result, output FROM signals WHERE ${where} ORDER BY id DESC LIMIT 1`).get(...args) ?? null;
  }

  signals(limit = 50): Array<{ name: string; ts: string; result: string; output: string }> {
    return this.db.query<{ name: string; ts: string; result: string; output: string }, [number]>(
      "SELECT name, ts, result, output FROM signals ORDER BY id DESC LIMIT ?").all(limit);
  }

  /**
   * What a slug's phases that started at or after `since` (an ISO time) cost. Running phases count at
   * what they hold, unless `endedOnly`.
   */
  costSince(slug: string, since: string, opts: { endedOnly?: boolean } = {}): number {
    return this.costIn({ slug }, since, opts);
  }

  /**
   * costSince over a pool of slugs. `runningSince`: a running phase that started before it no longer
   * counts (its process was killed and nothing will end its row); `endedOnly` takes precedence over it.
   */
  costIn(pool: BudgetPool, since: string, opts: { endedOnly?: boolean; runningSince?: string } = {}): number {
    const who = "slug" in pool ? "slug = ?" : "slug != ?";
    const stale = opts.endedOnly ? undefined : opts.runningSince;
    const running = opts.endedOnly ? " AND status != 'running'" : stale ? " AND (status != 'running' OR started >= ?)" : "";
    const args = [("slug" in pool ? pool.slug : pool.except), since, ...(stale ? [stale] : [])];
    return this.db.query<{ c: number | null }, string[]>(`SELECT SUM(cost_usd) AS c FROM phases WHERE ${who} AND started >= ?${running}`).get(...args)?.c ?? 0;
  }

  intentSummary(slug: string): IntentSummary | null {
    const i = this.db.query<{ slug: string; status: string; priority: string; updated: string }, [string]>("SELECT * FROM intents WHERE slug = ?").get(slug);
    if (!i) return null;
    const cost = this.db.query<{ c: number | null }, [string]>("SELECT SUM(cost_usd) AS c FROM phases WHERE slug = ?").get(slug)?.c ?? 0;
    const last = this.db.query<PhaseRow, [string]>("SELECT * FROM phases WHERE slug = ? ORDER BY seq DESC LIMIT 1").get(slug);
    const act = this.db.query<{ ts: string }, [string]>("SELECT ts FROM events WHERE slug = ? ORDER BY id DESC LIMIT 1").get(slug);
    return {
      slug: i.slug, status: i.status, priority: i.priority, updated: i.updated,
      costUsd: cost, lastPhase: last?.name ?? null, lastPhaseStatus: last?.status ?? null, lastActivity: act?.ts ?? null,
    };
  }

  allIntents(): IntentSummary[] {
    const rows = this.db.query<{ slug: string }, []>("SELECT slug FROM intents ORDER BY updated DESC").all();
    return rows.map((r) => this.intentSummary(r.slug)!).filter(Boolean);
  }
}
