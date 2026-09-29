import { onStop, StopRequested, throwIfStopping } from "./stop";

/** Resolves to the promise's value, or to `fallback` once `ms` pass. Never waits longer than `ms`. */
export async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/**
 * Children are spawned in their own process group on POSIX (a new session), so killTree can stop
 * the whole group with one signal. Windows kills the tree with taskkill instead.
 */
export const DETACHED = process.platform !== "win32";

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
  /** True when the command was killed for running past its timeout. */
  timedOut: boolean;
}

export interface RunCommandOptions {
  env?: Record<string, string>;
  /** Kill the command (and anything it started) after this long. Callers pass `claude.timeout_minutes`. */
  timeoutMs?: number;
}

/** Used only when a caller passes no timeout; matches the config default of 30 minutes. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const COMMAND_TIMEOUT_NOTE = "A project command did not finish in time.";

/** The timeout callers pass: the per-phase limit from config. */
export function commandTimeoutMs(cfg: { claude: { timeout_minutes: number } }): number {
  return cfg.claude.timeout_minutes * 60_000;
}

/**
 * Runs one configured command string through Bun's cross-platform shell (`bun exec`).
 * Never throws on non-zero exit; the exit code is the result. Past the timeout the
 * process tree is killed and the result says so. After a stop request it does not start, or it
 * kills the running command's tree, and throws StopRequested.
 */
export async function runCommand(command: string, cwd: string, opts: RunCommandOptions = {}): Promise<CommandResult> {
  throwIfStopping();
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proc = Bun.spawn({
    cmd: [process.execPath, "exec", command],
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...(opts.env ?? {}) },
    // Its own process group on POSIX, so killTree reaches everything it started.
    detached: DETACHED,
  });
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, add: (s: string) => void) => {
    const dec = new TextDecoder();
    try { for await (const chunk of stream) add(dec.decode(chunk, { stream: true })); } catch { /* closed */ }
  };
  const drained = Promise.all([drain(proc.stdout, (s) => { stdout += s; }), drain(proc.stderr, (s) => { stderr += s; })]);

  // A stop request kills the command's tree; the exit then ends the wait below.
  let stopped = false;
  const unsubscribe = onStop(() => { stopped = true; void killTree(proc); });
  let code: number | null;
  try {
    code = await within(proc.exited, timeoutMs, null);
  } finally {
    unsubscribe();
  }
  if (stopped) {
    await within(proc.exited, 2_000, null);
    throw new StopRequested();
  }
  const timedOut = code === null;
  if (timedOut) {
    await killTree(proc);
    code = await within(proc.exited, 2_000, null);
  }
  // Output pipes may be held by a leftover grandchild; take what arrived.
  await within(drained, timedOut ? 250 : 2_000, undefined);

  let output = stdout + stderr;
  if (timedOut) output += `\nThe command \`${command}\` did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.\n`;
  const lines = output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  return {
    command,
    code: timedOut ? (code || 124) : (code ?? 1),
    output,
    lastLine: timedOut ? COMMAND_TIMEOUT_NOTE : lines[lines.length - 1] ?? "",
    durationMs: Date.now() - started,
    timedOut,
  };
}
