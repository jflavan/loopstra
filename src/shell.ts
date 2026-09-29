import { delimiter, dirname } from "node:path";
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

/** How long a POSIX process group gets to end after SIGTERM before it is SIGKILLed. */
const TERM_GRACE_MS = 1_500;

/** True while any process of the group `pgid` is left (POSIX). */
function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

/**
 * Every process below `pid`, from `ps -A -o pid=,ppid=` (POSIX). It catches grandchildren that
 * left the child's process group (their own group or session). Empty when ps cannot be run.
 */
async function descendants(pid: number): Promise<number[]> {
  try {
    const ps = Bun.spawn({ cmd: ["ps", "-A", "-o", "pid=,ppid="], stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await within(new Response(ps.stdout).text(), 2_000, "");
    const children = new Map<number, number[]>();
    for (const line of text.split("\n")) {
      const [c, p] = line.trim().split(/\s+/).map(Number);
      if (!c || p === undefined || Number.isNaN(p)) continue;
      children.set(p, [...(children.get(p) ?? []), c]);
    }
    const out: number[] = [];
    const queue = [pid];
    while (queue.length) {
      for (const c of children.get(queue.shift()!) ?? []) {
        if (c === pid || out.includes(c)) continue;
        out.push(c);
        queue.push(c);
      }
    }
    return out;
  } catch { return []; }
}

/**
 * Kills a process and everything it started. Best effort; never throws, never waits more than a few
 * seconds. POSIX: SIGTERM to the process group, up to TERM_GRACE_MS for it to go, then SIGKILL to
 * the group and to every descendant found under the child (collected before anything is signalled,
 * since orphans are adopted by init and drop out of the tree). Windows: taskkill /T /F.
 */
async function killTree(proc: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): Promise<void> {
  try {
    if (process.platform === "win32") {
      const k = Bun.spawn({ cmd: ["taskkill", "/T", "/F", "/PID", String(proc.pid)], stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      await within(k.exited, 5_000, null);
    } else {
      const below = await descendants(proc.pid);
      try { process.kill(-proc.pid, "SIGTERM"); } catch { /* not a group leader, or already gone */ }
      const until = Date.now() + TERM_GRACE_MS;
      while (groupAlive(proc.pid) && Date.now() < until) await Bun.sleep(50);
      const later = await descendants(proc.pid);
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
      for (const pid of new Set([...below, ...later])) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  } catch { /* fall through to a direct kill */ }
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

/**
 * The children spawnBounded started that have not exited yet. When this process exits (a second
 * Ctrl-C, or an exit during a stop grace) each one's tree is killed, so no child outlives Loopstra.
 */
const live = new Set<number>();
let exitHookInstalled = false;

/** Kills what is left of each live child's tree. Synchronous: it runs in the process's exit handler. */
function killLiveChildren(): void {
  for (const pid of live) {
    try {
      if (process.platform === "win32") Bun.spawnSync({ cmd: ["taskkill", "/T", "/F", "/PID", String(pid)], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      else { try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ } }
    } catch { /* best effort */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  live.clear();
}

function track(proc: { pid: number; exited: Promise<unknown> }): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killLiveChildren);
  }
  live.add(proc.pid);
  void proc.exited.then(() => live.delete(proc.pid), () => live.delete(proc.pid));
}

/**
 * `env` with the folder of the running Bun first on its PATH, so children (agent sessions, project
 * commands, the hook) find the same `bun` even when Loopstra was started with a short PATH (cron).
 * Keeps the existing key's spelling (`Path` on Windows).
 */
export function withBunOnPath(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dir = dirname(process.execPath);
  const current = env[key] ?? "";
  if (current.split(delimiter)[0] === dir) return env;
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
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
  track(proc);

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
  const r = await spawnBounded({ cmd: [process.execPath, "exec", command], cwd, env: withBunOnPath({ ...process.env, ...opts.env }), timeoutMs, onStop: "kill" });
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
