import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { renderRetro } from "../../src/commands/retro";
import { configPath, parseConfig, type Config } from "../../src/config";
import { CRASH_NOTE, TIMEOUT_NOTE } from "../../src/context";
import { judgeReport, type JudgeReport } from "../../src/judges";
import { ownerNote } from "../../src/phases";
import { TOO_MANY_NOTE } from "../../src/questions";
import { blockKind, buildRetro, retroText, suggestions, type BlockKind, type RetroInput } from "../../src/retro";
import { CHECKS_KEPT_TIMING_OUT_NOTE, TESTS_KEPT_FAILING_NOTE, VERIFY_STILL_FAILED_NOTE } from "../../src/stages/build";
import { PR_CHECKS_FAILED_NOTE, PR_CLOSED_NOTE, REVIEWS_USED_UP, UPDATE_FAILED_NOTE } from "../../src/stages/merge";
import { REVIEW_STILL_FOUND_NOTE } from "../../src/stages/review";
import { MERGE_WAIT_NOTE, PR_CHECKS_NOTE } from "../../src/stages/shared";
import { UNMET_NOTE } from "../../src/stages/verify";
import { Trace, type EventRow, type GateRow, type PhaseRow, type StatusMove } from "../../src/trace";
import { tempDir } from "../helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local noon, so the window's first day reads the same in every time zone. */
const NOW = new Date(2026, 9, 27, 12);
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY + hours * HOUR).toISOString();
const BASE = "version: 1\ncommands:\n  test: echo ok\n";
const cfgOf = (yaml = "") => parseConfig(BASE + yaml);

function input(over: Partial<RetroInput> = {}): RetroInput {
  const cfg = over.cfg ?? cfgOf();
  return { days: 7, now: NOW, cfg, moves: [], gates: [], phases: [], questions: [], requests: [], judges: judgeReport(cfg, [], {}), ...over };
}

const mv = (slug: string, ts: string, from: string, to: string, note = ""): StatusMove => ({ slug, ts, from, to, note });
const gateRow = (slug: string, gate: string, check: string, result: string, ts = ago(1)): GateRow => ({ slug, gate, check, result, ts });
let seq = 0;
const phase = (slug: string, name: string, cost: number, status = "success", started = ago(1)): PhaseRow =>
  ({ slug, seq: ++seq, name, kind: "agent", status, started, ended: status === "running" ? null : started, cost_usd: cost, session_id: null, error: null });
let id = 0;
const ev = (slug: string, type: EventRow["type"], ts: string, payload: unknown): EventRow => ({ id: ++id, slug, phase_seq: null, type, ts, payload: JSON.stringify(payload) });
const blocks = (kind: BlockKind, n: number, slug = "slow-one"): StatusMove[] => {
  const note: Record<string, string> = { tests: TESTS_KEPT_FAILING_NOTE, timeout: ownerNote("timeout"), review: REVIEW_STILL_FOUND_NOTE, budget: ownerNote("budget"), unmet: UNMET_NOTE };
  return Array.from({ length: n }, (_, i) => mv(slug, ago(2, i), "building", "blocked", note[kind]));
};

describe("blockKind", () => {
  test("each note the runtime blocks with is told by the constant it is written from", () => {
    const cases: Array<[string, BlockKind]> = [
      [ownerNote("timeout"), "timeout"],
      [`${TIMEOUT_NOTE} To try again, set status to plan-approved.`, "timeout"],
      [`The finished change could not be checked. ${ownerNote("timeout")}`, "timeout"],
      [ownerNote("crash"), "crash"],
      [`${CRASH_NOTE} To try again, set status to plan-approved.`, "crash"],
      [ownerNote("budget"), "budget"],
      [TOO_MANY_NOTE, "questions"],
      [`${TESTS_KEPT_FAILING_NOTE} When that is sorted out, set status to plan-approved to try again.`, "tests"],
      [CHECKS_KEPT_TIMING_OUT_NOTE, "tests"],
      [REVIEW_STILL_FOUND_NOTE, "review"],
      [REVIEWS_USED_UP, "review"],
      [VERIFY_STILL_FAILED_NOTE, "verify"],
      [UPDATE_FAILED_NOTE, "conflicts"],
      [PR_CHECKS_FAILED_NOTE, "pr-checks"],
      [PR_CLOSED_NOTE, "pr-closed"],
      [UNMET_NOTE, "unmet"],
      ["The work for this change is missing. To build it again, set status to plan-approved.", "other"],
      ["", "other"],
    ];
    for (const [note, kind] of cases) expect({ note, kind: blockKind(note) }).toEqual({ note, kind });
  });
});

