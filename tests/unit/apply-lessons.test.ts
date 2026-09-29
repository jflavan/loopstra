import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyLessons } from "../../src/commands/apply-lessons";
import { tempDir } from "../helpers";

describe("applyLessons", () => {
  test("appends the proposed additions to CLAUDE.md under a Lessons heading once", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "one"), { recursive: true });
      await Bun.write(join(t.path, "intent", "one", "lessons.md"), "# Lessons\n\n## Evidence\n- x\n\n## Lessons\n- l\n\n## Proposed CLAUDE.md additions\n- Exported functions get a doc comment.\n- Never log tokens.\n");
      await Bun.write(join(t.path, "CLAUDE.md"), "# Project\n");
      const r = await applyLessons(t.path, "one");
      expect(r.added).toEqual(["- Exported functions get a doc comment.", "- Never log tokens."]);
      const text = await Bun.file(join(t.path, "CLAUDE.md")).text();
      expect(text).toBe("# Project\n\n## Lessons\n- Exported functions get a doc comment.\n- Never log tokens.\n");
      const again = await applyLessons(t.path, "one");
      expect(again.added).toEqual([]);
      expect((await Bun.file(join(t.path, "CLAUDE.md")).text()).match(/Never log tokens/g)?.length).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("reports when there is nothing to apply", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "one"), { recursive: true });
      await Bun.write(join(t.path, "intent", "one", "lessons.md"), "# Lessons\n\n## Proposed CLAUDE.md additions\nNone.\n");
      const r = await applyLessons(t.path, "one");
      expect(r.added).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("reads CRLF files and star bullets, stops at the next heading, and keeps CLAUDE.md's line endings", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "one"), { recursive: true });
      await Bun.write(join(t.path, "intent", "one", "lessons.md"), "# Lessons\r\n\r\n## Proposed CLAUDE.md additions\r\n* Run the linter first.\r\n\r\n## Needs a person\r\n- Not a lesson.\r\n");
      await Bun.write(join(t.path, "CLAUDE.md"), "# Project\r\n\r\n## Lessons\r\n- Old lesson.\r\n");
      const r = await applyLessons(t.path, "one");
      expect(r.added).toEqual(["- Run the linter first."]);
      expect(await Bun.file(join(t.path, "CLAUDE.md")).text()).toBe("# Project\r\n\r\n## Lessons\r\n- Old lesson.\r\n- Run the linter first.\r\n");
    } finally {
      t.cleanup();
    }
  });

  test("adds to an existing Lessons section even when another section follows it", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "one"), { recursive: true });
      await Bun.write(join(t.path, "intent", "one", "lessons.md"), "## Proposed CLAUDE.md additions\n- New.\n");
      await Bun.write(join(t.path, "CLAUDE.md"), "# Project\n\n## Lessons\n- Old.\n\n## Commands\n- bun test\n");
      await applyLessons(t.path, "one");
      expect(await Bun.file(join(t.path, "CLAUDE.md")).text()).toBe("# Project\n\n## Lessons\n- Old.\n- New.\n\n## Commands\n- bun test\n");
    } finally {
      t.cleanup();
    }
  });

  test("creates CLAUDE.md when there is none", async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.path, "intent", "one"), { recursive: true });
      await Bun.write(join(t.path, "intent", "one", "lessons.md"), "## Proposed CLAUDE.md additions\n- A.\n");
      await applyLessons(t.path, "one");
      expect(await Bun.file(join(t.path, "CLAUDE.md")).text()).toBe("# Project\n\n## Lessons\n- A.\n");
    } finally {
      t.cleanup();
    }
  });

  test("says plainly when there are no lessons yet, and refuses a slug that is not a folder name", async () => {
    const t = tempDir();
    try {
      await expect(applyLessons(t.path, "one")).rejects.toThrow("one has no lessons.md yet");
      await expect(applyLessons(t.path, "../one")).rejects.toThrow("not a change name");
    } finally {
      t.cleanup();
    }
  });
});
