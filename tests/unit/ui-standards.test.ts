import { describe, expect, test } from "bun:test";
import type { DraftCheck, ExceptionRow, StandardForm } from "../../src/console/types";
import { parseRoute, routePath } from "../../src/ui/router";
import { canSave, EXAMPLES, fieldProblems, filterExceptions, isStandardName, opensAsMarkdown, removeText, saveNotice, scopeLine, takenNames } from "../../src/ui/standards";
import { formToMarkdown, parseStandard, RULE_LABEL, STANDARD_NAME } from "../../src/standards";

const form = (over: Partial<StandardForm> = {}): StandardForm => ({
  name: "architecture", title: "Architecture", patterns: [], needsPerson: false, check: "", context: "",
  rules: [{ label: "ARCH-1", text: "Services talk over HTTP." }, { label: "ARCH-2", text: "Data goes through the repository layer." }],
  ...over,
});
const PATH = "loopstra/standards/architecture.md";
const clean: DraftCheck = { problems: [], matches: [] };

describe("the standard editor's field problems", () => {
  test("a well-formed form has none", () => {
    expect(fieldProblems(form(), [])).toEqual({});
  });

  test("a label used twice and one that is not valid are each reported next to their own rule rows", () => {
    const f = form({ rules: [{ label: "ARCH-1", text: "a" }, { label: "arch-2", text: "b" }, { label: "ARCH-1", text: "c" }] });
    const p = fieldProblems(f, []);
    expect(p["rule:0"]).toBe("ARCH-1 is used twice in this standard.");
    expect(p["rule:2"]).toBe("ARCH-1 is used twice in this standard.");
    expect(p["rule:1"]).toBe("arch-2 is not a valid label: start with a capital letter, then letters, digits, ., _ or -, ending in a letter or digit, 32 characters at most.");
    expect(Object.keys(p).sort()).toEqual(["rule:0", "rule:1", "rule:2"]);
  });

  test("labels are judged as the server's reader judges them", () => {
    for (const label of ["A", "ARCH-1", "SOC2-CC6.1", "SEC_3", "Ab", "A-", "a", "1A", "ARCH 1", `A${"b".repeat(31)}`, `A${"b".repeat(30)}`, "A.", ""]) {
      const p = fieldProblems(form({ rules: [{ label, text: "x" }] }), []);
      expect({ label, ok: p["rule:0"] === undefined }).toEqual({ label, ok: RULE_LABEL.test(label) });
    }
  });

  test("a rule without words, a missing title or rules, a bad name and an empty pattern each show on their field", () => {
    const p = fieldProblems(form({ name: "Arch", title: " ", patterns: ["src/**", " "], rules: [{ label: "ARCH-1", text: " " }] }), []);
    expect(p.name).toBe("A standard's name is lowercase words joined by dashes, like security.");
    expect(p.title).toBe("Give the standard a title.");
    expect(p.patterns).toBe("A pattern cannot be empty: fill it in or take it out.");
    expect(p["rule:0"]).toBe("Say what the rule asks.");
    expect(fieldProblems(form({ rules: [] }), []).rules).toBe("Add at least one rule.");
  });

  test("names are judged as the server judges them", () => {
    for (const name of ["a", "security", "soc2", "a-b-c", "A", "a--b", "-a", "a-", "a b", "a_b", "", "a/b"]) {
      expect({ name, ok: isStandardName(name) }).toEqual({ name, ok: STANDARD_NAME.test(name) });
    }
  });

  test("a new standard may not take the name of a file main has: a standard, one that cannot be read, or one that is ignored", () => {
    expect(fieldProblems(form(), [], ["architecture"]).name).toBe("There is already a file loopstra/standards/architecture.md: pick another name.");
    expect(takenNames({
      standards: [{ name: "security" }],
      problems: ["loopstra/standards/broken.md cannot be read: it has no title (start the text with `# Title`).", "loopstra/config.yaml does not load: x"],
      ignored: ["loopstra/standards/notes.txt", "loopstra/standards/odd.md", "loopstra/standards/Caps.md"],
    })).toEqual(["security", "broken", "odd"]);
  });

  test("a server problem about a pattern lands on the patterns field, a label's on its rule row, a check's on the check", () => {
    const p = fieldProblems(form({ patterns: ["src/[a"] }), [
      { path: PATH, line: 2, text: 'applies_to has an unclosed bracket: "src/[a"' },
      { path: PATH, line: 9, text: "the label ARCH-2 (line 9) is also used in loopstra/standards/security.md" },
      { path: PATH, line: 3, text: "check is not the right kind of value (applies_to is a list of patterns, needs_person is true or false, check is a command)" },
    ]);
    expect(p.patterns).toBe('applies_to has an unclosed bracket: "src/[a".');
    expect(p["rule:1"]).toBe("the label ARCH-2 (line 9) is also used in loopstra/standards/security.md.");
    expect(p.check).toContain("check is not the right kind of value");
    expect(p["rule:0"]).toBeUndefined();
    // One about the file as a whole is said under the form.
    expect(fieldProblems(form(), [{ path: PATH, line: 1, text: "the front matter is not valid YAML (write `key: value` lines between two `---` lines)" }]).file)
      .toBe("the front matter is not valid YAML (write `key: value` lines between two `---` lines).");
  });
});