describe("buildRetro", () => {
  test("what happened: changes that reached main, finished, blocked (once per change) and closed in the window, and the median from accepted to merged", () => {
    const r = buildRetro(input({
      moves: [
        mv("old-one", ago(20), "draft", "accepted"), // accepted before the window
        mv("ancient", ago(10), "merge-approved", "merged"), // merged before the window
        mv("add-numbers", ago(6), "draft", "accepted"),
        mv("add-numbers", ago(6, 2), "accepted", "designing"),
        mv("fix-typo", ago(4), "accepted", "designing"), // written as accepted: the first move starts it
        mv("add-numbers", ago(5), "merge-approved", "merged"),
        mv("fix-typo", ago(4, 3), "merge-approved", "merged"),
        mv("add-numbers", ago(5, 1), "merged", "verifying"),
        mv("add-numbers", ago(5, 2), "verifying", "done"),
        ...blocks("tests", 2),
        mv("slow-one", ago(1), "blocked", "blocked", "a note rewritten"),
        mv("old-one", ago(2), "merge-approved", "merged"),
        mv("gone", ago(1), "spec-review", "closed"),
      ],
    }));
    expect(r.reached).toEqual(["add-numbers", "fix-typo", "old-one"]);
    expect(r.finished).toEqual(["add-numbers"]);
    expect(r.blocked).toEqual(["slow-one"]);
    expect(r.closed).toEqual(["gone"]);
    expect(r.merged).toBe(3);
    // 24 hours, 3 hours, 18 days: the median is 24 hours.
    expect(r.toMerged).toEqual({ changes: 3, medianMs: 24 * HOUR });
  });

  test("where changes blocked: grouped by kind, most common first (ties in the kinds' order), with the changes and other notes", () => {
    const r = buildRetro(input({
      moves: [
        ...blocks("tests", 2),
        mv("odd-one", ago(1), "merge-approved", "blocked", "The work for this change is missing. To build it again, set status to plan-approved."),
        ...blocks("timeout", 1, "x"),
        ...blocks("tests", 1, "other"),
      ],
    }));
    expect(r.blockGroups).toEqual([
      { kind: "tests", count: 3, slugs: [["slow-one", 2], ["other", 1]], notes: [] },
      { kind: "timeout", count: 1, slugs: [["x", 1]], notes: [] },
      { kind: "other", count: 1, slugs: [["odd-one", 1]], notes: [{ slug: "odd-one", note: "The work for this change is missing." }] },
    ]);
    expect(r.blocks.tests).toBe(3);
    expect(r.blocks.crash).toBe(0);
  });

  test("gates: runs and first-time passes per check, people's own checks left out, in the stages' order", () => {
    const r = buildRetro(input({
      gates: [
        gateRow("b", "review", "findings", "pass"),
        gateRow("a", "spec", "spec-check", "fail"),
        gateRow("a", "spec", "spec-check", "pass"),
        gateRow("b", "spec", "spec-check", "pass"),
        gateRow("a", "done", "human", "waiting"),
        gateRow("a", "merge", "pr-approved", "pass"),
        gateRow("a", "done", "done-check", "pass"),
      ],
    }));
    expect(r.gates).toEqual([
      { gate: "spec", check: "spec-check", runs: 3, passed: 2, changes: 2, firstTime: 1 },
      { gate: "review", check: "findings", runs: 1, passed: 1, changes: 1, firstTime: 1 },
      { gate: "done", check: "done-check", runs: 1, passed: 1, changes: 1, firstTime: 1 },
    ]);
  });

  test("spending: phase names folded to their kind, the five biggest, chat on its own, running phases' holds left out", () => {
    const r = buildRetro(input({
      phases: [
        phase("a", "build", 2), phase("a", "fix-1", 0.5), phase("a", "fix-2", 0.5), phase("a", "early-review", 0.25),
        phase("a", "review-1", 0.75), phase("a", "spec-check-cheap", 0.1), phase("a", "test-1", 0), phase("b", "build", 1),
        phase("b", "design", 0.05), phase("b", "plan", 0.04), phase("b", "intake", 0.01),
        phase("c", "build", 5, "running"), phase("_chat", "chat", 0.4),
      ],
    }));
    expect(r.spending.totalUsd).toBeCloseTo(5.2);
    expect(r.spentUsd).toBeCloseTo(5.2);
    expect(r.changesSpent).toBe(2); // c only holds part of a budget so far
    expect(r.spending.chatUsd).toBeCloseTo(0.4);
    expect(r.spending.kinds.map((k) => [k.kind, Number(k.usd.toFixed(2)), k.changes])).toEqual([
      ["build", 3, 2], ["fix", 1, 1], ["review", 1, 1], ["spec-check", 0.1, 1], ["design", 0.05, 1],
    ]);
    expect(r.judgesUsd).toBeCloseTo(1.1);
  });

  test("waiting for people: review statuses a person decides and questions, with the median wait; a wait still open counts until now", () => {
    const r = buildRetro(input({
      moves: [
        mv("a", ago(5), "reviewing", "merge-review", MERGE_WAIT_NOTE),
        mv("a", ago(5, 1), "merge-review", "merge-review", "the note rewritten"),
        mv("a", ago(5, 30), "merge-review", "merge-approved"),
        mv("b", ago(4), "reviewing", "merge-review", PR_CHECKS_NOTE), // waits for GitHub's checks, not a person
        mv("b", ago(4, 1), "merge-review", "merged"),
        mv("c", ago(2), "designing", "spec-review"), // still waiting: 2 days so far
        mv("d", ago(9), "designing", "spec-review"), // began before the window
        mv("d", ago(1), "spec-review", "spec-approved"),
        mv("e", ago(4), "building", "blocked"),
      ],
      questions: [ev("e", "question", ago(3), { question: "Which?" }), ev("f", "question", ago(3), { question: "Where?" }), ev("_chat", "question", ago(3), {})],
      requests: [
        ev("f", "request", ago(3, 1), { kind: "answer", result: "applied" }),
        ev("e", "request", ago(3, 2), { kind: "answer", result: "refused" }),
      ],
    }));
    expect(r.waits).toEqual([
      { at: "spec-review", waits: 1, open: 1, medianMs: 2 * DAY },
      { at: "merge-review", waits: 1, open: 0, medianMs: 30 * HOUR },
      // f answered after an hour; e's question waits until now (a refused answer, or a block before it, does not end it).
      { at: "question", waits: 2, open: 1, medianMs: (1 * HOUR + 3 * DAY) / 2 },
    ]);
  });

  test("a status move ends a question's wait", () => {
    const r = buildRetro(input({
      moves: [mv("e", ago(3, 3), "planning", "plan-review")],
      questions: [ev("e", "question", ago(3), { question: "Which?" })],
    }));
    expect(r.waits.find((w) => w.at === "question")).toEqual({ at: "question", waits: 1, open: 0, medianMs: 3 * HOUR });
  });

  test("an empty window, or one with only chat in it, is empty", () => {
    expect(buildRetro(input()).empty).toBe(true);
    expect(buildRetro(input({ phases: [phase("_chat", "chat", 1)], questions: [ev("_chat", "question", ago(1), {})] })).empty).toBe(true);
    expect(buildRetro(input({ phases: [phase("a", "build", 1, "success", ago(9))] })).empty).toBe(true);
    expect(buildRetro(input({ gates: [gateRow("a", "spec", "spec-check", "pass")] })).empty).toBe(false);
  });
});

