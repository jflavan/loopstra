import { existsSync, readFileSync, renameSync } from "node:fs";
import type { z } from "zod";
import { issuesText } from "../sessions";

/** The files already reported as damaged in this process, so a file that cannot be moved aside is one line, not one per read. */
const reported = new Set<string>();

/**
 * A JSON state file chat keeps (a thread, the Discord threads, the announcer's memory), checked
 * against `schema` with its defaults filled in, or null when there is no file. A file that is not
 * JSON or not the shape is moved aside as `<name>.bad-<time>` and said once in the log, and null
 * is given then too: it is never read as empty and written over, which would lose what a person
 * could still recover from it.
 */
export function readStateFile<T>(path: string, schema: z.ZodType<T>, log: (line: string) => void = (l) => console.error(l)): T | null {
  if (!existsSync(path)) return null;
  let problem: string;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) { reported.delete(path); return parsed.data; }
    problem = issuesText(parsed.error.issues);
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  const aside = `${path}.bad-${Date.now()}`;
  let moved = true;
  try { renameSync(path, aside); } catch { moved = false; }
  if (moved || !reported.has(path)) log(`${path} could not be read (${problem}); ${moved ? `it was moved to ${aside} and a fresh one starts` : "it could not be moved aside, so it is ignored"}.`);
  reported.add(path);
  return null;
}
