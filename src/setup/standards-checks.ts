import type { Config } from "../config";
import { Git } from "../git";
import { errorText } from "../shell";
import { problemText, readStandards, standardsSizeWarning } from "../standards";
import { baseAware, checkOnMain } from "../standards-check";
import type { Check } from "./types";

/**
 * The standards' checks, as setup lists them: every standard reads from main's last commit, the
 * standards are not over 40 KB, and each tool `check` is tried on main. Nothing when main has no
 * commit or no standards.
 */
export async function standardsChecks(root: string, cfg: Config): Promise<Check[]> {
  const git = new Git(root);
  const main = await git.commitOf(cfg.main_branch).catch(() => null);
  if (!main) return [];
  let read;
  try { read = await readStandards(git, main); } catch (e) { return [{ level: "fail", text: `The standards could not be read from ${cfg.main_branch}: ${errorText(e)}` }]; }
  const checks: Check[] = read.problems.map((p) => ({ level: "fail", text: problemText(p) }));
  const size = standardsSizeWarning(read);
  if (size) checks.push({ level: "warn", text: size });
  const tried = await Promise.all(read.standards.filter((s) => s.check).map((s) => tryCheck(root, cfg, s.title, s.check!)));
  return [...checks, ...tried];
}

export async function tryCheck(root: string, cfg: Config, title: string, command: string): Promise<Check> {
  try {
    const r = await checkOnMain(root, cfg, command, title);
    if (r.ok) return { level: "ok", text: `The check of ${title} passes on ${cfg.main_branch}.` };
    const end = r.lastLines.split("\n").at(-1);
    if (r.installFailed) return { level: "warn", text: `The check of ${title} could not run on ${cfg.main_branch}: commands.install failed (exit ${r.code})${end ? `: ${end}` : ""}.` };
    if (r.missingProgram) return { level: "warn", text: `The check of ${title} names \`${r.missingProgram}\`, which is not installed or not on PATH.` };
    if (r.timedOut) return { level: "warn", text: `The check of ${title} did not finish on ${cfg.main_branch} within claude.timeout_minutes.` };
    const better = baseAware(command);
    return { level: "warn", text: `${r.failsOnMain ?? `The check of ${title} fails on ${cfg.main_branch}.`}${better ? ` For this scanner, that form is: ${better}` : ""}${end ? ` It ended with: ${end}` : ""}` };
  } catch (e) {
    return { level: "warn", text: `The check of ${title} could not run on ${cfg.main_branch}: ${errorText(e)}` };
  }
}
