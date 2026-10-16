import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderJudges } from "../../src/commands/judges";
import { configPath } from "../../src/config";
import { templateSha } from "../../src/judges";
import { Trace, type NewJudgeRow } from "../../src/trace";
import { tempDir } from "../helpers";

/** A set-up folder with the three judge prompts, so each has a template sha. */
async function setUp(root: string, extra = ""): Promise<void> {
  mkdirSync(join(root, "loopstra", "prompts"), { recursive: true });
  await Bun.write(configPath(root), `version: 1\ncommands:\n  test: echo ok\n${extra}`);
  for (const judge of ["spec-check", "plan-challenge", "review"]) await Bun.write(join(root, "loopstra", "prompts", `${judge}.md`), `${judge} prompt`);
}

/** Writes judges rows, with each row's day set by hand (the trace stamps the real clock). */
function seed(root: string, rows: Array<Partial<NewJudgeRow> & { slug?: string; ts?: string }>): void {
  const trace = Trace.open(root);
  try {
    rows.forEach((o, i) => {
      const judge = (o.judge ?? "spec-check") as "spec-check" | "plan-challenge" | "review";
      trace.judge(o.slug ?? "add-numbers", {
        judge, trace_name: judge, mode: "shadow", how: "shadow", cheap_model: "sonnet", strong_model: "opus",
        template_sha: templateSha(root, judge)!, prompt_sha: `p${i}`, cheap: "reject", strong: "reject",
        cheap_usd: 0.1, strong_usd: 0.3, cheap_ms: 2000, strong_ms: 6000, ...o,
      });
    });
  } finally {
    trace.close();
  }
  const db = new Database(join(root, ".loopstra", "trace.db"));
  try {
    rows.forEach((o, i) => db.run("UPDATE judges SET ts = ? WHERE id = ?", [o.ts ?? new Date(2026, 9, 1, 12).toISOString(), i + 1]));
  } finally {
    db.close();
  }
}

/** The table's cells: the columns are at least two spaces apart, and no cell holds two spaces. */
function cells(text: string, first: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith(`${first} `) || l === first)!;
  return line.trim().split(/\s{2,}/);
}

describe("loopstra judges", () => {
  test("a table per judge from the comparisons with today's models and prompts, what the cheaper judges cost, and the false passes", async () => {
    const t = tempDir();
    try {
      await setUp(t.path, "speed:\n  cheap_judges: shadow\n");
      seed(t.path, [
        { judge: "spec-check", cheap: "pass", strong: "pass", strong_usd: 0.3 },
        { judge: "spec-check", cheap: "reject", strong: "reject", strong_usd: 0.5 },
        { judge: "spec-check", cheap: "pass", strong: "reject", strong_usd: 0.4, slug: "other", ts: new Date(2026, 9, 14, 9).toISOString() },
        { judge: "plan-challenge" }, { judge: "plan-challenge" }, { judge: "plan-challenge" },
        { judge: "review", template_sha: "an older prompt" },
      ]);
      const trace = Trace.open(t.path);
      for (const [name, cost] of [["spec-check-cheap", 0.25], ["review-1-cheap", 0.5], ["review-1", 1]] as const) {
        trace.phaseEnd("add-numbers", trace.phaseStart("add-numbers", name, name.endsWith("-cheap") ? "cheap-judge" : "agent"), { status: "success", costUsd: cost });
      }
      trace.close();

      const text = await renderJudges(t.path);
      expect(text.split("\n")[0]).toBe("Cheaper judges: shadow (sonnet beside opus). Only comparisons with these two models and the current prompts count.");
      expect(cells(text, "Judge")).toEqual(["Judge", "Compared", "Agreed", "Passed what opus rejected", "Rejected what opus passed", "Unsure", "Could not answer",
        "Avg cost (sonnet / opus)", "Avg time (sonnet / opus)", "First would cost", "Goes first?"]);
      // spec-check: first would cost (0.1) + (0.1 + 0.5) + (0.1) = 0.8 against 0.3 + 0.5 + 0.4 = 1.2.
      expect(cells(text, "spec-check")).toEqual(["spec-check", "3", "2", "1", "0", "0", "0", "$0.10 / $0.40", "2s / 6s", "67%", "no: missed one on 14 Oct (other); 0 of 30 caught since"]);
      expect(cells(text, "plan-challenge")).toEqual(["plan-challenge", "3", "3", "0", "0", "0", "0", "$0.10 / $0.30", "2s / 6s", "133%", "not yet: 3 of 30 rejections caught"]);
      expect(cells(text, "review")).toEqual(["review", "0", "0", "0", "0", "0", "0", "-", "-", "-", "not yet: 0 of 30 rejections caught"]);
      expect(text).toContain("\nSpent on cheaper judges so far: $0.75. 1 older comparison with other models or prompts is not counted.\n");
      expect(text).toEndWith("\nPassed what the strong judge rejected (newest first):\n- 14 Oct, other, spec-check: opus rejected, sonnet passed.\n");
    } finally {
      t.cleanup();
    }
  });

  test("first says the cheaper judge goes before the strong one; off leaves out Goes first?", async () => {
    const t = tempDir();
    try {
      await setUp(t.path, "speed:\n  cheap_judges: first\n");
      seed(t.path, [{ judge: "review" }]);
      const first = await renderJudges(t.path);
      expect(first.split("\n")[0]).toStartWith("Cheaper judges: first (sonnet before opus).");
      expect(cells(first, "review").at(-1)).toBe("not yet: 1 of 30 rejections caught");

      await setUp(t.path, "speed:\n  cheap_judges: off\n");
      const off = await renderJudges(t.path);
      expect(off.split("\n")[0]).toStartWith("Cheaper judges: off (sonnet is not asked).");
      expect(cells(off, "Judge").at(-1)).toBe("First would cost");
      expect(off).not.toContain("Passed what the strong judge rejected");
    } finally {
      t.cleanup();
    }
  });

  test("a judge that cannot be compared says why, in words", async () => {
    const t = tempDir();
    try {
      await setUp(t.path, "speed:\n  cheap_judges: shadow\nstages:\n  review:\n    model: default\nclaude:\n  max_budget_usd_per_day: 10\n");
      seed(t.path, [{ judge: "spec-check" }]);
      const text = await renderJudges(t.path);
      expect(cells(text, "review").at(-1)).toBe("not compared (see below)");
      expect(text).toContain("\nNot compared:\n"
        + "- with claude.max_budget_usd_per_day set and no claude.max_budget_usd, both judges never run at once; set a session limit\n"
        + "- review already runs on sonnet; there is nothing cheaper to compare\n");
    } finally {
      t.cleanup();
    }
  });

  test("with no comparisons yet, it says how to start measuring", async () => {
    const t = tempDir();
    try {
      await setUp(t.path);
      expect(await renderJudges(t.path)).toBe("Cheaper judges: off (sonnet is not asked).\nNo comparisons yet. Set speed.cheap_judges to shadow to start measuring.\n");
      await setUp(t.path, "speed:\n  cheap_judges: shadow\n");
      expect(await renderJudges(t.path)).toBe("Cheaper judges: shadow (sonnet beside opus).\nNo comparisons yet.\n");
    } finally {
      t.cleanup();
    }
  });
});