describe("saving a standard", () => {
  test("Save is offered only when the form has no problems and the server's check has none", () => {
    expect(canSave(form(), clean)).toBe(true);
    // Not checked yet (or checking again after an edit).
    expect(canSave(form(), null)).toBe(false);
    expect(canSave(form(), { problems: [{ path: PATH, line: null, text: "it has no title (start the text with `# Title`)" }], matches: [] })).toBe(false);
    expect(canSave(form({ rules: [{ label: "ARCH-1", text: "a" }, { label: "ARCH-1", text: "b" }] }), clean)).toBe(false);
  });

  test("the save notice names the changes in progress under the standard", () => {
    expect(saveNotice(["billing-refunds", "csv-export"])).toBe("billing-refunds and csv-export are in progress under this standard; their next steps use the new rules.");
    expect(saveNotice(["a", "b", "c"])).toBe("a, b and c are in progress under this standard; their next steps use the new rules.");
    expect(saveNotice(["csv-export"])).toBe("csv-export is in progress under this standard; its next steps use the new rules.");
    expect(saveNotice([])).toBeNull();
  });

  test("removing asks first, naming the changes in progress it applies to", () => {
    expect(removeText({ title: "Architecture", path: PATH, inProgress: ["billing-refunds", "csv-export"] }))
      .toBe(`Remove Architecture (${PATH})? billing-refunds and csv-export are in progress under it; their next steps no longer use its rules.`);
    expect(removeText({ title: "Architecture", path: PATH, inProgress: [] })).toBe(`Remove Architecture (${PATH})? No change in progress is under it.`);
  });

  test("the README's two examples read as standards", () => {
    expect(EXAMPLES.map((e) => e.label)).toEqual(["Architecture, for every change", "SOC 2 technical controls, for services/** and infra/**"]);
    for (const e of EXAMPLES) {
      expect(fieldProblems(e.form, [])).toEqual({});
      expect(parseStandard(e.form.name, formToMarkdown(e.form)).ok).toBe(true);
    }
    const soc2 = EXAMPLES[1]!.form;
    expect(soc2.patterns).toEqual(["services/**", "infra/**"]);
    expect(soc2.check).toContain("$LOOPSTRA_BASE");
    expect(EXAMPLES[0]!.form.patterns).toEqual([]);
  });
});

describe("opening a standard of main's", () => {
  test("it opens as a form only when the form writes the file as it is, so no text outside the form's parts is lost unasked", () => {
    const text = "# Architecture\n\n## Rules\n- ARCH-1: Services talk over HTTP.\n";
    expect(opensAsMarkdown(text, text)).toBe(false);
    // Only line endings and the end of the file differ: nothing is lost.
    expect(opensAsMarkdown(text.replace(/\n/g, "\r\n"), text)).toBe(false);
    expect(opensAsMarkdown(`${text}\n\n`, text)).toBe(false);
    expect(opensAsMarkdown(`${text}\n## Notes\nMore.\n`, text)).toBe(true);
    expect(opensAsMarkdown(`---\napplies_to:\n  - src/**\n---\n${text}`, `---\napplies_to: ["src/**"]\n---\n${text}`)).toBe(true);
    // A file the server could not read into a form.
    expect(opensAsMarkdown(text, null)).toBe(true);
  });
});

describe("the standards list", () => {
  test("a row's scope says every change, or its patterns with the files they match on main", () => {
    expect(scopeLine({ scope: "Every change", matches: null })).toBe("Every change");
    expect(scopeLine({ scope: "Files matching services/**, infra/**", matches: 12 })).toBe("Files matching services/**, infra/** (12 files on main now)");
    expect(scopeLine({ scope: "Files matching docs/**", matches: 1 })).toBe("Files matching docs/** (1 file on main now)");
  });
});

describe("exceptions granted", () => {
  const row = (label: string, standard: string): ExceptionRow => ({ label, title: standard, standard, change: "C", slug: "c", reason: "r", by: "J", via: "the dashboard", date: "2026-10-28", gate: "plan" });
  const rows = [row("ARCH-1", "architecture"), row("ARCH-2", "architecture"), row("SEC-1", "security")];

  test("filter by standard and by rule; empty is all", () => {
    expect(filterExceptions(rows, { standard: "", rule: "" })).toEqual(rows);
    expect(filterExceptions(rows, { standard: "architecture", rule: "" }).map((r) => r.label)).toEqual(["ARCH-1", "ARCH-2"]);
    expect(filterExceptions(rows, { standard: "", rule: "SEC-1" }).map((r) => r.label)).toEqual(["SEC-1"]);
    expect(filterExceptions(rows, { standard: "security", rule: "ARCH-1" })).toEqual([]);
  });

  test("the page has its own address under Settings", () => {
    expect(parseRoute("/settings/exceptions")).toEqual({ name: "exceptions" });
    expect(routePath({ name: "exceptions" })).toBe("/settings/exceptions");
    expect(parseRoute("/settings/nope")).toEqual({ name: "missing", path: "/settings/nope" });
  });
});
