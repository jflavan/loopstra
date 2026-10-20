import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkoutKey, onCheckoutKey, onRemoteKey, realPathKey } from "./lanes";
import { lastLine, spawnBounded, withoutGitHookEnv } from "./shell";
import { endsStepQuietly, notTheStepsFault, StopRequested } from "./stop";

/** How long one git call may take before it is stopped (a Git constructor option overrides it). */
const GIT_TIMEOUT_MS = 5 * 60_000;

/** After a stop request, a running git call gets this long to finish on its own before it is killed (a Git constructor option overrides it). */
const STOP_GRACE_MS = 2_000;

/** The identity every commit the runtime makes is authored with. */
export const RUNTIME_NAME = "Loopstra";
export const RUNTIME_EMAIL = "loopstra@localhost";

/**
 * Turns off git's automatic gc and maintenance for one command. Commits, fetches and merges start
 * them when they end, in the background: they could pack refs while another change commits or
 * deletes a branch, and that one would fail with "cannot lock ref". The tick start runs gc itself
 * while no step runs.
 */
export const NO_AUTO_MAINTENANCE: readonly string[] = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/**
 * Settings for every commit the runtime makes (bookkeeping on main, saves in a worktree, merges,
 * rebases): its own identity, and never a signing prompt. Hooks are skipped with `--no-verify`
 * where the command has it; the gates run the configured checks instead of the owner's hooks.
 * No automatic gc or maintenance (see NO_AUTO_MAINTENANCE).
 */
export const RUNTIME_COMMIT_CONFIG: readonly string[] = [
  "-c", `user.name=${RUNTIME_NAME}`, "-c", `user.email=${RUNTIME_EMAIL}`, "-c", "commit.gpgsign=false",
  ...NO_AUTO_MAINTENANCE,
];

/**
 * The message of a bookkeeping commit on main (status changes, artifacts, a person's recorded
 * edits): marked so CI skips it. The change's own merge commit is not bookkeeping.
 */
export function bookkeeping(message: string): string {
  return `${message} [skip ci]`;
}

/** Git's own advice lines (line-ending warnings and the like) are not the error. */
const ADVICE = /^warning:/i;

export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stdout: string, public readonly stderr: string, public readonly code: number, message?: string) {
    // git prints conflict text to stdout, not stderr, so fall back to stdout when stderr has nothing useful.
    super(message ?? `git ${args.join(" ")} failed (${code}): ${lastLine(stderr, ADVICE) || lastLine(stdout, ADVICE)}`);
  }
}

/** A git call ran past its time limit and was stopped (with everything it started). */
export class GitTimeout extends GitError {
  constructor(args: string[], timeoutMs: number) {
    super(args, "", "", 124, `git ${args.join(" ")} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`);
    this.name = "GitTimeout";
  }
}

/** The owner's note when a version-control command hung inside a step. */
export const GIT_TIMEOUT_NOTE = "A version-control command did not finish in time; an engineer should look.";

/**
 * Rethrows a stop request, an unavailable assistant, the loop's used-up day, a session a person
 * stopped, a question an agent asked, or a git timeout. Code that turns errors into a failure of its
 * own calls this first: none is that step's failure, and the scheduler handles each the same way everywhere.
 */
export function passOn(e: unknown): void {
  if (notTheStepsFault(e) || endsStepQuietly(e) || e instanceof GitTimeout) throw e;
}

export interface GitRunOptions {
  /** Return a non-zero exit instead of throwing. A timeout or a stop still throws. */
  allowFail?: boolean;
  timeoutMs?: number;
  /**
   * A call that must finish once begun (an abort, the commit of a record already written, moving
   * main): it runs even after a stop was requested and is not stopped by one, so nothing is left
   * half-way. Still bounded by the timeout.
   */
  cleanup?: boolean;
  /** Variables added to the command's environment (a temporary index's GIT_INDEX_FILE, say). */
  env?: Record<string, string>;
  /** Text written to the command's stdin, which is then closed. */
  stdin?: string;
}

