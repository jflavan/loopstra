import { describe, expect, test } from "bun:test";
import { Envelopes, jsonSchemaFor, type PhaseName } from "../../src/envelopes";

describe("envelopes", () => {
  test("every phase has a schema with the base fields", () => {
    const names: PhaseName[] = [
      "intake", "design", "spec-check", "plan", "plan-challenge", "build", "fix",
      "reconcile", "verify", "review", "revise", "done-check", "lessons",
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
