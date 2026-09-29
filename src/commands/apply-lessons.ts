import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies the bullets under "## Proposed CLAUDE.md additions" in a change's lessons.md (written for
 * engineers when the change is verified) into the repository's CLAUDE.md, under "## Lessons".
 * Bullets already present are skipped, so running it twice adds nothing. Returns the bullets it added.
 */
export async function applyLessons(root: string, slug: string): Promise<{ added: string[] }> {
  if (!slug || /[\\/:]|^\.\.?$/.test(slug)) throw new Error(`"${slug}" is not a change name. Use the folder name under intent/.`);
  const lessonsPath = join(root, "intent", slug, "lessons.md");
  if (!existsSync(lessonsPath)) throw new Error(`${slug} has no lessons.md yet. Lessons are proposed when a change is verified.`);
  const bullets = proposedAdditions(await Bun.file(lessonsPath).text());
  const claudePath = join(root, "CLAUDE.md");
  const existing = existsSync(claudePath) ? await Bun.file(claudePath).text() : "# Project\n";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const added = bullets.filter((b, n) => !existing.includes(b.slice(2)) && bullets.indexOf(b) === n);
  if (!added.length) return { added };
  const lines = existing.trimEnd().split(/\r?\n/);
  const heading = lines.findIndex((l) => /^##\s+Lessons\s*$/.test(l));
  if (heading < 0) {
    lines.push("", "## Lessons", ...added);
  } else {
    // At the end of the Lessons section, before any blank lines that lead into the next heading.
    let end = lines.findIndex((l, n) => n > heading && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    while (end - 1 > heading && !lines[end - 1]!.trim()) end--;
    lines.splice(end, 0, ...added);
  }
  await Bun.write(claudePath, lines.join(eol) + eol);
  return { added };
}

/** The bullets of the "Proposed CLAUDE.md additions" section, each as "- text". */
function proposedAdditions(lessons: string): string[] {
  const lines = lessons.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Proposed CLAUDE\.md additions\s*$/i.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const m = /^\s*[-*]\s+(\S.*?)\s*$/.exec(line);
    if (m) out.push(`- ${m[1]}`);
  }
  return out;
}
