import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { validateConfig } from "../../src/config";
import type { Envelope } from "../../src/envelopes";
import { contradicts, FIRST_NEEDS, firstStanding, judgeReport, passes, standingWhy, type JudgeKey } from "../../src/judges";
import type { JudgeRow } from "../../src/trace";

const spec = (approved: boolean, met: boolean[]): Envelope<"spec-check"> =>
  ({ status: "success", summary: "s", approved, findings: met.map((m, i) => ({ requirement: `r${i}`, met: m, evidence: "e" })) });
const challenge = (approved: boolean, blocking: boolean[]): Envelope<"plan-challenge"> =>
  ({ status: "success", summary: "s", approved, concerns: blocking.map((b, i) => ({ concern: `c${i}`, blocking: b })) });
const review = (approved: boolean, severities: Array<"important" | "nit">): Envelope<"review"> =>
  ({ status: "success", summary: "s", approved, review_markdown: "# Review", findings: severities.map((s, i) => ({ severity: s, file: "a.ts", line: i, finding: "f" })) });

describe("passes and contradicts: the gate's own rule, and a pass that contradicts itself", () => {
  const cases: Array<[string, () => boolean, () => boolean, boolean, boolean]> = [
    ["spec-check approved, every finding met", () => passes("spec-check", spec(true, [true])), () => contradicts("spec-check", spec(true, [true])), true, false],
    ["spec-check not approved, every finding met", () => passes("spec-check", spec(false, [true, true])), () => contradicts("spec-check", spec(false, [true, true])), false, false],
    ["spec-check approved with an unmet finding", () => passes("spec-check", spec(true, [true, false])), () => contradicts("spec-check", spec(true, [true, false])), true, true],
    ["plan-challenge approved with non-blocking concerns", () => passes("plan-challenge", challenge(true, [false, false])), () => contradicts("plan-challenge", challenge(true, [false])), true, false],
    ["plan-challenge approved with a blocking concern", () => passes("plan-challenge", challenge(true, [true])), () => contradicts("plan-challenge", challenge(true, [true])), true, true],
    ["plan-challenge not approved", () => passes("plan-challenge", challenge(false, [true])), () => contradicts("plan-challenge", challenge(false, [true])), false, false],
    ["review approved with one important finding", () => passes("review", review(true, ["important"])), () => contradicts("review", review(true, ["important"])), false, false],
    ["review approved with only nits", () => passes("review", review(true, ["nit"])), () => contradicts("review", review(true, ["nit"])), true, false],
    ["review not approved with only nits (the runtime's rule)", () => passes("review", review(false, ["nit"])), () => contradicts("review", review(false, ["nit"])), true, true],
  ];
  for (const [what, pass, unsure, expectPass, expectUnsure] of cases) {
    test(what, () => {
      expect(pass()).toBe(expectPass);
      expect(unsure()).toBe(expectUnsure);
    });
  }
});

const KEY: JudgeKey = { judge: "review", cheap_model: "sonnet", strong_model: "opus", template_sha: "t1" };

/** Judges rows, oldest first, with ids and days in that order. */
function rows(...over: Array<Partial<JudgeRow>>): JudgeRow[] {
  return over.map((o, i) => ({
    id: i + 1, slug: "add-numbers", judge: "review", trace_name: "review-1", ts: new Date(2026, 9, 1, 12, i).toISOString(),
    mode: "shadow", how: "shadow", cheap_model: "sonnet", strong_model: "opus", template_sha: "t1", prompt_sha: `p${i + 1}`,
    cheap: "reject", strong: "reject", cheap_usd: 0.1, strong_usd: 0.3, cheap_ms: 1000, strong_ms: 3000, ...o,
  }));
}
const caught = (n: number, o: Partial<JudgeRow> = {}) => Array.from({ length: n }, () => o);

