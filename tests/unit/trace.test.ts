import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { judgeNote, migrate, SCHEMA_VERSION, Trace, useJournal, type NewJudgeRow } from "../../src/trace";
import { tempDir } from "../helpers";

describe("Trace", () => {
  test("writes events to jsonl and sqlite, and reports intent summaries", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    trace.upsertIntent("a-b", "building", "high");
    const seq = trace.phaseStart("a-b", "build", "agent");
    trace.event("a-b", "claude_event", { type: "assistant" }, seq);
    trace.phaseEnd("a-b", seq, { status: "success", costUsd: 0.12, sessionId: "sid-1" });
    trace.gate("a-b", "merge", "tests", "pass", "exit 0");
    trace.signal("main_health", "pass", "all green");

    const rows = trace.events("a-b");
    expect(rows.map((r) => r.type)).toEqual(["phase_start", "claude_event", "phase_end", "gate_check"]);
    const jsonl = readFileSync(join(t.path, ".loopstra", "runs", "a-b", "events.jsonl"), "utf8").trim().split("\n");
    expect(jsonl.length).toBe(4);
    expect(JSON.parse(jsonl[0]!).type).toBe("phase_start");

    const summary = trace.intentSummary("a-b");
    expect(summary?.status).toBe("building");
    expect(summary?.costUsd).toBeCloseTo(0.12);
    expect(summary?.lastPhase).toBe("build");
    expect(summary?.lastPhaseStatus).toBe("success");
    expect(existsSync(join(t.path, ".loopstra", "trace.db"))).toBe(true);
    trace.close();
    t.cleanup();
  });

  test("the summary's last phase passes over work that ran alongside one: it says where the change is", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    trace.upsertIntent("a-b", "blocked", "high");
    const verify = trace.phaseStart("a-b", "verify", "agent");
    const early = trace.phaseStart("a-b", "early-review", "agent");
    trace.phaseEnd("a-b", verify, { status: "fail", error: "crash: x" });
    trace.phaseEnd("a-b", early, { status: "success" });
    expect(trace.intentSummary("a-b")).toMatchObject({ lastPhase: "verify", lastPhaseStatus: "fail" });
    // Once a phase comes after, it is the last one as usual.
    trace.phaseEnd("a-b", trace.phaseStart("a-b", "fix-after-verify", "agent"), { status: "success" });
    expect(trace.intentSummary("a-b")?.lastPhase).toBe("fix-after-verify");
    trace.close();
    t.cleanup();
  });

  test("the lookups each tick makes have indexes, and an old database gains them when it is opened", () => {
    const t = tempDir();
    try {
      // A trace.db from before the indexes: only the events table and its first index.
      mkdirSync(join(t.path, ".loopstra"), { recursive: true });
      const old = new Database(join(t.path, ".loopstra", "trace.db"));
      old.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, phase_seq INTEGER, type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX events_slug ON events (slug, id);");
      old.close();
      const trace = Trace.open(t.path);
      trace.close();
      const db = new Database(join(t.path, ".loopstra", "trace.db"));
      const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
      expect(indexes).toEqual(expect.arrayContaining(["events_slug", "events_slug_type", "signals_name", "gates_check", "phases_started"]));
      // lastEvent on the loop's rows (one per tick) is an index search, not a scan of every _loop row.
      const plan = db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT * FROM events WHERE slug = '_loop' AND type = 'error' AND instr(payload, 'gc') > 0 ORDER BY id DESC LIMIT 1").all().map((r) => r.detail).join("\n");
      expect(plan).toContain("events_slug_type");
      db.close();
    } finally { t.cleanup(); }
  });

  test("eventOnChange records an event only when the field differs from the newest one like it, or that one is too old", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      const pauses = () => trace.events("_loop").filter((e) => e.type === "pause").map((e) => JSON.parse(e.payload).reason);
      trace.eventOnChange("_loop", "pause", "", { reason: "spent" }, "reason");
      trace.eventOnChange("_loop", "pause", "", { reason: "spent" }, "reason");
      expect(pauses()).toEqual(["spent"]);
      trace.eventOnChange("_loop", "pause", "", { reason: "held" }, "reason");
      expect(pauses()).toEqual(["spent", "held"]);
      // The same again, but the newest is older than `since`: recorded anew (a new day, say).
      trace.eventOnChange("_loop", "pause", "", { reason: "held" }, "reason", new Date(Date.now() + 60_000).toISOString());
      expect(pauses()).toEqual(["spent", "held", "held"]);
      // Only events like it count: another slug's, or one whose payload lacks `like`, do not.
      trace.eventOnChange("x", "error", '"where":"scan"', { where: "scan", problem: "p" }, "problem");
      trace.event("x", "error", { where: "elsewhere", problem: "q" });
      trace.eventOnChange("x", "error", '"where":"scan"', { where: "scan", problem: "p" }, "problem");
      expect(trace.events("x").map((e) => JSON.parse(e.payload).problem)).toEqual(["p", "q"]);
    } finally { trace.close(); t.cleanup(); }
  });

  test("lastGate returns the newest row for one gate check only", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    expect(trace.lastGate("x", "review", "findings")).toBeNull();
    trace.gate("x", "review", "findings", "fail", "round 1");
    trace.gate("x", "review", "findings", "pass", "round 2");
    trace.gate("x", "merge", "findings", "fail", "other gate");
    trace.gate("y", "review", "findings", "fail", "other intent");
    expect(trace.lastGate("x", "review", "findings")).toMatchObject({ result: "pass", evidence: "round 2" });
    trace.close();
    t.cleanup();
  });

  test("lastEvents reads only the newest events of one change, oldest first", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    for (let n = 1; n <= 5; n++) trace.event("x", "command", { n });
    trace.event("y", "command", { n: 99 });
    expect(trace.lastEvents("x", 3).map((e) => JSON.parse(e.payload).n)).toEqual([3, 4, 5]);
    expect(trace.lastEvents("z", 3)).toEqual([]);
    trace.close();
    t.cleanup();
  });

  test("phase sequence increments per intent and survives reopen", () => {
    const t = tempDir();
    let trace = Trace.open(t.path);
    expect(trace.phaseStart("x", "design", "agent")).toBe(1);
    expect(trace.phaseStart("x", "spec-check", "agent")).toBe(2);
    trace.close();
    trace = Trace.open(t.path);
    expect(trace.phaseStart("x", "plan", "agent")).toBe(3);
    trace.close();
    t.cleanup();
  });

  test("a damaged trace.db is moved aside and a fresh one started, with a plain line and a recorded event", () => {
    const t = tempDir();
    mkdirSync(join(t.path, ".loopstra"), { recursive: true });
    writeFileSync(join(t.path, ".loopstra", "trace.db"), "this is not a database, just some bytes that got written here by mistake".repeat(20));
    const said: string[] = [];
    const trace = Trace.open(t.path, (l) => said.push(l));
    trace.event("x", "tick", {});
    expect(trace.events("x")).toHaveLength(1);
    const moved = readdirSync(join(t.path, ".loopstra")).filter((f) => f.startsWith("trace.db.corrupt-"));
    expect(moved).toHaveLength(1);
    expect(said).toEqual([`The trace database could not be read, so it was moved to .loopstra/${moved[0]} and a new one was started.`]);
    expect(trace.events("_loop").some((e) => e.type === "error" && e.payload.includes("moved aside"))).toBe(true);
    trace.close();
    // The fresh database opens normally next time.
    const again = Trace.open(t.path, (l) => said.push(l));
    again.close();
    expect(said).toHaveLength(1);
    t.cleanup();
  });

  test("uses WAL where it can, and falls back to DELETE with a note where it cannot", () => {
    const t = tempDir();
    const file = new Database(join(t.path, "x.db"));
    try {
      expect(useJournal(file)).toBeNull();
      expect((file.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    } finally { file.close(); t.cleanup(); }
    // An in-memory database cannot use WAL: the same answer a file system without it gives.
    const memory = new Database(":memory:");
    try {
      expect(useJournal(memory)).toContain("journal_mode=DELETE");
      memory.run("CREATE TABLE t (x INTEGER)");
    } finally { memory.close(); }
  });
});

