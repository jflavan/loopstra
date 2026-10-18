import { describe, expect, test } from "bun:test";
import { CONFIG_VERSION, migrateConfig, type Migration } from "../../src/upgrade/migrations";

const V1 = "# my config\nversion: 1\nold_key: 5 # keep this comment\nother: x\n";

describe("migrateConfig", () => {
  test("no migrations: the text is unchanged", () => {
    expect(migrateConfig(V1, [], () => {})).toEqual({ text: V1, from: 1, to: 1 });
    expect(CONFIG_VERSION).toBe(1);
  });

  test("runs each step from the file's version, keeping comments, and sets the version", () => {
    const steps: Migration[] = [{ from: 1, run: (doc) => { doc.set("new_key", doc.get("old_key")); doc.delete("old_key"); } }];
    const r = migrateConfig(V1, steps, () => {});
    expect(r.from).toBe(1);
    expect(r.to).toBe(2);
    expect(r.text).toContain("# my config");
    expect(r.text).toContain("version: 2");
    expect(r.text).toContain("new_key: 5");
    expect(r.text).not.toContain("old_key");
  });

  test("a step that throws, or a result that does not load, names the problem and gives nothing", () => {
    const bad: Migration[] = [{ from: 1, run: () => { throw new Error("boom"); } }];
    expect(() => migrateConfig(V1, bad, () => {})).toThrow("config migration from version 1 failed: boom");
    const ok: Migration[] = [{ from: 1, run: () => {} }];
    expect(() => migrateConfig(V1, ok, () => { throw new Error("commands.test is required"); })).toThrow("commands.test is required");
  });
});
