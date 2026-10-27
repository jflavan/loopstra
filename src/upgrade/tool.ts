import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../fsutil";
import { DEV_VERSION } from "../package";
import { loopstraDir } from "../paths";

/** Where versions are read: npm, unless LOOPSTRA_REGISTRY_URL (for tests only) says otherwise. */
function registryUrl(): string {
  return process.env.LOOPSTRA_REGISTRY_URL ?? "https://registry.npmjs.org";
}

/** Where release notes are read: GitHub's API, unless LOOPSTRA_GITHUB_API (for tests only) says otherwise. */
function githubApi(): string {
  return process.env.LOOPSTRA_GITHUB_API ?? "https://api.github.com";
}

/** How long the registry and GitHub are given to answer. */
const TIMEOUT_MS = 5_000;

/** Compares x.y.z versions. Anything after a - or + is ignored, except that such a version sorts before the plain one. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const [core, extra] = v.split(/[-+](.*)/s);
    return { n: core!.split(".").map((p) => Number(p) || 0), pre: extra !== undefined };
  };
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

/** The newest published version of the package, or null when the registry cannot be reached. */
export async function latestVersion(registry = registryUrl()): Promise<string | null> {
  try {
    const res = await fetch(`${registry}/loopstra/latest`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The notes of every release after `from` up to `to`, newest first, as Markdown; "" when they cannot be read. */
export async function releaseNotes(from: string, to: string, api = githubApi()): Promise<string> {
  try {
    const res = await fetch(`${api}/repos/jflavan/loopstra/releases?per_page=100`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return "";
    const releases = (await res.json()) as Array<{ tag_name: string; body?: string | null }>;
    return releases
      .map((r) => ({ v: r.tag_name.replace(/^v/, ""), body: (r.body ?? "").trim() }))
      .filter((r) => compareVersions(r.v, from) > 0 && compareVersions(r.v, to) <= 0)
      .sort((a, b) => compareVersions(b.v, a.v))
      .map((r) => `## ${r.v}\n${r.body}`.trimEnd())
      .join("\n\n");
  } catch {
    return "";
  }
}

const DAY_MS = 24 * 60 * 60_000;

/** True for a published version, not a development checkout's. */
export const released = (v: string | null): v is string => !!v && !v.startsWith(DEV_VERSION);

/**
 * One line for `start` and `status` when the repository was set up before the stamp (`stamp` is ""),
 * its stamp names a different version from the installed one, or a newer release is out; null
 * otherwise. `stamp` null: not known, not compared. The registry is asked at most once a day (the
 * answer is kept in .loopstra/update-check.json) and never by a development checkout. Never throws.
 */
export async function updateNotice(root: string, o: { installed: string; registry?: string; stamp?: string | null; now?: number }): Promise<string | null> {
  // Not a question for the registry, so a development checkout says it too.
  if (o.stamp === "") return "This repository was set up by an older Loopstra: run loopstra upgrade.";
  if (!released(o.installed)) return null;
  if (o.stamp && o.stamp !== o.installed) {
    return released(o.stamp) && compareVersions(o.stamp, o.installed) > 0
      ? `This repository is on Loopstra ${o.stamp}, newer than the installed ${o.installed}: install it with ${installHint(o.stamp)}.`
      : `This repository is on Loopstra ${o.stamp} and ${o.installed} is installed: run loopstra upgrade.`;
  }
  const now = o.now ?? Date.now();
  const cache = join(loopstraDir(root), "update-check.json");
  let latest: string | null;
  try {
    const c = JSON.parse(readFileSync(cache, "utf8")) as { checkedAt: number; latest: string | null };
    if (!(now - c.checkedAt >= 0 && now - c.checkedAt < DAY_MS)) throw new Error("stale");
    latest = c.latest;
  } catch {
    latest = await latestVersion(o.registry);
    // An unreachable registry is remembered too, so it slows a command at most once a day.
    try { writeFileAtomic(cache, JSON.stringify({ checkedAt: now, latest })); } catch { /* the notice is a convenience */ }
  }
  return latest && compareVersions(latest, o.installed) > 0 ? `Loopstra ${latest} is out (you have ${o.installed}): run loopstra upgrade.` : null;
}

/**
 * The command that installs a version globally: `bun add -g loopstra@<version>`, run by the Bun
 * running this (so it does not depend on PATH). For tests only, LOOPSTRA_INSTALL_COMMAND replaces
 * it, as a JSON array of words (so a path may hold spaces) or as words separated by spaces;
 * `{version}` in it is filled in.
 */
export function installCommand(version: string): string[] {
  const custom = process.env.LOOPSTRA_INSTALL_COMMAND;
  if (!custom) return [process.execPath, "add", "-g", `loopstra@${version}`];
  const words = custom.trim().startsWith("[") ? (JSON.parse(custom) as string[]) : custom.trim().split(/\s+/);
  return words.map((w) => w.replaceAll("{version}", version));
}

/** The install command as a person would type it. */
export function installHint(version: string): string {
  return process.env.LOOPSTRA_INSTALL_COMMAND ? installCommand(version).join(" ") : `bun add -g loopstra@${version}`;
}

/**
 * A line for when the `loopstra` that PATH runs (`onPath`) is not the one just installed (`bin`),
 * for instance an older copy installed with npm; null when they are the same or PATH has none.
 */
export function pathWarning(bin: string, onPath: string | null): string | null {
  if (!onPath) return null;
  const same = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
  if (same(bin, onPath)) return null;
  const dir = dirname(bin);
  return `Your PATH runs loopstra from ${onPath}; the new version is in ${dir}. Remove the old one (npm rm -g loopstra) or put ${dir} first on PATH.`;
}

/**
 * The globally installed `loopstra` executable (`<bun pm bin -g>/loopstra`, else in Bun's own bin
 * folder, since `bun pm bin -g` fails while nothing is installed globally), or null when there is
 * none. LOOPSTRA_INSTALLED_BIN (for tests only) names it instead.
 */
export async function installedBin(): Promise<string | null> {
  if (process.env.LOOPSTRA_INSTALLED_BIN) return process.env.LOOPSTRA_INSTALLED_BIN;
  let dir = "";
  try {
    const proc = Bun.spawn({ cmd: [process.execPath, "pm", "bin", "-g"], stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0) dir = out.trim();
  } catch { /* Bun's own folder, below */ }
  if (!dir) dir = join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "bin");
  const bin = join(dir, process.platform === "win32" ? "loopstra.exe" : "loopstra");
  return existsSync(bin) ? bin : null;
}