describe("firstStanding", () => {
  test("29 caught strong rejections are not enough; 30 earn first", () => {
    const s29 = firstStanding(rows(...caught(29)), KEY);
    expect(s29).toMatchObject({ earned: false, caught: 29, miss: null });
    expect(standingWhy(s29)).toBe("the cheaper judge decides alone only after it has also rejected the last 30 things the strong judge rejected (29 so far)");
    expect(firstStanding(rows(...caught(30)), KEY)).toMatchObject({ earned: true, caught: FIRST_NEEDS });
  });

  test("an unsure verdict counts as caught", () => {
    expect(firstStanding(rows(...caught(30, { cheap: "unsure" })), KEY).earned).toBe(true);
  });

  test("rows with other models, another template, first-mode rows, a failed cheaper judge, or a strong pass do not count", () => {
    const ignored = [
      { cheap_model: "haiku" }, { strong_model: "opus-4" }, { template_sha: "t0" }, { judge: "spec-check" },
      { how: "alone" as const, strong: null }, { how: "escalated" as const }, { cheap: "failed" as const }, { strong: "pass" as const, cheap: "pass" as const },
      { strong: "failed" as const },
    ];
    const s = firstStanding(rows(...caught(29), ...ignored), KEY);
    expect(s).toMatchObject({ earned: false, caught: 29 });
  });

  test("rows asking the same prompt count once", () => {
    expect(firstStanding(rows(...caught(30, { prompt_sha: "same" })), KEY).caught).toBe(1);
    expect(firstStanding(rows(...caught(29), { prompt_sha: "p1" }), KEY).caught).toBe(29);
  });

  test("a miss is not hidden by a newer row that asked the same prompt and was caught", () => {
    const s = firstStanding(rows(...caught(30), { cheap: "pass", prompt_sha: "same", slug: "missed" }, { prompt_sha: "same" }), KEY);
    expect(s).toMatchObject({ earned: false, caught: 0 });
    expect(s.miss?.slug).toBe("missed");
  });

  test("a miss among the newest 30 loses first, with when and where; 30 newer caught earn it back", () => {
    const missed = rows(...caught(40), { cheap: "pass", slug: "add-numbers", ts: new Date(2026, 9, 14, 9).toISOString() }, ...caught(6));
    const s = firstStanding(missed, KEY);
    expect(s).toMatchObject({ earned: false, caught: 6 });
    expect(s.miss?.slug).toBe("add-numbers");
    expect(standingWhy(s)).toBe("it passed something the strong judge rejected on 14 Oct (add-numbers), so it needs 30 newer ones (6 so far)");
    expect(firstStanding(rows(...caught(40), { cheap: "pass" }, ...caught(30)), KEY).earned).toBe(true);
  });

  test("an audit is due after 4 first-mode rows since the newest shadow row", () => {
    const first = { how: "alone" as const, mode: "first" as const, strong: null, cheap: "pass" as const };
    expect(firstStanding(rows(...caught(30), first, first, first), KEY).auditDue).toBe(false);
    expect(firstStanding(rows(...caught(30), first, first, { ...first, how: "escalated", strong: "reject", cheap: "reject" }, first), KEY).auditDue).toBe(true);
    // The audit itself is a shadow row: the count starts again after it.
    expect(firstStanding(rows(...caught(30), first, first, first, first, { mode: "first" }), KEY).auditDue).toBe(false);
    // Another model's first-mode rows are not this judge's.
    expect(firstStanding(rows(...caught(30), ...caught(4, { ...first, cheap_model: "haiku" })), KEY).auditDue).toBe(false);
  });

  test("audited counts only audits, not the shadow calls that earn first back after a miss", () => {
    const first = { how: "alone" as const, mode: "first" as const, strong: null, cheap: "pass" as const };
    const audit = { mode: "first" as const, cheap: "pass" as const };
    const earningBack = caught(30, { mode: "first" as const });
    expect(firstStanding(rows(...caught(30), first, first, first, first, audit, ...earningBack), KEY)).toMatchObject({ earned: true, alone: 4, audited: 1 });
    expect(firstStanding(rows(...caught(30, { mode: "first" })), KEY).audited).toBe(0);
  });
});

