import type { Config } from "./config";
import { Git } from "./git";
import type { Trace } from "./trace";

function lastLine(s: string): string {
  return s.trim().split(/\r?\n/).pop() ?? "";
}

/**
 * Brings the root checkout's main up to date with the remote: fetch, then replay local commits on
 * top of the remote's main (`pull --rebase`), so an owner's status edits made on GitHub or pushed
 * from another clone, and merges done on GitHub, arrive here. Main is never pushed: that would also
 * push a person's own unpushed commits. Runs only when the checkout is on main with no staged or
 * unstaged changes to tracked files, so a person's work there is never touched. Never throws and
 * never stops the tick: every problem is traced, and a rebase that conflicts is aborted.
 */
export async function syncMain(root: string, cfg: Config, trace: Trace): Promise<void> {
  const git = new Git(root);
  const main = cfg.main_branch;
  const problem = (what: string, detail: Record<string, unknown> = {}) => { trace.event("_loop", "error", { where: "sync", what, ...detail }); };
  try {
    const remote = await git.remoteName();
    if (!remote) return;
    const branch = (await git.runBounded(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
    if (branch !== main) return problem("skipped: the root checkout is not on main", { branch });
    const status = await git.runBounded(["status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0) return problem("skipped: git status failed", { error: lastLine(status.err) || `exit ${status.code}` });
    if (status.out.trim()) return problem("skipped: the root checkout has changes to tracked files");

    const fetched = await git.runBounded(["fetch", "--quiet", remote]);
    if (fetched.code !== 0) return problem("fetch failed", { remote, error: lastLine(fetched.err) || `exit ${fetched.code}` });

    const upstream = `${remote}/${main}`;
    if ((await git.runBounded(["rev-parse", "--verify", "--quiet", `refs/remotes/${upstream}`])).code !== 0) return;
    const behind = await git.countAhead(upstream, main);
    if (behind === 0) return;
    const rebased = await rebaseMain(git, upstream);
    if (!rebased.ok) return problem("rebase onto the remote failed and was aborted; main is not synced", { upstream, error: rebased.error });
    trace.event("_loop", "command", { command: "sync main", pulled: behind, ...(rebased.tookRemote.length ? { tookRemote: rebased.tookRemote } : {}) });
  } catch (e) {
    problem("unexpected problem", { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Replays local main on top of `upstream`. A conflict only inside intent/ (Loopstra's own
 * artifacts, which a merged pull request also carries, and owners' status lines) is settled with
 * the remote's version: an owner's edit on GitHub wins over the local record, and the next steps
 * write on top of it. Any other conflict aborts the rebase and leaves main exactly as it was.
 */
async function rebaseMain(git: Git, upstream: string): Promise<{ ok: true; tookRemote: string[] } | { ok: false; error: string }> {
  const tookRemote = new Set<string>();
  let r = await git.runBounded(["rebase", upstream]);
  for (let step = 0; r.code !== 0 && step < 500; step++) {
    const conflicted = (await git.runBounded(["diff", "--name-only", "--diff-filter=U"])).out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!conflicted.length || conflicted.some((p) => !p.startsWith("intent/"))) break;
    for (const p of conflicted) {
      // During a rebase HEAD is the remote side plus what has been replayed so far.
      const there = (await git.runBounded(["cat-file", "-e", `HEAD:${p}`])).code === 0;
      await git.runBounded(there ? ["checkout", "HEAD", "--", p] : ["rm", "-q", "-f", "--", p]);
      tookRemote.add(p);
    }
    r = await git.runBounded(["-c", "core.editor=true", "rebase", "--continue"]);
    // A commit left with nothing of its own (the remote already had it all) is skipped.
    const unmerged = (await git.runBounded(["diff", "--name-only", "--diff-filter=U"])).out.trim();
    const empty = (await git.runBounded(["diff", "--cached", "--quiet"])).code === 0;
    if (r.code !== 0 && !unmerged && empty) r = await git.runBounded(["rebase", "--skip"]);
  }
  if (r.code === 0) return { ok: true, tookRemote: [...tookRemote] };
  await git.runBounded(["rebase", "--abort"]);
  return { ok: false, error: lastLine(r.err) || lastLine(r.out) || `exit ${r.code}` };
}

/**
 * Pushes an intent branch to the remote for its pull request. The branch is Loopstra's own and the
 * merge checks may have rebased it, so it is force-pushed, but only over what Loopstra pushed last
 * time (`--force-with-lease`): work a person added on GitHub is never overwritten.
 */
export async function pushBranch(git: Git, branch: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const remote = await git.remoteName();
  if (!remote) return { ok: false, detail: "no remote" };
  const r = await git.runBounded(["push", "--quiet", "--force-with-lease", "-u", remote, `${branch}:${branch}`]);
  return r.code === 0 ? { ok: true } : { ok: false, detail: `push of ${branch} to ${remote} failed: ${lastLine(r.err) || `exit ${r.code}`}` };
}
