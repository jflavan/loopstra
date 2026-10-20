import { z } from "zod";
import { lastLine, spawnBounded, withoutGitHookEnv } from "./shell";
import { StopRequested } from "./stop";
import type { Trace } from "./trace";

const GH_ENV = "LOOPSTRA_GH_EXECUTABLE";
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

/** Whether GitHub answered the pull request watcher's last look: `fail` with gh's error, or `pass`. */
export const GITHUB_SIGNAL = "github";
/** How long GitHub may go unanswered before a person is told (see attention). */
export const GITHUB_SILENT_MS = 15 * 60_000;

/** Ids that change on every call: a request id (hex groups joined by colons or dashes), a long hex or number. */
const CALL_IDS = /\b(?=[0-9a-f:-]*\d)[0-9a-f]+(?:[:-][0-9a-f]+){2,}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi;

/**
 * gh's error the same from one look to the next, as a person reads it: its first line, with the ids
 * that change on every call (a request id, say) put as "…".
 */
export function ghProblem(error: string): string {
  return (error.trim().split(/\r?\n/)[0] ?? "").replace(CALL_IDS, "…");
}

/**
 * Records a look at GitHub (`error`: gh's error, or null when it answered) as the `github` signal,
 * only when that differs from the last one (gh's words, not the ids that change on every call; see
 * ghProblem): a lasting problem (a token GitHub no longer takes) is one line in the trace, not one per look.
 */
export function recordGitHub(trace: Trace, error: string | null): void {
  const last = trace.lastSignal(GITHUB_SIGNAL);
  if (error === null) {
    if (last?.result === "fail") trace.signal(GITHUB_SIGNAL, "pass", "GitHub answers again.");
    return;
  }
  if (last?.result === "fail" && ghProblem(last.output) === ghProblem(error)) return;
  trace.signal(GITHUB_SIGNAL, "fail", error);
}

/**
 * `mergeCommit`: the commit the merge made on the base branch (null until merged, or when gh does not say).
 * `head`: the commit at the tip of the pull request's branch on GitHub (null when gh does not say).
 * `draft`: a draft pull request, which GitHub refuses to merge until it is marked ready for review.
 */
export interface PrInfo { number: number; state: "OPEN" | "MERGED" | "CLOSED"; approved: boolean; merged: boolean; mergeCommit: string | null; url: string; createdAt: string; head: string | null; draft: boolean }
/** `none`: GitHub reports no checks on the pull request (none configured, or not registered yet). */
type ChecksState = "pass" | "fail" | "pending" | "none" | "unknown";

/**
 * Check states that fail or are still running. A failed state wins over gh's `bucket`, which puts
 * STARTUP_FAILURE (a workflow that could not start) with the pending ones; `bucket` decides the rest.
 */
const FAILED_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

/** The pull request's checks as a whole, from the rows gh pr checks --json prints: any failure wins, then any pending. */
export function checksFromRows(rows: { state?: string; bucket?: string }[]): ChecksState {
  if (rows.length === 0) return "none";
  const buckets = rows.map((r) => FAILED_STATES.has(r.state ?? "") ? "fail" : r.bucket || (PENDING_STATES.has(r.state ?? "") ? "pending" : "pass"));
  if (buckets.some((b) => b === "fail" || b === "cancel")) return "fail";
  if (buckets.includes("pending")) return "pending";
  return "pass";
}

const ghUser = z.looseObject({ login: z.string().nullish() }).nullish();

/** The fields of a pull request gh pr view --json prints that approved reads (see lookupPr). */
const REVIEW_FIELDS = {
  reviewDecision: z.string().nullish(),
  latestReviews: z.array(z.looseObject({ author: ghUser, authorAssociation: z.string().nullish(), state: z.string().nullish() })).nullish(),
  author: ghUser,
};

/**
 * What gh pr view --json prints, as far as it is read here (see lookupPr): the fields read without a
 * fallback must be there and of their type, the review fields left out, null, or of their type. The
 * fields read with a fallback take it when they are anything else.
 */
