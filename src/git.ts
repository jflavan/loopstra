import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkoutKey, onCheckoutKey, onRemoteKey, realPathKey } from "./lanes";
import { lastLine, spawnBounded } from "./shell";
import { endsStepQuietly, notTheStepsFault, StopRequested } from "./stop";

/** How long one git call may take before it is stopped (a Git constructor option overrides it). */
export const GIT_TIMEOUT_MS = 5 * 60_000;

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
}

/** Commands that write, or refresh, the index or the files of the checkout they run in: the checkout lock's. */
const WRITES_CHECKOUT: ReadonlySet<string> = new Set([
  "add", "commit", "status", "diff", "checkout", "reset", "merge", "rebase", "rm", "restore", "stash",
  "cherry-pick", "apply", "read-tree", "update-index", "clean", "switch", "mv",
]);
/** Commands that write the remote-tracking refs: the remote lock's. */
const WRITES_REMOTE: ReadonlySet<string> = new Set(["fetch", "push"]);

/** The git command of an argument list: the first argument after any `-c name=value` pairs. */
function subcommand(args: string[]): string {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i] ?? "";
}

export type GitResult = { code: number; out: string; err: string };

/** Whether a repository has its own ssh command configured (then GIT_SSH_COMMAND must not override it). */
const sshConfigured = new Map<string, boolean>();
function hasOwnSshCommand(cwd: string): boolean {
  let known = sshConfigured.get(cwd);
  if (known === undefined) {
    try {
      const r = Bun.spawnSync({ cmd: ["git", "config", "--get", "core.sshCommand"], cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      known = r.exitCode === 0 && r.stdout.toString().trim().length > 0;
    } catch { known = false; }
    sshConfigured.set(cwd, known);
  }
  return known;
}

/**
 * The environment of every git call: it never waits for a person to type a password or confirm a
 * key, and it speaks English (the C locale) whatever the machine's language, since some of its
 * messages are read (conflicts, a missing session, the last line of an error).
 */
function gitEnv(cwd: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", LC_ALL: "C", LANG: "C" };
  delete env.SSH_ASKPASS;
  delete env.LANGUAGE;
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !hasOwnSshCommand(cwd)) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/** At most this many paths go on one git command line (Windows limits a command line to 32K characters). */
export const DIFF_CHUNK = 200;

/** `items` in consecutive slices of at most `size`. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
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
   * `allowFail` (or `true`) returns a non-zero exit instead of throwing. In the main checkout, a
   * command that writes its index or files takes the checkout lock, and fetch and push take the
   * remote lock; every other command, and every command in a linked worktree, takes none.
   */
  async run(args: string[], opts: boolean | GitRunOptions = {}): Promise<GitResult> {
    const o: GitRunOptions = typeof opts === "boolean" ? { allowFail: opts } : opts;
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    const spawn = () => spawnBounded({
      cmd: ["git", ...args], cwd: this.cwd, env: gitEnv(this.cwd), timeoutMs,
      onStop: o.cleanup ? "ignore" : "grace", graceMs: this.stopGraceMs,
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
  async headSha(): Promise<string> { return (await this.run(["rev-parse", "HEAD"])).out.trim(); }
  async branchExists(name: string): Promise<boolean> { return (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], true)).code === 0; }
  async createBranch(name: string, from: string): Promise<void> { await this.run(["branch", name, from]); }
  async deleteBranch(name: string): Promise<void> { await this.run(["branch", "-D", name]); }
  async worktreePrune(): Promise<void> { await worktreeAdmin(this, () => this.run(["worktree", "prune"])); }

  /** Always prunes first, so a worktree whose directory was deleted by hand does not block the add. */
  async worktreeAdd(path: string, branch: string): Promise<void> {
    await worktreeAdmin(this, async () => {
      await this.run(["worktree", "prune"]);
      await this.run(["worktree", "add", path, branch]);
    });
  }

  /**
   * Makes `dir` a worktree of this repository checked out on `branch`. An existing directory is
   * reused only if it is itself a worktree root (not just a folder inside the main checkout) on
   * `branch`; anything else is removed and the worktree is added again. No lock: git keeps another
   * change's prune off a worktree it is still adding (it marks it "initializing").
   */
  async ensureWorktree(dir: string, branch: string): Promise<void> {
    if (existsSync(dir)) {
      const there = new Git(dir);
      if ((await there.isWorktreeRoot()) && (await there.currentBranch()) === branch) return;
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
  async worktreeRemove(path: string): Promise<void> {
    await worktreeAdmin(this, async () => {
      const r = await this.run(["worktree", "remove", "--force", "--force", path], true);
      if (r.code !== 0) {
        // Windows can hold a brief open handle on a just-written file; retry once after a short wait.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await this.run(["worktree", "remove", "--force", "--force", path]);
      }
      await this.run(["worktree", "prune"]);
    });
  }

  async isDirty(): Promise<boolean> { return (await this.run(["status", "--porcelain"])).out.trim().length > 0; }
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> { return (await this.run(["merge-base", "--is-ancestor", ancestor, descendant], true)).code === 0; }

  /**
   * True when `target` already has `branch`'s changes: the branch is part of its history, or it has
   * the branch's version of every file the branch changed since the two diverged (a squash merge).
   * Paths under an `ignore` prefix are left out of the comparison.
   */
  async containsChanges(target: string, branch: string, ignore: string[] = []): Promise<boolean> {
    if (await this.isAncestor(branch, target)) return true;
    // -z: the names as they are; without it git quotes a non-ASCII name, and a quoted name matches no file.
    const changed = await this.run(["diff", "--name-only", "-z", `${target}...${branch}`], true);
    if (changed.code !== 0) return false;
    const files = changed.out.split("\0").filter((f) => f && !ignore.some((p) => f.startsWith(p)));
    if (!files.length) return true;
    // In chunks: one command line for thousands of paths would pass Windows' 32K character limit.
    for (const chunk of chunks(files, DIFF_CHUNK)) {
      if ((await this.run(["diff", "--quiet", target, branch, "--", ...chunk], true)).code !== 0) return false;
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

  /**
   * Commits only the given paths, as the runtime. Anything else a person has staged stays staged
   * and out of the commit. False when the paths have nothing to commit. `finish`: once begun, a stop
   * request does not stop it (see GitRunOptions.cleanup).
   */
  async commitPaths(paths: string[], message: string, opts: { finish?: boolean } = {}): Promise<boolean> {
    // Skip paths that don't exist: `git add -- <missing pathspec>` errors instead of no-op-ing,
    // and callers (e.g. commitRecord) pass paths, like intent/queue.md, that may not exist yet.
    const existing = paths.filter((p) => existsSync(join(this.cwd, p)));
    if (!existing.length) return false;
    const o = { cleanup: opts.finish === true };
    await this.run(["add", "-A", "--", ...existing], o);
    const staged = (await this.run(["diff", "--cached", "--name-only", "--", ...existing], o)).out.trim();
    if (!staged) return false;
    await this.runtime("commit", ["-q", "-m", message, "--", ...existing], o);
    return true;
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

/** An index lock older than this is left over from a git process that died: the loop's own calls end within GIT_TIMEOUT_MS. */
export const STALE_LOCK_MS = 10 * 60_000;

/**
 * Removes `index.lock` files older than `maxAgeMs` from the repository and each of its worktrees,
 * and returns their paths. A killed git leaves its lock behind, and every later git write then fails;
 * the loop is the only automated git user, and a person's git command does not hold a lock that long.
 */
export async function removeStaleLocks(root: string, maxAgeMs = STALE_LOCK_MS, now = Date.now()): Promise<string[]> {
  const common = await new Git(root).run(["rev-parse", "--git-common-dir"], true);
  if (common.code !== 0) return [];
  const gitDir = resolve(root, common.out.trim());
  const worktrees = join(gitDir, "worktrees");
  const candidates = [join(gitDir, "index.lock")];
  if (existsSync(worktrees)) for (const name of readdirSync(worktrees)) candidates.push(join(worktrees, name, "index.lock"));
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
 * of it, unlocked first in case a `worktree add` killed part way left it locked.
 */
export async function removeWorktree(git: Git, dir: string): Promise<void> {
  if (existsSync(dir)) {
    try {
      await git.worktreeRemove(dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  await worktreeAdmin(git, async () => {
    await git.run(["worktree", "unlock", dir], true);
    await git.run(["worktree", "prune"], true);
  });
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

/** Runs `fn` in a throwaway detached worktree of `ref` at `dir` (see addDetachedWorktree), and always removes it afterwards. */
export async function withDetachedWorktree<T>(git: Git, dir: string, ref: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await addDetachedWorktree(git, dir, ref);
  try {
    return await fn(dir);
  } finally {
    await removeWorktree(git, dir);
  }
}
