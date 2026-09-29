import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "tick" | "phase_start" | "claude_event" | "command" | "gate_check"
  | "status_change" | "phase_end" | "error" | "signal" | "stop";

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

export class Trace {
  private constructor(private readonly root: string, private readonly db: Database) {}

  static open(root: string): Trace {
    const dir = join(root, ".loopstra");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "trace.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    return new Trace(root, db);
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

  phaseStart(slug: string, name: string, kind: "agent" | "code" | "human"): number {
    const row = this.db.query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM phases WHERE slug = ?").get(slug);
    const seq = (row?.m ?? 0) + 1;
    this.db.run("INSERT INTO phases (slug, seq, name, kind, status, started) VALUES (?, ?, ?, ?, 'running', ?)", [slug, seq, name, kind, now()]);
    this.event(slug, "phase_start", { name, kind }, seq);
    return seq;
  }

  phaseEnd(slug: string, seq: number, r: { status: "success" | "fail" | "interrupted"; costUsd?: number; sessionId?: string; error?: string }): void {
    this.db.run("UPDATE phases SET status = ?, ended = ?, cost_usd = ?, session_id = COALESCE(?, session_id), error = ? WHERE slug = ? AND seq = ?",
      [r.status, now(), r.costUsd ?? 0, r.sessionId ?? null, r.error ?? null, slug, seq]);
    this.event(slug, "phase_end", { status: r.status, cost_usd: r.costUsd ?? 0, error: r.error ?? null }, seq);
  }

  gate(slug: string, gate: string, check: string, result: "pass" | "fail" | "waiting", evidence: string): void {
    this.db.run('INSERT INTO gates (slug, gate, "check", result, evidence, ts) VALUES (?, ?, ?, ?, ?, ?)', [slug, gate, check, result, evidence, now()]);
    this.event(slug, "gate_check", { gate, check, result, evidence });
  }

  signal(name: string, result: "pass" | "fail" | "error", output: string): void {
    this.db.run("INSERT INTO signals (name, ts, result, output) VALUES (?, ?, ?, ?)", [name, now(), result, output]);
    this.event("_signals", "signal", { name, result, output });
  }

  events(slug: string, afterId = 0, limit = 500): EventRow[] {
    return this.db.query<EventRow, [string, number, number]>("SELECT * FROM events WHERE slug = ? AND id > ? ORDER BY id LIMIT ?").all(slug, afterId, limit);
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

  signals(limit = 50): Array<{ name: string; ts: string; result: string; output: string }> {
    return this.db.query<{ name: string; ts: string; result: string; output: string }, [number]>(
      "SELECT name, ts, result, output FROM signals ORDER BY id DESC LIMIT ?").all(limit);
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
