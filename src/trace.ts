import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { errorText } from "./shell";

export type EventType =
  | "tick" | "phase_start" | "claude_event" | "command" | "gate_check"
  | "status_change" | "phase_end" | "error" | "signal" | "stop" | "person-changed-status" | "pause" | "stale-lock-removed"
  | "chat-message" | "chat-request" | "chat-pr" | "judge";

export interface EventRow {
  id: number; slug: string; phase_seq: number | null; type: EventType; ts: string; payload: string;
}

export interface IntentSummary {
  slug: string; status: string; priority: string; updated: string;
  costUsd: number; lastPhase: string | null; lastPhaseStatus: string | null; lastActivity: string | null;
}

/**
 * The trace names of work run alongside another phase start with this ("early-review" beside the
 * verifier, "early-lessons" beside the done-check; see alongside in phases). That work is optional, so
 * summaries and the fix history pass over its rows.
 */
export const EARLY = "early-";

/** A cheaper judge's trace name ends with this ("spec-check-cheap"; see src/judges.ts). */
export const CHEAP = "-cheap";

/**
 * A phase that only ran beside (or before) the one that decides: work run alongside (`early-…`) or a
 * cheaper judge (`…-cheap`). The phase that decides says where the change is, so lessons' fix history
 * and the status table's newest phase pass over these rows; the change's cost still counts them.
 */
export function besideWork(name: string): boolean {
  return name.startsWith(EARLY) || name.endsWith(CHEAP);
}

/** besideWork as an SQL condition on a phases row. */
const BESIDE_WORK_SQL = `(name LIKE '${EARLY}%' OR name LIKE '%${CHEAP}')`;

export interface PhaseRow {
  slug: string; seq: number; name: string; kind: string; status: string;
  started: string; ended: string | null; cost_usd: number; session_id: string | null; error: string | null;
}

/**
 * One question a cheaper judge was asked (see src/judges.ts). `mode` is the setting (shadow or first);
 * `how` is what ran: shadow (both judges, the strong one decided), alone (the cheaper judge passed and
 * decided), or escalated (the cheaper judge did not pass, then the strong one decided). `strong` is null
 * when the cheaper judge decided alone. Costs and times are null for a session that did not end ok.
 */
export interface JudgeRow {
  id: number; slug: string; judge: string; trace_name: string; ts: string;
  mode: "shadow" | "first"; how: "shadow" | "alone" | "escalated";
  cheap_model: string; strong_model: string; template_sha: string; prompt_sha: string;
  cheap: "pass" | "unsure" | "reject" | "failed"; strong: "pass" | "reject" | "failed" | null;
  cheap_usd: number | null; strong_usd: number | null; cheap_ms: number | null; strong_ms: number | null;
}