/** Commands that write, or refresh, the index or the files of the checkout they run in: the checkout lock's. */
const WRITES_CHECKOUT: ReadonlySet<string> = new Set([
  "add", "commit", "status", "diff", "checkout", "reset", "merge", "rebase", "rm", "restore", "stash",
  "cherry-pick", "apply", "read-tree", "update-index", "clean", "switch", "mv",
]);
/** Commands that write the remote-tracking refs: the remote lock's. */
const WRITES_REMOTE: ReadonlySet<string> = new Set(["fetch", "push"]);

/**
 * The git command of an argument list: the first argument after any `-c name=value` pairs. Only
 * that prefix is skipped: every call here puts its command right after its `-c` settings, and no
 * other option (`-C`, `--git-dir`) is ever passed before it. One that were would be read as the
 * command, and the call would take no lock.
 */
function subcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

type GitResult = { code: number; out: string; err: string };

/** Whether a repository has its own ssh command configured (then GIT_SSH_COMMAND must not override it). */
const sshConfigured = new Map<string, boolean>();
function hasOwnSshCommand(cwd: string): boolean {
  let known = sshConfigured.get(cwd);
  if (known === undefined) {
    try {
      // The repository at cwd, not one a hook named in the environment (see GIT_LOCATION_VARS).
      const r = Bun.spawnSync({ cmd: ["git", "config", "--get", "core.sshCommand"], cwd, env: withoutGitHookEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      known = r.exitCode === 0 && r.stdout.toString().trim().length > 0;
    } catch { known = false; }
    sshConfigured.set(cwd, known);
  }
  return known;
}

/**
 * The environment of every git call: it never waits for a person to type a password or confirm a
 * key, and it speaks English (the C locale) whatever the machine's language, since some of its
 * messages are read (conflicts, a missing session, the last line of an error). An author or committer
 * named in the environment is dropped: it would win over RUNTIME_COMMIT_CONFIG's identity, and every
 * commit this git makes is the runtime's (a replayed commit keeps the author it recorded). So is a
 * repository location named in it (see GIT_LOCATION_VARS): the call works on the checkout it is
 * given, even when Loopstra was started from a git hook or alias. So are the hook's pathspec rules,
 * commit dates and `-c` settings (see GIT_HOOK_VARS in src/shell.ts): a `:(literal)` pathspec stays
 * literal, and a commit gets its own time.
 */
function gitEnv(cwd: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = withoutGitHookEnv({ ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", LC_ALL: "C", LANG: "C" });
  delete env.SSH_ASKPASS;
  delete env.LANGUAGE;
  for (const who of ["AUTHOR", "COMMITTER"]) { delete env[`GIT_${who}_NAME`]; delete env[`GIT_${who}_EMAIL`]; }
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !hasOwnSshCommand(cwd)) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/** At most this many paths go on one git command line. */
export const DIFF_CHUNK = 200;

/**
 * At most this many characters of paths go on one git command line, each counted as the literal
 * pathspec it is passed as: Windows limits a whole command line to 32K characters, and the rest of
 * the command (git's path, two commits, options) needs room beside them.
 */
export const DIFF_CHARS = 24_000;

/** The prefix that makes a pathspec literal. */
const LITERAL = ":(literal)";

/** What a path takes on a command line as a literal pathspec, beside its own characters: the prefix and a space. */
const PATHSPEC_EXTRA = LITERAL.length + 1;

/**
 * The paths as literal pathspecs: each names only itself, never every file a * or [ in it would
 * match. pathChunks counts each path at this length (PATHSPEC_EXTRA).
 */
export function literalPathspecs(paths: string[]): string[] {
  return paths.map((p) => LITERAL + p);
}

/**
 * `paths` in consecutive slices of at most `size` paths and `chars` characters (see DIFF_CHARS), for
 * one git command line each. A path longer than `chars` on its own still gets a slice, alone.
 */
export function pathChunks(paths: string[], size = DIFF_CHUNK, chars = DIFF_CHARS): string[][] {
  const out: string[][] = [];
  let slice: string[] = [];
  let used = 0;
  for (const p of paths) {
    const cost = p.length + PATHSPEC_EXTRA;
    if (slice.length && (slice.length >= size || used + cost > chars)) { out.push(slice); slice = []; used = 0; }
    slice.push(p);
    used += cost;
  }
  if (slice.length) out.push(slice);
  return out;
}

/** The checkout is on a different branch than the caller is about to commit to. */
export class WrongBranchError extends Error {
  constructor(public readonly cwd: string, public readonly expected: string, public readonly actual: string) {
    super(`expected ${cwd} to be on branch ${expected} but it is on ${actual}`);
  }
}

/** True when two paths name the same directory (resolves links, 8.3 names, slashes, and case on Windows). */
export function samePath(a: string, b: string): boolean {
  return realPathKey(a) === realPathKey(b);
}

export class Git {
  private readonly timeoutMs: number;
  private readonly stopGraceMs: number;
  /** The key of this checkout's locks (see checkoutKey), or null for a linked worktree, which takes none. */
  private readonly lockKey: string | null;
  constructor(public readonly cwd: string, opts: { timeoutMs?: number; stopGraceMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    this.stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
    this.lockKey = checkoutKey(cwd);
  }

  /**
   * Runs one git command. Bounded: past the timeout it is stopped with everything it started and
   * GitTimeout is thrown. It never asks for credentials. It does not start after a stop request; a
   * stop during the call gives it a moment to finish, then kills it, and throws StopRequested.
   * `allowFail` (or `true`) returns a non-zero exit instead of throwing: `run(args, true)` and
   * `run(args, { allowFail: true })` mean the same, and both spellings are in use (the shorthand
   * where that is the only option, the object where a timeout or `cleanup` goes with it). In the
   * main checkout, a command that writes its index or files takes the checkout lock, and fetch and
   * push take the remote lock; every other command, and every command in a linked worktree, takes none.
   */
  async run(args: string[], opts: boolean | GitRunOptions = {}): Promise<GitResult> {
    const o: GitRunOptions = typeof opts === "boolean" ? { allowFail: opts } : opts;
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    const spawn = () => spawnBounded({
      cmd: ["git", ...args], cwd: this.cwd, env: { ...gitEnv(this.cwd), ...o.env }, timeoutMs,
      onStop: o.cleanup ? "ignore" : "grace", graceMs: this.stopGraceMs,
      ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
    });
    const sub = subcommand(args);
    const key = this.lockKey;
    const r = key === null ? await spawn()
      : WRITES_CHECKOUT.has(sub) ? await onCheckoutKey(key, spawn)
      : WRITES_REMOTE.has(sub) ? await onRemoteKey(key, spawn)
      : await spawn();
    if (r.timedOut) throw new GitTimeout(args, timeoutMs);
    if (r.stopped) throw new StopRequested();
    const code = r.code ?? 1;
    if (code !== 0 && !o.allowFail) throw new GitError(args, r.out, r.err, code);
    return { code, out: r.out, err: r.err };
  }

  /** Runs a command that makes commits, as the runtime: its identity, no signing, no hooks where `--no-verify` exists. */
  runtime(sub: "commit" | "commit-tree" | "merge" | "rebase", rest: string[], opts: boolean | GitRunOptions = {}): Promise<GitResult> {
    const noVerify = sub === "commit-tree" ? [] : ["--no-verify"];
    return this.run([...RUNTIME_COMMIT_CONFIG, sub, ...noVerify, ...rest], opts);
  }

  /** `git fetch` with these arguments, without the automatic gc or maintenance a fetch starts (see NO_AUTO_MAINTENANCE). */
  fetch(args: string[], opts: boolean | GitRunOptions = {}): Promise<GitResult> {
    return this.run([...NO_AUTO_MAINTENANCE, "fetch", ...args], opts);
  }

  /** The checked-out branch (`HEAD` when detached), or "" when it cannot be read. */
  async currentBranch(): Promise<string> {
    const r = await this.run(["rev-parse", "--abbrev-ref", "HEAD"], true);
    return r.code === 0 ? r.out.trim() : "";
  }
  /** True when this path is the top of a checkout (a real worktree), not a plain folder inside another one. */
  async isWorktreeRoot(): Promise<boolean> {
    const top = await this.run(["rev-parse", "--show-toplevel"], true);
    return top.code === 0 && samePath(top.out.trim(), this.cwd);
  }
  /** False when this worktree's `git worktree add` never finished: git's "initializing" lock is still on it, or it has no index yet. */
  async addFinished(): Promise<boolean> {
    const gitPath = async (name: string) => resolve(this.cwd, (await this.run(["rev-parse", "--git-path", name])).out.trim());
    const lock = await gitPath("locked");
    if (existsSync(lock) && readFileSync(lock, "utf8").trim() === "initializing") return false;
    return existsSync(await gitPath("index"));
  }
  async headSha(): Promise<string> { return (await this.run(["rev-parse", "HEAD"])).out.trim(); }
  async branchExists(name: string): Promise<boolean> { return (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], true)).code === 0; }
  async createBranch(name: string, from: string): Promise<void> { await this.run(["branch", name, from]); }
  async deleteBranch(name: string): Promise<void> { await this.run(["branch", "-D", name]); }
  async worktreePrune(): Promise<void> { await worktreeAdmin(this, () => this.run(["worktree", "prune"])); }

  /**
   * Always prunes first, unlocking the path before, so a worktree whose directory was deleted by hand,
   * or a killed add's "initializing" lock on it (a prune never takes a locked entry), does not block the add.
   */
  async worktreeAdd(path: string, branch: string): Promise<void> {
    await worktreeAdmin(this, async () => {
      await this.run(["worktree", "unlock", path], true);
      await this.run(["worktree", "prune"]);
      await this.run(["worktree", "add", path, branch]);
    });
  }

  /**
   * Makes `dir` a worktree of this repository checked out on `branch`. An existing directory is
   * reused only if it is itself a worktree root (not just a folder inside the main checkout) on
   * `branch` whose add finished (a killed add leaves files missing, and the next save would commit
   * them as deleted); anything else is removed and the worktree is added again. No lock: git keeps
   * another change's prune off a worktree it is still adding (it marks it "initializing").
   */
  async ensureWorktree(dir: string, branch: string): Promise<void> {
    if (existsSync(dir)) {
      const there = new Git(dir);
      if ((await there.isWorktreeRoot()) && (await there.currentBranch()) === branch && (await there.addFinished())) return;
      await removeWorktree(this, dir);
    }
    await this.worktreeAdd(dir, branch);
  }

  /** Throws unless the checkout at this path is on `expected`. Call before committing. */
  async assertBranch(expected: string): Promise<void> {
    const actual = (await this.currentBranch()) || "(unknown)";
    if (actual !== expected) throw new WrongBranchError(this.cwd, expected, actual);
  }

  /**
   * Removes a worktree, even a locked one (--force twice: a `worktree add` killed part way leaves its
   * "initializing" lock behind), then prunes git's records of worktrees whose folder is gone.
   */
  async worktreeRemove(path: string, opts: { cleanup?: boolean } = {}): Promise<void> {
    const cleanup = opts.cleanup === true;
    await worktreeAdmin(this, async () => {
      const r = await this.run(["worktree", "remove", "--force", "--force", path], { allowFail: true, cleanup });
      if (r.code !== 0) {
        // Windows can hold a brief open handle on a just-written file; retry once after a short wait.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await this.run(["worktree", "remove", "--force", "--force", path], { cleanup });
      }
      await this.run(["worktree", "prune"], { cleanup });
    });
  }

  async isDirty(): Promise<boolean> { return (await this.run(["status", "--porcelain"])).out.trim().length > 0; }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> { return (await this.run(["merge-base", "--is-ancestor", ancestor, descendant], true)).code === 0; }

  /**
   * True when `target` already has `branch`'s changes: the branch is part of its history, or it has
   * the branch's version of every file the branch changed since the two diverged (a squash merge).
   * Paths under an `ignore` prefix are left out of the comparison; with `ignoreOnlyWithOthers`, only
   * when the branch changed a file outside them too (a branch that changed nothing else has every
   * file compared, since with nothing left the test would always pass). The files compared are
   * those the branch changed since it diverged from `base`, `target` itself unless given: a caller
   * asking whether a merged pull request's head has the branch's commits names main as the base,
   * since the branch may have been rebased onto a main that has that merge, and then only the
   * commits on top are the branch's own.
   */
  async containsChanges(target: string, branch: string, opts: { ignore?: string[]; base?: string; ignoreOnlyWithOthers?: boolean } = {}): Promise<boolean> {
    const { ignore = [], base = target, ignoreOnlyWithOthers = false } = opts;
    if (await this.isAncestor(branch, target)) return true;
    // -z: the names as they are; without it git quotes a non-ASCII name, and a quoted name matches no file.
    const changed = await this.run(["diff", "--name-only", "-z", `${base}...${branch}`], true);
    if (changed.code !== 0) return false;
    const all = changed.out.split("\0").filter(Boolean);
    const outside = all.filter((f) => !ignore.some((p) => f.startsWith(p)));
    const files = ignoreOnlyWithOthers && !outside.length ? all : outside;
    if (!files.length) return true;
    // In chunks: one command line for thousands of paths would pass Windows' 32K character limit.
    // Each name literal, so one with * or [ in it is compared, not every file it matches.
    for (const chunk of pathChunks(files)) {
      if ((await this.run(["diff", "--quiet", target, branch, "--", ...literalPathspecs(chunk)], true)).code !== 0) return false;
    }
    return true;
  }

  /** Commits on `a` that `b` does not have (0 when either cannot be read). */
  async countAhead(a: string, b: string): Promise<number> {
    const r = await this.run(["rev-list", "--count", `${b}..${a}`], true);
    return r.code === 0 ? Number.parseInt(r.out.trim(), 10) || 0 : 0;
  }

  /** Commits everything in the checkout, as the runtime. False when there was nothing to commit. */
  async commitAll(message: string): Promise<boolean> {
    await this.run(["add", "-A"]);
    if ((await this.run(["diff", "--cached", "--quiet"], true)).code === 0) return false;
    await this.runtime("commit", ["-q", "-m", message]);
    return true;
  }

  /** Tracked files changed in the checkout and not committed (staged or not). New files are left out. */
  async changedTrackedFiles(): Promise<string[]> {
    return (await this.run(["diff", "--name-only", "-z", "HEAD"])).out.split("\0").filter(Boolean);
  }

  /** Puts tracked files back as HEAD has them, staged and unstaged edits alike. */
  async putBack(files: string[]): Promise<void> {
    // In chunks, as in containsChanges; each name literal, so one with * or [ in it names only itself.
    for (const chunk of pathChunks(files)) await this.run(["checkout", "HEAD", "--", ...literalPathspecs(chunk)]);
  }

  /**
   * Commits only the given paths, as the runtime. Anything else a person has staged stays staged
   * and out of the commit. False when the paths have nothing to commit. `finish`: once begun, a stop
   * request does not stop it (see GitRunOptions.cleanup).
   */
  async commitPaths(paths: string[], message: string, opts: { finish?: boolean } = {}): Promise<boolean> {
    const o = { cleanup: opts.finish === true };
    const toCommit = await this.stagePaths(paths, o);
    if (!toCommit) return false;
    await this.runtime("commit", ["-q", "-m", message, "--", ...toCommit], o);
    return true;
  }

  /**
   * Stages `paths` as they are on disk into the index `o.env` names (the checkout's by default), by the
   * rules commitPaths has always used: an ignored, untracked file is left out, a removal is taken
   * along, and a path that matches nothing is not named. The paths to commit, or null when none
   * differs from what HEAD has.
   */
  async stagePaths(paths: string[], o: GitRunOptions = {}): Promise<string[] | null> {
    const names = (out: string) => out.split("\0").filter(Boolean);
    const covers = (list: string[]) => (p: string) => list.some((l) => l === p || l.startsWith(`${p.replace(/\/$/, "")}/`));
    // `git add -A -- <pathspec>` errors on a path that matches nothing it can stage, so these are left out:
    // - one on disk that is ignored and untracked (a repository that ignores .claude/, say);
    //   check-ignore leaves tracked files out, and exits 1 when nothing is ignored;
    // - one missing on disk and not in the index: never seen (callers such as commitRecord pass
    //   paths, like intent/queue.md, that may not exist yet), or its removal already staged (git rm).
    const present = paths.filter((p) => existsSync(join(this.cwd, p)));
    const missing = paths.filter((p) => !present.includes(p));
    let ignored = new Set<string>();
    if (present.length) {
      // One path per line, as given (-z needs --stdin); quotepath off so other alphabets are not quoted.
      const r = await this.run(["-c", "core.quotepath=false", "check-ignore", "--", ...present], { ...o, allowFail: true });
      if (r.code > 1) throw new GitError(["check-ignore", "--", ...present], r.out, r.err, r.code);
      ignored = new Set(r.out.split(/\r?\n/).filter(Boolean));
    }
    const indexed = names((await this.run(["ls-files", "-z", "--", ...paths], o)).out);
    const inIndex = covers(indexed);
    let inHead: (p: string) => boolean = () => false;
    if (missing.length) {
      // No HEAD yet (no commit): nothing is in it.
      const head = await this.run(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...missing], { ...o, allowFail: true });
      inHead = covers(head.code === 0 ? names(head.out) : []);
    }
    const onDisk = (p: string) => present.includes(p) && !ignored.has(p);
    const toAdd = paths.filter((p) => onDisk(p) || (missing.includes(p) && inIndex(p)));
    // In HEAD, missing on disk: its removal is committed (also one already staged with git rm). A path
    // only in the index (staged, never committed) is gone from it after the add: naming it would match nothing.
    const toCommit = paths.filter((p) => onDisk(p) || (missing.includes(p) && inHead(p)));
    // A tracked file is staged with -u: -A also looks for new files around it, and fails (after
    // staging it) when its folder is ignored (a skill force-added in an ignored .claude/, say).
    const tracked = toAdd.filter((p) => indexed.includes(p));
    const others = toAdd.filter((p) => !indexed.includes(p));
    if (tracked.length) await this.run(["add", "-u", "--", ...tracked], o);
    if (others.length) await this.run(["add", "-A", "--", ...others], o);
    // Never a commit without paths: that would take everything staged.
    if (!toCommit.length) return null;
    const staged = (await this.run(["diff", "--cached", "--name-only", "--", ...toCommit], o)).out.trim();
    return staged ? toCommit : null;
  }

  /**
   * A commit made from `parent` without touching the checkout's index or files: `paths` as they are
   * on disk (see stagePaths), with `changes` over them, in a temporary index. Each content is hashed
   * with `--path`, so the repository's line-ending and attribute rules apply as `git add` applies
   * them. Made as the runtime (no hooks, the records' identity). Null when the tree is `parent`'s.
   */
  async commitFiles(parent: string, paths: string[], changes: ReadonlyArray<{ rel: string; text: string | null }>, message: string): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "loopstra-index-"));
    const o: GitRunOptions = { env: { GIT_INDEX_FILE: join(dir, "index") }, cleanup: true };
    try {
      await this.run(["read-tree", parent], o);
      // Its answer compares the temporary index with HEAD, not with `parent`: the trees are compared below instead.
      await this.stagePaths(paths, o);
      for (const c of changes) {
        if (c.text === null) {
          await this.run(["update-index", "--force-remove", "--", c.rel], o);
          continue;
        }
        const blob = (await this.run(["hash-object", "-w", `--path=${c.rel}`, "--stdin"], { ...o, stdin: c.text })).out.trim();
        // A file already in the temporary index keeps its mode there (`parent`'s, or one a person set
        // on disk that stagePaths took along: an executable stays one); a new one is a plain file.
        const mode = (await this.run(["ls-files", "-s", "--", c.rel], o)).out.split(/\s/)[0] || "100644";
        await this.run(["update-index", "--add", "--cacheinfo", `${mode},${blob},${c.rel}`], o);
      }
      const tree = (await this.run(["write-tree"], o)).out.trim();
      const parentTree = (await this.run(["rev-parse", `${parent}^{tree}`], o)).out.trim();
      if (tree === parentTree) return null;
      return (await this.runtime("commit-tree", [tree, "-p", parent, "-m", message], o)).out.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Moves `ref` (a full name, such as `refs/heads/main`) from `from` to `to`, as a
   * compare-and-swap: false when the ref is no longer `from`. A branch is named, not HEAD, so a
   * person switching branches meanwhile never has theirs moved. Any other failure (a missing object,
   * a ref another git process has locked) throws a GitError, so a real error is never taken for a race.
   */
  async moveRef(ref: string, from: string, to: string): Promise<boolean> {
    const args = ["update-ref", "-m", "loopstra: record", ref, to, from];
    const r = await this.run(args, { allowFail: true, cleanup: true });
    if (r.code === 0) return true;
    // git's words when the ref holds another value (LC_ALL=C, see gitEnv): "cannot lock ref '<ref>': is at <sha> but expected <sha>".
    if (/: is at [0-9a-f]+ but expected [0-9a-f]+/.test(r.err)) return false;
    throw new GitError(args, r.out, r.err, r.code);
  }

  /** The commit a ref names, or null when it names none. */
  async commitOf(ref: string): Promise<string | null> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true);
    return r.code === 0 ? r.out.trim() : null;
  }

  async changedFilesSince(base: string): Promise<string[]> {
    return (await this.run(["diff", "--name-only", "-z", `${base}...HEAD`])).out.split("\0").filter(Boolean);
  }

  /** True when a rebase is in progress in this checkout. */
  async rebasing(): Promise<boolean> {
    for (const name of ["rebase-merge", "rebase-apply"]) {
      const p = (await this.run(["rev-parse", "--git-path", name], true)).out.trim();
      if (p && existsSync(resolve(this.cwd, p))) return true;
    }
    return false;
  }

  /** Replays this checkout's branch onto `base`, as the runtime. A conflict is aborted and reported as false. */
  async rebaseOnto(base: string): Promise<boolean> {
    // A rebase left over from an interrupted step is the runtime's own (this is its worktree).
    if (await this.rebasing()) await this.run(["rebase", "--abort"], { allowFail: true, cleanup: true });
    let r: GitResult;
    try {
      r = await this.runtime("rebase", ["-q", base], true);
    } catch (e) {
      await this.run(["rebase", "--abort"], { allowFail: true, cleanup: true });
      throw e;
    }
    if (r.code !== 0) { await this.run(["rebase", "--abort"], { allowFail: true, cleanup: true }); return false; }
    return true;
  }

  /**
   * The commit that merges `branch` into the checked-out commit, built without touching the
   * checkout (moveMain then moves main to it): `squash`, the branch's tree on top of the current
   * commit; `merge`, a merge commit of the two. The branch must contain the current commit (the
   * merge checks make sure), so its tree is the merge's and nothing can conflict. `from` is the
   * current commit, `to` the merge.
   */
  async mergeCommit(branch: string, method: "squash" | "merge", message: string): Promise<{ from: string; to: string }> {
    const from = await this.headSha();
    if (!(await this.isAncestor(from, branch))) {
      throw new GitError(["merge", branch], "", `${branch} does not contain the current commit; bring it up to date first`, 1);
    }
    const parents = method === "squash" ? ["-p", from] : ["-p", from, "-p", branch];
    const to = (await this.runtime("commit-tree", [`${branch}^{tree}`, ...parents, "-m", message])).out.trim();
    return { from, to };
  }

  /** The remote Loopstra works with: origin when there is one, else the first; null without a remote. */
  async remoteName(): Promise<string | null> {
    const names = (await this.run(["remote"])).out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!names.length) return null;
    return names.includes("origin") ? "origin" : names[0]!;
  }
}

