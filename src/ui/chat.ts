export interface Line { key: string; kind: "person" | "loopstra" | "announce"; text: string }
/** Where the drawer was opened from: a change (`slug`), and a session of it (`seq`), or a page with a title only. */
export interface About { slug?: string; title: string; seq?: number }

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

/** What the first message from a change sends with it, so the orchestrator hears that change's context (and the session's); null without a change. */
export function aboutOf(about: About | null): { slug: string; seq?: number } | null {
  if (!about?.slug) return null;
  return about.seq !== undefined ? { slug: about.slug, seq: about.seq } : { slug: about.slug };
}
