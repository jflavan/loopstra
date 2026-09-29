import { describe, expect, test } from "bun:test";
import { parseIntentFile, serializeIntentFile, STATUSES, type IntentFile } from "../../src/intents";

const SAMPLE = `---
status: draft
priority: normal
author: J. Ortiz
opened: 2026-09-28
note: ""
---
# Intent: claims status self-service

## Problem
People call.

## Proposed outcome
They stop calling.

## Done when
- Status is visible.
`;

describe("intent frontmatter", () => {
  test("parses frontmatter and body", () => {
    const f = parseIntentFile(SAMPLE);
    expect(f.frontmatter.status).toBe("draft");
    expect(f.frontmatter.priority).toBe("normal");
    expect(f.frontmatter.opened).toBe("2026-09-28");
    expect(f.title).toBe("claims status self-service");
    expect(f.sections["Problem"]).toBe("People call.");
    expect(f.sections["Done when"]).toBe("- Status is visible.");
  });

  test("round-trips through serialize", () => {
    const f = parseIntentFile(SAMPLE);
    f.frontmatter.status = "accepted";
    f.frontmatter.note = "Read spec.md";
    const text = serializeIntentFile(f);
    const again = parseIntentFile(text);
    expect(again.frontmatter.status).toBe("accepted");
    expect(again.frontmatter.note).toBe("Read spec.md");
    expect(again.body).toBe(f.body);
  });

  test("defaults missing frontmatter fields", () => {
    const f = parseIntentFile("# Intent: x\n\n## Problem\np\n");
    expect(f.frontmatter.status).toBe("draft");
    expect(f.frontmatter.priority).toBe("normal");
    expect(f.frontmatter.note).toBe("");
  });

  test("rejects an unknown status", () => {
    expect(() => parseIntentFile("---\nstatus: flying\n---\n# Intent: x\n")).toThrow(/status/);
    expect(STATUSES).toContain("merge-review");
  });
});
