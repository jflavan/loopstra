import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/fsutil";
import { tempDir } from "../helpers";

describe("writeFileAtomic", () => {
  test("writes the whole file, makes its folder, and leaves no temp file", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "a", "b", "c.json");
      writeFileAtomic(path, "one");
      writeFileAtomic(path, "two");
      expect(readFileSync(path, "utf8")).toBe("two");
      expect(readdirSync(join(t.path, "a", "b"))).toEqual(["c.json"]);
    } finally { t.cleanup(); }
  });

  test("with a temp folder, the temp file is made there and renamed over the file", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "intent", "x", "intent.md");
      const tmpDir = join(t.path, ".loopstra");
      writeFileAtomic(path, "one");
      const id = statSync(path, { bigint: true }).ino;
      writeFileAtomic(path, "two", tmpDir);
      expect(readFileSync(path, "utf8")).toBe("two");
      expect(statSync(path, { bigint: true }).ino).not.toBe(id);
      expect(readdirSync(join(t.path, "intent", "x"))).toEqual(["intent.md"]);
      expect(readdirSync(tmpDir)).toEqual([]);
    } finally { t.cleanup(); }
  });
});