describe("the judges table", () => {
  const row = (over: Partial<NewJudgeRow> = {}): NewJudgeRow => ({
    judge: "spec-check", trace_name: "spec-check", mode: "shadow", how: "shadow",
    cheap_model: "sonnet", strong_model: "opus", template_sha: "t1", prompt_sha: "p1",
    cheap: "pass", strong: "reject", cheap_usd: 0.1, strong_usd: 0.3, cheap_ms: 1000, strong_ms: 2000, ...over,
  });

  test("an old database gains the judges table when it is opened", () => {
    const t = tempDir();
    mkdirSync(join(t.path, ".loopstra"), { recursive: true });
    const old = new Database(join(t.path, ".loopstra", "trace.db"));
    old.run("CREATE TABLE intents (slug TEXT PRIMARY KEY, status TEXT NOT NULL, priority TEXT NOT NULL, updated TEXT NOT NULL)");
    old.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, phase_seq INTEGER, type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL)");
    old.close();
    const trace = Trace.open(t.path);
    try {
      expect(trace.judgeRows()).toEqual([]);
      trace.judge("x", row());
      expect(trace.judgeRows()).toHaveLength(1);
    } finally { trace.close(); t.cleanup(); }
  });

  test("judge() writes the row and a judge event with a plain note to events.jsonl; judgeRows() reads them oldest first", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      trace.judge("add-numbers", row());
      trace.judge("other", row({ judge: "review", trace_name: "review-1", how: "alone", mode: "first", cheap: "pass", strong: null, strong_usd: null, strong_ms: null }));
      const rows = trace.judgeRows();
      expect(rows.map((r) => [r.slug, r.trace_name, r.how, r.strong])).toEqual([["add-numbers", "spec-check", "shadow", "reject"], ["other", "review-1", "alone", null]]);
      expect(rows[0]).toMatchObject({ cheap_model: "sonnet", strong_model: "opus", template_sha: "t1", prompt_sha: "p1", cheap: "pass", cheap_usd: 0.1, strong_usd: 0.3, cheap_ms: 1000, strong_ms: 2000 });
      expect(rows[0]!.ts).toMatch(/^\d{4}-/);
      const jsonl = readFileSync(join(t.path, ".loopstra", "runs", "add-numbers", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(jsonl.map((e) => e.type)).toEqual(["judge"]);
      expect(jsonl[0].payload).toMatchObject({ judge: "spec-check", cheap: "pass", strong: "reject",
        note: "the cheaper judge (sonnet) passed what the strong judge (opus) rejected; the strong judge decided" });
    } finally { trace.close(); t.cleanup(); }
  });

  test("a judge event's note says who decided, in plain words", () => {
    expect(judgeNote(row({ cheap: "reject", strong: "reject" }))).toBe("the cheaper judge (sonnet) agreed with the strong judge (opus): rejected");
    expect(judgeNote(row({ cheap: "pass", strong: "pass" }))).toBe("the cheaper judge (sonnet) agreed with the strong judge (opus): passed");
    expect(judgeNote(row({ how: "alone", cheap: "pass", strong: null }))).toBe("decided by the cheaper judge (sonnet): passed");
    expect(judgeNote(row({ how: "escalated", cheap: "unsure", strong: "reject" }))).toBe("the cheaper judge (sonnet) was unsure, so the strong judge (opus) decided: rejected");
    expect(judgeNote(row({ cheap: "failed", strong: "pass" }))).toBe("the cheaper judge (sonnet) could not answer; the strong judge (opus) decided: passed");
    expect(judgeNote(row({ cheap: "pass", strong: "failed" }))).toBe("the strong judge (opus) could not answer, so nothing was compared");
  });

  test("a change's last phase leaves out the cheaper judge's rows; its cost still counts them", () => {
    const t = tempDir();
    const trace = Trace.open(t.path);
    try {
      trace.upsertIntent("x", "designing", "normal");
      const strong = trace.phaseStart("x", "spec-check", "agent");
      const cheap = trace.phaseStart("x", "spec-check-cheap", "agent");
      trace.phaseEnd("x", strong, { status: "success", costUsd: 0.3 });
      trace.phaseEnd("x", cheap, { status: "fail", costUsd: 0.1, error: "invalid-envelope: x" });
      const summary = trace.intentSummary("x")!;
      expect([summary.lastPhase, summary.lastPhaseStatus]).toEqual(["spec-check", "success"]);
      expect(summary.costUsd).toBeCloseTo(0.4);
    } finally { trace.close(); t.cleanup(); }
  });
});

