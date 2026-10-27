import { existsSync, readFileSync, renameSync } from "node:fs";
import type { z } from "zod";
import { issuesText } from "../sessions";
import { errorText } from "../shell";

/** The files already reported in this process (unreadable, or damaged and kept), so a lasting problem is one line, not one per read. */
const reported = new Set<string>();

/**
 * Thrown when a state file is there but cannot be used now: it could not be read (busy or locked for
 * a moment, as Windows does), or it is damaged and could not be moved aside. The caller must not
 * start afresh and write over it: that would lose what it holds.
 */
export class StateFileUnavailable extends Error {}

/**
 * A JSON state file chat keeps (a thread, the Discord threads, the announcer's memory), checked
 * against `schema` with its defaults filled in, or null when there is no file. A file that is not
 * JSON or not the shape is moved aside as `<name>.bad-<time>` and said once in the log, and null
 * is given then too: it is never read as empty and written over, which would lose what a person
 * could still recover from it. A file that cannot be read, or a damaged one that cannot be moved
 * aside, is left where it is, said once, and StateFileUnavailable is thrown (see it).
 */
export function readStateFile<T>(path: string, schema: z.ZodType<T>, log: (line: string) => void = (l) => console.error(l)): T | null {
  if (!existsSync(path)) return null;
  const once = (line: string) => {
    if (!reported.has(path)) log(line);
    reported.add(path);
  };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    const why = errorText(e);
    once(`${path} could not be read (${why}); it is left as it is and tried again next time.`);
    throw new StateFileUnavailable(`${path} could not be read: ${why}`);
  }
  let problem: string;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) { reported.delete(path); return parsed.data; }
    problem = issuesText(parsed.error.issues);
  } catch (e) {
    problem = errorText(e);
  }
  const aside = `${path}.bad-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch {
    once(`${path} is damaged (${problem}) and could not be moved aside, so it is kept and not used until a person moves or fixes it.`);
    throw new StateFileUnavailable(`${path} is damaged and could not be moved aside`);
  }
  reported.delete(path);
  log(`${path} could not be read (${problem}); it was moved to ${aside} and a fresh one starts.`);
  return null;
}
