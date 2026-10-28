import { describe, expect, test } from "bun:test";
import { Envelopes, jsonSchemaFor, type PhaseName } from "../../src/envelopes";

describe("envelopes", () => {
  test("every phase has a schema with the base fields", () => {
    const names: PhaseName[] = [
      "intake", "design", "spec-check", "plan", "plan-challenge", "build", "fix",
      "reconcile", "verify", "review", "revise", "done-check", "lessons", "acceptance",
    ];
    for (const name of names) {
      const schema = Envelopes[name];
      const parsed = schema.safeParse({ status: "success", summary: "ok" });
      // base-only input should fail for phases with required extras, but base fields must exist
      const shape = jsonSchemaFor(name);
      expect(shape.properties).toHaveProperty("status");
      expect(shape.properties).toHaveProperty("summary");
      // Nothing reads a note for the next phase: the model is not asked for one.
      expect(shape.properties).not.toHaveProperty("notes_for_next_phase");
      expect(typeof parsed.success).toBe("boolean");
    }
  });

  test("the plan's files come from its markdown list, and concerns from the spec's own heading", () => {
    expect(jsonSchemaFor("plan").properties).not.toHaveProperty("files");
    expect(jsonSchemaFor("design").properties).not.toHaveProperty("concerns");
    // plan-challenge keeps its own concerns: they are the verdict.
    expect(jsonSchemaFor("plan-challenge").properties).toHaveProperty("concerns");
  });

  test("acceptance names each test by its criterion, file and name, and what it could not test; it never asks", () => {
    const r = Envelopes.acceptance.parse({
      status: "success", summary: "one test, one criterion for a person", commit_message: "test: acceptance tests for counting words",
      tests: [{ criterion: "Counting the words in \"hello world\" gives 2", file: "tests/count.test.ts", test: "counts two words" }],
      not_testable: [{ criterion: "People find the new page easy to read", why: "needs a person" }],
    });
    expect(r.tests[0]?.file).toBe("tests/count.test.ts");
    expect(r.not_testable[0]?.why).toBe("needs a person");
    expect(jsonSchemaFor("acceptance").required).toEqual(expect.arrayContaining(["tests", "not_testable", "commit_message"]));
    expect(jsonSchemaFor("acceptance").properties).not.toHaveProperty("question");
  });

  test("intake accepts a priority and question; missing sections are the consistency check's, before intake", () => {
    const r = Envelopes.intake.parse({
      status: "success", summary: "fine",
      priority: "high", question: "",
    });
    expect(r.priority).toBe("high");
    expect(jsonSchemaFor("intake").properties).not.toHaveProperty("missing_sections");
  });

  test("review requires severity on findings", () => {
    const r = Envelopes.review.safeParse({
      status: "success", summary: "", approved: false,
      review_markdown: "# Review", findings: [{ file: "a.ts", line: 1, finding: "bug" }],
    });
    expect(r.success).toBe(false);
  });

  test("json schema has no additional properties and lists required fields", () => {
    const s = jsonSchemaFor("build");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(expect.arrayContaining(["status", "summary", "commit_message"]));
    // Nothing read the list of changed files: the runtime asks git.
    for (const name of ["build", "fix", "revise"] as const) expect(jsonSchemaFor(name).properties).not.toHaveProperty("changed_files");
  });
});

describe("jsonSchemaOf", () => {
  test("optional fields are not required, and nested objects are closed too", () => {
    // Design may ask a question; intake must say (its question is a string, empty for none).
    const s = jsonSchemaFor("design");
    expect(s.required).not.toContain("question");
    expect(jsonSchemaFor("intake").required).toContain("question");
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const o = node as Record<string, unknown>;
      if (o.type === "object" && o.properties) expect(o.additionalProperties).toBe(false);
      for (const v of Object.values(o)) walk(v);
    };
    walk(s);
  });
});

describe("done-check standards", () => {
  test("an envelope without standards still parses, with none", () => {
    const r = Envelopes["done-check"].parse({ status: "success", summary: "ok", evidence: [], outcome_markdown: "# Outcome" });
    expect(r.standards).toEqual([]);
  });

  test("each rule is judged met, unmet or needs-person with evidence", () => {
    const r = Envelopes["done-check"].parse({ status: "success", summary: "ok", evidence: [], outcome_markdown: "", standards: [{ label: "SEC-1", result: "needs-person", evidence: "in monitoring" }] });
    expect(r.standards[0]).toEqual({ label: "SEC-1", result: "needs-person", evidence: "in monitoring" });
    expect(Envelopes["done-check"].safeParse({ status: "success", summary: "", evidence: [], outcome_markdown: "", standards: [{ label: "A", result: "maybe", evidence: "" }] }).success).toBe(false);
  });
});