describe("judgeReport", () => {
  const cfg = (yaml = "", setting = "shadow") => validateConfig(parse(`version: 1\ncommands:\n  test: echo ok\nspeed:\n  cheap_judges: ${setting}\n${yaml}`));
  const TEMPLATES = { "spec-check": "t1", "plan-challenge": "t1", review: "t1" } as const;

  test("counts comparisons where neither side failed, with hand-checked averages and what first would cost", () => {
    const seeded = rows(
      { judge: "spec-check", cheap: "pass", strong: "pass", cheap_usd: 0.1, strong_usd: 0.3 }, // agreed
      { judge: "spec-check", cheap: "reject", strong: "reject", cheap_usd: 0.1, strong_usd: 0.5 }, // agreed
      { judge: "spec-check", cheap: "unsure", strong: "reject", cheap_usd: 0.2, strong_usd: 0.4 }, // agreed, unsure
      { judge: "spec-check", cheap: "pass", strong: "reject", cheap_usd: 0.1, strong_usd: 0.6, slug: "other", trace_name: "spec-check" }, // false pass
      { judge: "spec-check", cheap: "reject", strong: "pass", cheap_usd: 0.1, strong_usd: 0.5 }, // false reject
      { judge: "spec-check", cheap: "failed", strong: "pass", cheap_usd: null, strong_usd: 0.3 }, // could not answer
      { judge: "spec-check", cheap: "pass", strong: "failed", cheap_usd: 0.1, strong_usd: null }, // left out
      { judge: "spec-check", how: "alone", mode: "first", cheap: "pass", strong: null, cheap_usd: 0.3, strong_usd: null },
      { judge: "spec-check", cheap_model: "haiku" }, // another model: not counted
      { judge: "review", template_sha: "t0" }, // an older prompt: not counted
    );
    const r = judgeReport(cfg(), seeded, TEMPLATES);
    expect(r).toMatchObject({ setting: "shadow", cheapModel: "sonnet", strongModel: "opus", notCounted: 2 });
    const sc = r.judges.find((j) => j.judge === "spec-check")!;
    expect(sc).toMatchObject({ why: null, compared: 5, agreed: 3, falsePasses: 1, falseRejects: 1, unsure: 1, couldNotAnswer: 1 });
    // Cheaper: 0.1, 0.1, 0.2, 0.1, 0.1, 0.1, 0.3 → 1.0 / 7. Strong: 0.3, 0.5, 0.4, 0.6, 0.5, 0.3 → 2.6 / 6.
    expect(sc.avgCheapUsd).toBeCloseTo(1.0 / 7);
    expect(sc.avgStrongUsd).toBeCloseTo(2.6 / 6);
    // Shadow rows with both costs: the cheaper judge always, the strong one when the cheaper did not pass.
    // (0.1) + (0.1 + 0.5) + (0.2 + 0.4) + (0.1) + (0.1 + 0.5) = 2.0, over strong 0.3 + 0.5 + 0.4 + 0.6 + 0.5 = 2.3.
    // The rows whose cheaper or strong judge failed have no cost on that side and are left out.
    expect(sc.firstWouldCost).toBeCloseTo(2.0 / 2.3);
    // The false pass is the newest strong rejection, so nothing newer was caught.
    expect(sc.goesFirst).toBe("no: missed one on 1 Oct (other); 0 of 30 caught since");
    expect(r.falsePasses.map((p) => `${p.slug} ${p.trace_name}`)).toEqual(["other spec-check"]);
    expect(r.judges.find((j) => j.judge === "plan-challenge")).toMatchObject({ compared: 0, avgCheapUsd: null, firstWouldCost: null });
  });

  test("Goes first? says how many rejections were caught, when the miss was, or how often it decided alone", () => {
    const report = (seeded: JudgeRow[], setting = "shadow") => judgeReport(cfg("", setting), seeded, TEMPLATES).judges.find((j) => j.judge === "review")!.goesFirst;
    expect(report(rows(...caught(3)))).toBe("not yet: 3 of 30 rejections caught");
    expect(report(rows({ cheap: "pass", ts: new Date(2026, 9, 14, 9).toISOString() }, ...caught(6)))).toBe("no: missed one on 14 Oct (add-numbers); 6 of 30 caught since");
    const alone = { how: "alone" as const, mode: "first" as const, cheap: "pass" as const, strong: null };
    expect(report(rows(...caught(30), alone, alone, { mode: "first" }, alone), "first")).toBe("yes (decided alone 3 times, audited 1)");
    expect(report(rows(...caught(30)))).toBe("it would: 30 of 30 rejections caught");
    expect(report(rows(...caught(3)), "off")).toBeNull();
  });

  test("a judge that cannot be compared says why in words", () => {
    const why = (yaml: string, judge = "review") => judgeReport(cfg(yaml), [], TEMPLATES).judges.find((j) => j.judge === judge)!.why;
    expect(why("stages:\n  review:\n    model: default\n")).toBe("review already runs on sonnet; there is nothing cheaper to compare");
    expect(why("claude:\n  models:\n    default: opus\n", "spec-check")).toBe("the cheaper and the strong model are both opus; there is nothing cheaper to compare");
    expect(why("claude:\n  max_budget_usd_per_day: 10\n")).toBe("with claude.max_budget_usd_per_day set and no claude.max_budget_usd, both judges never run at once; set a session limit");
    expect(why("gates:\n  plan:\n    agent: false\n", "plan-challenge")).toBe("the plan gate has no judge (gates.plan.agent is false)");
    expect(why("")).toBeNull();
  });
});
