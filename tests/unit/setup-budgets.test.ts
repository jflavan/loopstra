import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { loadConfig } from "../../src/config";
import { ConfigDocument } from "../../src/setup/document";
import { budgets } from "../../src/setup/sections/budgets";
import { askSection, checkSection, configRepo, scripted } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

describe("the budgets section", () => {
  test("no: every limit is removed, old defaults included", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 5\n  max_budget_usd_per_session: 2\n`);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["n"]);
      expect(text).not.toContain("max_budget_usd");
      expect(shown).toContain("claude.max_budget_usd: $5.00 (the old default; the default is now no limit)");
    } finally { r.cleanup(); }
  });

  test("--defaults removes the old template's values when nothing else is set", async () => {
    for (const old of [`claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 5\n  max_budget_usd_per_session: 2\n`, `claude:\n  max_budget_usd: 5\n`]) {
      const r = configRepo(`${BASE}${old}`);
      try {
        expect((await askSection(budgets, r.root, "defaults")).text).toBe(BASE);
      } finally { r.cleanup(); }
    }
  });

  test("with any other limit set, or a loop day limit, every limit there counts as chosen and --defaults keeps it", async () => {
    for (const chosen of [
      `claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 20\n`,
      `claude:\n  max_budget_usd: 5\n  max_budget_usd_per_day: 30\n`,
      `claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_session: 3\n`,
    ]) {
      const r = configRepo(`${BASE}${chosen}`);
      try {
        const { text, shown } = await askSection(budgets, r.root, "defaults");
        expect(text).toBe(`${BASE}${chosen}`);
        expect(shown).toContain("claude.max_budget_usd: $5.00\n");
        expect(shown).not.toContain("the old default");
        // Nobody is typing under --defaults.
        expect(shown).toContain("Minutes are turned into dollars at $0.20 a minute (about $2.00 per 10 minutes): 0.2\n");
        expect(shown).not.toContain("press Enter");
      } finally { r.cleanup(); }
    }
  });

  test("--defaults on a config with no limits adds none", async () => {
    const r = configRepo(BASE);
    try {
      expect((await askSection(budgets, r.root, "defaults")).text).toBe(BASE);
    } finally { r.cleanup(); }
  });

  test("yes: each limit in minutes or dollars, at the rate given", async () => {
    const r = configRepo(BASE);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["y", "", "45m", "none", "$4", "3h"]);
      const yaml = parse(text);
      expect(yaml.claude).toEqual({ max_budget_usd: 9 });
      expect(yaml.chat).toEqual({ max_budget_usd_per_session: 4, max_budget_usd_per_day: 36 });
      // The suggestion for a loop session follows timeout_minutes (30 by default): 45 minutes.
      expect(shown).toContain("What may one loop session spend? Suggested: 45m ($9.00). Enter keeps: no limit.");
    } finally { r.cleanup(); }
  });

  test("a bad rate is asked again; $ in front of a rate is fine", async () => {
    const r = configRepo(BASE);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["y", "abc", "$0.3", "45m", "none", "none", "none"]);
      expect(shown).toContain("$0.20 a minute (about $2.00 per 10 minutes)");
      expect(shown).toContain("Answer a number of dollars");
      expect(shown).toContain("Suggested: 45m ($13.50)");
      expect(parse(text).claude).toEqual({ max_budget_usd: 13.5 });
      expect(parse(text).chat).toBeUndefined();
    } finally { r.cleanup(); }
  });

  test("yes: each question says what Enter keeps, a chosen limit or no limit", async () => {
    const r = configRepo(`${BASE}chat:\n  max_budget_usd_per_day: 20\n`);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["y", "", "", "", "", ""]);
      expect(shown).toContain("What may chat spend in a day, everyone together? Suggested: 3h ($36.00). Enter keeps: $20.00 (about 100 min).");
      expect(shown).toContain("What may one chat turn or write-up spend? Suggested: 20m ($4.00). Enter keeps: no limit.");
      expect(text).toBe(`${BASE}chat:\n  max_budget_usd_per_day: 20\n`);
    } finally { r.cleanup(); }
  });

  test("yes, then Enter on every old-template value, ends with no limits", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 5\n  max_budget_usd_per_session: 2\n`);
    try {
      const { text } = await askSection(budgets, r.root, ["y", "", "", "", "", ""]);
      expect(text).toBe(BASE);
    } finally { r.cleanup(); }
  });

  test("a session limit shorter than the timeout is a warning", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\n`);
    try {
      const [c] = await checkSection(budgets, r.root);
      expect(c!.level).toBe("warn");
      expect(c!.text).toContain("runs out before claude.timeout_minutes (30 min, about $6.00 at $0.20 a minute)");
    } finally { r.cleanup(); }
    const none = configRepo(BASE);
    try {
      expect(await checkSection(budgets, none.root)).toEqual([{ level: "ok", text: "Budgets: no limits." }]);
    } finally { none.cleanup(); }
  });

  test("the check uses the rate given in this run, and says it", async () => {
    const r = configRepo(BASE);
    try {
      const doc = ConfigDocument.load(r.root);
      const s = scripted("y", "0.1", "$2", "none", "none", "none");
      const ctx = { root: r.root, doc, ask: s.prompt, env: {} };
      try { await budgets.ask(ctx); } finally { s.prompt.close(); }
      doc.save();
      const [c] = await budgets.check(ctx, await loadConfig(r.root));
      expect(c).toEqual({ level: "warn", text: "claude.max_budget_usd ($2.00) runs out before claude.timeout_minutes (30 min, about $3.00 at $0.10 a minute): a long step stops on the budget first. Raise or remove it with loopstra setup budgets." });
    } finally { r.cleanup(); }
  });

  test("limits that do not fit together are warnings", async () => {
    const r = configRepo(`${BASE}claude:\n  timeout_minutes: 10\n  max_budget_usd: 10\n  max_budget_usd_per_day: 4.5\nchat:\n  max_budget_usd_per_session: 4\n  max_budget_usd_per_day: 3\n`);
    try {
      expect(await checkSection(budgets, r.root)).toEqual([
        { level: "warn", text: "claude.max_budget_usd ($10.00) is above claude.max_budget_usd_per_day ($4.50): the day's limit stops a session first." },
        { level: "warn", text: "chat.max_budget_usd_per_session ($4.00) is above chat.max_budget_usd_per_day ($3.00): the day's limit stops a conversation first." },
      ]);
    } finally { r.cleanup(); }
    const alone = configRepo(`${BASE}chat:\n  max_budget_usd_per_day: 20\n`);
    try {
      expect(await checkSection(budgets, alone.root)).toEqual([
        { level: "warn", text: "chat.max_budget_usd_per_day ($20.00) is set without chat.max_budget_usd_per_session: one conversation holds the rest of the day while it answers; set chat.max_budget_usd_per_session so others can run at the same time." },
      ]);
    } finally { alone.cleanup(); }
  });
});
