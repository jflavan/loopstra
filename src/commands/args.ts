/** The words a command takes after its name. */
export interface ArgSpec {
  /** The line to print when the words do not fit, "Usage: loopstra ...". */
  usage: string;
  /** The flags it takes, each at most once, like "--once". */
  flags?: readonly string[];
  /** True when it takes `--port <n>` or `--port=<n>`. */
  port?: boolean;
  /** How many plain words (a change name, a prompt name) it takes; none by default. */
  names?: number;
}

/** A command's words, sorted. */
export interface Args {
  /** The flags given. */
  flags: Set<string>;
  /** The port given, or null for the command's default. */
  port: number | null;
  /** The plain words, in order. */
  names: string[];
}

const PORT = /^\d+$/;
const MAX_PORT = 65535;

/**
 * Sorts a command's words by `spec`, or gives null when they do not fit, for the caller to print
 * the usage line: a word starting with `-` that the command does not take (`--onec`, `-p`), a flag
 * given twice, a port that is not a whole number from 0 to 65535 (`--port ""`, `--port=5000x`,
 * `--port` with nothing after it), or more plain words than it takes. Nothing is guessed from a
 * word that is nearly a flag: the loop runs unattended, and `start --onec` must not run forever.
 */
export function parseArgs(args: readonly string[], spec: ArgSpec): Args | null {
  const out: Args = { flags: new Set(), port: null, names: [] };
  const takes = new Set(spec.flags ?? []);
  const port = (text: string | undefined): boolean => {
    if (!spec.port || out.port !== null || text === undefined || !PORT.test(text) || Number(text) > MAX_PORT) return false;
    out.port = Number(text);
    return true;
  };
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--port") {
      if (!port(args[++i])) return null;
    } else if (word.startsWith("--port=")) {
      if (!port(word.slice("--port=".length))) return null;
    } else if (word.startsWith("-")) {
      if (!takes.has(word) || out.flags.has(word)) return null;
      out.flags.add(word);
    } else {
      if (out.names.length >= (spec.names ?? 0)) return null;
      out.names.push(word);
    }
  }
  return out;
}
