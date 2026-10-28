import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { effectivePriority, FrontmatterProblem, parseIntentFile, scanRepo, serializeIntentFile, STATUSES } from "../../src/intents";
import { tempDir } from "../helpers";

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

  test("a fence parse cannot take (a blank line above it, a space after the dashes, no closing line) is refused, never read as a draft", () => {
    // Read as a draft, the file's real status would be lost, and a patch could add a second frontmatter block.
    for (const text of ["\n---\nstatus: accepted\n---\n# Intent: x\n", "--- \nstatus: accepted\n---\n# Intent: x\n", "  \n\n---\nstatus: accepted\n---\n", "---\nstatus: accepted\n# Intent: x\n"]) {
      expect(() => parseIntentFile(text)).toThrow(FrontmatterProblem);
    }
    // No newline after the closing fence is fine.
    expect(parseIntentFile("---\nstatus: accepted\n---").frontmatter.status).toBe("accepted");
    expect(parseIntentFile("﻿---\r\nstatus: accepted\r\n---").frontmatter.status).toBe("accepted");
  });

  test("an empty frontmatter block (--- straight after ---) is an empty frontmatter: the file is a draft", () => {
    // An older Loopstra wrote exactly this (a priority set, then undone, on a draft with no frontmatter).
    for (const text of ["---\n---\n# Intent: x\n", "﻿---\r\n---\r\n# Intent: x\r\n", "---\n--- \n# Intent: x\n", "---\n---"]) {
      expect(parseIntentFile(text).frontmatter.status).toBe("draft");
    }
    expect(parseIntentFile("---\n---\n# Intent: x\n").title).toBe("x");
  });

  test("an opening fence with spaces before the dashes is refused, never read as a draft", () => {
    for (const text of [" ---\nstatus: building\n---\n# Intent: x\n", "\t---  \nstatus: building\n---\n# Intent: x\n", "\n  ---\nstatus: building\n---\n"]) {
      expect(() => parseIntentFile(text)).toThrow(FrontmatterProblem);
    }
  });

  test("a closing line counts only when it is three dashes with nothing but spaces after them", () => {
    // ---- is not a closing fence: read as one, the fourth dash went into the body.
    for (const text of ["---\nstatus: building\n----\n# Intent: x\n", "---\nstatus: building\n---x\n# Intent: x\n"]) {
      expect(() => parseIntentFile(text)).toThrow(FrontmatterProblem);
    }
    const f = parseIntentFile("---\nstatus: building\n---  \n# Intent: x\n");
    expect([f.frontmatter.status, f.title]).toEqual(["building", "x"]);
    // A --- inside a block value is indented, so it is the value's, not a fence.
    expect(parseIntentFile("---\nnote: |\n  a\n  ---\n  b\n---\n# Intent: x\n").frontmatter.note).toBe("a\n---\nb\n");
  });

  test("scanRepo lists a change whose fence is wrong under the ones a person needs to fix, with how", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "a"), { recursive: true });
      await Bun.write(join(t.path, "intent", "a", "intent.md"), "\n---\nstatus: accepted\n---\n# Intent: a\n");
      const scan = await scanRepo(t.path);
      expect(scan.intents).toEqual([]);
      expect(scan.unreadable.map((u) => [u.slug, u.problem])).toEqual([["a", "intent.md must start with a line of exactly three dashes (---) and close its top lines with another, with nothing else on either line. Fix them, and the change is picked up again."]]);
    } finally {
      t.cleanup();
    }
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

describe("hold", () => {
  test("a hold line is read as plain text; blank or absent reads as no hold", () => {
    const held = parseIntentFile("---\nstatus: building\nhold: waiting for legal (John, the dashboard)\n---\n# Intent: x\n");
    expect(held.frontmatter.hold).toBe("waiting for legal (John, the dashboard)");
    expect(parseIntentFile("---\nstatus: building\nhold:\n---\n# Intent: x\n").frontmatter.hold).toBe("");
    expect(parseIntentFile("---\nstatus: building\n---\n# Intent: x\n").frontmatter.hold).toBe("");
  });

  test("a hold that ends in blank lines, written last, is read back with them", () => {
    const held = parseIntentFile("---\nstatus: building\nhold: \"waiting for legal\\n\\n\"\n---\n# Intent: x\n");
    expect(parseIntentFile(serializeIntentFile(held)).frontmatter.hold).toBe("waiting for legal\n\n");
  });
});

describe("question", () => {
  test("question: open is read and written; blank or absent reads as none and gets no line, as a blank hold does", () => {
    const open = parseIntentFile("---\nstatus: designing\nquestion: open\n---\n# Intent: x\n");
    expect(open.frontmatter.question).toBe("open");
    expect(serializeIntentFile(open)).toContain("question: open\n");
    const none = parseIntentFile("---\nstatus: designing\nquestion:\nhold:\n---\n# Intent: x\n");
    expect(none.frontmatter.question).toBe("");
    const text = serializeIntentFile(none);
    expect(text).not.toContain("question");
    expect(text).not.toContain("hold");
    expect(text).toStartWith("---\nstatus: designing\n");
  });
});

describe("merge_gate", () => {
  test("pr or status is read; blank or absent reads as none and gets no line; anything else is a problem", () => {
    const gated = parseIntentFile("---\nstatus: merge-review\nmerge_gate: pr\n---\n# Intent: x\n");
    expect(gated.frontmatter.merge_gate).toBe("pr");
    expect(serializeIntentFile(gated)).toContain("merge_gate: pr\n");
    expect(parseIntentFile("---\nstatus: merge-review\nmerge_gate: status\n---\n# Intent: x\n").frontmatter.merge_gate).toBe("status");
    for (const blank of ["merge_gate:\n", "merge_gate: \"\"\n", ""]) {
      const none = parseIntentFile(`---\nstatus: merge-review\n${blank}---\n# Intent: x\n`);
      expect(none.frontmatter.merge_gate).toBeUndefined();
      expect(serializeIntentFile(none)).not.toContain("merge_gate");
    }
    expect(() => parseIntentFile("---\nstatus: merge-review\nmerge_gate: none\n---\n# Intent: x\n")).toThrow(FrontmatterProblem);
    expect(() => parseIntentFile("---\nstatus: merge-review\nmerge_gate: none\n---\n# Intent: x\n")).toThrow("intent.md frontmatter problem at merge_gate: must be pr or status, or the line removed");
  });
});
