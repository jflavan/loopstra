import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonAs, writeFileAtomic, writeJson } from "../../src/fsutil";
import { tempDir } from "../helpers";

describe("readJsonAs", () => {
  const Shape = z.object({ by: z.string(), seq: z.number(), via: z.string().default("chat") });

  test("gives the file's value when it has the shape, with the schema's defaults filled in", () => {
    const t = tempDir();
    try {
      const path = join(t.path, "a.json");
      writeJson(path, { by: "John", seq: 3 });
      expect(readJsonAs(path, Shape)).toEqual({ by: "John", seq: 3, via: "chat" });
    } finally { t.cleanup(); }
  });

  test("gives null for a file that is missing, not JSON, or not the shape", () => {
    const t = tempDir();
    try {
      expect(readJsonAs(join(t.path, "missing.json"), Shape)).toBeNull();
      writeFileSync(join(t.path, "broken.json"), "{ not json");
      expect(readJsonAs(join(t.path, "broken.json"), Shape)).toBeNull();
      writeJson(join(t.path, "wrong.json"), { by: 7, seq: "3" });
      expect(readJsonAs(join(t.path, "wrong.json"), Shape)).toBeNull();
      writeJson(join(t.path, "short.json"), { by: "John" });
      expect(readJsonAs(join(t.path, "short.json"), Shape)).toBeNull();
      writeJson(join(t.path, "list.json"), ["John"]);
      expect(readJsonAs(join(t.path, "list.json"), Shape)).toBeNull();
    } finally { t.cleanup(); }
  });
});

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