describe("the schema version", () => {
  test("a fresh database is stamped with this version's schema version", () => {
    const t = tempDir();
    try {
      Trace.open(t.path).close();
      const db = new Database(join(t.path, ".loopstra", "trace.db"), { readonly: true });
      try {
        expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      } finally { db.close(); }
    } finally { t.cleanup(); }
  });

  test("a database from a newer Loopstra is refused with a plain message", () => {
    const db = new Database(":memory:");
    try {
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      expect(() => migrate(db)).toThrow("written by a newer Loopstra");
    } finally { db.close(); }
  });

  test("an older database is brought up without losing its rows", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, ".loopstra"), { recursive: true });
      const old = new Database(join(t.path, ".loopstra", "trace.db"));
      old.run("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, phase_seq INTEGER, type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL)");
      old.run("INSERT INTO events (slug, type, ts, payload) VALUES ('a', 'tick', '2026-01-01T00:00:00.000Z', '{}')");
      old.close();
      const trace = Trace.open(t.path);
      try {
        expect(trace.events("a").map((e) => e.type)).toEqual(["tick"]);
      } finally { trace.close(); }
      const db = new Database(join(t.path, ".loopstra", "trace.db"), { readonly: true });
      try {
        expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      } finally { db.close(); }
    } finally { t.cleanup(); }
  });
});

describe("two connections at once", () => {
  test("phase starts from two connections on one file get distinct seqs, and a write waits for a held transaction", async () => {
    const t = tempDir();
    try {
      const a = Trace.open(t.path);
      const b = Trace.open(t.path);
      try {
        const seqs = [a.phaseStart("x", "design", "agent"), b.phaseStart("x", "plan", "agent"), a.phaseStart("x", "build", "agent")];
        expect(new Set(seqs).size).toBe(3);
        // Another process holds the write lock for a moment; a's write waits (busy_timeout) rather than failing.
        const path = join(t.path, ".loopstra", "trace.db");
        const script = `const { Database } = require("bun:sqlite"); const db = new Database(process.argv[1]); db.run("PRAGMA busy_timeout = 5000;"); db.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(400); db.run("COMMIT"); db.close();`;
        const holder = Bun.spawn({ cmd: [process.execPath, "-e", script, path], stdout: "pipe", stderr: "pipe" });
        const reader = holder.stdout.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain("held");
        const started = Date.now();
        a.event("x", "tick", {});
        expect(Date.now() - started).toBeGreaterThan(100);
        await holder.exited;
        expect(a.events("x").filter((e) => e.type === "tick")).toHaveLength(1);
      } finally { a.close(); b.close(); }
    } finally { t.cleanup(); }
  });
});
