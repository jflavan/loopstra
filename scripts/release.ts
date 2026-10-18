#!/usr/bin/env bun
// The release workflow's decisions: whether to release, and the next version.
// `bun scripts/release.ts plan [--manual] [patch|minor]` prints `version=<v>`, `ship=<true|false>` and
// `previous=<v or nothing>` lines for $GITHUB_OUTPUT. --manual: a manual run, which releases even
// when nothing the package ships changed.
import { Git } from "../src/git";

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

/**
 * The release of the checkout at `root`: the next version, whether to ship it, and the previous
 * release (null: none yet). Ships when something the package ships changed since the latest `v*`
 * tag, or on a manual run (`manual`, or a `bump`); never when HEAD is already part of the latest
 * release (the commit is tagged, or a newer commit was released first).
 */
export async function plan(root: string, bump?: Bump, manual = false): Promise<{ version: string; ship: boolean; previous: string | null }> {
  const git = new Git(root);
  const out = async (args: string[]) => (await git.run(args)).out;
  const tags = (await out(["tag", "--list", "v*", "--sort=-v:refname"])).split("\n").map((t) => t.trim()).filter(Boolean);
  const previous = tags[0]?.slice(1) ?? null;
  const range = previous ? [`v${previous}..HEAD`] : ["HEAD"];
  const log = await out(["log", "--format=%s%x1f%b%x1e", ...range]);
  const commits = log.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [subject, body = ""] = c.split("\x1f");
    return { subject: subject!, body };
  });
  const version = nextVersion(previous, commits, bump);
  if (!previous) return { version, ship: true, previous };
  // HEAD is the latest release, or an ancestor of it: there is nothing to release.
  if ((await git.run(["merge-base", "--is-ancestor", "HEAD", `v${previous}`], true)).code === 0) return { version, ship: false, previous };
  const changed = (await out(["diff", "--name-only", `v${previous}`, "HEAD"])).split("\n").map((l) => l.trim()).filter(Boolean);
  return { version, ship: manual || Boolean(bump) || shipsChanges(changed), previous };
}

const USAGE = "Usage: bun scripts/release.ts plan [--manual] [patch|minor]";

if (import.meta.main && process.argv[2] === "plan") {
  const args = process.argv.slice(3).filter((a) => a !== "");
  const manual = args.includes("--manual");
  const rest = args.filter((a) => a !== "--manual");
  const bump = rest[0];
  if (rest.length > 1 || (bump !== undefined && bump !== "patch" && bump !== "minor")) {
    console.error(`${USAGE} (not ${rest.join(" ")})`);
    process.exit(1);
  }
  const p = await plan(process.cwd(), bump, manual);
  console.log(`version=${p.version}`);
  console.log(`ship=${p.ship}`);
  console.log(`previous=${p.previous ?? ""}`);
}