/** A git lock older than this is left over from a git process that died: the loop's own calls end within GIT_TIMEOUT_MS. */
export const STALE_LOCK_MS = 10 * 60_000;

/** The lock files a killed git can leave in a git directory, beside those under refs/. */
const LOCK_FILES = ["index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"];

/** Every `*.lock` file under `dir`, at any depth (none when `dir` does not exist). */
function lockFilesUnder(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...lockFilesUnder(p));
    else if (e.name.endsWith(".lock")) found.push(p);
  }
  return found;
}

/**
 * Removes git's lock files older than `maxAgeMs` from the repository and each of its worktrees, and
 * returns their paths: `index.lock`, `HEAD.lock`, `packed-refs.lock`, `config.lock`, and every
 * `*.lock` under `refs/`, in the main git directory and under each `worktrees/*`. A killed git
 * leaves the lock of what it was writing behind (a commit holds the index's and the branch's, a
 * push the packed refs'), and every later git write of that then fails; the loop is the only
 * automated git user, and a person's git command does not hold a lock that long.
 */
export async function removeStaleLocks(root: string, maxAgeMs = STALE_LOCK_MS, now = Date.now()): Promise<string[]> {
  const common = await new Git(root).run(["rev-parse", "--git-common-dir"], true);
  if (common.code !== 0) return [];
  const gitDir = resolve(root, common.out.trim());
  const worktrees = join(gitDir, "worktrees");
  const dirs = [gitDir];
  if (existsSync(worktrees)) for (const name of readdirSync(worktrees)) dirs.push(join(worktrees, name));
  const candidates = dirs.flatMap((dir) => [...LOCK_FILES.map((name) => join(dir, name)), ...lockFilesUnder(join(dir, "refs"))]);
  const removed: string[] = [];
  for (const lock of candidates) {
    try {
      if (now - statSync(lock).mtimeMs < maxAgeMs) continue;
      rmSync(lock, { force: true });
      removed.push(lock);
    } catch { /* no lock there, or it went away meanwhile */ }
  }
  return removed;
}

