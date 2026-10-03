import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { budgets } from "../../src/setup/sections/budgets";
import { askSection, checkSection, configRepo } from "../setup-helpers";

const BASE = "version: 1\ncommands:\n  test: echo ok\n";

describe("the budgets section", () => {
  test("no: every limit is removed, old defaults included", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 5\n  max_budget_usd_per_session: 2\n`);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["n"]);
      expect(text).not.toContain("max_budget_usd");
      expect(shown).toContain("claude.max_budget_usd: $5 (the old default; the default is now no limit)");
    } finally { r.cleanup(); }
  });

  test("--defaults removes the old template's values and keeps a limit someone chose", async () => {
    const r = configRepo(`${BASE}claude:\n  max_budget_usd: 5\nchat:\n  max_budget_usd_per_day: 20\n`);
    try {
      const yaml = parse((await askSection(budgets, r.root, "defaults")).text);
      expect(yaml.claude?.max_budget_usd).toBeUndefined();
      expect(yaml.chat.max_budget_usd_per_day).toBe(20);
    } finally { r.cleanup(); }
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
      expect(shown).toContain("Suggested: 45m ($9.00)");
    } finally { r.cleanup(); }
  });

  test("a bad rate is asked again; $ in front of a rate is fine", async () => {
    const r = configRepo(BASE);
    try {
      const { text, shown } = await askSection(budgets, r.root, ["y", "abc", "$0.3", "45m", "none", "none", "none"]);
      expect(shown).toContain("$0.20 a minute (about $2 per 10 minutes)");
      expect(shown).toContain("Answer a number of dollars");
      expect(shown).toContain("Suggested: 45m ($13.50)");
      expect(parse(text).claude).toEqual({ max_budget_usd: 13.5 });
      expect(parse(text).chat).toBeUndefined();
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
});
