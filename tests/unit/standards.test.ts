import { describe, expect, test } from "bun:test";
import { formToMarkdown, parseStandard, parseStandards, problemText, STANDARD_NAME, STANDARDS_DIR, standardToForm, type Rule, type Standard } from "../../src/standards";

const EXAMPLE = `---
applies_to: ["services/**", "api/**"]
needs_person: false
check: bunx depcruise --config .dependency-cruiser.cjs services
---
# Service architecture

Why these rules exist, links to the design records in docs/adr/, examples of the right way.
Sessions are given the whole file, so this text is context, not decoration.

## Rules
- ARCH-1: Services call each other only through their published HTTP APIs. No service reads
  or writes another service's database.
- ARCH-2: New persistent data lives in Postgres, through the repository layer in \`src/db/\`.
`;

const ok = (name: string, text: string): Standard => {
  const r = parseStandard(name, text);
  if (!r.ok) throw new Error(`did not parse: ${r.problems.map((p) => p.text).join("; ")}`);
  return r.standard;
};

const problemsOf = (text: string) => {
  const r = parseStandard("a", text);
  if (r.ok) throw new Error("parsed");
  return r.problems;
};

describe("parseStandard", () => {
  test("parses the spec's example", () => {
    const s = ok("architecture", EXAMPLE);
    expect(s).toMatchObject({
      name: "architecture",
      path: "loopstra/standards/architecture.md",
      title: "Service architecture",
      appliesTo: ["services/**", "api/**"],
      needsPerson: false,
      check: "bunx depcruise --config .dependency-cruiser.cjs services",
    });
    const rules: Rule[] = [
      { label: "ARCH-1", text: "Services call each other only through their published HTTP APIs. No service reads or writes another service's database.", line: 12 },
      { label: "ARCH-2", text: "New persistent data lives in Postgres, through the repository layer in `src/db/`.", line: 14 },
    ];
    expect(s.rules).toEqual(rules);
    expect(s.body.startsWith("# Service architecture")).toBe(true);
  });

  test("no front matter means every change, no check", () => {
    const s = ok("a", "# T\n\n## Rules\n- A-1: one\n");
    expect(s.appliesTo).toBeNull();
    expect(s.check).toBeNull();
    expect(s.needsPerson).toBe(false);
    expect(s.rules[0]?.line).toBe(4);
  });

  test("CRLF parses the same as LF", () => {
    const lf = ok("a", EXAMPLE);
    const crlf = ok("a", EXAMPLE.replace(/\n/g, "\r\n"));
    expect({ ...crlf, body: crlf.body.replace(/\r\n/g, "\n") }).toEqual(lf);
  });

  test("each unreadable shape is a problem with its line", () => {
    const rules = (...bullets: string[]) => `# T\n\n## Rules\n${bullets.join("\n")}\n`;
    const front = (...lines: string[]) => `---\n${lines.join("\n")}\n---\n# T\n\n## Rules\n- A-1: x\n`;
    const cases: Array<[string, string, number | null]> = [
      ["no title", "## Rules\n- A-1: x\n", null],
      ["no Rules section", "# T\n\nText.\n", null],
      ["an empty Rules section", "# T\n\n## Rules\n\n## Other\n", 3],
      ["a bullet with no label", rules("- no label here"), 4],
      ["a lower case label", rules("- A-1: fine", "- arch-1: lower case"), 5],
      ["a label of 33 characters", rules(`- A${"b".repeat(32)}: long`), 4],
      ["a label used twice", rules("- A-1: one", "- A-1: two"), 5],
      ["an unknown key", front("owner: x"), 2],
      ["applies_to that is not a list", front('applies_to: "src/**"'), 2],
      ["an invalid glob", front('applies_to: ["["]'), 2],
      ["YAML that does not parse", front("applies_to: [unclosed"), 1],
    ];
    for (const [what, text, line] of cases) {
      const r = parseStandard("a", text);
      expect(r.ok, what).toBe(false);
      if (!r.ok) {
        expect(r.problems[0]?.line, what).toBe(line);
        expect(r.problems[0]?.path, what).toBe("loopstra/standards/a.md");
      }
    }
  });

  test("a rule's problem text is a plain sentence naming the line", () => {
    expect(problemsOf("# T\n\n## Rules\n- fine: no\n")[0]?.text).toContain("line 4");
  });
});