/**
 * Removes a worktree directory however it can: git first, then the file system, then git's record
 * of it, unlocked first in case a `worktree add` killed part way left it locked. A stop request met
 * on the way does not leave the folder (a throwaway checkout with its installed dependencies, say):
 * its removal and git's unlock and prune are still tried, each on its own, and then the stop is
 * thrown, never a failure of theirs (a folder Windows holds, say): the stop is what the caller sees.
 */
export async function removeWorktree(git: Git, dir: string, opts: { cleanup?: boolean } = {}): Promise<void> {
  let stop: StopRequested | null = null;
  if (existsSync(dir)) {
    try {
      await git.worktreeRemove(dir, { cleanup: opts.cleanup === true });
    } catch (e) {
      if (!(e instanceof StopRequested)) rmSync(dir, { recursive: true, force: true });
      else {
        stop = e;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* the stop wins; the next add at this path removes what is left */ }
      }
    }
  }
  // After a stop, the unlock and prune still run (as cleanup calls do), so no record of the folder is left.
  const cleanup = opts.cleanup === true || stop !== null;
  const admin = worktreeAdmin(git, async () => {
    await git.run(["worktree", "unlock", dir], { allowFail: true, cleanup });
    await git.run(["worktree", "prune"], { allowFail: true, cleanup });
  });
  if (!stop) return admin;
  await admin.catch(() => { /* best effort: the stop wins */ });
  throw stop;
}

