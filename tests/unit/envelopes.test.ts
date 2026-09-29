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
      const parsed = schema.safeParse({ status: "success", summary: "ok", notes_for_next_phase: "" });
      // base-only input should fail for phases with required extras, but base fields must exist
      const shape = jsonSchemaFor(name);
      expect(shape.properties).toHaveProperty("status");
      expect(shape.properties).toHaveProperty("summary");
      expect(shape.properties).toHaveProperty("notes_for_next_phase");
      expect(typeof parsed.success).toBe("boolean");
    }
  });

  test("intake accepts a priority and question", () => {
    const r = Envelopes.intake.parse({
      status: "success", summary: "fine", notes_for_next_phase: "",
      priority: "high", missing_sections: [], question: "",
    });
    expect(r.priority).toBe("high");
  });

  test("review requires severity on findings", () => {
    const r = Envelopes.review.safeParse({
      status: "success", summary: "", notes_for_next_phase: "", approved: false,
      review_markdown: "# Review", findings: [{ file: "a.ts", line: 1, finding: "bug" }],
    });
    expect(r.success).toBe(false);
  });

  test("json schema has no additional properties and lists required fields", () => {
    const s = jsonSchemaFor("build");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(expect.arrayContaining(["status", "summary", "changed_files", "commit_message"]));
  });
});