const PrView = z.looseObject({
  number: z.number(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  url: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.looseObject({ oid: z.string().optional() }).nullish().catch(null),
  headRefOid: z.string().optional().catch(undefined),
  isDraft: z.boolean().optional().catch(undefined),
  ...REVIEW_FIELDS,
});
type PrJson = z.infer<typeof PrView>;

/** The rows gh pr checks --json prints, each read for its state and bucket where they are strings; null when it printed no list. */
function checkRows(rows: unknown): { state?: string; bucket?: string }[] | null {
  if (!Array.isArray(rows)) return null;
  return rows.map((r: unknown) => {
    const o = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
    return { ...(typeof o.state === "string" ? { state: o.state } : {}), ...(typeof o.bucket === "string" ? { bucket: o.bucket } : {}) };
  });
}

/**
 * Who has a say in the repository; on a public one anybody else can leave a review too. Broader than
 * GitHub's own rule (write access): a collaborator with read access counts.
 */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * GitHub's reviewDecision when it gives one. It gives none unless a branch rule requires reviews (one
 * requiring 0 approvals too), and then the latest reviews of those with a say in the repository (when
 * gh gives no authorAssociation, of anyone but the pull request's author) decide: one approves, and
 * none asks for changes.
 */
function approved(j: PrJson): boolean {
  if (j.reviewDecision) return j.reviewDecision === "APPROVED";
  const reviews = (j.latestReviews ?? []).filter((r) => r.authorAssociation ? TRUSTED.has(r.authorAssociation) : r.author?.login !== j.author?.login);
  return reviews.some((r) => r.state === "APPROVED") && !reviews.some((r) => r.state === "CHANGES_REQUESTED");
}

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
   * not start after a stop request, and a stop kills it; both throw StopRequested. `stdin` is written
   * to its standard input (a body passed with `--body-file -`, never on the command line, which
   * Windows limits to 32K characters).
   */
  private async run(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
    if (!this.exe) return { code: 127, out: "", err: "gh not found" };
    const cmd = this.exe.endsWith(".ts") ? [process.execPath, this.exe, ...args] : [this.exe, ...args];
    // gh runs git to find the repository: a hook's GIT_DIR would point it at the hook's (see withoutGitHookEnv).
    const r = await spawnBounded({ cmd, cwd: this.cwd, env: withoutGitHookEnv({ ...process.env, ...this.env }), stdin, timeoutMs: this.timeoutMs, onStop: "kill" });
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
   * The pull request for a branch (or by its number): `{ pr: null }` when GitHub says there is none,
   * and `{ error }` when gh could not tell (not found, timed out, not signed in), so a caller can wait instead.
   */
  async lookupPr(branchOrNumber: string): Promise<{ pr: PrInfo | null } | { error: string }> {
    const r = await this.run(["pr", "view", branchOrNumber, "--json", "number,state,reviewDecision,latestReviews,author,mergedAt,mergeCommit,url,createdAt,headRefOid,isDraft"]);
    if (r.code !== 0) {
      if (/no pull requests found/i.test(r.err)) return { pr: null };
      return { error: lastLine(r.err) || `gh exited ${r.code}` };
    }
    let j: unknown;
    try { j = JSON.parse(r.out); } catch { return { error: "gh pr view printed something that is not JSON" }; }
    const parsed = PrView.safeParse(j);
    if (!parsed.success) {
      // Reviews that cannot be read are waited on, like checks that cannot be read: approved would throw on them.
      const reviewsOnly = parsed.error.issues.every((i) => typeof i.path[0] === "string" && i.path[0] in REVIEW_FIELDS);
      return { error: reviewsOnly ? "gh pr view printed reviews in a shape Loopstra does not read" : "gh pr view printed something that is not a pull request" };
    }
    const p = parsed.data;
    return { pr: { number: p.number, state: p.state, approved: approved(p), merged: !!p.mergedAt, mergeCommit: p.mergeCommit?.oid || null, url: p.url, createdAt: p.createdAt, head: p.headRefOid || null, draft: p.isDraft === true } };
  }

  async createPr(p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.run(["pr", "create", "--head", p.head, "--base", p.base, "--title", p.title, "--body-file", "-"], p.body);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${lastLine(r.err)}`);
    const url = lastLine(r.out);
    const pr = await this.prForBranch(p.head);
    return { number: pr?.number ?? Number(url.split("/").pop()), url };
  }

  async comment(number: number, body: string): Promise<void> {
    const r = await this.run(["pr", "comment", String(number), "--body-file", "-"], body);
    if (r.code !== 0) throw new Error(`gh pr comment failed: ${lastLine(r.err)}`);
  }

  /**
   * Reads the check states gh prints: with --json, gh exits 0 whatever they are. A call that timed
   * out, could not start, or printed no rows is `unknown` (ask again later), never read as a pass
   * or a failure; `onError` gets what gh said.
   */
  async checks(number: number, onError?: (error: string) => void): Promise<ChecksState> {
    const r = await this.run(["pr", "checks", String(number), "--json", "name,state,bucket"]);
    if (r.code === 124 || r.code === 127) { onError?.(lastLine(r.err)); return "unknown"; }
    try {
      const rows = checkRows(JSON.parse(r.out));
      if (rows) return checksFromRows(rows);
    } catch { /* not JSON: gh reported an error */ }
    if (/no checks reported/i.test(r.err)) return "none";
    onError?.(lastLine(r.err) || `gh exited ${r.code}`);
    return "unknown";
  }

  /**
   * Merges on GitHub. Without `--delete-branch`: gh would also delete the local branch, which fails
   * while the change's worktree has it checked out (after the merge went through). The caller
   * deletes the remote branch itself, and cleanup deletes the local one once main has its changes.
   * With `head`, GitHub merges only while the branch is still at that commit (`--match-head-commit`):
   * commits pushed after the checks were read are not merged with them.
   */
  async merge(number: number, method: "squash" | "merge", head?: string | null): Promise<void> {
    const r = await this.run(["pr", "merge", String(number), method === "squash" ? "--squash" : "--merge", ...(head ? ["--match-head-commit", head] : [])]);
    if (r.code !== 0) throw new Error(`gh pr merge failed: ${lastLine(r.err)}`);
  }
}