/** Makes `dir` a detached worktree of `ref` (never the owner's checkout); a leftover directory there is removed first. */
export async function addDetachedWorktree(git: Git, dir: string, ref: string): Promise<void> {
  await removeWorktree(git, dir);
  mkdirSync(dirname(dir), { recursive: true });
  await worktreeAdmin(git, () => git.run(["worktree", "add", "--detach", dir, ref]));
}

/** The worktree administration in flight, by repository (see worktreeAdmin). */
const admin = new Map<string, Promise<unknown>>();

/**
 * Runs git's worktree administration (add, remove, prune, unlock) for the repository at `git` one at a
 * time in this process. Two at once can trip over each other: worktrees whose folders share a name
 * (a change's snapshot of main and its done-check copy) race for one record under .git/worktrees, and
 * a prune can take the record of a worktree another add has only begun. Not a lock in the lock order:
 * nothing runs inside it but those git commands, so it never waits for another lock.
 */
function worktreeAdmin<T>(git: Git, fn: () => Promise<T>): Promise<T> {
  const key = realPathKey(git.cwd);
  const next = (admin.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  admin.set(key, tail);
  void tail.then(() => { if (admin.get(key) === tail) admin.delete(key); });
  return next;
}

/**
 * Runs `fn` in a throwaway detached worktree of `ref` at `dir` (see addDetachedWorktree), and always
 * tries to remove it afterwards. A removal that fails is given to `teardownFailed` (to trace it).
 */
export async function withDetachedWorktree<T>(git: Git, dir: string, ref: string, fn: (dir: string) => Promise<T>, teardownFailed?: (e: unknown) => void): Promise<T> {
  await addDetachedWorktree(git, dir, ref);
  try {
    return await fn(dir);
  } finally {
    // Best effort: a folder Windows still holds (a process the work left running there) must not hide
    // fn's result or error. The next add at this path removes what is left (see addDetachedWorktree).
    await removeWorktree(git, dir).catch((e) => { try { teardownFailed?.(e); } catch { /* the result stands */ } });
  }
}
