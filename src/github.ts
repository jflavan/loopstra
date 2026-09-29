import { lastLine, spawnBounded } from "./shell";
import { StopRequested } from "./stop";

export const GH_ENV = "LOOPSTRA_GH_EXECUTABLE";
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

export interface PrInfo { number: number; state: "OPEN" | "MERGED" | "CLOSED"; approved: boolean; merged: boolean; url: string }
export type ChecksState = "pass" | "fail" | "pending" | "unknown";

export class GitHub {
  private readonly exe: string | null;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  constructor(private readonly cwd: string, opts: { executable?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
    this.exe = opts.executable ?? process.env[GH_ENV] ?? Bun.which("gh");
    this.env = opts.env ?? {};
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Runs gh once. Past the timeout the process tree is killed and the call reports code 124. It does
   * not start after a stop request, and a stop kills it; both throw StopRequested.
   */
  private async run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    if (!this.exe) return { code: 127, out: "", err: "gh not found" };
    const cmd = this.exe.endsWith(".ts") ? [process.execPath, this.exe, ...args] : [this.exe, ...args];
    const r = await spawnBounded({ cmd, cwd: this.cwd, env: { ...process.env, ...this.env }, timeoutMs: this.timeoutMs, onStop: "kill" });
    if (r.stopped) throw new StopRequested();
    if (r.timedOut) return { code: 124, out: r.out, err: `${r.err}\ngh did not finish within ${Math.round(this.timeoutMs / 1000)}s and was stopped.`.trim() };
    return { code: r.code ?? 1, out: r.out, err: r.err };
  }

  async available(): Promise<boolean> { return (await this.run(["--version"])).code === 0; }
  /** True when gh is signed in to GitHub. */
  async signedIn(): Promise<boolean> { return (await this.run(["auth", "status"])).code === 0; }

  async prForBranch(branch: string): Promise<PrInfo | null> {
    const r = await this.lookupPr(branch);
    return "pr" in r ? r.pr : null;
  }

  /**
   * The pull request for a branch: `{ pr: null }` when GitHub says there is none, and `{ error }`
   * when gh could not tell (not found, timed out, not signed in), so a caller can wait instead.
   */
  async lookupPr(branch: string): Promise<{ pr: PrInfo | null } | { error: string }> {
    const r = await this.run(["pr", "view", branch, "--json", "number,state,reviewDecision,mergedAt,url"]);
    if (r.code !== 0) {
      if (/no pull requests found/i.test(r.err)) return { pr: null };
      return { error: lastLine(r.err) || `gh exited ${r.code}` };
    }
    try {
      const j = JSON.parse(r.out) as { number: number; state: PrInfo["state"]; reviewDecision: string; mergedAt: string | null; url: string };
      return { pr: { number: j.number, state: j.state, approved: j.reviewDecision === "APPROVED", merged: !!j.mergedAt, url: j.url } };
    } catch { return { error: "gh pr view printed something that is not JSON" }; }
  }

  async createPr(p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.run(["pr", "create", "--head", p.head, "--base", p.base, "--title", p.title, "--body", p.body]);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${lastLine(r.err)}`);
    const url = lastLine(r.out);
    const pr = await this.prForBranch(p.head);
    return { number: pr?.number ?? Number(url.split("/").pop()), url };
  }

  async comment(number: number, body: string): Promise<void> {
    const r = await this.run(["pr", "comment", String(number), "--body", body]);
    if (r.code !== 0) throw new Error(`gh pr comment failed: ${lastLine(r.err)}`);
  }

  /**
   * gh pr checks exits 0 when all pass, 1 when any fail, 8 when pending. A call that timed out or
   * could not start is `unknown` (ask again later), never read as a failure.
   */
  async checks(number: number): Promise<ChecksState> {
    const r = await this.run(["pr", "checks", String(number), "--json", "name,state"]);
    if (r.code === 0) return "pass";
    if (r.code === 8) return "pending";
    if (r.code === 124 || r.code === 127) return "unknown";
    if (/no checks reported/i.test(r.err)) return "pass";
    return "fail";
  }

  async merge(number: number, method: "squash" | "merge"): Promise<void> {
    const r = await this.run(["pr", "merge", String(number), method === "squash" ? "--squash" : "--merge", "--delete-branch"]);
    if (r.code !== 0) throw new Error(`gh pr merge failed: ${lastLine(r.err)}`);
  }
}
