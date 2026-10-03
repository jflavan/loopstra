import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { parse } from "yaml";
import { NOT_SET_UP } from "../../src/config";
import { NEEDS_TERMINAL, parseSetupArgs, setup } from "../../src/setup";
import { DefaultsPrompt } from "../../src/setup/prompt";
import { gates } from "../../src/setup/sections/gates";
import type { Check, Section, SetupContext } from "../../src/setup/types";
import { tempDir } from "../helpers";
import { configRepo } from "../setup-helpers";

function io(...answers: string[]) {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  return { input: Readable.from(answers.map((a) => `${a}\n`)), output, text: () => text };
}

const CONFIG = "version: 1\ncommands:\n  test: echo ok\n";

/** A section that asks for the test command and sets it, and reports `checks`. */
function fake(o: { name?: string; covers?: string[]; checks?: Check[]; ask?: (ctx: SetupContext) => Promise<void>; check?: () => Promise<Check[]> } = {}): Section {
  return {
    name: o.name ?? "fake",
    title: `The ${o.name ?? "fake"} section`,
    covers: o.covers ?? ["commands"],
    ask: o.ask ?? (async (ctx) => { ctx.doc.set(["commands", "test"], await ctx.ask.text("Test command", { suggestion: "echo ok" })); }),
    check: o.check ?? (async () => o.checks ?? []),
  };
}

