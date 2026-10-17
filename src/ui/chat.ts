export interface Line { key: string; kind: "person" | "loopstra" | "announce"; text: string }
export interface About { slug?: string; title: string }

/** Adds the lines not shown yet. Two reads of the same messages can overlap, and a message must not appear twice. */
export function addLines(shown: Line[], more: Line[]): Line[] {
  const seen = new Set(shown.map((l) => l.key));
  const fresh: Line[] = [];
  for (const l of more) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    fresh.push(l);
  }
  return fresh.length ? [...shown, ...fresh] : shown;
}

/** What starts the first message sent from a change: the slug names it for the orchestrator, the title is for the person. */
export function aboutPrefix(about: About | null): string {
  if (!about) return "";
  return about.slug ? `About ${about.slug} (${about.title}): ` : `About ${about.title}: `;
}
