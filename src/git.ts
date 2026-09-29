import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lastLine, spawnBounded } from "./shell";
import { AssistantUnavailable, StopRequested } from "./stop";

/** How long one git call may take before it is stopped (a Git constructor option overrides it). */
export const GIT_TIMEOUT_MS = 5 * 60_000;

/** After a stop request, a running git call gets this long to finish on its own before it is killed (a Git constructor option overrides it). */
const STOP_GRACE_MS = 2_000;

/** The identity every commit the runtime makes is authored with. */
export const RUNTIME_NAME = "Loopstra";
export const RUNTIME_EMAIL = "loopstra@localhost";

/**
 * Settings for every commit the runtime makes (bookkeeping on main, saves in a worktree, merges,
 * rebases): its own identity, and never a signing prompt. Hooks are skipped with `--no-verify`
 * where the command has it; the gates run the configured checks instead of the owner's hooks.
 */
export const RUNTIME_COMMIT_CONFIG: readonly string[] = [
  "-c", `user.name=${RUNTIME_NAME}`, "-c", `user.email=${RUNTIME_EMAIL}`, "-c", "commit.gpgsign=false",
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
 * Rethrows a stop request, an unavailable assistant, or a git timeout. Code that turns errors into a
 * failure of its own calls this first: none is that step's failure, and the scheduler handles each
 * the same way everywhere.
 */
export function passOn(e: unknown): void {
  if (e instanceof StopRequested || e instanceof AssistantUnavailable || e instanceof GitTimeout) throw e;
}

export interface GitRunOptions {
  /** Return a non-zero exit instead of throwing. A timeout or a stop still throws. */
  allowFail?: boolean;
  timeoutMs?: number;
  /**
   * A call that puts things back (an abort): it runs even after a stop was requested and is not
   * stopped by one, so a checkout is never left half-way. Still bounded by the timeout.
   */
  cleanup?: boolean;
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

/** The environment of every git call: it never waits for a person to type a password or confirm a key. */
function gitEnv(cwd: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "" };
  delete env.SSH_ASKPASS;
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !hasOwnSshCommand(cwd)) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/** The checkout is on a different branch than the caller is about to commit to. */
export class WrongBranchError extends Error {
  constructor(public readonly cwd: string, public readonly expected: string, public readonly actual: string) {
    super(`expected ${cwd} to be on branch ${expected} but it is on ${actual}`);
  }
}

/** True when two paths name the same directory (resolves links, 8.3 names, slashes, and case on Windows). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r: string;
    try { r = realpathSync.native(p); } catch { r = resolve(p); }
    r = r.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export class Git {
  private readonly timeoutMs: number;
  private readonly stopGraceMs: number;
  constructor(public readonly cwd: string, opts: { timeoutMs?: number; stopGraceMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    this.stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
  }

  /**
   * Runs one git command. Bounded: past the timeout it is stopped with everything it started and
   * GitTimeout is thrown. It never asks for credentials. It does not start after a stop request; a
   * stop during the call gives it a moment to finish, then kills it, and throws StopRequested.
   * `allowFail` (or `true`) returns a non-zero exit instead of throwing.
   */
  async run(args: string[], opts: boolean | GitRunOptions = {}): Promise<GitResult> {
    const o: GitRunOptions = typeof opts === "boolean" ? { allowFail: opts } : opts;
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    const r = await spawnBounded({
      cmd: ["git", ...args], cwd: this.cwd, env: gitEnv(this.cwd), timeoutMs,
      onStop: o.cleanup ? "ignore" : "grace", graceMs: this.stopGraceMs,
    });
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
  async worktreePrune(): Promise<void> { await this.run(["worktree", "prune"]); }

  /** Always prunes first, so a worktree whose directory was deleted by hand does not block the add. */
  async worktreeAdd(path: string, branch: string): Promise<void> {
    await this.worktreePrune();
    await this.run(["worktree", "add", path, branch]);
  }

  /**
   * Makes `dir` a worktree of this repository checked out on `branch`. An existing directory is
   * reused only if it is itself a worktree root (not just a folder inside the main checkout) on
   * `branch`; anything else is removed and the worktree is added again.
   */
  async ensureWorktree(dir: string, branch: string): Promise<void> {
    if (existsSync(dir)) {
      const there = new Git(dir);
      if ((await there.isWorktreeRoot()) && (await there.currentBranch()) === branch) return;
      await this.run(["worktree", "remove", "--force", dir], true);
      rmSync(dir, { recursive: true, force: true });
    }
    await this.worktreeAdd(dir, branch);
  }

  /** Throws unless the checkout at this path is on `expected`. Call before committing. */
  async assertBranch(expected: string): Promise<void> {
    const actual = (await this.currentBranch()) || "(unknown)";
    if (actual !== expected) throw new WrongBranchError(this.cwd, expected, actual);
  }

  async worktreeRemove(path: string): Promise<void> {
    const r = await this.run(["worktree", "remove", "--force", path], true);
    if (r.code !== 0) {
      // Windows can hold a brief open handle on a just-written file; retry once after a short wait.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await this.run(["worktree", "remove", "--force", path]);
    }
    await this.run(["worktree", "prune"]);
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
    const changed = await this.run(["diff", "--name-only", `${target}...${branch}`], true);
    if (changed.code !== 0) return false;
    const files = changed.out.split(/\r?\n/).map((l) => l.trim()).filter((f) => f && !ignore.some((p) => f.startsWith(p)));
    if (!files.length) return true;
    return (await this.run(["diff", "--quiet", target, branch, "--", ...files], true)).code === 0;
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
   * and out of the commit. False when the paths have nothing to commit.
   */
  async commitPaths(paths: string[], message: string): Promise<boolean> {
    // Skip paths that don't exist: `git add -- <missing pathspec>` errors instead of no-op-ing,
    // and callers (e.g. commitArtifacts) pass paths, like intent/queue.md, that may not exist yet.
    const existing = paths.filter((p) => existsSync(join(this.cwd, p)));
    if (!existing.length) return false;
    await this.run(["add", "-A", "--", ...existing]);
    const staged = (await this.run(["diff", "--cached", "--name-only", "--", ...existing])).out.trim();
    if (!staged) return false;
    await this.runtime("commit", ["-q", "-m", message, "--", ...existing]);
    return true;
  }

  async changedFilesSince(base: string): Promise<string[]> {
    return (await this.run(["diff", "--name-only", `${base}...HEAD`])).out.trim().split("\n").filter(Boolean);
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
   * Merges `branch` into the checked-out branch. `squash` is one step that either lands whole or
   * not at all: a commit with the branch's tree on top of the current commit, then a fast-forward
   * to it. It needs the branch to contain the current commit (the merge checks make sure). A
   * failure before the fast-forward leaves the branch, the index, and the files as they were.
   * `merge` is a merge commit (`--no-ff`); a conflict is aborted.
   */
  async merge(branch: string, method: "squash" | "merge", message: string): Promise<void> {
    if (method === "squash") {
      const head = (await this.run(["rev-parse", "HEAD"])).out.trim();
      if (!(await this.isAncestor(head, branch))) {
        throw new GitError(["merge", branch], "", `${branch} does not contain the current commit; bring it up to date first`, 1);
      }
      const sha = (await this.runtime("commit-tree", [`${branch}^{tree}`, "-p", head, "-m", message])).out.trim();
      await this.run(["merge", "--ff-only", "-q", sha]);
      return;
    }
    try {
      await this.runtime("merge", ["--no-ff", "-q", "-m", message, branch]);
    } catch (e) {
      // Never leave the checkout half-merged.
      await this.run(["merge", "--abort"], { allowFail: true, cleanup: true });
      throw e;
    }
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

/** Removes a worktree directory however it can: git first, then the file system, then prunes git's record of it. */
export async function removeWorktree(git: Git, dir: string): Promise<void> {
  if (existsSync(dir)) {
    try {
      await git.worktreeRemove(dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  await git.run(["worktree", "prune"], true);
}

/**
 * Runs `fn` in a throwaway detached worktree of `ref` at `dir` (never the owner's checkout), and
 * always removes it afterwards. A leftover directory from an earlier run is removed first.
 */
export async function withDetachedWorktree<T>(git: Git, dir: string, ref: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await removeWorktree(git, dir);
  mkdirSync(dirname(dir), { recursive: true });
  await git.run(["worktree", "add", "--detach", dir, ref]);
  try {
    return await fn(dir);
  } finally {
    await removeWorktree(git, dir);
  }
}
