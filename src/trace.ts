import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { CHAT_SLUG } from "./budget";
import type { ModelRef } from "./models";
import { loopstraDir, runDir } from "./paths";
import { errorCode, errorText } from "./shell";

export type EventType =
  | "tick" | "phase_start" | "claude_event" | "command" | "gate_check"
  | "status_change" | "phase_end" | "error" | "signal" | "stop" | "person-changed-status" | "pause" | "stale-lock-removed"
  | "chat-message" | "chat-request" | "chat-pr" | "request" | "judge" | "steer" | "question" | "agent_setup";

export interface EventRow {
  id: number; slug: string; phase_seq: number | null; type: EventType; ts: string; payload: string;
}

interface IntentSummary {
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

/** What a named model ran on in one session that told: `ran` is the model Claude Code reported (null if it named none); `bad-model` is a model it did not accept. */
export interface ModelRun {
  ref: ModelRef; asked: string; ran: string | null; result: "ok" | "bad-model"; slug: string; seq: number; ts: string;
}

/** A status_change event's payload, as statusChange writes it (other fields, like who moved it, are not read here). */
const StatusPayload = z.object({ from: z.string(), to: z.string(), note: z.string().default("") });

/** One status move of a change: when, from what, to what, and the note it left. */
export interface StatusMove { slug: string; ts: string; from: string; to: string; note: string }

/** One gate check's result, without its evidence. */
export interface GateRow { slug: string; gate: string; check: string; result: string; ts: string }

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
CREATE TABLE IF NOT EXISTS model_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, asked TEXT NOT NULL, ran TEXT,
  result TEXT NOT NULL, slug TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS model_runs_ref ON model_runs (ref, id);
CREATE INDEX IF NOT EXISTS signals_name ON signals (name, id);
CREATE INDEX IF NOT EXISTS gates_check ON gates (slug, gate, "check", id);
CREATE INDEX IF NOT EXISTS phases_started ON phases (started);
`;

/**
 * Changes to tables the schema above created in an older version, in order: the first entry brings
 * a database at user_version 0 to 1, and so on. CREATE ... IF NOT EXISTS adds a new table or index
 * by itself; a new column, a renamed one or a changed index goes here, as SQL run in one transaction.
 */
const MIGRATIONS: readonly string[] = [];

/** The schema version this version writes (`PRAGMA user_version`): how many migrations a database has had. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Brings the database to this version's schema. The version is read first: a database from a newer
 * Loopstra is refused, plainly and before anything is written to it (its tables may have columns
 * this version does not know). A new database gets the schema and this version at once. An older
 * one gets its migrations first, one at a time, each in its own transaction with the version bump
 * (a kill part way leaves the version true), and then the schema, whose CREATE ... IF NOT EXISTS
 * adds the new tables and indexes, which may name a column a migration just added. Each step reads
 * the version again inside its transaction, which takes the write lock at once: another process (a
 * second loop, the console) that ran the step meanwhile is not followed by a second run of it. One
 * already up to date enters no step, so opening it never takes the write lock.
 * `migrations` is for tests.
 */
export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): void {
  const target = migrations.length;
  const version = () => (db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? 0;
  const newer = (at: number) => new Error(`The trace database was written by a newer Loopstra (schema version ${at}; this one knows ${target}). Upgrade Loopstra, or move .loopstra/trace.db aside.`);
  const at = version();
  if (at > target) throw newer(at);
  // Fresh only when it has no tables at all: an older version created them one statement at a time,
  // so a kill could leave some but not `events`, and those must still get every migration.
  const fresh = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table'").get() === null;
  if (fresh) {
    db.transaction(() => {
      db.run(SCHEMA);
      db.run(`PRAGMA user_version = ${target}`);
    })();
    return;
  }
  // Up to date, the common case (every console request and chat turn opens the trace): no step's
  // transaction is entered, so the open does not take the write lock and wait behind the loop's writes.
  if (at < target) {
    for (;;) {
      const done = db.transaction(() => {
        const v = version();
        if (v > target) throw newer(v);
        if (v === target) return true;
        db.run(migrations[v]!);
        db.run(`PRAGMA user_version = ${v + 1}`);
        return false;
      }).immediate();
      if (done) break;
    }
  }
  db.run(SCHEMA);
}

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
    if (/SQLITE_BUSY|locked/i.test(`${errorCode(e) ?? ""} ${errorText(e)}`)) throw e;
    got = errorText(e);
  }
  if (got.toLowerCase() === "wal") return null;
  try { db.run("PRAGMA journal_mode = DELETE"); } catch { /* keep the mode it has */ }
  return `the trace database could not use WAL journal mode (${got || "no answer"}), so it uses journal_mode=DELETE`;
}

/** The WAL fallback is traced once per process, not on every open. */
let journalNoted = false;

/** Opens and prepares the database; closes it again when that fails. */
function connect(path: string): { db: Database; note: string | null } {
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const note = useJournal(db);
    db.run("PRAGMA synchronous = NORMAL;");
    migrate(db);
    // A read, to meet a damaged file now rather than at the first query. One row, not a count: the console opens a trace per request.
    db.query("SELECT 1 FROM events LIMIT 1").get();
    return { db, note };
  } catch (e) {
    try { db.close(); } catch { /* already unusable */ }
    throw e;
  }
}

/** True for errors that mean the file is not a usable database (as opposed to, say, a lock). */
function damaged(e: unknown): boolean {
  const text = `${errorCode(e) ?? ""} ${errorText(e)}`;
  return /SQLITE_(CORRUPT|NOTADB)|not a database|malformed/i.test(text);
}

/** Whose phases a budget counts: one slug's, or every slug's but one (the loop's day leaves chat out). */
type BudgetPool = { slug: string } | { except: string };

export class Trace {
  private constructor(private readonly root: string, private readonly db: Database) {}

  /**
   * Opens the trace database. A damaged one (not a database, or malformed) is moved aside to
   * `trace.db.corrupt-<time>` and a fresh one is started, with a plain console line and an event in
   * the new one, so the loop and the dashboard keep working. Any other problem (a lock) is thrown.
   */
  static open(root: string, say: (line: string) => void = (l) => console.log(l)): Trace {
    const dir = loopstraDir(root);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "trace.db");
    try {
      return Trace.noted(root, connect(path));
    } catch (e) {
      if (!damaged(e)) throw e;
      const moved = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(path, moved);
        for (const side of ["-wal", "-shm"]) if (existsSync(path + side)) renameSync(path + side, moved + side);
      } catch (moveError) {
        // Held open by another process (the console, say; Windows refuses the rename): say what is wrong, plainly.
        throw new Error(`The trace database .loopstra/trace.db could not be read (${errorText(e)}), and it could not be moved aside: ${errorText(moveError)}. Stop every loopstra process that has it open, then start again.`);
      }
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
    const dir = runDir(this.root, slug);
    mkdirSync(dir, { recursive: true });
    // The row as JSON with the payload stringified once: `{"ts":…,"type":…,"payload":…}`.
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ts, slug, phase_seq: phaseSeq, type }).slice(0, -1)},"payload":${json}}\n`);
  }

  /** Records a change's status and priority; a row that already has them is left alone (no write), so `updated` is when they last changed. */
  upsertIntent(slug: string, status: string, priority: string): void {
    this.db.run(
      "INSERT INTO intents (slug, status, priority, updated) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET status = excluded.status, priority = excluded.priority, updated = excluded.updated WHERE status != excluded.status OR priority != excluded.priority",
      [slug, status, priority, now()],
    );
  }

  statusChange(slug: string, from: string, to: string, note = "", extra: Record<string, unknown> = {}): void {
    this.event(slug, "status_change", { from, to, note, ...extra });
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
  phaseEnd(slug: string, seq: number, r: { status: "success" | "fail" | "interrupted" | "asked"; costUsd?: number; sessionId?: string; error?: string; denied?: string[] }): void {
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

  /** The agent setup each phase of a change ran with, by phase seq (the newest event of a seq wins; phases with none are absent). */
  agentSetups(slug: string): Map<number, Record<string, unknown>> {
    const rows = this.db.query<{ phase_seq: number; payload: string }, [string]>(
      "SELECT phase_seq, payload FROM events WHERE slug = ? AND type = 'agent_setup' AND phase_seq IS NOT NULL ORDER BY id").all(slug);
    const out = new Map<number, Record<string, unknown>>();
    for (const r of rows) {
      try { out.set(r.phase_seq, JSON.parse(r.payload) as Record<string, unknown>); } catch { /* unreadable row */ }
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

  /** Records what a named model ran on in one session (see ModelRun). */
  recordModelRun(r: Omit<ModelRun, "ts">): void {
    this.db.run("INSERT INTO model_runs (ref, asked, ran, result, slug, seq, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", [r.ref, r.asked, r.ran, r.result, r.slug, r.seq, now()]);
  }

  /** The newest run of each named model that has one. */
  lastModelRuns(): Partial<Record<ModelRef, ModelRun>> {
    const rows = this.db.query<ModelRun, []>("SELECT ref, asked, ran, result, slug, seq, ts FROM model_runs WHERE id IN (SELECT MAX(id) FROM model_runs GROUP BY ref)").all();
    return Object.fromEntries(rows.map((r) => [r.ref, r]));
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
   * The id of the newest status change of a slug to another status, or 0 when there is none. One to
   * the same status, which only rewrote the note, is passed over.
   */
  lastStatusMove(slug: string): number {
    return this.db.query<{ id: number }, [string]>(
      "SELECT id FROM events WHERE slug = ? AND type = 'status_change' AND json_valid(payload) AND json_extract(payload, '$.from') IS NOT json_extract(payload, '$.to') ORDER BY id DESC LIMIT 1").get(slug)?.id ?? 0;
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

  /** What the ended phases of every slug cost: those started at or after `day`, at or after `week` (ISO times), and in all. */
  endedCostTotals(day: string, week: string): { day: number; week: number; all: number } {
    const r = this.db.query<{ d: number | null; w: number | null; a: number | null }, [string, string]>(
      "SELECT SUM(CASE WHEN started >= ?1 THEN cost_usd END) AS d, SUM(CASE WHEN started >= ?2 THEN cost_usd END) AS w, SUM(cost_usd) AS a FROM phases WHERE status != 'running'",
    ).get(day, week);
    return { day: r?.d ?? 0, week: r?.w ?? 0, all: r?.a ?? 0 };
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

  /** When one signal started failing: the first of its newest fails in a row (null when its newest result is no fail). */
  failingSince(name: string): string | null {
    return this.db.query<{ ts: string | null }, [string, string]>(
      "SELECT MIN(ts) AS ts FROM signals WHERE name = ? AND result = 'fail' AND id > COALESCE((SELECT MAX(id) FROM signals WHERE name = ? AND result != 'fail'), 0)",
    ).get(name, name)?.ts ?? null;
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

  /**
   * Every status move of every change (chat's left out) at or after `since` (an ISO time), oldest
   * first. A row whose payload cannot be read is passed over.
   */
  statusChangesSince(since: string): StatusMove[] {
    const rows = this.eventsOfTypeSince("status_change", since);
    const out: StatusMove[] = [];
    for (const r of rows) {
      if (r.slug === CHAT_SLUG) continue;
      let raw: unknown;
      try { raw = JSON.parse(r.payload); } catch { continue; }
      const p = StatusPayload.safeParse(raw);
      if (p.success) out.push({ slug: r.slug, ts: r.ts, ...p.data });
    }
    return out;
  }

  /** Every event of one type at or after `since` (an ISO time), of every slug, oldest first. */
  eventsOfTypeSince(type: EventType, since: string): EventRow[] {
    return this.db.query<EventRow, [string, string]>("SELECT * FROM events WHERE type = ? AND ts >= ? ORDER BY id").all(type, since);
  }

  /** Every gate check's result at or after `since` (an ISO time), of every change, oldest first. */
  gatesSince(since: string): GateRow[] {
    return this.db.query<GateRow, [string]>('SELECT slug, gate, "check", result, ts FROM gates WHERE ts >= ? ORDER BY id').all(since);
  }

  /** Every phase (chat's too) started at or after `since` (an ISO time), in the order they started. */
  phasesSince(since: string): PhaseRow[] {
    return this.db.query<PhaseRow, [string]>("SELECT * FROM phases WHERE started >= ? ORDER BY started, rowid").all(since);
  }

  /** What a slug's ended phases cost, in all (a running phase's budget hold is not spending). */
  endedCost(slug: string): number {
    return this.db.query<{ c: number | null }, [string]>("SELECT SUM(cost_usd) AS c FROM phases WHERE slug = ? AND status != 'running'").get(slug)?.c ?? 0;
  }

  intentSummary(slug: string): IntentSummary | null {
    const i = this.db.query<{ slug: string; status: string; priority: string; updated: string }, [string]>("SELECT * FROM intents WHERE slug = ?").get(slug);
    if (!i) return null;
    const cost = this.endedCost(slug);
    // The newest phase, passing over work that ran beside one (see besideWork: the one that decides says where the change is).
    const last = this.db.query<PhaseRow, [string]>(`SELECT * FROM phases WHERE slug = ? ORDER BY ${BESIDE_WORK_SQL}, seq DESC LIMIT 1`).get(slug);
    const act = this.db.query<{ ts: string }, [string]>("SELECT ts FROM events WHERE slug = ? ORDER BY id DESC LIMIT 1").get(slug);
    return {
      slug: i.slug, status: i.status, priority: i.priority, updated: i.updated,
      costUsd: cost, lastPhase: last?.name ?? null, lastPhaseStatus: last?.status ?? null, lastActivity: act?.ts ?? null,
    };
  }
}
