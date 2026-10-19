import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { FrontmatterProblem, parseIntentFile, patchFrontmatter, readIntent, writeIntent } from "../../src/intents";
import { tempDir } from "../helpers";

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

  test("a fence parse refuses is refused here too: a patch never puts a second frontmatter block in front of the first", () => {
    for (const text of ["\n---\nstatus: building\n---\n# Intent: x\n", "--- \nstatus: building\n---\n# Intent: x\n", "---\nstatus: building\n# Intent: x\n"]) {
      expect(() => patchFrontmatter(text, { status: "reviewing" })).toThrow(FrontmatterProblem);
    }
    // No newline after the closing fence: patched in place, one block.
    const out = patchFrontmatter("---\nstatus: building\n---", { status: "reviewing" });
    expect(out).toBe("---\nstatus: reviewing\n---");
    expect(out.split("\n").filter((l) => l === "---")).toHaveLength(2);
  });

  test("an indented comment line after the patched key stays: only a block scalar's lines are its value's", () => {
    const raw = "---\nstatus: building\n  # a person's note about priority\npriority: high\n---\n# Intent: x\n";
    expect(patchFrontmatter(raw, { status: "reviewing" })).toBe("---\nstatus: reviewing\n  # a person's note about priority\npriority: high\n---\n# Intent: x\n");
    const held = "---\nstatus: building\nhold: legal\n  # a person's note about priority\npriority: high\n---\n# Intent: x\n";
    expect(patchFrontmatter(held, {}, ["hold"])).toBe("---\nstatus: building\n  # a person's note about priority\npriority: high\n---\n# Intent: x\n");
    // Inside a block scalar an indented # line is text, and goes with the value.
    const block = "---\nnote: |\n  # not a comment\n  more\nstatus: building\n---\n";
    expect(patchFrontmatter(block, { note: "new" })).toBe("---\nnote: new\nstatus: building\n---\n");
    expect(patchFrontmatter("---\nnote: >-\n  # not a comment\nstatus: building\n---\n", {}, ["note"])).toBe("---\nstatus: building\n---\n");
  });

  test("a value YAML would read as something else is quoted, and reads back as the same text", () => {
    const values = ["true", "123", "null", "#x", "a: b", "- x", "[a]", "~", "2026-09-28", "  leading", "trailing  ", "yes", "1e3", "0x1f", "", "a # b", "'quoted'", '"double"', "*ref", "&anchor", "!tag", "%percent", "@at", "`tick`", "|", ">", "{a: 1}", "key:"];
    for (const value of values) {
      const out = patchFrontmatter("---\nstatus: building\nnote: old\n---\n# Intent: x\n", { note: value, hold: value });
      const f = parseIntentFile(out);
      expect([value, f.frontmatter.note]).toEqual([value, value]);
      expect([value, f.frontmatter.hold]).toEqual([value, value]);
      expect(f.frontmatter.status).toBe("building");
    }
  });
});

describe("removing a line", () => {
  test("a removed key's line goes, with its comment and any lines it went on over; the rest stays as it was", () => {
    const raw = "---\nstatus: building # now\nhold: >-\n  waiting for\n  legal\npriority: high\n---\n# Intent: x\n";
    expect(patchFrontmatter(raw, {}, ["hold"])).toBe("---\nstatus: building # now\npriority: high\n---\n# Intent: x\n");
  });

  test("removing a key that is not there changes nothing; patch and remove together", () => {
    const raw = "---\r\nstatus: building\r\n---\r\nbody\r\n";
    expect(patchFrontmatter(raw, {}, ["hold"])).toBe(raw);
    expect(patchFrontmatter("---\nstatus: building\nhold: x\n---\n", { status: "closed" }, ["hold"])).toBe("---\nstatus: closed\n---\n");
  });

  test("writeIntent removes keys it is told to, and refuses when the status moved on", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "a"), { recursive: true });
      await Bun.write(join(t.path, "intent", "a", "intent.md"), "---\nstatus: building\nhold: x\n---\n# Intent: a\n");
      const i = await readIntent(t.path, "a");
      expect(await writeIntent(i, {}, { expectStatus: "reviewing", remove: ["hold"] })).toBe(false);
      expect(await writeIntent(i, {}, { expectStatus: "building", remove: ["hold"] })).toBe(true);
      expect(await Bun.file(join(t.path, "intent", "a", "intent.md")).text()).toBe("---\nstatus: building\n---\n# Intent: a\n");
      expect(i.file.frontmatter.hold).toBe("");
      // A deleted change is not written back.
      rmSync(join(t.path, "intent", "a"), { recursive: true });
      expect(await writeIntent(i, { status: "closed" })).toBe(false);
      expect(existsSync(join(t.path, "intent", "a"))).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("writeIntent replaces intent.md whole, never rewrites it in place, and leaves no temp file in the change's folder", async () => {
    const t = tempDir();
    try {
      const path = join(t.path, "intent", "a", "intent.md");
      const before = "---\nstatus: building\n---\n# Intent: a\n";
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, before);
      const i = await readIntent(t.path, "a");
      const id = statSync(path, { bigint: true }).ino;
      expect(await writeIntent(i, { status: "reviewing" })).toBe(true);
      // Another file was renamed over it: a reader (the console, chat, a person's editor) never sees it emptied and half written.
      expect(statSync(path, { bigint: true }).ino).not.toBe(id);
      expect(await Bun.file(path).text()).toBe("---\nstatus: reviewing\n---\n# Intent: a\n");
      expect(readdirSync(dirname(path))).toEqual(["intent.md"]);
    } finally {
      t.cleanup();
    }
  });
});
