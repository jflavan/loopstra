import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./shell";

/** One file a record changes: its new text, or null when the record removes it. Paths are relative to the repository, with forward slashes. */
export interface DraftChange { rel: string; text: string | null }

/**
 * The files one record changes, held in memory until commitRecord has committed them (see
 * src/context.ts): a record's write callback writes here, never into the checkout. A read gives the
 * draft's version, else the file on disk. Only the change's own folder (`intent/<slug>/`) and the
 * generated `intent/queue.md` may be written, or, for a record given its own `paths` (a settings
 * record's loopstra/config.yaml), exactly those files: a record never writes elsewhere.
 */
export class RecordDraft {
  private readonly drafted = new Map<string, string | null>();
  /** What each file held on disk when the draft first read it there (null: not there). */
  private readonly onDisk = new Map<string, Buffer | null>();

  constructor(readonly root: string, readonly slug: string, private readonly paths?: readonly string[]) {}

  /**
   * Throws for a path outside the change's folder and queue.md, or not one of `paths` when it was
   * given. Inside the folder, an empty, `.` or `..` segment (each names a file two ways, climbs out,
   * or names none) and a backslash are refused too.
   */
  private check(rel: string): void {
    if (this.paths) {
      if (!this.paths.includes(rel)) throw new Error(`a record of ${this.slug} cannot write ${rel}`);
      return;
    }
    const prefix = `intent/${this.slug}/`;
    const inFolder = rel.startsWith(prefix) && !rel.includes("\\")
      && rel.slice(prefix.length).split("/").every((s) => s !== "" && s !== "." && s !== "..");
    if (!inFolder && rel !== "intent/queue.md") throw new Error(`a record of ${this.slug} cannot write ${rel}`);
  }

  /** The draft's version of the file, else what is on disk; null when neither has it. */
  read(rel: string): string | null {
    this.check(rel);
    if (this.drafted.has(rel)) return this.drafted.get(rel) ?? null;
    let bytes: Buffer | null;
    try {
      bytes = readFileSync(join(this.root, rel));
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
      bytes = null;
    }
    if (!this.onDisk.has(rel)) this.onDisk.set(rel, bytes);
    return bytes === null ? null : bytes.toString("utf8");
  }

  /**
   * What the file held on disk when the draft first read it there (null: it was not there), or
   * undefined when the draft never read it from disk. commitRecord tells a person's save by it.
   */
  readFromDisk(rel: string): Buffer | null | undefined {
    return this.onDisk.get(rel);
  }

  write(rel: string, text: string): void {
    this.check(rel);
    this.drafted.set(rel, text);
  }

  remove(rel: string): void {
    this.check(rel);
    this.drafted.set(rel, null);
  }

  /** Every file written or removed, in the order first touched. */
  changes(): DraftChange[] {
    return [...this.drafted].map(([rel, text]) => ({ rel, text }));
  }
}
