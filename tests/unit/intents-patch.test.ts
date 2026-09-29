import { describe, expect, test } from "bun:test";
import { parseIntentFile, patchFrontmatter } from "../../src/intents";

const OWNER = `---
status: draft
priority: normal          # low | normal | high | urgent, plain words
author: J. Ortiz
opened: 2026-09-28
note: ""                  # runtime writes plain-language guidance here
---
# Intent: claims status self-service

## Problem
People call.
`;

describe("patchFrontmatter", () => {
  test("changes only the keys it is given; comments, other keys, their order, and the body stay as they were", () => {
    const out = patchFrontmatter(OWNER, { status: "accepted", note: "Read spec.md. When you are happy with it, change the status line to spec-approved." });
    expect(out).toBe(OWNER
      .replace("status: draft", "status: accepted")
      .replace('note: ""                  #', "note: Read spec.md. When you are happy with it, change the status line to spec-approved.                  #"));
    const f = parseIntentFile(out);
    expect(f.frontmatter.status).toBe("accepted");
    expect(f.frontmatter.priority).toBe("normal");
  });

  test("a key that is not there is added just before the closing line", () => {
    const out = patchFrontmatter("---\nstatus: designing\n# a person's comment\n---\n# Intent: x\n", { resume_from: "accepted" });
    expect(out).toBe("---\nstatus: designing\n# a person's comment\nresume_from: accepted\n---\n# Intent: x\n");
  });

  test("CRLF files stay CRLF, and a leading BOM stays", () => {
    const crlf = "﻿---\r\nstatus: accepted\r\nnote: \"\"\r\n---\r\n# Intent: x\r\n\r\n## Problem\r\np\r\n";
    const out = patchFrontmatter(crlf, { status: "designing", resume_from: "accepted" });
    expect(out).toBe("﻿---\r\nstatus: designing\r\nnote: \"\"\r\nresume_from: accepted\r\n---\r\n# Intent: x\r\n\r\n## Problem\r\np\r\n");
  });

  test("values that need quoting are quoted, and a multi-line value is replaced whole", () => {
    const text = "---\nstatus: blocked\nnote: |\n  line one\n  line two\nauthor: A\n---\nbody\n";
    const out = patchFrontmatter(text, { status: "accepted", note: "Why: it failed.\nSecond line" });
    const f = parseIntentFile(out);
    expect(f.frontmatter.note).toBe("Why: it failed.\nSecond line");
    expect(f.frontmatter.author).toBe("A");
    expect(out.split("\n").filter((l) => l.startsWith("note:"))).toHaveLength(1);
    expect(out).not.toContain("line two");
    expect(out.endsWith("---\nbody\n")).toBe(true);
  });

  test("a file without frontmatter gets one, and the text below is kept", () => {
    const out = patchFrontmatter("# Intent: x\n\n## Problem\np\n", { status: "blocked", note: "Fix it." });
    expect(out).toBe("---\nstatus: blocked\nnote: Fix it.\n---\n# Intent: x\n\n## Problem\np\n");
  });

  test("a frontmatter shape the line patcher cannot handle falls back to a full rewrite that still parses", () => {
    const out = patchFrontmatter("---\n{status: draft, author: A}\n---\n# Intent: x\n", { status: "accepted" });
    const f = parseIntentFile(out);
    expect(f.frontmatter.status).toBe("accepted");
    expect(f.frontmatter.author).toBe("A");
  });
});
