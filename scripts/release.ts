#!/usr/bin/env bun
// The release workflow's decisions: whether to release, and the next version.
// `bun scripts/release.ts plan [patch|minor]` prints `version=<v>`, `ship=<true|false>` and
// `previous=<v or nothing>` lines for $GITHUB_OUTPUT.

export interface Commit { subject: string; body: string }

export type Bump = "patch" | "minor";

/** The next version after `last` (null: no release yet): minor for a breaking change (we are on 0.x), else patch. `bump` forces one. */
export function nextVersion(last: string | null, commits: Commit[], bump?: Bump): string {
  if (!last) return "0.1.0";
  const [major, minor, patch] = last.split(".").map(Number) as [number, number, number];
  const breaking = commits.some((c) => /^[a-z]+(\([^)]*\))?!:/.test(c.subject) || /BREAKING CHANGE/.test(c.body));
  const kind = bump ?? (breaking ? "minor" : "patch");
  return kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** Whether a set of changed paths changes what the package ships. */
export function shipsChanges(paths: string[]): boolean {
  return paths.some((p) => p.startsWith("src/") || p.startsWith("templates/") || p === "package.json");
}

/** Runs git in `cwd`; its output and exit code. Throws for an exit code above 1 (1 is a "no" answer for some commands). */
async function git(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code > 1) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return { out, code };
}

/** Runs git in `cwd` and returns its output; throws when it fails. */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return r.out;
}

/**
 * The release of the checkout at `root`: the next version, whether to ship it, and the previous
 * release (null: none yet). Ships when something the package ships changed since the latest `v*`
 * tag, or when `bump` asks for a release (a manual run); never when HEAD is already part of the
 * latest release (the commit is tagged, or a newer commit was released first).
 */
export async function plan(root: string, bump?: Bump): Promise<{ version: string; ship: boolean; previous: string | null }> {
  const tags = (await gitOut(root, ["tag", "--list", "v*", "--sort=-v:refname"])).split("\n").map((t) => t.trim()).filter(Boolean);
  const previous = tags[0]?.slice(1) ?? null;
  const range = previous ? [`v${previous}..HEAD`] : ["HEAD"];
  const log = await gitOut(root, ["log", "--format=%s%x1f%b%x1e", ...range]);
  const commits = log.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [subject, body = ""] = c.split("\x1f");
    return { subject: subject!, body };
  });
  const version = nextVersion(previous, commits, bump);
  if (!previous) return { version, ship: true, previous };
  // HEAD is the latest release, or an ancestor of it: there is nothing to release.
  if ((await git(root, ["merge-base", "--is-ancestor", "HEAD", `v${previous}`])).code === 0) return { version, ship: false, previous };
  const changed = (await gitOut(root, ["diff", "--name-only", `v${previous}`, "HEAD"])).split("\n").filter(Boolean);
  return { version, ship: Boolean(bump) || shipsChanges(changed), previous };
}

if (import.meta.main && process.argv[2] === "plan") {
  const arg = process.argv[3];
  if (arg !== undefined && arg !== "" && arg !== "patch" && arg !== "minor") {
    console.error(`Usage: bun scripts/release.ts plan [patch|minor] (not ${arg})`);
    process.exit(1);
  }
  const p = await plan(process.cwd(), arg ? arg : undefined);
  console.log(`version=${p.version}`);
  console.log(`ship=${p.ship}`);
  console.log(`previous=${p.previous ?? ""}`);
}
