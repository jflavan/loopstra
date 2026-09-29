import { $ } from "bun";

export interface CommandResult {
  command: string;
  code: number;
  output: string;
  lastLine: string;
  durationMs: number;
}

/**
 * Runs one configured command string through Bun's cross-platform shell.
 * Never throws on non-zero exit; the exit code is the result.
 */
export async function runCommand(command: string, cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  const started = Date.now();
  const r = await $`${{ raw: command }}`.cwd(cwd).env({ ...process.env, ...env }).nothrow().quiet();
  const output = r.stdout.toString() + r.stderr.toString();
  const lines = output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  return { command, code: r.exitCode, output, lastLine: lines[lines.length - 1] ?? "", durationMs: Date.now() - started };
}
