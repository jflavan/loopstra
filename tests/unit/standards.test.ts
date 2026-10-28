import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../src/git";
import {
  applying, checkStandardsSection, formToMarkdown, parseStandard, parseStandards, problemText, readOutcomeStandards, readStandards, readStandardsSection,
  renderStandards, STANDARD_NAME, STANDARDS_DIR, standardsBytes, standardToForm, type Applying, type Rule, type Standard,
} from "../../src/standards";
import { tempGitRepo } from "../helpers";

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

function std(name: string, appliesTo: string[] | null, title = name, rules: string[] = ["X-1"]): Standard {
  return {
    name, path: `${STANDARDS_DIR}/${name}.md`, title, appliesTo, needsPerson: false, check: null,
    rules: rules.map((label, i) => ({ label, text: "t", line: i + 1 })),
    body: `# ${title}\n\n## Rules\n${rules.map((r) => `- ${r}: t\n`).join("")}`,
  };
}

describe("readStandards", () => {
  test("readStandards reads only the commit", async () => {
    const repo = await tempGitRepo();
    try {
      mkdirSync(join(repo.path, STANDARDS_DIR), { recursive: true });
      const file = join(repo.path, STANDARDS_DIR, "arch.md");
      await Bun.write(file, "# Arch\n\n## Rules\n- ARCH-1: committed\n");
      await Bun.write(join(repo.path, STANDARDS_DIR, "notes.txt"), "x");
      mkdirSync(join(repo.path, STANDARDS_DIR, "sub"), { recursive: true });
      await Bun.write(join(repo.path, STANDARDS_DIR, "sub", "x.md"), "# X\n");
      const git = new Git(repo.path);
      await git.commitAll("standards");
      await Bun.write(file, "# Arch\n\n## Rules\n- ARCH-1: edited\n");
      const sha = (await git.run(["rev-parse", "HEAD"])).out.trim();
      const r = await readStandards(git, sha);
      expect(r.problems).toEqual([]);
      expect(r.standards.map((s) => s.rules[0]?.text)).toEqual(["committed"]);
      expect(r.ignored.sort()).toEqual([`${STANDARDS_DIR}/notes.txt`, `${STANDARDS_DIR}/sub`]);
      const none = await readStandards(git, `${sha}~1`);
      expect(none).toEqual({ standards: [], problems: [], ignored: [] });
      await expect(readStandards(git, "0".repeat(40))).rejects.toThrow();
    } finally { repo.cleanup(); }
  });
});

describe("applying", () => {
  const every = std("every", null);
  const svc = std("svc", ["services/**"]);
  const other = std("other", ["docs/**"]);
  test("every and files: the matched files are listed", () => {
    const r = applying([every, svc, other], ["services/a.ts", "README.md", "services/b.ts", "old/x.ts"]);
    expect(r.map((a) => [a.standard.name, a.why, a.files])).toEqual([["every", "every", []], ["svc", "files", ["services/a.ts", "services/b.ts"]]]);
    const renamed = applying([svc], ["old/a.ts", "services/a.ts"]);
    expect(renamed[0]?.files).toEqual(["services/a.ts"]);
  });
  test("removed beats both", () => {
    expect(applying([every, svc], ["services/a.ts"], { added: [], removed: ["every", "svc"] })).toEqual([]);
  });
  test("added applies with no matching file", () => {
    const r = applying([every, other], ["README.md"], { added: ["other"], removed: [] });
    expect(r.map((a) => [a.standard.name, a.why, a.files])).toEqual([["every", "every", []], ["other", "added", []]]);
  });
  test("a path with a space and an accent matches services/**", () => {
    expect(applying([svc], ["services/café menu/é.ts"])[0]?.files).toEqual(["services/café menu/é.ts"]);
  });
});

describe("renderStandards", () => {
  const arch = std("architecture", ["services/**"], "Service architecture");
  const sec = std("secrets", null, "Secrets");
  const list: Applying[] = [
    { standard: arch, why: "files", files: ["a", "b"] },
    { standard: sec, why: "every", files: [] },
  ];
  test("heading, why line and the file's text", () => {
    const out = renderStandards(list);
    expect(out).toContain("### Service architecture (loopstra/standards/architecture.md)\nApplies because the change touches a and b.\n\n# Service architecture");
    expect(out).toContain("### Secrets (loopstra/standards/secrets.md)\nApplies to every change.\n\n# Secrets");
  });
  test("a standard a person added says so", () => {
    expect(renderStandards([{ standard: sec, why: "added", files: [] }])).toContain("Applies because a person added it to this change.");
  });
  test("scoped standards come under their sentence", () => {
    const out = renderStandards([{ standard: sec, why: "every", files: [] }], { scoped: [arch] });
    expect(out).toContain("These apply only to changes that touch the files named.");
    expect(out).toContain("### Service architecture (loopstra/standards/architecture.md)\nApplies only to changes that touch services/**.");
    expect(out.indexOf("Secrets")).toBeLessThan(out.indexOf("These apply only"));
  });
  test("excepted rules are listed with their reasons", () => {
    const out = renderStandards(list, { excepted: [{ label: "ARCH-1", reason: "legacy table" }] });
    expect(out).toContain("Rules under an approved exception:\n- ARCH-1: legacy table");
  });
  test("empty input gives an empty string", () => {
    expect(renderStandards([])).toBe("");
    expect(renderStandards([], { scoped: [], excepted: [{ label: "A", reason: "r" }] })).toBe("");
  });
});

