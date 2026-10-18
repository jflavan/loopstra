import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeText, upgradeFile } from "../../src/upgrade/files";
import { textSha, type ManagedFile } from "../../src/stamp";
import { tempDir } from "../helpers";

const BASE = "# Title\n\nline a\nline b\nline c\n";
const NEW = "# Title\n\nline a\nline b changed\nline c\n";

function setup(theirs: string | null) {
  const t = tempDir();
  mkdirSync(join(t.path, "pkg"), { recursive: true });
  writeFileSync(join(t.path, "pkg", "REVIEW.md"), NEW);
  if (theirs !== null) writeFileSync(join(t.path, "REVIEW.md"), theirs);
  const file: ManagedFile = { path: "REVIEW.md", template: "templates/REVIEW.md", shipped: join(t.path, "pkg", "REVIEW.md") };
  return { t, file };
}

describe("upgradeFile", () => {
  test("an unedited file is replaced", async () => {
    const { t, file } = setup(BASE);
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(r).toEqual({ path: "REVIEW.md", outcome: "replaced", entry: { base: textSha(NEW) } });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe(NEW);
    } finally { t.cleanup(); }
  });

  test("a file already at the new text is unchanged", async () => {
    const { t, file } = setup(NEW);
    try {
      expect((await upgradeFile(t.path, file, { base: textSha(NEW) }, async () => null, { write: true })).outcome).toBe("unchanged");
    } finally { t.cleanup(); }
  });

  test("an edited file is merged", async () => {
    const { t, file } = setup("# Title\n\nline a\nline b\nline c\nmy own line\n");
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(r.outcome).toBe("merged");
      expect(r.entry).toEqual({ base: textSha(NEW) });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe("# Title\n\nline a\nline b changed\nline c\nmy own line\n");
    } finally { t.cleanup(); }
  });

  test("a conflict leaves markers and keeps the old base", async () => {
    const { t, file } = setup("# Title\n\nline a\nline b mine\nline c\n");
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(r.outcome).toBe("conflict");
      expect(r.entry).toEqual({ base: textSha(BASE) });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toContain("<<<<<<<");
    } finally { t.cleanup(); }
  });

  test("an edited file whose base cannot be fetched is left alone", async () => {
    const { t, file } = setup("mine\n");
    try {
      const r = await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => null, { write: true });
      expect(r.outcome).toBe("no-base");
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe("mine\n");
    } finally { t.cleanup(); }
  });

  test("deleted on purpose stays deleted; a new managed file is written; a just-deleted one is recorded", async () => {
    const { t, file } = setup(null);
    try {
      expect((await upgradeFile(t.path, file, { base: "x", deleted: true }, async () => null, { write: true })).outcome).toBe("deleted");
      expect(existsSync(join(t.path, "REVIEW.md"))).toBe(false);
      const fresh = await upgradeFile(t.path, file, undefined, async () => null, { write: true });
      expect(fresh).toEqual({ path: "REVIEW.md", outcome: "added", entry: { base: textSha(NEW) } });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe(NEW);
    } finally { t.cleanup(); }
    const again = setup(null);
    try {
      const r = await upgradeFile(again.t.path, again.file, { base: textSha(BASE) }, async () => null, { write: true });
      expect(r).toEqual({ path: "REVIEW.md", outcome: "deleted", entry: { base: textSha(BASE), deleted: true } });
    } finally { again.t.cleanup(); }
  });

  test("with write false nothing is written", async () => {
    const { t, file } = setup(BASE);
    try {
      expect((await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: false })).outcome).toBe("replaced");
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe(BASE);
    } finally { t.cleanup(); }
  });

  test("a CRLF file stays CRLF after a merge", async () => {
    const { t, file } = setup("# Title\r\n\r\nline a\r\nline b\r\nline c\r\nmine\r\n");
    try {
      await upgradeFile(t.path, file, { base: textSha(BASE) }, async () => BASE, { write: true });
      expect(readFileSync(join(t.path, "REVIEW.md"), "utf8")).toBe("# Title\r\n\r\nline a\r\nline b changed\r\nline c\r\nmine\r\n");
    } finally { t.cleanup(); }
  });
});

describe("mergeText", () => {
  test("clean and conflicting merges", async () => {
    // git takes edits on adjacent lines as one conflict, so the clean case keeps a line between them.
    expect(await mergeText("a\nb\nmine\n", "a\nb\n", "A\nb\n")).toEqual({ text: "A\nb\nmine\n", conflict: false });
    expect((await mergeText("a\nX\n", "a\nb\n", "a\nY\n")).conflict).toBe(true);
  });
});
