import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Git, readBlobs } from "./git";
import { isDev, PACKAGE_ROOT } from "./package";
import { textSha, type ManagedFile } from "./stamp";

/** Every text each template has had: its textSha and the first commit that had it, oldest first. Keyed by `templates/...` path. */
export type ShippedIndex = Record<string, Array<{ sha: string; commit: string }>>;

/** Gets a template's text at a commit, or null when it cannot. */
export type FetchText = (template: string, commit: string) => Promise<string | null>;

/** Where a release's base texts are read from. LOOPSTRA_RAW_URL is for tests only. */
const RAW_URL = process.env.LOOPSTRA_RAW_URL ?? "https://raw.githubusercontent.com/jflavan/loopstra";

/** The texts of these blobs (see readBlobs); a blob git does not have is left out. */
async function blobTexts(repo: string, blobs: string[]): Promise<Map<string, string>> {
  const dec = new TextDecoder();
  return new Map([...(await readBlobs(repo, blobs))].map(([blob, bytes]) => [blob, dec.decode(bytes)]));
}

/**
 * Builds the index from a Loopstra checkout's git history (a release does this; so does a development
 * checkout, which has no shipped.json): every file under templates/ in every commit that touched
 * templates/, on any line of history. Each commit's tree is listed once and each distinct blob read
 * once, so it takes seconds on the whole history.
 */
export async function buildShippedIndex(repo: string): Promise<ShippedIndex> {
  const git = new Git(repo);
  const log = await git.run(["log", "--reverse", "--full-history", "--format=%H", "--", "templates"]);
  const seen: Array<{ commit: string; path: string; blob: string }> = [];
  for (const commit of log.out.split(/\r?\n/).filter(Boolean)) {
    const tree = await git.run(["ls-tree", "-r", "-z", commit, "--", "templates"]);
    for (const line of tree.out.split("\0").filter(Boolean)) {
      // "<mode> <type> <object>\t<path>"
      const tab = line.indexOf("\t");
      const [, type, blob] = line.slice(0, tab).split(" ");
      if (type === "blob") seen.push({ commit, path: line.slice(tab + 1), blob: blob! });
    }
  }
  const texts = await blobTexts(repo, [...new Set(seen.map((s) => s.blob))]);
  const index: ShippedIndex = {};
  for (const { commit, path, blob } of seen) {
    const text = texts.get(blob);
    if (text === undefined) continue;
    const sha = textSha(text);
    const entries = (index[path] ??= []);
    if (!entries.some((e) => e.sha === sha)) entries.push({ sha, commit });
  }
  return index;
}

/** The installed package's index: its shipped.json, or, in a development checkout, built from the checkout's history. */
export async function loadShippedIndex(): Promise<ShippedIndex> {
  const file = join(PACKAGE_ROOT, "shipped.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as ShippedIndex;
  return isDev() ? buildShippedIndex(PACKAGE_ROOT) : {};
}

/** Fetches a template's text at a commit: `git show` in a development checkout, else from GitHub. */
export const fetchShipped: FetchText = async (template, commit) => {
  if (isDev() && !process.env.LOOPSTRA_RAW_URL) {
    const r = await new Git(PACKAGE_ROOT).run(["show", `${commit}:${template}`], true);
    return r.code === 0 ? r.out : null;
  }
  try {
    const res = await fetch(`${RAW_URL}/${commit}/${template}`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

/** Whether a text is one the template has shipped with. */
export function wasShipped(index: ShippedIndex, template: string, text: string): boolean {
  const sha = textSha(text);
  return (index[template] ?? []).some((e) => e.sha === sha);
}

/** The text of the shipped version with this sha, or null when it is not in the index or cannot be fetched. */
export async function baseText(index: ShippedIndex, template: string, sha: string, fetchText: FetchText = fetchShipped): Promise<string | null> {
  const entry = (index[template] ?? []).find((e) => e.sha === sha);
  return entry ? fetchText(template, entry.commit) : null;
}

/** Lines in one text and not the other, counted both ways (a multiset difference). */
function differingLines(a: string, b: string): number {
  const count = new Map<string, number>();
  for (const l of a.replace(/\r\n/g, "\n").split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  let extra = 0;
  for (const l of b.replace(/\r\n/g, "\n").split("\n")) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1); else extra++;
  }
  return extra + [...count.values()].reduce((s, n) => s + n, 0);
}

/** How many versions of a template are read at once: a long history is not a burst of requests. */
const FETCH_CONCURRENCY = 4;

/** How long a read that failed waits before its one retry, so a dropped connection is not the end. */
const RETRY_WAIT_MS = 500;

/** A version's text, read a second time after a short wait when the first read gives nothing. */
async function fetchWithRetry(fetchText: FetchText, template: string, commit: string): Promise<string | null> {
  const first = await fetchText(template, commit);
  if (first !== null && first !== undefined) return first;
  await Bun.sleep(RETRY_WAIT_MS);
  return (await fetchText(template, commit)) ?? null;
}

/** Every version's text, in the entries' order, read FETCH_CONCURRENCY at a time. */
async function fetchAll(entries: Array<{ commit: string }>, template: string, fetchText: FetchText): Promise<Array<string | null>> {
  const texts: Array<string | null> = new Array<string | null>(entries.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      texts[i] = await fetchWithRetry(fetchText, template, entries[i]!.commit);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, entries.length) }, worker));
  return texts;
}

/**
 * The shipped version closest to `text` (fewest differing lines), with its text. Ties go to the newer
 * version. The versions are read a few at a time, and a read that fails is tried once more. Null when
 * there is none, or when any version still cannot be fetched: the closest one may be the one that
 * could not be read, so a choice among the rest could be the wrong base.
 */
export async function closestBase(index: ShippedIndex, template: string, text: string, fetchText: FetchText = fetchShipped): Promise<{ sha: string; commit: string; text: string } | null> {
  const entries = index[template] ?? [];
  const fetched = await fetchAll(entries, template, fetchText);
  if (fetched.some((t) => t === null)) return null;
  let best: { sha: string; commit: string; text: string; d: number } | null = null;
  for (const [i, e] of entries.entries()) {
    const t = fetched[i]!;
    const d = differingLines(text, t);
    if (!best || d <= best.d) best = { ...e, text: t, d };
  }
  return best ? { sha: best.sha, commit: best.commit, text: best.text } : null;
}

/**
 * The base a managed file with no stamp entry starts from (adopting an older setup, or an override
 * made by hand): the shipped version it is; else, with no shipped version known, today's shipped text
 * (nothing is merged into it until that changes); else the closest shipped version. `note` tells the
 * person which, for a file of their own. Throws when versions are known but cannot all be read
 * (offline): taking today's text then would mean never merging what changed since its real base.
 */
export async function baseOf(index: ShippedIndex, file: ManagedFile, text: string, fetchText: FetchText = fetchShipped): Promise<{ sha: string; note?: string }> {
  if (wasShipped(index, file.template, text)) return { sha: textSha(text) };
  if (!(index[file.template] ?? []).length) {
    return { sha: textSha(readFileSync(file.shipped, "utf8")), note: `${file.path} is your own; Loopstra knows no earlier version of it, so it is left as it is.` };
  }
  const best = await closestBase(index, file.template, text, fetchText);
  if (!best) throw new Error(`Loopstra's shipped versions of ${file.path} could not be read to merge from; check the connection and run loopstra upgrade again.`);
  return { sha: best.sha, note: `${file.path} is your own; it is merged from the shipped version of commit ${best.commit.slice(0, 7)}.` };
}
