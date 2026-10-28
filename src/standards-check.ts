import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config";
import { Git, withDetachedWorktree } from "./git";
import { loopstraDir } from "./paths";
import { missingProgram, runCommand, type CommandResult } from "./shell";

/** A command run in a throwaway checkout of main's last commit, and what it says. */
export interface CheckOnMain {
  ok: boolean;
  timedOut: boolean;
  code: number;
  durationMs: number;
  /** The end of its output. */
  lastLines: string;
  /** The program the shell could not find, or null. */
  missingProgram: string | null;
  /** True when commands.install failed, so the command itself never ran. */
  installFailed: boolean;
  /** The spec's warning for a check that fails on main (never for a timeout, a missing program or an install that failed), or null. */
  failsOnMain: string | null;
}

const LAST_LINES = 10;

/**
 * `command` once in a throwaway checkout of main's last commit, after commands.install when there is
 * one, never touching the working tree. Both share one claude.timeout_minutes. `name` is the folder
 * under .loopstra/ (runs at the same time need different ones); `env` is added to the command's
 * environment, not the install's. Throws when main has no commit or the checkout cannot be made.
 */
export async function runOnMain(root: string, cfg: Config, o: { name: string; command: string; what: string; env?: Record<string, string> }): Promise<CommandResult & { what: string }> {
  const deadline = Date.now() + cfg.claude.timeout_minutes * 60_000;
  const left = () => Math.max(1000, deadline - Date.now());
  const git = new Git(root);
  const main = await git.commitOf(cfg.main_branch);
  if (!main) throw new Error(`${cfg.main_branch} has no commit yet`);
  return withDetachedWorktree(git, join(loopstraDir(root), o.name), main, async (cwd) => {
    if (cfg.commands.install) {
      const i = await runCommand(cfg.commands.install, cwd, { timeoutMs: left() });
      if (i.code !== 0) return { ...i, what: "commands.install" };
    }
    return { ...(await runCommand(o.command, cwd, { timeoutMs: left(), env: o.env })), what: o.what };
  });
}

/**
 * A standard's tool check tried on main: in a throwaway checkout of main's last commit, install
 * first, with LOOPSTRA_BASE set to that commit, as a change's merge check gets it. `title` names the
 * standard in the warning.
 */
export async function checkOnMain(root: string, cfg: Config, command: string, title = "this standard"): Promise<CheckOnMain> {
  const base = await new Git(root).commitOf(cfg.main_branch);
  if (!base) throw new Error(`${cfg.main_branch} has no commit yet`);
  const r = await runOnMain(root, cfg, { name: `check-main-${randomUUID().slice(0, 8)}`, command, what: "check", env: { LOOPSTRA_BASE: base } });
  const installFailed = r.what === "commands.install" && r.code !== 0;
  const missing = r.code === 0 ? null : missingProgram(r.command, r.output) ?? null;
  const fails = r.code !== 0 && !r.timedOut && !installFailed && !missing;
  return {
    ok: r.code === 0,
    timedOut: r.timedOut,
    code: r.code,
    durationMs: r.durationMs,
    lastLines: r.output.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-LAST_LINES).join("\n"),
    missingProgram: r.timedOut ? null : missing,
    installFailed,
    failsOnMain: fails
      ? `The check of ${title} fails on main already, so every change under it would fail it too. Use a form that looks only at what a change adds (with $LOOPSTRA_BASE), or fix main first.`
      : null,
  };
}

/** The form of a known scanner's command that reports only what a change adds; null for any other command, or one that already uses LOOPSTRA_BASE. */
export function baseAware(command: string): string | null {
  if (command.includes("LOOPSTRA_BASE")) return null;
  if (/(^|[\s;&|(])gitleaks(\s|$)/.test(command)) return 'gitleaks git --no-banner --log-opts="$LOOPSTRA_BASE..HEAD"';
  if (/(^|[\s;&|(])semgrep(\s|$)/.test(command)) return 'semgrep scan --error --baseline-commit "$LOOPSTRA_BASE"';
  return null;
}