describe("Standards section", () => {
  const doc = (body: string) => `# Spec\n\n## Design\nd\n\n## Standards\n${body}\n## Next\n- NOT-1: x\n`;
  test("readStandardsSection accepts decorated labels", () => {
    const s = readStandardsSection(doc("- **ARCH-1**: x\n- `ARCH-2`: y\n- ARCH-3 \u2014 z\n- ARCH-4: does not apply: why\n- ARCH-5: exception: because\n- ARCH-6 - dash\n- **ARCH-7:** bold\r\n"));
    expect(s).toEqual([
      { label: "ARCH-1", kind: "keeps", text: "x" },
      { label: "ARCH-2", kind: "keeps", text: "y" },
      { label: "ARCH-3", kind: "keeps", text: "z" },
      { label: "ARCH-4", kind: "not-applicable", text: "why" },
      { label: "ARCH-5", kind: "exception", text: "because" },
      { label: "ARCH-6", kind: "keeps", text: "dash" },
      { label: "ARCH-7", kind: "keeps", text: "bold" },
    ]);
  });
  test("None. gives [] and no heading gives null", () => {
    expect(readStandardsSection(doc("None.\n"))).toEqual([]);
    expect(readStandardsSection("# Spec\n\n## Design\nx\n")).toBeNull();
  });
  test("labels keep their case", () => {
    expect(readStandardsSection(doc("- arch-1: x\n- Arch-1: y\n"))?.map((b) => b.label)).toEqual(["Arch-1"]);
  });
  const known = new Set(["SEC-1", "SEC-2", "SEC-4"]);
  const b = (label: string, kind: "keeps" | "exception" = "keeps") => ({ label, kind, text: "t" });
  test("checkStandardsSection", () => {
    expect(checkStandardsSection(null, [], known)).toEqual({ ok: false, evidence: "no Standards section" });
    expect(checkStandardsSection([b("SEC-9")], [], known)).toEqual({ ok: false, evidence: "no rule called SEC-9" });
    expect(checkStandardsSection([b("SEC-1")], ["SEC-1", "SEC-2", "SEC-4"], known)).toEqual({ ok: false, evidence: "missing SEC-2, SEC-4" });
    expect(checkStandardsSection([b("SEC-1"), b("SEC-9")], ["SEC-1", "SEC-2"], known).evidence).toBe("missing SEC-2; no rule called SEC-9");
    expect(checkStandardsSection([b("SEC-1"), b("SEC-2")], ["SEC-1", "SEC-2"], known)).toEqual({ ok: true, evidence: "all 2 rules addressed" });
    expect(checkStandardsSection([b("SEC-1"), b("SEC-2"), b("SEC-4", "exception")], [], known)).toEqual({ ok: true, evidence: "3 rules addressed, 1 exception" });
    expect(checkStandardsSection([], [], known)).toEqual({ ok: true, evidence: "0 rules addressed" });
  });
});

describe("readOutcomeStandards", () => {
  test("reads the five line forms and skips the rest", () => {
    const outcome = [
      "## Standards",
      "The engineering rules this change was checked against (the standards as of commit 3f9c2ab):",
      "- ARCH-1 (Service architecture): met: services only call the HTTP API (see api.ts)",
      "- ARCH-2 (Service architecture): unmet: billing reads the table",
      "- SEC-4 (Secrets): needs-person: the alert exists in the monitoring system",
      "- ARCH-3 (Service architecture): exception, approved by J. at the plan: billing keeps the legacy table",
      "- OPS-1 (Ops (core)): not checked automatically",
      "- Check of Secrets: passed at merge",
      "- Payments data was added to this change by J.: card data",
    ].join("\n");
    expect(readOutcomeStandards(outcome)).toEqual([
      { label: "ARCH-1", title: "Service architecture", result: "met", evidence: "services only call the HTTP API (see api.ts)" },
      { label: "ARCH-2", title: "Service architecture", result: "unmet", evidence: "billing reads the table" },
      { label: "SEC-4", title: "Secrets", result: "needs-person", evidence: "the alert exists in the monitoring system" },
      { label: "ARCH-3", title: "Service architecture", result: "exception", evidence: "billing keeps the legacy table" },
      { label: "OPS-1", title: "Ops (core)", result: "not-checked", evidence: "" },
    ]);
  });

  test("a line with no evidence still reads", () => {
    expect(readOutcomeStandards("- ARCH-1 (Service architecture): met:")).toEqual([{ label: "ARCH-1", title: "Service architecture", result: "met", evidence: "" }]);
    expect(readOutcomeStandards("- ARCH-1 (Service architecture): unmet: \r\n")).toEqual([{ label: "ARCH-1", title: "Service architecture", result: "unmet", evidence: "" }]);
  });

  test("a title with \"): \" in it is read whole, up to the result", () => {
    const outcome = [
      "- API-1 (APIs (v2): the public ones): met: the route is versioned (see v2.ts)",
      "- API-2 (APIs (v2): the public ones): exception, approved by J. at the spec: legacy route",
      "- API-3 (APIs (v2): the public ones): not checked automatically",
    ].join("\n");
    expect(readOutcomeStandards(outcome)).toEqual([
      { label: "API-1", title: "APIs (v2): the public ones", result: "met", evidence: "the route is versioned (see v2.ts)" },
      { label: "API-2", title: "APIs (v2): the public ones", result: "exception", evidence: "legacy route" },
      { label: "API-3", title: "APIs (v2): the public ones", result: "not-checked", evidence: "" },
    ]);
  });
});

test("standardsBytes adds up the files' text", () => {
  expect(standardsBytes({ standards: [std("a", null), std("b", null, "é")], problems: [], ignored: [] })).toBe(
    Buffer.byteLength(std("a", null).body) + Buffer.byteLength(std("b", null, "é").body),
  );
});