describe("loopstra setup", () => {
  test("outside a set-up folder, it says so", async () => {
    const t = tempDir();
    try {
      const o = io();
      expect(await setup(t.path, { output: o.output, defaults: true })).toBe(1);
      expect(o.text()).toContain(NOT_SET_UP);
    } finally { t.cleanup(); }
  });

  test("without a terminal and without --defaults or --check, it refuses and writes nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, interactive: false, sections: [fake()] })).toBe(1);
      expect(o.text()).toContain(NEEDS_TERMINAL);
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("an unknown section is named, with the ones there are", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, section: "nope", defaults: true, sections: [fake({ name: "one" }), fake({ name: "two" })] })).toBe(1);
      expect(o.text()).toContain("There is no setup section called nope. Sections: one, two.");
    } finally { r.cleanup(); }
  });

  test("an unchanged answer says No changes; a new one is saved", async () => {
    const r = configRepo(CONFIG);
    try {
      const same = io("");
      expect(await setup(r.root, { input: same.input, output: same.output, interactive: true, sections: [fake()] })).toBe(0);
      expect(same.text()).toContain("No changes.");
      expect(r.text()).toBe(CONFIG);
      const changed = io("bun test");
      expect(await setup(r.root, { input: changed.input, output: changed.output, interactive: true, sections: [fake()] })).toBe(0);
      expect(changed.text()).toContain("Saved loopstra/config.yaml.");
      expect(r.text()).toBe("version: 1\ncommands:\n  test: bun test\n");
    } finally { r.cleanup(); }
  });

  test("an answer that makes the config invalid is not saved", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const bad = fake({ ask: async (ctx) => { ctx.doc.set(["claude", "timeout_minutes"], -1); } });
      expect(await setup(r.root, { output: o.output, defaults: true, sections: [bad] })).toBe(1);
      expect(o.text()).toContain("Not saved: ");
      expect(o.text()).toContain("claude.timeout_minutes");
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("a section that throws saves nothing and says why, without a stack", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const broken = fake({ ask: async (ctx) => { ctx.doc.set(["commands", "test"], "bun test"); throw new Error("the section broke"); } });
      expect(await setup(r.root, { output: o.output, defaults: true, sections: [broken] })).toBe(1);
      expect(o.text()).toContain("Not saved: the section broke");
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("a config with problems now gets a heads-up, and the questions go on", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: ''\n");
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, defaults: true, sections: [fake()] })).toBe(0);
      expect(o.text()).toContain("Note: loopstra/config.yaml has problems now; the questions below can fix them:\n- commands.test is required: the single command that runs your tests\n");
      expect(o.text()).not.toContain("loopstra/config.yaml has problems:");
      expect(parse(r.text()).commands.test).toBe("echo ok");
    } finally { r.cleanup(); }
  });

  test("a problem the sections being run do not ask about: says to fix it first, asks nothing, saves nothing", async () => {
    for (const yaml of [`${CONFIG}claude:\n  timeout_minutes: -1\n`, `${CONFIG}gates:\n  intent: { human: none }\n`]) {
      const r = configRepo(yaml);
      try {
        const o = io();
        let asked = false;
        const section = fake({ covers: ["commands", "gates"], ask: async () => { asked = true; } });
        expect(await setup(r.root, { output: o.output, defaults: true, sections: [section] })).toBe(1);
        expect(o.text()).toContain("Fix these in loopstra/config.yaml first:\n- ");
        expect(o.text()).toContain(yaml.includes("intent") ? "gates.intent: remove this line" : "claude.timeout_minutes");
        expect(o.text()).not.toContain("the questions below can fix them");
        expect(asked).toBe(false);
        expect(r.text()).toBe(yaml);
      } finally { r.cleanup(); }
    }
  });

  test("gates: none is replaced by the gates questions, even when every answer is the default", async () => {
    const r = configRepo(`${CONFIG}gates: none\n`);
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, defaults: true, sections: [gates] })).toBe(0);
      expect(o.text()).toContain("the questions below can fix them");
      expect(o.text()).toContain("Saved loopstra/config.yaml.");
      expect(parse(r.text()).gates).toEqual({ spec: { human: "none" } });
    } finally { r.cleanup(); }
  });

  test("the checks are listed after saving, with how many are left to fix", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const checks: Check[] = [{ level: "ok", text: "fine" }, { level: "warn", text: "hmm" }, { level: "fail", text: "broken" }];
      expect(await setup(r.root, { output: o.output, defaults: true, sections: [fake({ checks })] })).toBe(0);
      expect(o.text()).toContain("Checks:\n  ok    fine\n  warn  hmm\n  FAIL  broken\n");
      expect(o.text()).toContain("To fix: 2 items above. Run loopstra setup fake again once fixed, or loopstra setup --check.");
    } finally { r.cleanup(); }
  });

  test("To fix names the sections whose checks are not ok", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const sections = [
        fake({ name: "one", checks: [{ level: "warn", text: "hmm" }] }),
        fake({ name: "two", checks: [{ level: "ok", text: "fine" }] }),
        fake({ name: "three", checks: [{ level: "fail", text: "broken" }, { level: "fail", text: "also broken" }] }),
      ];
      expect(await setup(r.root, { output: o.output, check: true, sections })).toBe(1);
      expect(o.text()).toContain("To fix: 3 items above. Run loopstra setup one or loopstra setup three again once fixed, or loopstra setup --check.");
    } finally { r.cleanup(); }
  });

  test("the sections' checks run at the same time, and are listed in section order", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      let secondStarted!: () => void;
      const started = new Promise<void>((resolve) => { secondStarted = resolve; });
      const first = fake({ name: "first", check: async () => { await started; return [{ level: "ok", text: "first" }]; } });
      const second = fake({ name: "second", check: async () => { secondStarted(); return [{ level: "ok", text: "second" }]; } });
      expect(await setup(r.root, { output: o.output, check: true, sections: [first, second], checkMs: 2000 })).toBe(0);
      expect(o.text()).toContain("Checks:\n  ok    first\n  ok    second\n");
    } finally { r.cleanup(); }
  });

  test("a check that does not finish in time fails, naming its section", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const slow = fake({ check: () => new Promise<Check[]>(() => {}) });
      expect(await setup(r.root, { output: o.output, check: true, sections: [slow], checkMs: 50 })).toBe(1);
      expect(o.text()).toContain("FAIL  The fake section: the check did not finish in 0 seconds");
    } finally { r.cleanup(); }
  });

  test("--check fails only when a check fails, and says the config loads", async () => {
    const r = configRepo(CONFIG);
    try {
      const warn = io();
      expect(await setup(r.root, { output: warn.output, check: true, sections: [fake({ checks: [{ level: "warn", text: "hmm" }] })] })).toBe(0);
      expect(warn.text()).toStartWith("loopstra/config.yaml loads.\n");
      const fail = io();
      expect(await setup(r.root, { output: fail.output, check: true, sections: [fake({ checks: [{ level: "fail", text: "broken" }] })] })).toBe(1);
      expect(fail.text()).toContain("FAIL  broken");
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });

  test("--check with a config that does not load reports why and fails", async () => {
    const r = configRepo("version: 1\ncommands:\n  test: echo ok\nclaude:\n  timeout_minutes: -1\n");
    try {
      const o = io();
      expect(await setup(r.root, { output: o.output, check: true, sections: [fake()] })).toBe(1);
      expect(o.text()).toContain("claude.timeout_minutes");
      expect(o.text()).not.toContain("loads.");
    } finally { r.cleanup(); }
  });

  test("a prompt it is given is closed on every early return", async () => {
    class Counted extends DefaultsPrompt {
      closes = 0;
      override close(): void { this.closes++; }
    }
    const t = tempDir();
    const r = configRepo(CONFIG);
    const bad = configRepo("version: [\n");
    try {
      const cases: Array<[string, string, Parameters<typeof setup>[1]]> = [
        ["config missing", t.path, { interactive: true }],
        ["config not YAML", bad.root, { interactive: true }],
        ["unknown section", r.root, { interactive: true, section: "nope", sections: [fake()] }],
        ["no terminal", r.root, { interactive: false, sections: [fake()] }],
        ["--check", r.root, { check: true, sections: [fake()] }],
      ];
      for (const [what, root, opts] of cases) {
        const prompt = new Counted(() => {});
        expect(await setup(root, { ...opts, output: io().output, prompt })).toBeGreaterThanOrEqual(0);
        expect({ what, closes: prompt.closes }).toEqual({ what, closes: 1 });
      }
    } finally { t.cleanup(); r.cleanup(); bad.cleanup(); }
  });

  test("input that runs out stops setup and saves nothing", async () => {
    const r = configRepo(CONFIG);
    try {
      const o = io();
      const first = fake({ ask: async (ctx) => { ctx.doc.set(["commands", "lint"], "eslint"); } });
      expect(await setup(r.root, { input: o.input, output: o.output, interactive: true, sections: [first, fake()] })).toBe(1);
      expect(o.text()).toContain("Setup stopped; nothing was saved.");
      expect(r.text()).toBe(CONFIG);
    } finally { r.cleanup(); }
  });
});

describe("the setup command line", () => {
  test("takes at most one section, and --defaults or --check but not both", () => {
    expect(parseSetupArgs([])).toEqual({ section: undefined, defaults: false, check: false });
    expect(parseSetupArgs(["budgets", "--defaults"])).toEqual({ section: "budgets", defaults: true, check: false });
    expect(parseSetupArgs(["--check"])).toEqual({ section: undefined, defaults: false, check: true });
    for (const bad of [["budgets", "chat"], ["--defaults", "--check"], ["--force"], ["-d"]]) expect(parseSetupArgs(bad)).toBeNull();
  });
});