describe("suggestions", () => {
  const facts = (over: Partial<RetroInput> = {}) => buildRetro(input(over));
  const say = (over: Partial<RetroInput> = {}) => suggestions(facts(over), over.cfg ?? cfgOf());

  test("none apply: none", () => {
    expect(say()).toEqual([]);
  });

  test("cheaper judges: shadow with a judge that earned first suggests first; not when it has not, or the setting is first", () => {
    const report = (cfg: Config, earned: string[]): JudgeReport => {
      const r = judgeReport(cfg, [], {});
      return { ...r, judges: r.judges.map((j) => ({ ...j, earned: earned.includes(j.judge) })) };
    };
    const shadow = cfgOf("speed:\n  cheap_judges: shadow\n");
    expect(say({ cfg: shadow, judges: report(shadow, ["spec-check", "review"]) })).toEqual([
      "The cheaper spec-check and review judges have earned going first (see loopstra judges): set speed.cheap_judges to first to spend less on judging.",
    ]);
    expect(say({ cfg: shadow, judges: report(shadow, ["review"]) })[0]).toStartWith("The cheaper review judge has earned going first");
    expect(say({ cfg: shadow, judges: report(shadow, []) })).toEqual([]);
    const first = cfgOf("speed:\n  cheap_judges: first\n");
    expect(say({ cfg: first, judges: report(first, ["review"]) })).toEqual([]);
  });

  test("cheaper judges: off, with judging at least 30% of the spending over at least 5 changes, suggests shadow", () => {
    const spend = (judging: number, changes = 5) => Array.from({ length: changes }, (_, i) => [phase(`c${i}`, "build", (10 - judging) / changes), phase(`c${i}`, "review-1", judging / changes)]).flat();
    expect(say({ phases: spend(3) })).toEqual([
      "Judging cost $3.00 of the $10.00 spent (30%) over 5 changes: set speed.cheap_judges to shadow to measure whether a cheaper model judges as well.",
    ]);
    expect(say({ phases: spend(2.9) })).toEqual([]);
    expect(say({ phases: spend(3, 4) })).toEqual([]);
    expect(say({ phases: spend(5), cfg: cfgOf("speed:\n  cheap_judges: shadow\n") })).toEqual([]);
  });

  test("fix loops: at least 2 blocks from failing tests suggest one more fix loop", () => {
    expect(say({ moves: blocks("tests", 2) })).toEqual([
      "2 blocks came from tests that kept failing: raise stages.build.max_fix_loops from 3 to 4, or write smaller changes.",
    ]);
    expect(say({ moves: blocks("tests", 1) })).toEqual([]);
  });

  test("timeouts: at least 2 suggest half as long again, rounded up to 5 minutes", () => {
    expect(say({ moves: blocks("timeout", 2) })).toEqual(["2 steps timed out: raise claude.timeout_minutes from 30 to 45, or write smaller changes."]);
    expect(say({ moves: blocks("timeout", 2), cfg: cfgOf("claude:\n  timeout_minutes: 45\n") })[0]).toContain("from 45 to 70");
    expect(say({ moves: blocks("timeout", 1) })).toEqual([]);
  });

  test("review rounds: at least 2 blocks from the reviewer suggest one more round", () => {
    expect(say({ moves: blocks("review", 2) })).toEqual([
      "2 blocks came from a reviewer that kept finding problems: raise stages.review.max_rounds from 2 to 3.",
    ]);
    expect(say({ moves: blocks("review", 1) })).toEqual([]);
  });

  test("spending limit: one block on the session's limit suggests raising it", () => {
    expect(say({ moves: blocks("budget", 1), cfg: cfgOf("claude:\n  max_budget_usd: 2.5\n") })).toEqual([
      "1 step hit the session spending limit of $2.50: raise claude.max_budget_usd with loopstra setup budgets.",
    ]);
    expect(say({ moves: blocks("budget", 2) })).toEqual([
      "2 steps hit the session spending limit: raise claude.max_budget_usd with loopstra setup budgets.",
    ]);
    expect(say()).toEqual([]);
  });

  test("risky changes: a merge with nobody on the gate and no risky files set suggests setting them", () => {
    const merged = [mv("a", ago(2), "merge-review", "merged")];
    expect(say({ moves: merged })).toEqual([
      "1 change merged with nobody looking, and no file is set to need a person: set gates.merge.risky.paths (loopstra setup github suggests some) so changes to CI, dependencies or migrations wait for a person.",
    ]);
    expect(say({ moves: merged, cfg: cfgOf("gates:\n  merge:\n    risky:\n      paths: [\".github/**\"]\n") })).toEqual([]);
    expect(say({ moves: merged, cfg: cfgOf("gates:\n  merge:\n    risky:\n      lines: 500\n") })).toEqual([]);
    expect(say({ moves: merged, cfg: cfgOf("gates:\n  merge:\n    human: status\n") })).toEqual([]);
  });

  test("waits: a person's gate with a median wait over a day, whose automatic checks all passed at least 5 times, may not need the person", () => {
    const merge = cfgOf("gates:\n  merge:\n    human: status\n");
    const waits = (hours: number) => [mv("a", ago(5), "reviewing", "merge-review", MERGE_WAIT_NOTE), mv("a", ago(5, hours), "merge-review", "merge-approved")];
    const checks = (n: number, last = "pass") => Array.from({ length: n }, (_, i) => gateRow(`c${i}`, "merge", "tests", i === n - 1 ? last : "pass"));
    expect(say({ cfg: merge, moves: waits(25), gates: checks(5) })).toEqual([
      "Changes waited 25 hours at the median in merge-review, and the merge gate's automatic checks passed all 5 times: the person on it may not be needed (gates.merge.human: none).",
    ]);
    expect(say({ cfg: merge, moves: waits(24), gates: checks(5) })).toEqual([]);
    expect(say({ cfg: merge, moves: waits(25), gates: checks(4) })).toEqual([]);
    expect(say({ cfg: merge, moves: waits(25), gates: checks(5, "fail") })).toEqual([]);
    // Nobody is on the gate now: nothing to take off.
    expect(say({ moves: waits(25), gates: checks(5) })).toEqual([]);
  });
});

