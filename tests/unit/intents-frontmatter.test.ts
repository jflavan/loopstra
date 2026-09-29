import { describe, expect, test } from "bun:test";
import { effectivePriority, parseIntentFile, serializeIntentFile, STATUSES } from "../../src/intents";

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

  test("defaults missing frontmatter fields; priority stays absent (not stated) and counts as normal", () => {
    const f = parseIntentFile("# Intent: x\n\n## Problem\np\n");
    expect(f.frontmatter.status).toBe("draft");
    expect(f.frontmatter.priority).toBeUndefined();
    expect(effectivePriority(f.frontmatter)).toBe("normal");
    expect(serializeIntentFile(f)).not.toContain("priority");
    expect(parseIntentFile("---\npriority:\n---\n# Intent: x\n").frontmatter.priority).toBeUndefined();
    expect(f.frontmatter.note).toBe("");
  });

  test("rejects an unknown status", () => {
    expect(() => parseIntentFile("---\nstatus: flying\n---\n# Intent: x\n")).toThrow(/status/);
    expect(STATUSES).toContain("merge-review");
    expect(STATUSES).toContain("merge-approved");
  });

  test("strips a leading BOM before matching the frontmatter fence", () => {
    const f = parseIntentFile("﻿---\nstatus: accepted\n---\n# Intent: x\n");
    expect(f.frontmatter.status).toBe("accepted");
  });

  test("treats blank frontmatter values as the default empty string", () => {
    const f = parseIntentFile("---\nstatus: accepted\nnote:\n---\n# Intent: x\n");
    expect(f.frontmatter.note).toBe("");
  });

  test("only matches a single # for the title, not ##", () => {
    const f = parseIntentFile("## Problem\np\n");
    expect(f.title).toBe("");
  });

  test("serializes CRLF-consistent frontmatter when the body uses CRLF", () => {
    const crlf = "---\r\nstatus: accepted\r\n---\r\n# Intent: x\r\n\r\n## Problem\r\np\r\n";
    const f = parseIntentFile(crlf);
    const text = serializeIntentFile(f);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") expect(text[i - 1]).toBe("\r");
    }
  });
});