describe("parseStandards", () => {
  test("a label used in two files is a problem in both", () => {
    const a = "# A\n\n## Rules\n- X-1: one\n";
    const b = "# B\n\n## Rules\n- X-1: two\n- X-2: three\n";
    const r = parseStandards([
      { path: "loopstra/standards/a.md", text: a },
      { path: "loopstra/standards/b.md", text: b },
    ]);
    expect(r.standards).toEqual([]);
    expect(r.problems.map((p) => [p.path, p.line])).toEqual([
      ["loopstra/standards/a.md", 4],
      ["loopstra/standards/b.md", 4],
    ]);
  });

  test("other files are ignored", () => {
    const r = parseStandards([
      { path: "loopstra/standards/README.txt", text: "x" },
      { path: "loopstra/standards/Bad_Name.md", text: "x" },
      { path: "loopstra/standards/ok.md", text: "# T\n\n## Rules\n- A-1: x\n" },
    ]);
    expect(r.ignored).toEqual(["loopstra/standards/README.txt", "loopstra/standards/Bad_Name.md"]);
    expect(r.standards.map((s) => s.name)).toEqual(["ok"]);
    expect(r.problems).toEqual([]);
  });
});

test("the folder and the name pattern are the ones the spec names", () => {
  expect(STANDARDS_DIR).toBe("loopstra/standards");
  expect(["soc2", "a-b-1"].every((n) => STANDARD_NAME.test(n))).toBe(true);
  expect(["Soc2", "a--b", "-a", "a_b"].some((n) => STANDARD_NAME.test(n))).toBe(false);
});

test("problemText gives the spec's sentence for a missing label", () => {
  const text = `# T\n${"\n".repeat(9)}## Rules\n\n- A-1: ok\n- no label\n`;
  const p = problemsOf(text)[0];
  expect(p).toBeDefined();
  if (p) {
    const withLine = { ...p, path: "loopstra/standards/soc2.md" };
    expect(problemText(withLine)).toBe(`loopstra/standards/soc2.md cannot be read: the rule on line ${p.line} has no rule label (write it as \`- LABEL: text\`).`);
  }
  expect(problemText({ path: "loopstra/standards/soc2.md", line: 14, text: "the rule on line 14 has no rule label (write it as `- LABEL: text`)" }))
    .toBe("loopstra/standards/soc2.md cannot be read: the rule on line 14 has no rule label (write it as `- LABEL: text`).");
});

describe("formToMarkdown", () => {
  test("round trips the spec's example", () => {
    const f = standardToForm(ok("architecture", EXAMPLE));
    expect(f.context).toStartWith("Why these rules exist");
    const again = standardToForm(ok("architecture", formToMarkdown(f)));
    expect(again).toEqual(f);
  });

  test("an empty list of patterns writes no applies_to, and an empty check no check", () => {
    const md = formToMarkdown({ name: "a", title: "T", patterns: [], needsPerson: false, check: "", rules: [{ label: "A-1", text: "x" }], context: "" });
    expect(md).toBe("# T\n\n## Rules\n- A-1: x\n");
    const s = ok("a", md);
    expect(s.appliesTo).toBeNull();
    expect(s.check).toBeNull();
  });

  test("needs_person is written only when true, and a hard check survives", () => {
    const f = { name: "a", title: "T", patterns: ["src/**"], needsPerson: true, check: 'grep -rn "a: b" src # x', rules: [{ label: "A-1", text: "x" }], context: "Why." };
    const md = formToMarkdown(f);
    expect(md).toContain("needs_person: true");
    expect(standardToForm(ok("a", md))).toEqual(f);
  });
});