/** A judges row as written: the trace adds the id, the change and the time. */
export type NewJudgeRow = Omit<JudgeRow, "id" | "slug" | "ts">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (slug TEXT PRIMARY KEY, status TEXT NOT NULL, priority TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phases (slug TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, cost_usd REAL NOT NULL DEFAULT 0, session_id TEXT, error TEXT,
  PRIMARY KEY (slug, seq));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, phase_seq INTEGER,
  type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_slug ON events (slug, id);
CREATE INDEX IF NOT EXISTS events_phase ON events (slug, phase_seq, id);
CREATE INDEX IF NOT EXISTS events_slug_type ON events (slug, type, id);
CREATE TABLE IF NOT EXISTS gates (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, gate TEXT NOT NULL,
  "check" TEXT NOT NULL, result TEXT NOT NULL, evidence TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ts TEXT NOT NULL,
  result TEXT NOT NULL, output TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS judges (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
  judge TEXT NOT NULL, trace_name TEXT NOT NULL, ts TEXT NOT NULL, mode TEXT NOT NULL, how TEXT NOT NULL,
  cheap_model TEXT NOT NULL, strong_model TEXT NOT NULL, template_sha TEXT NOT NULL, prompt_sha TEXT NOT NULL,
  cheap TEXT NOT NULL, strong TEXT,
  cheap_usd REAL, strong_usd REAL, cheap_ms INTEGER, strong_ms INTEGER);
CREATE INDEX IF NOT EXISTS signals_name ON signals (name, id);
CREATE INDEX IF NOT EXISTS gates_check ON gates (slug, gate, "check", id);
CREATE INDEX IF NOT EXISTS phases_started ON phases (started);
`;

const JUDGE_COLUMNS = ["slug", "judge", "trace_name", "ts", "mode", "how", "cheap_model", "strong_model", "template_sha", "prompt_sha",
  "cheap", "strong", "cheap_usd", "strong_usd", "cheap_ms", "strong_ms"] as const;

/** "passed", "rejected", "could not answer": a strong verdict in words. */
function decided(verdict: "pass" | "reject" | "failed"): string {
  return verdict === "pass" ? "passed" : verdict === "reject" ? "rejected" : "could not answer";
}

/** What the cheaper judge did, in words: "rejected", "was unsure", "could not answer". */
function cheapDid(verdict: "unsure" | "reject" | "failed"): string {
  return verdict === "reject" ? "rejected" : verdict === "unsure" ? "was unsure" : "could not answer";
}

/** The plain note on a judge event: who decided, and whether the two judges agreed. */
export function judgeNote(row: NewJudgeRow): string {
  const cheap = `the cheaper judge (${row.cheap_model})`;
  const strong = `the strong judge (${row.strong_model})`;
  if (row.how === "alone" || row.strong === null) return `decided by ${cheap}: passed`;
  if (row.how === "escalated") return `${cheap} ${row.cheap === "pass" ? "passed" : cheapDid(row.cheap)}, so ${strong} decided: ${decided(row.strong)}`;
  if (row.strong === "failed") return `${strong} could not answer, so nothing was compared`;
  if (row.cheap === "failed") return `${cheap} could not answer; ${strong} decided: ${decided(row.strong)}`;
  if (row.cheap === "pass" && row.strong === "pass") return `${cheap} agreed with ${strong}: passed`;
  if (row.cheap === "reject" && row.strong === "reject") return `${cheap} agreed with ${strong}: rejected`;
  if (row.cheap === "unsure" && row.strong === "reject") return `${cheap} was unsure and ${strong} rejected; counted as agreed`;
  if (row.cheap === "pass") return `${cheap} passed what ${strong} rejected; the strong judge decided`;
  return `${cheap} ${row.cheap === "unsure" ? "was unsure of" : "rejected"} what ${strong} passed; the strong judge decided`;
}

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

  /** Records one question a cheaper judge was asked, and a `judge` event: the row plus a plain note. */
  judge(slug: string, row: NewJudgeRow): void {
    const full = { slug, ts: now(), ...row };
    this.db.run(`INSERT INTO judges (${JUDGE_COLUMNS.join(", ")}) VALUES (${JUDGE_COLUMNS.map(() => "?").join(", ")})`, JUDGE_COLUMNS.map((c) => full[c]));
    // The note first: `loopstra tail` shortens long lines, and the note is what a person reads.
    this.event(slug, "judge", { note: judgeNote(row), ...row });
  }

  /** What every cheaper judge's session (a `-cheap` phase) has cost, across all changes; a running one holds, so it is left out. */
  cheapJudgeCost(): number {
    return this.db.query<{ c: number | null }, []>(`SELECT SUM(cost_usd) AS c FROM phases WHERE name LIKE '%${CHEAP}' AND status != 'running'`).get()?.c ?? 0;
  }

  /** Every judges row, oldest first. They are few; src/judges.ts filters them. */
  judgeRows(): JudgeRow[] {
    return this.db.query<JudgeRow, []>("SELECT * FROM judges ORDER BY id").all();
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

  /**
   * Records an event unless the newest one like it (see lastEvent: the same slug and type, its payload
   * containing `like`) says the same `field`, and is no older than `since` when given. A condition that
   * lasts is then one line in the trace, not one per tick.
   */
  eventOnChange(slug: string, type: EventType, like: string, payload: Record<string, unknown>, field: string, since?: string): void {
    const last = this.lastEvent(slug, type, like);
    if (last && (since === undefined || last.ts >= since)) {
      let said: unknown;
      try { said = (JSON.parse(last.payload) as Record<string, unknown>)[field]; } catch { said = undefined; }
      if (JSON.stringify(said) === JSON.stringify(payload[field])) return;
    }
    this.event(slug, type, payload);
  }

  /** The newest `limit` events of one slug, oldest first. */
  lastEvents(slug: string, limit: number): EventRow[] {
    return this.db.query<EventRow, [string, number]>("SELECT * FROM events WHERE slug = ? ORDER BY id DESC LIMIT ?").all(slug, limit).reverse();
  }

  recentEvents(afterId = 0, limit = 200): EventRow[] {
    return this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?").all(afterId, limit).reverse();
  }

  /** The newest event's id, or 0 when there is none. */
  lastEventId(): number {
    return this.db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0;
  }

  /** Up to `limit` events after `afterId`, oldest first. */
  eventsAfter(afterId: number, limit: number): EventRow[] {
    return this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, limit);
  }

  /** Up to `limit` events older than `beforeId` (any, when it is 0), newest first; only one slug's when given. */
  eventsBefore(beforeId: number, limit: number, slug?: string): EventRow[] {
    const before = beforeId > 0 ? beforeId : Number.MAX_SAFE_INTEGER;
    return slug
      ? this.db.query<EventRow, [string, number, number]>("SELECT * FROM events WHERE slug = ? AND id < ? ORDER BY id DESC LIMIT ?").all(slug, before, limit)
      : this.db.query<EventRow, [number, number]>("SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit);
  }

  /** The newest `limit` events of one phase, oldest first. */
  phaseEvents(slug: string, seq: number, limit: number): EventRow[] {
    return this.db.query<EventRow, [string, number, number]>(
      "SELECT * FROM events WHERE slug = ? AND phase_seq = ? ORDER BY id DESC LIMIT ?").all(slug, seq, limit).reverse();
  }

  /** The first event of a type in one phase, or null. */
  firstEvent(slug: string, seq: number, type: EventType): EventRow | null {
    return this.db.query<EventRow, [string, number, string]>(
      "SELECT * FROM events WHERE slug = ? AND phase_seq = ? AND type = ? ORDER BY id LIMIT 1").get(slug, seq, type) ?? null;
  }

  /** One phase, or null. */
  phase(slug: string, seq: number): PhaseRow | null {
    return this.db.query<PhaseRow, [string, number]>("SELECT * FROM phases WHERE slug = ? AND seq = ?").get(slug, seq) ?? null;
  }

  /** Every phase of every slug (chat's too), in the order they started. */
  allPhases(): PhaseRow[] {
    return this.db.query<PhaseRow, []>("SELECT * FROM phases ORDER BY started, rowid").all();
  }

  /** The newest `limit` ended phases of any slug, newest first. */
  recentPhases(limit: number): PhaseRow[] {
    return this.db.query<PhaseRow, [number]>("SELECT * FROM phases WHERE ended IS NOT NULL ORDER BY ended DESC, rowid DESC LIMIT ?").all(limit);
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
    const cost = this.db.query<{ c: number | null }, [string]>("SELECT SUM(cost_usd) AS c FROM phases WHERE slug = ? AND status != 'running'").get(slug)?.c ?? 0;
    // The newest phase, passing over work that ran beside one (see besideWork: the one that decides says where the change is).
    const last = this.db.query<PhaseRow, [string]>(`SELECT * FROM phases WHERE slug = ? ORDER BY ${BESIDE_WORK_SQL}, seq DESC LIMIT 1`).get(slug);
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
