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

  test("a file with Windows line endings keeps them; one stray CRLF does not convert the file", () => {
    const steps: Migration[] = [{ from: 1, run: (doc) => { doc.set("new_key", 7); } }];
    const crlf = migrateConfig(V1.replace(/\n/g, "\r\n"), steps, () => {}).text;
    expect(crlf).toContain("# my config\r\nversion: 2\r\n");
    expect(crlf).toContain("new_key: 7\r\n");
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
    const stray = migrateConfig(V1.replace("version: 1\n", "version: 1\r\n"), steps, () => {}).text;
    expect(stray).toContain("version: 2\n");
    expect(stray).not.toContain("\r");
  });

  test("a file at the latest version is left as it is", () => {
    const steps: Migration[] = [{ from: 1, run: () => { throw new Error("not run"); } }];
    const v2 = V1.replace("version: 1", "version: 2");
    expect(migrateConfig(v2, steps, () => {})).toEqual({ text: v2, from: 2, to: 2 });
  });

  test("a version newer than this Loopstra reads, or no whole-number version, is refused", () => {
    const steps: Migration[] = [{ from: 1, run: () => {} }];
    expect(() => migrateConfig(V1.replace("version: 1", "version: 3"), steps, () => {})).toThrow(
      "loopstra/config.yaml is version 3, newer than this Loopstra reads (2); run loopstra upgrade",
    );
    expect(() => migrateConfig(V1.replace("version: 1", "version: 2"), [], () => {})).toThrow("newer than this Loopstra reads (1)");
    for (const bad of ["version: 1.5", "version: two", "version: 0", "other_version: 1"]) {
      expect(() => migrateConfig(V1.replace("version: 1", bad), [], () => {})).toThrow("loopstra/config.yaml has no valid version");
    }
  });
});
