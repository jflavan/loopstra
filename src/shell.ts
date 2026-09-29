import { $ } from "bun";

/** Resolves to the promise's value, or to `fallback` once `ms` pass. Never waits longer than `ms`. */
export async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/** Kills a process and everything it started. Best effort; never throws, never waits more than a few seconds. */
export async function killTree(proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): Promise<void> {
  try {
    if (process.platform === "win32") {
      const k = Bun.spawn({ cmd: ["taskkill", "/T", "/F", "/PID", String(proc.pid)], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      await within(k.exited, 5_000, null);
    } else {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* not a group leader */ }
    }
  } catch { /* fall through to a direct kill */ }
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

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
