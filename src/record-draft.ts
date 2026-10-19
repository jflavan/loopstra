import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One file a record changes: its new text, or null when the record removes it. Paths are relative to the repository, with forward slashes. */
export interface DraftChange { rel: string; text: string | null }

/**
 * The files one record changes, held in memory until commitRecord has committed them (see
 * src/context.ts): a record's write callback writes here, never into the checkout. A read gives the
 * draft's version, else the file on disk. Only the change's own folder (`intent/<slug>/`) and the
 * generated `intent/queue.md` may be written: a record never writes elsewhere.
 */
export class RecordDraft {
  private readonly drafted = new Map<string, string | null>();

  constructor(readonly root: string, readonly slug: string) {}

  /** Throws for a path outside the change's folder and queue.md, including one that climbs out with `..` or uses a backslash. */
  private check(rel: string): void {
    const inFolder = rel.startsWith(`intent/${this.slug}/`) && !rel.split("/").includes("..") && !rel.includes("\\");
    if (!inFolder && rel !== "intent/queue.md") throw new Error(`a record of ${this.slug} cannot write ${rel}`);
  }

  /** The draft's version of the file, else what is on disk; null when neither has it. */
  read(rel: string): string | null {
    this.check(rel);
    if (this.drafted.has(rel)) return this.drafted.get(rel) ?? null;
    try {
      return readFileSync(join(this.root, rel), "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
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