describe("retroText", () => {
  test("every section, in plain lines", () => {
    const cfg = cfgOf("claude:\n  max_budget_usd: 2\n");
    const text = retroText(buildRetro(input({
      cfg,
      moves: [
        mv("add-numbers", ago(6), "draft", "accepted"),
        mv("add-numbers", ago(5), "merge-approved", "merged"),
        ...blocks("budget", 1, "slow-one"),
        mv("odd-one", ago(1), "merge-approved", "blocked", "The work for this change is missing. To build it again, set status to plan-approved."),
      ],
      gates: [gateRow("add-numbers", "spec", "spec-check", "fail"), gateRow("add-numbers", "spec", "spec-check", "pass")],
      phases: [phase("add-numbers", "build", 1.5), phase("slow-one", "fix-1", 0.5), phase("_chat", "chat", 0.25)],
      questions: [ev("add-numbers", "question", ago(6, 1), { question: "Which?" })],
      requests: [ev("add-numbers", "request", ago(6, 3), { kind: "answer", result: "applied" })],
    })));
    expect(text).toBe([
      "The last 7 days (since Oct 20).",
      "",
      "What happened",
      "- Reached main: 1 (add-numbers).",
      "- Finished: 0.",
      "- Blocked: 2 (slow-one and odd-one).",
      "- Closed: 0.",
      "- From accepted to merged: 24 hours at the median, over 1 change.",
      "",
      "Where changes blocked",
      "- Hit the spending limit: 1 (slow-one).",
      "- Other: 1 (odd-one).",
      "  - odd-one: The work for this change is missing.",
      "",
      "Gates",
      "- spec-check: ran 2 times; 0 of 1 change passed the first time.",
      "",
      "Spending",
      "- $2.00 in all, over 2 changes ($1.00 a change).",
      "- build: $1.50 (75%), $1.50 a change.",
      "- fix: $0.50 (25%), $0.50 a change.",
      "- Chat: $0.25, not counted above.",
      "",
      "Waiting for people",
      "- Questions: 1 wait, 2 hours at the median.",
      "",
      "Suggestions",
      "- 1 step hit the session spending limit of $2.00: raise claude.max_budget_usd with loopstra setup budgets.",
      "- 1 change merged with nobody looking, and no file is set to need a person: set gates.merge.risky.paths (loopstra setup github suggests some) so changes to CI, dependencies or migrations wait for a person.",
      "",
    ].join("\n"));
  });

  test("quiet sections say so, and no suggestions says why", () => {
    const text = retroText(buildRetro(input({ days: 1, gates: [gateRow("a", "merge", "pr-approved", "pass")] })));
    expect(text).toBe([
      "The last day (since Oct 26).",
      "",
      "What happened",
      "- Reached main: 0.",
      "- Finished: 0.",
      "- Blocked: 0.",
      "- Closed: 0.",
      "",
      "Where changes blocked",
      "- Nothing blocked.",
      "",
      "Gates",
      "- No automatic checks ran.",
      "",
      "Spending",
      "- Nothing was spent.",
      "",
      "Waiting for people",
      "- Nobody was waited for.",
      "",
      "Suggestions",
      "- No suggestions: nothing in the trace points at a setting to change.",
      "",
    ].join("\n"));
  });

  test("an empty window says nothing happened, then the suggestions", () => {
    expect(retroText(buildRetro(input()))).toBe("Nothing happened in the last 7 days.\n\nSuggestions\n- No suggestions: nothing in the trace points at a setting to change.\n");
    expect(retroText(buildRetro(input({ days: 1 })))).toStartWith("Nothing happened in the last day.\n");
  });

  test("long lists of changes are cut at five", () => {
    const moves = ["a", "b", "c", "d", "e", "f", "g"].map((s) => mv(s, ago(1), "closed", "closed")).concat(["a", "b", "c", "d", "e", "f", "g"].map((s) => mv(s, ago(1), "reviewing", "closed")));
    expect(retroText(buildRetro(input({ moves })))).toContain("\n- Closed: 7 (a, b, c, d, e and 2 more).\n");
  });
});

