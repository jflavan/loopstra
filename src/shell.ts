import { onStop, StopRequested, throwIfStopping } from "./stop";

/** Resolves to the promise's value, or to `fallback` once `ms` pass. Never waits longer than `ms`. */
export async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/** An error's message, or the thrown value as text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The last non-blank line of `s`, trimmed ("" when there is none). Lines matching `skip` do not count. */
export function lastLine(s: string, skip?: RegExp): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !skip?.test(l));
  return lines[lines.length - 1] ?? "";
}

/**
 * Children are spawned in their own process group on POSIX (a new session), so killTree can stop
 * the whole group with one signal. Windows kills the tree with taskkill instead.
 */
const DETACHED = process.platform !== "win32";

/** Kills a process and everything it started. Best effort; never throws, never waits more than a few seconds. */
async function killTree(proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): Promise<void> {
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

export interface SpawnOptions {
  cmd: string[];
  cwd: string;
  /** The child's whole environment. Defaults to this process's. */
  env?: Record<string, string | undefined>;
  /** How long the call may take (until the process exits, or with `onLine` until reading ends). */
  timeoutMs: number;
  /** Written to the child's stdin, which is then closed. Without it stdin is not connected. */
  stdin?: string;
  /**
   * What a stop request does: "kill" kills the process tree at once; "grace" gives it `graceMs` to
   * finish on its own first; "ignore" lets it run (a cleanup call, still bounded by the timeout).
   * Unless "ignore", nothing starts after a stop was requested (StopRequested is thrown).
   */
  onStop: "kill" | "grace" | "ignore";
  /** The stop grace, and how long the process gets to exit after reading ends or after a kill. Default 2s. */
  graceMs?: number;
  /** Reads stdout line by line; returning true ends the call (the process then gets `graceMs` to exit before it is killed). */
  onLine?: (line: string) => boolean | void;
}

export interface SpawnResult {
  /** The exit code; null when the process could not be made to exit. 127 when it could not start. */
  code: number | null;
  out: string;
  err: string;
  /** False when the process could not be started (`err` says why). */
  started: boolean;
  /** Killed for running past `timeoutMs`. */
  timedOut: boolean;
  /** A stop was requested while it ran; the caller throws StopRequested (nothing waits for its output). */
  stopped: boolean;
}

/**
 * Runs one process, bounded: everything it awaits ends within the timeout plus a short grace. Past
 * the timeout the process and everything it started are killed. It never waits on pipes a leftover
 * grandchild may hold, and it never throws for the process's sake (only StopRequested before start).
 */
export async function spawnBounded(o: SpawnOptions): Promise<SpawnResult> {
  if (o.onStop !== "ignore") throwIfStopping();
  const graceMs = o.graceMs ?? 2_000;
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: o.cmd, cwd: o.cwd, stdin: o.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
      env: o.env ?? process.env,
      // Its own process group on POSIX, so killTree reaches everything it started.
      detached: DETACHED,
    });
  } catch (e) {
    return { code: 127, out: "", err: errorText(e), started: false, timedOut: false, stopped: false };
  }

  let stopped = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = o.onStop === "ignore" ? () => {} : onStop(() => {
    stopped = true;
    if (o.onStop === "kill") void killTree(proc);
    else grace = setTimeout(() => { void killTree(proc); }, graceMs);
  });

  if (o.stdin !== undefined) {
    const stdin = proc.stdin as Bun.FileSink;
    try {
      stdin.write(o.stdin);
      void Promise.resolve(stdin.end()).catch(() => {});
    } catch { /* the process already exited; its result says so */ }
  }

  let out = "";
  let err = "";
  const reader = proc.stdout.getReader();
  const outDone = (async () => {
    const dec = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        out += text;
        if (!o.onLine) continue;
        buffer += text;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (o.onLine(line)) return;
        }
      }
      if (o.onLine && buffer.trim()) o.onLine(buffer);
    } catch { /* stream cancelled or broken; what arrived stands */ }
  })();
  const errDone = (async () => {
    const dec = new TextDecoder();
    try { for await (const chunk of proc.stderr) err += dec.decode(chunk, { stream: true }); } catch { /* closed */ }
  })();

  // With onLine the deadline bounds the reading; otherwise it bounds the exit.
  const done = await within((o.onLine ? outDone : proc.exited).then(() => true), o.timeoutMs, false);
  const timedOut = !done;
  if (o.onLine) void reader.cancel().catch(() => {});
  let code = timedOut ? null : await within(proc.exited, graceMs, null);
  if (code === null) {
    await killTree(proc);
    code = await within(proc.exited, graceMs, null);
  }
  clearTimeout(grace);
  unsubscribe();
  // Output pipes may be held by a leftover grandchild; take what arrived.
  if (!stopped) await within(Promise.all([outDone, errDone]), timedOut || o.onLine ? 250 : 2_000, undefined);
  return { code, out, err, started: true, timedOut, stopped };
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
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const r = await spawnBounded({ cmd: [process.execPath, "exec", command], cwd, env: { ...process.env, ...opts.env }, timeoutMs, onStop: "kill" });
  if (r.stopped) throw new StopRequested();
  if (!r.started) throw new Error(r.err);
  let output = r.out + r.err;
  if (r.timedOut) output += `\nThe command \`${command}\` did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.\n`;
  return {
    command,
    code: r.timedOut ? (r.code || 124) : (r.code ?? 1),
    output,
    lastLine: r.timedOut ? COMMAND_TIMEOUT_NOTE : lastLine(output),
    durationMs: Date.now() - started,
    timedOut: r.timedOut,
  };
}
