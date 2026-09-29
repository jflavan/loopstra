export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stderr: string, public readonly code: number) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`);
  }
}

export class Git {
  constructor(public readonly cwd: string) {}

  async run(args: string[], allowFail = false): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn({ cmd: ["git", ...args], cwd: this.cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0 && !allowFail) throw new GitError(args, err, code);
    return { code, out, err };
  }

  async currentBranch(): Promise<string> { return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim(); }
  async headSha(): Promise<string> { return (await this.run(["rev-parse", "HEAD"])).out.trim(); }
  async hasRemote(): Promise<boolean> { return (await this.run(["remote"])).out.trim().length > 0; }
  async branchExists(name: string): Promise<boolean> { return (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], true)).code === 0; }
  async createBranch(name: string, from: string): Promise<void> { await this.run(["branch", name, from]); }
  async deleteBranch(name: string): Promise<void> { await this.run(["branch", "-D", name]); }
  async worktreeAdd(path: string, branch: string): Promise<void> { await this.run(["worktree", "add", path, branch]); }

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
    await this.run(["add", "-A", "--", ...paths]);
    const staged = (await this.run(["diff", "--cached", "--name-only"])).out.trim();
    if (!staged) return false;
    await this.run(["commit", "-q", "-m", message, "--", ...paths]);
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
    if (method === "squash") {
      await this.run(["merge", "--squash", branch]);
      await this.run(["commit", "-q", "-m", message]);
    } else {
      await this.run(["merge", "--no-ff", "-m", message, branch]);
    }
  }

  async push(branch: string): Promise<void> { await this.run(["push", "-u", "origin", branch]); }
  async pushCurrent(): Promise<void> { await this.run(["push"]); }
  async fetch(): Promise<void> { await this.run(["fetch", "--quiet"], true); }
}
