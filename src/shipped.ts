import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git";
import { isDev, PACKAGE_ROOT } from "./package";
import { withoutGitLocation } from "./shell";
import { textSha, type ManagedFile } from "./stamp";

/** Every text each template has had: its textSha and the first commit that had it, oldest first. Keyed by `templates/...` path. */
export type ShippedIndex = Record<string, Array<{ sha: string; commit: string }>>;

/** Gets a template's text at a commit, or null when it cannot. */
export type FetchText = (template: string, commit: string) => Promise<string | null>;

/** Where a release's base texts are read from. LOOPSTRA_RAW_URL is for tests only. */
const RAW_URL = process.env.LOOPSTRA_RAW_URL ?? "https://raw.githubusercontent.com/jflavan/loopstra";

/** How long reading every blob may take before git is stopped. */
const BLOBS_TIMEOUT_MS = 60_000;

/** The texts of these blobs, read in one `git cat-file --batch`; a blob git does not have is left out. */
async function blobTexts(repo: string, blobs: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (!blobs.length) return texts;
  // Bun.spawn, not spawnBounded: the batch output is parsed by byte counts, and spawnBounded gives text.
  const proc = Bun.spawn({ cmd: ["git", "cat-file", "--batch"], cwd: repo, env: withoutGitLocation(process.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, BLOBS_TIMEOUT_MS);
  void proc.stdin.write(`${blobs.join("\n")}\n`);
  void proc.stdin.end();
  const [bytes, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`git cat-file --batch did not finish within ${BLOBS_TIMEOUT_MS / 1000}s`);
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

/**
 * The shipped version closest to `text` (fewest differing lines), with its text. Ties go to the newer
 * version. Null when there is none, or when any version cannot be fetched: the closest one may be
 * the one that could not be read, so a choice among the rest could be the wrong base.
 */
export async function closestBase(index: ShippedIndex, template: string, text: string, fetchText: FetchText = fetchShipped): Promise<{ sha: string; commit: string; text: string } | null> {
  const entries = index[template] ?? [];
  const fetched = await Promise.all(entries.map((e) => fetchText(template, e.commit)));
  if (fetched.some((t) => t === null || t === undefined)) return null;
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