describe("loopstra retro on a trace", () => {
  async function setUp(root: string): Promise<void> {
    mkdirSync(join(root, "loopstra"), { recursive: true });
    await Bun.write(configPath(root), BASE);
  }

  test("a brand-new trace, and one with only chat in it, say nothing happened", async () => {
    const t = tempDir();
    try {
      await setUp(t.path);
      const empty = "Nothing happened in the last 7 days.\n\nSuggestions\n- No suggestions: nothing in the trace points at a setting to change.\n";
      expect(await renderRetro(t.path, 7)).toBe(empty);
      const trace = Trace.open(t.path);
      trace.phaseEnd("_chat", trace.phaseStart("_chat", "chat", "agent"), { status: "success", costUsd: 0.5 });
      trace.event("_chat", "question", { question: "?" });
      trace.close();
      expect(await renderRetro(t.path, 7)).toBe(empty);
    } finally { t.cleanup(); }
  });

  test("reads the window's rows from the trace, leaving older ones out", async () => {
    const t = tempDir();
    try {
      await setUp(t.path);
      const trace = Trace.open(t.path);
      trace.statusChange("old", "draft", "accepted");
      trace.statusChange("add-numbers", "draft", "accepted");
      trace.statusChange("add-numbers", "merge-approved", "merged");
      trace.statusChange("old", "merge-approved", "merged");
      trace.gate("add-numbers", "spec", "spec-check", "pass", "ok");
      trace.phaseEnd("add-numbers", trace.phaseStart("add-numbers", "build", "agent"), { status: "success", costUsd: 1 });
      trace.close();
      const db = new Database(join(t.path, ".loopstra", "trace.db"));
      const old = new Date(Date.now() - 30 * DAY).toISOString();
      db.run("UPDATE events SET ts = ? WHERE slug = 'old' AND payload LIKE '%merged%'", [old]);
      db.close();
      const text = await renderRetro(t.path, 3);
      expect(text).toStartWith("The last 3 days (since ");
      expect(text).toContain("\n- Reached main: 1 (add-numbers).\n");
      expect(text).toContain("\n- spec-check: ran 1 time; 1 of 1 change passed the first time.\n");
      expect(text).toContain("\n- $1.00 in all, over 1 change ($1.00 a change).\n");
    } finally { t.cleanup(); }
  });
});
