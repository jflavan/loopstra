import { describe, expect, test } from "bun:test";
import { amountText, DefaultsPrompt, parseAmount, SetupStopped } from "../../src/setup/prompt";
import { scripted } from "../setup-helpers";

describe("amounts", () => {
  test("times at the rate, dollars as given, or none", () => {
    expect(parseAmount("30m", 0.2)).toBe(6);
    expect(parseAmount("45 min", 0.2)).toBe(9);
    expect(parseAmount("2h", 0.2)).toBe(24);
    expect(parseAmount("$6", 0.2)).toBe(6);
    expect(parseAmount("6.5", 0.2)).toBe(6.5);
    expect(parseAmount("None", 0.2)).toBe("none");
    for (const bad of ["", "0", "0m", "-3", "six", "$", "3 days"]) expect(parseAmount(bad, 0.2)).toBeNull();
  });

  test("are shown in dollars and minutes", () => {
    expect(amountText(9, 0.2)).toBe("$9.00 (about 45 min)");
    expect(amountText("none", 0.2)).toBe("no limit");
    expect(amountText(0.1, 0.2)).toBe("$0.10 (under 1 min)");
    expect(amountText(0.2, 0.2)).toBe("$0.20 (about 1 min)");
  });
});

describe("a prompt over streams", () => {
  test("Enter takes the suggestion; an answer replaces it", async () => {
    const { prompt, shown } = scripted("", "npm test");
    expect(await prompt.text("Test command", { suggestion: "bun test" })).toBe("bun test");
    expect(await prompt.text("Test command", { suggestion: "bun test" })).toBe("npm test");
    expect(shown()).toContain("Test command [bun test]: ");
  });

  test("an optional answer can be emptied with -", async () => {
    const { prompt } = scripted("-", "");
    expect(await prompt.text("Lint", { suggestion: "bun run lint", optional: true })).toBe("");
    expect(await prompt.text("Build", { optional: true })).toBe("");
  });

  test("- on a question that needs an answer is asked again", async () => {
    const { prompt, shown } = scripted("-", "");
    expect(await prompt.text("Test command", { suggestion: "bun test" })).toBe("bun test");
    expect(shown()).toContain("  An answer is needed.");
  });

  test("a bad answer is asked again, saying why", async () => {
    const { prompt, shown } = scripted("maybe", "y", "sometimes", "status", "soon", "1h", "bad name", "GOOD_NAME", "", "x");
    expect(await prompt.yesNo("Limits?", false)).toBe(true);
    expect(await prompt.pick("Gate", ["none", "status"] as const, "none")).toBe("status");
    expect(await prompt.amount("Session", { suggestion: "none", ratePerMinute: 0.2 })).toBe(12);
    expect(await prompt.text("Var", { check: (s) => (/^[A-Z_]+$/.test(s) ? null : "Use an environment variable name.") })).toBe("GOOD_NAME");
    expect(await prompt.text("Required")).toBe("x");
    expect(shown()).toContain("Answer y or n.");
    expect(shown()).toContain("Answer one of: none, status.");
    expect(shown()).toContain("Answer a time (30m, 2h), an amount ($6), or none.");
    expect(shown()).toContain("Use an environment variable name.");
    expect(shown()).toContain("An answer is needed.");
  });

  test("several choices: by name, separated by commas; - for none; Enter for the suggestion", async () => {
    const { prompt, shown } = scripted("Slack, terminal", "-", "", "teams");
    const places = ["terminal", "dashboard", "slack", "discord"] as const;
    expect(await prompt.pickMany("Where", places, ["terminal"])).toEqual(["terminal", "slack"]);
    expect(await prompt.pickMany("Where", places, ["terminal"])).toEqual([]);
    expect(await prompt.pickMany("Where", places, ["terminal"])).toEqual(["terminal"]);
    await expect(prompt.pickMany("Where", places, [])).rejects.toBeInstanceOf(SetupStopped);
    expect(shown()).toContain("Not a choice: teams.");
  });

  test("running out of input stops setup", async () => {
    const { prompt } = scripted();
    await expect(prompt.text("Anything")).rejects.toBeInstanceOf(SetupStopped);
  });
});

describe("--defaults", () => {
  test("every question takes its suggestion, without reading anything, and says what it took", async () => {
    const lines: string[] = [];
    const p = new DefaultsPrompt((l) => lines.push(l));
    expect(await p.yesNo("Limits?", false)).toBe(false);
    expect(await p.amount("Session", { suggestion: 9, ratePerMinute: 0.2 })).toBe(9);
    expect(await p.text("Lint", { optional: true })).toBe("");
    expect(await p.pick("Gate", ["none", "status"] as const, "none")).toBe("none");
    expect(await p.pickMany("Where", ["terminal", "dashboard"] as const, ["terminal"])).toEqual(["terminal"]);
    expect(lines).toEqual(["Limits?: no", "Session: $9.00 (about 45 min)", "Lint: (empty)", "Gate: none", "Where: terminal"]);
  });

  test("a question with nothing to suggest stops setup, naming it", async () => {
    const p = new DefaultsPrompt(() => {});
    await expect(p.text("Test command (commands.test)")).rejects.toThrow('--defaults has no answer for "Test command (commands.test)"');
  });
});
