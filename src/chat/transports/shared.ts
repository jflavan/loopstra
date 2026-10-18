import { userInfo } from "node:os";
import { andList } from "../../text";

/** Splits a message into parts of at most `max` characters, at line breaks where it can. */
export function chunkText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [""];
}

/** "a, b and c" for the people who may start drafts, or who to ask when there are none. */
export function mentionList(people: string[], setting: string): string {
  if (!people.length) return `nobody here yet (an engineer can add people to ${setting})`;
  return andList(people);
}

/** How long a refusal a retry cannot fix waits between tries (see Reconnector.slowly). */
const REFUSED_WAIT_MS = 5 * 60_000;

/**
 * Reconnects a dropped connection, waiting 1, 2, 4 ... up to 30 seconds between tries, until one
 * succeeds: a connection that opens and is closed again backs off like one that does not open.
 */
export class Reconnector {
  private delay = 1_000;
  private longest = 30_000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  constructor(private readonly connect: () => Promise<void>, private readonly onError: (e: string) => void) {}

  succeeded(): void { this.delay = 1_000; this.longest = 30_000; }

  /** Tries wait REFUSED_WAIT_MS until one succeeds: a person can fix the cause (a token, a setting) without a restart. */
  slowly(): void { this.delay = this.longest = REFUSED_WAIT_MS; }

  schedule(): void {
    if (this.cancelled || this.timer) return;
    const wait = this.delay;
    this.delay = Math.min(this.longest, this.delay * 2);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.cancelled) return;
      try {
        await this.connect();
      } catch (e) {
        this.onError(e instanceof Error ? e.message : String(e));
        this.schedule();
      }
    }, wait);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The person at this machine (the terminal and the dashboard), by their login name. */
export function localUser(): string {
  try { return userInfo().username || "you"; } catch { return "you"; }
}
