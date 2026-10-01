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
  return people.length > 1 ? `${people.slice(0, -1).join(", ")} and ${people.at(-1)}` : people[0]!;
}

/** Reconnects a dropped connection, waiting 1, 2, 4 ... up to 30 seconds between tries. */
export class Reconnector {
  private delay = 1_000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;

  constructor(private readonly connect: () => Promise<void>, private readonly onError: (e: string) => void) {}

  succeeded(): void { this.delay = 1_000; }

  schedule(): void {
    if (this.cancelled || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.cancelled) return;
      try {
        await this.connect();
      } catch (e) {
        this.onError(e instanceof Error ? e.message : String(e));
        this.delay = Math.min(30_000, this.delay * 2);
        this.schedule();
      }
    }, this.delay);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
