import { DEV_VERSION, packageVersion } from "../package";
import type { FileOutcome } from "../upgrade/files";
import { REAL_DEPS, upgradeRepo, type RepoResult } from "../upgrade/repo";
import { compareVersions, installCommand, installedBin, latestVersion, releaseNotes } from "../upgrade/tool";

/** The pieces of `loopstra upgrade`, injectable for tests. */
export interface UpgradeIo {
  say: (line: string) => void;
  /** The running version. */
  installed: string;
  /** The newest published version; null when the registry cannot be reached. */
  latest: () => Promise<string | null>;
  /** The release notes after `from` up to `to`; "" when there are none or they cannot be read. */
  notes: (from: string, to: string) => Promise<string>;
  /** Installs a version globally; false when that failed. */
  install: (version: string) => Promise<boolean>;
  /** Runs the repository step with a newer version (installed, or not when `installed` is false); its exit code. */
  handOff: (version: string, installed: boolean) => Promise<number>;
  /** Runs the repository step with the running version (`check`: only say what it would do); its exit code. */
  repoStep: (check: boolean) => Promise<number>;
}

/** Runs a command with this terminal; its exit code. */
async function spawnInherit(cmd: string[], cwd: string): Promise<number> {
  try {
    return await Bun.spawn({ cmd, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  } catch {
    return 1;
  }
}

/** The real pieces, for the repository at `root`. */
export function realIo(root: string): UpgradeIo {
  const say = (l: string) => console.log(l);
  return {
    say,
    installed: packageVersion(),
    latest: () => latestVersion(),
    notes: (from, to) => releaseNotes(from, to),
    install: async (v) => (await spawnInherit(installCommand(v), root)) === 0,
    handOff: async (v, installed) => {
      const bin = installed ? await installedBin() : null;
      if (bin) return spawnInherit([bin, "upgrade", "--repo"], root);
      say(`${installed ? `The installed loopstra command could not be found` : "The install did not succeed"}; running Loopstra ${v} through bunx instead.`);
      say(`To install it, run: ${installCommand(v).join(" ")}`);
      return spawnInherit(["bunx", `loopstra@${v}`, "upgrade", "--repo"], root);
    },
    repoStep: (check) => runRepoStep(root, check, say),
  };
}

/**
 * `loopstra upgrade [--repo] [--check]` (spec: "loopstra upgrade"): installs a newer release and has
 * it bring the repository up to date, or, when this is the newest (or the registry cannot be
 * reached, or this is a development checkout), brings the repository up to this version. `--repo`
 * skips the install; `--check` installs and writes nothing, and says what would happen.
 */
export async function upgradeCommand(root: string, args: string[], io: UpgradeIo): Promise<number> {
  const dev = io.installed.startsWith(DEV_VERSION);
  if (args.includes("--check")) {
    if (dev) {
      io.say(`Installed: a development checkout of Loopstra (${io.installed}); update it with git pull.`);
      return io.repoStep(true);
    }
    const latest = await io.latest();
    if (latest === null) io.say(`Installed: Loopstra ${io.installed}. The npm registry could not be reached to find the latest.`);
    else if (compareVersions(latest, io.installed) <= 0) io.say(`Installed: Loopstra ${io.installed}, the latest.`);
    else {
      io.say(`Installed: Loopstra ${io.installed}. Latest: ${latest}. loopstra upgrade would install it first.`);
      const notes = await io.notes(io.installed, latest);
      if (notes) io.say(`\nWhat is new:\n${notes}\n`);
      io.say(`What the installed ${io.installed} would do to this repository (${latest} may do more):`);
    }
    return io.repoStep(true);
  }
  if (args.includes("--repo")) return io.repoStep(false);
  if (dev) {
    io.say("This is a development checkout of Loopstra; update it with git pull. Bringing this repository up to the checkout.");
    return io.repoStep(false);
  }
  const latest = await io.latest();
  if (latest === null) io.say(`The npm registry could not be reached; bringing this repository up to the installed Loopstra ${io.installed}.`);
  if (latest === null || compareVersions(latest, io.installed) <= 0) return io.repoStep(false);
  io.say(`Installing Loopstra ${latest} (you have ${io.installed}).`);
  return io.handOff(latest, await io.install(latest));
}

/** Runs the repository step and prints its report; a refusal (or a commit that failed) goes to stderr as it is. */
export async function runRepoStep(root: string, check: boolean, say: (l: string) => void): Promise<number> {
  const r = await upgradeRepo(root, { check }, { ...REAL_DEPS, notes: (from, to) => releaseNotes(from, to) });
  if (!r.ok) { console.error(r.refusal); return 1; }
  for (const line of report(r, check)) say(line);
  return 0;
}

/** What happened to a file, and (with --check) what would. */
const DONE: Record<Exclude<FileOutcome, "unchanged">, string> = {
  replaced: "updated",
  merged: "merged with your edits",
  conflict: "has conflict markers; resolve them and commit it",
  "no-base": "left as it is (the version it came from could not be read)",
  added: "added",
  deleted: "stays deleted (it was removed on purpose)",
};
const WOULD: Record<Exclude<FileOutcome, "unchanged">, string> = {
  replaced: "would be updated",
  merged: "would be merged with your edits",
  conflict: "would conflict with your edits, and be left with conflict markers to resolve",
  "no-base": "would be left as it is (the version it came from could not be read)",
  added: "would be added",
  deleted: "stays deleted (it was removed on purpose)",
};

/** The repository step's report: the version change, then one line per file that changed (or would). */
export function report(r: RepoResult, check: boolean): string[] {
  const words = check ? WOULD : DONE;
  const was = r.from ? `from ${r.from}` : check ? "it has no stamp yet" : "it had no stamp";
  const lines = [
    r.from === r.to ? `This repository is on Loopstra ${r.to}.`
      : check ? `This repository would be upgraded to Loopstra ${r.to} (${was}).`
      : `Upgraded this repository to Loopstra ${r.to} (${was}).`,
  ];
  for (const f of r.files) if (f.outcome !== "unchanged") lines.push(`  ${f.path}: ${words[f.outcome]}`);
  for (const p of r.removed) lines.push(`  ${p}: ${check ? "would be removed" : "removed"}`);
  for (const p of r.changed) lines.push(`  ${p}: ${check ? "would be updated" : "updated"}`);
  for (const n of r.notes) lines.push(`  ${n}`);
  for (const w of r.warnings) lines.push(`  Note: ${w}`);
  if (lines.length === 1) lines.push(check ? "  Nothing would change." : "  Nothing changed.");
  if (!check && r.committed) lines.push("Committed on main; loopstra start shares it with the remote, or push it yourself.");
  return lines;
}
