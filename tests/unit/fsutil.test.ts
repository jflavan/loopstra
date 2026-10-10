import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
});
