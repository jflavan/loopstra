import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** The last non-empty line of some git output, or "" when there is none. */
function lastNonEmptyLine(s: string): string {
  const lines = s.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stdout: string, public readonly stderr: string, public readonly code: number) {
    // git prints conflict text to stdout, not stderr, so fall back to stdout when stderr has nothing useful.
    super(`git ${args.join(" ")} failed (${code}): ${lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout)}`);
  }
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
  constructor(public readonly cwd: string) {}

  async run(args: string[], allowFail = false): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn({ cmd: ["git", ...args], cwd: this.cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 && !allowFail) throw new GitError(args, out, err, code);
    return { code, out, err };
  }

  async currentBranch(): Promise<string> { return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim(); }
  async headSha(): Promise<string> { return (await this.run(["rev-parse", "HEAD"])).out.trim(); }
  async hasRemote(): Promise<boolean> { return (await this.run(["remote"])).out.trim().length > 0; }
  async branchExists(name: string): Promise<boolean> { return (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], true)).code === 0; }
  async createBranch(name: string, from: string): Promise<void> { await this.run(["branch", name, from]); }
  async deleteBranch(name: string): Promise<void> { await this.run(["branch", "-D", name]); }
  async toplevel(): Promise<string> { return (await this.run(["rev-parse", "--show-toplevel"])).out.trim(); }
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
      const top = await there.run(["rev-parse", "--show-toplevel"], true);
      const head = await there.run(["rev-parse", "--abbrev-ref", "HEAD"], true);
      if (top.code === 0 && samePath(top.out.trim(), dir) && head.code === 0 && head.out.trim() === branch) return;
      await this.run(["worktree", "remove", "--force", dir], true);
      rmSync(dir, { recursive: true, force: true });
    }
    await this.worktreeAdd(dir, branch);
  }

  /** Throws unless the checkout at this path is on `expected`. Call before committing. */
  async assertBranch(expected: string): Promise<void> {
    const r = await this.run(["rev-parse", "--abbrev-ref", "HEAD"], true);
    const actual = r.code === 0 ? r.out.trim() : "(unknown)";
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
  async log(n: number): Promise<string[]> { return (await this.run(["log", `-${n}`, "--format=%h %s"])).out.trim().split("\n").filter(Boolean); }

  async commitAll(message: string): Promise<boolean> {
    await this.run(["add", "-A"]);
    if (!(await this.isDirty())) return false;
    await this.run(["commit", "-q", "-m", message]);
    return true;
  }

  async commitPaths(paths: string[], message: string): Promise<boolean> {
    // Skip paths that don't exist: `git add -- <missing pathspec>` errors instead of no-op-ing,
    // and callers (e.g. commitArtifacts) pass paths, like intent/queue.md, that may not exist yet.
    const existing = paths.filter((p) => existsSync(join(this.cwd, p)));
    if (!existing.length) return false;
    await this.run(["add", "-A", "--", ...existing]);
    const staged = (await this.run(["diff", "--cached", "--name-only"])).out.trim();
    if (!staged) return false;
    await this.run(["commit", "-q", "-m", message, "--", ...existing]);
    return true;
  }

  async changedFilesSince(base: string): Promise<string[]> {
    return (await this.run(["diff", "--name-only", `${base}...HEAD`])).out.trim().split("\n").filter(Boolean);
  }

  async rebaseOnto(base: string): Promise<boolean> {
    const r = await this.run(["rebase", base], true);
    if (r.code !== 0) { await this.run(["rebase", "--abort"], true); return false; }
    return true;
  }

  async merge(branch: string, method: "squash" | "merge", message: string): Promise<void> {
    try {
      if (method === "squash") {
        await this.run(["merge", "--squash", branch]);
        await this.run(["commit", "-q", "-m", message]);
      } else {
        await this.run(["merge", "--no-ff", "-m", message, branch]);
      }
    } catch (e) {
      // Never leave the checkout half-merged: a squash conflict doesn't set MERGE_HEAD, so
      // `merge --abort` alone can fail (harmlessly); `reset --merge` clears the working tree too.
      await this.run(["merge", "--abort"], true);
      if (method === "squash") await this.run(["reset", "--merge"], true);
      throw e;
    }
  }

  async push(branch: string): Promise<void> { await this.run(["push", "-u", "origin", branch]); }
  async pushCurrent(): Promise<void> { await this.run(["push"]); }
  async fetch(): Promise<void> { await this.run(["fetch", "--quiet"], true); }
}
