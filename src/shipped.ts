import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git";
import { isDev, PACKAGE_ROOT } from "./package";
import { textSha } from "./stamp";

/** Every text each template has had: its textSha and the first commit that had it, oldest first. Keyed by `templates/...` path. */
export type ShippedIndex = Record<string, Array<{ sha: string; commit: string }>>;

/** Gets a template's text at a commit, or null when it cannot. */
export type FetchText = (template: string, commit: string) => Promise<string | null>;

/** Where a release's base texts are read from. LOOPSTRA_RAW_URL is for tests only. */
const RAW_URL = process.env.LOOPSTRA_RAW_URL ?? "https://raw.githubusercontent.com/jflavan/loopstra";

/** The texts of these blobs, read in one `git cat-file --batch`; a blob git does not have is left out. */
async function blobTexts(repo: string, blobs: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (!blobs.length) return texts;
  const proc = Bun.spawn({ cmd: ["git", "cat-file", "--batch"], cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(`${blobs.join("\n")}\n`);
  proc.stdin.end();
  const [bytes, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git cat-file --batch failed (${code}): ${err.trim()}`);
  const dec = new TextDecoder();
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0) break;
    const [blob, kind, size] = dec.decode(bytes.subarray(at, nl)).split(" ");
    at = nl + 1;
    if (kind === "missing" || size === undefined) continue;
    const end = at + Number(size);
    texts.set(blob!, dec.decode(bytes.subarray(at, end)));
    at = end + 1;
  }
  return texts;
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

/** The shipped version closest to `text` (fewest differing lines), with its text; null when none can be fetched. Ties go to the newer version. */
export async function closestBase(index: ShippedIndex, template: string, text: string, fetchText: FetchText = fetchShipped): Promise<{ sha: string; commit: string; text: string } | null> {
  let best: { sha: string; commit: string; text: string; d: number } | null = null;
  for (const e of index[template] ?? []) {
    const t = await fetchText(template, e.commit);
    if (t === null) continue;
    const d = differingLines(text, t);
    if (!best || d <= best.d) best = { ...e, text: t, d };
  }
  return best ? { sha: best.sha, commit: best.commit, text: best.text } : null;
}
