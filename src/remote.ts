import type { Config } from "./config";
import { Git, RUNTIME_COMMIT_CONFIG, RUNTIME_EMAIL } from "./git";
import { errorText, lastLine } from "./shell";
import { StopRequested } from "./stop";
import type { Trace } from "./trace";

/** The generated queue, left uncommitted between runtime commits. */
const QUEUE = "intent/queue.md";

/** The signal that says whether main here and main on GitHub are in step. */
export const SYNC_SIGNAL = "main_sync";

/** Plain words for each sync outcome; the technical detail goes to the trace. */
export const SYNC_TEXT = {
  inStep: "Main is in step with GitHub.",
  ownCommits: "Main has your own unpushed commits; Loopstra will share its records after you push yours.",
  unsaved: "Main has unsaved changes to tracked files, so Loopstra is not bringing it up to date with GitHub until they are committed or undone.",
  offMain: "The main checkout is on another branch, so Loopstra is not bringing it up to date with GitHub.",
  unreachable: "Loopstra could not reach GitHub to bring main up to date; it will keep trying.",
  noMain: "The GitHub repository has no main branch yet; an engineer should push it once.",
  clash: "Main here and main on GitHub have changes that clash; an engineer needs to bring them together.",
  pushFailed: "Loopstra could not share its records with GitHub; an engineer should check that main can be pushed to.",
  unexpected: "Something unexpected went wrong bringing main up to date with GitHub; an engineer can find the details in the trace.",
} as const;

type SyncOutcome = { result: "pass" | "waiting" | "fail"; text: string; detail?: Record<string, unknown> };

/**
 * Records the sync outcome as the `main_sync` signal, only when it differs from the last one, so a
 * condition that lasts (unsaved changes, GitHub out of reach) is one line in the trace, not one per
 * tick. The technical detail goes with it into the trace.
 */
function recordSync(trace: Trace, o: SyncOutcome | null): void {
  if (!o) return;
  const last = trace.lastSignal(SYNC_SIGNAL);
  if (last && last.result === o.result && last.output === o.text) return;
  trace.signal(SYNC_SIGNAL, o.result, o.text);
  if (o.result !== "pass") trace.event("_loop", "error", { where: "sync", result: o.result, ...(o.detail ?? {}) });
}

/**
 * Brings the root checkout's main in step with the remote. Fetch, then replay local commits on top
 * of the remote's main (`pull --rebase`), so an owner's status edits made on GitHub or pushed from
 * another clone, and merges done on GitHub, arrive here; then share Loopstra's own records (see
 * shareMain). Runs only when the checkout is on main with no staged or unstaged changes to tracked
 * files (the generated queue.md aside), so a person's work there is never touched. Never throws
 * (except for a stop request) and never stops the tick: the outcome is the `main_sync` signal, and a
 * rebase that conflicts is aborted. Returns the outcome's result (null without a remote).
 */
export async function syncMain(root: string, cfg: Config, trace: Trace): Promise<SyncOutcome["result"] | null> {
  const git = new Git(root);
  const main = cfg.main_branch;
  let outcome: SyncOutcome | null;
  try {
    outcome = await sync(git, main, trace);
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    outcome = { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "unexpected problem", error: errorText(e) } };
  }
  recordSync(trace, outcome);
  return outcome?.result ?? null;
}

async function sync(git: Git, main: string, trace: Trace): Promise<SyncOutcome | null> {
  const remote = await git.remoteName();
  if (!remote) return null;
  const branch = await git.currentBranch();
  if (branch !== main) return { result: "waiting", text: SYNC_TEXT.offMain, detail: { what: "skipped: the root checkout is not on main", branch } };
  const status = await git.run(["status", "--porcelain", "--untracked-files=no"], true);
  if (status.code !== 0) return { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "skipped: git status failed", error: lastLine(status.err) || `exit ${status.code}` } };
  const changed = status.out.split(/\r?\n/).filter((l) => l.trim());
  if (changed.some((l) => l.slice(3) !== QUEUE)) return { result: "waiting", text: SYNC_TEXT.unsaved, detail: { what: "skipped: the root checkout has changes to tracked files" } };
  // queue.md is generated and rewritten later in this tick; its unsaved copy never holds up the sync.
  if (changed.length) await git.run(["checkout", "--", QUEUE], true);

  const fetched = await git.run(["fetch", "--quiet", remote], true);
  if (fetched.code !== 0) return { result: "fail", text: SYNC_TEXT.unreachable, detail: { what: "fetch failed", remote, error: lastLine(fetched.err) || `exit ${fetched.code}` } };

  const upstream = `${remote}/${main}`;
  if ((await git.run(["rev-parse", "--verify", "--quiet", `refs/remotes/${upstream}`], true)).code !== 0) {
    return { result: "fail", text: SYNC_TEXT.noMain, detail: { what: "remote has no main", upstream } };
  }
  const behind = await git.countAhead(upstream, main);
  if (behind > 0) {
    const rebased = await rebaseMain(git, upstream);
    if (!rebased.ok) return { result: "fail", text: SYNC_TEXT.clash, detail: { what: "rebase onto the remote failed and was aborted; main is not synced", upstream, error: rebased.error } };
    trace.event("_loop", "command", { command: "sync main", pulled: behind, ...(rebased.tookRemote.length ? { tookRemote: rebased.tookRemote } : {}) });
  }
  return push(git, remote, main, trace);
}

/**
 * Shares Loopstra's own records (status changes and artifacts committed on main) with the remote:
 * once at the end of each tick, and before a pull request's branch is pushed. Main is pushed only when every commit the remote does not have is
 * Loopstra's own: a person's unpushed commits are theirs to share, so then nothing is pushed and
 * the signal waits. A push the remote refuses (a protected branch) is a `main_sync` failure; the
 * loop carries on. Never throws, except for a stop request.
 */
export async function shareMain(root: string, cfg: Config, trace: Trace): Promise<void> {
  const git = new Git(root);
  let outcome: SyncOutcome | null;
  try {
    const remote = await git.remoteName();
    if (!remote) return;
    const upstream = `refs/remotes/${remote}/${cfg.main_branch}`;
    // Without the remote's main, the tick's sync reports it; nothing to compare with here.
    if ((await git.run(["rev-parse", "--verify", "--quiet", upstream], true)).code !== 0) return;
    outcome = await push(git, remote, cfg.main_branch, trace);
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    outcome = { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "unexpected problem", error: errorText(e) } };
  }
  recordSync(trace, outcome);
}

/** Pushes main when only Loopstra's commits are ahead of the remote's main. Null: nothing new to record. */
async function push(git: Git, remote: string, main: string, trace: Trace): Promise<SyncOutcome | null> {
  const upstream = `${remote}/${main}`;
  const ahead = (await git.run(["log", "--format=%ae %h %s", `${upstream}..${main}`])).out.split(/\r?\n/).filter(Boolean);
  if (!ahead.length) return { result: "pass", text: SYNC_TEXT.inStep };
  const theirs = ahead.filter((l) => l.split(" ")[0] !== RUNTIME_EMAIL);
  if (theirs.length) return { result: "waiting", text: SYNC_TEXT.ownCommits, detail: { what: "not pushed: main has commits that are not Loopstra's", commits: theirs.map((l) => l.split(" ").slice(1).join(" ")) } };
  const r = await git.run(["push", "--quiet", remote, `${main}:${main}`], true);
  if (r.code === 0) {
    trace.event("_loop", "command", { command: "share main", pushed: ahead.length });
    return { result: "pass", text: SYNC_TEXT.inStep };
  }
  const error = lastLine(r.err) || `exit ${r.code}`;
  // The remote moved on since the last fetch: the next tick fetches, replays, and pushes again.
  if (/non-fast-forward|fetch first|\(stale info\)/i.test(r.err)) {
    trace.event("_loop", "command", { command: "share main", pushed: 0, note: "the remote has newer commits; the next sync brings them in first", error });
    return null;
  }
  return { result: "fail", text: SYNC_TEXT.pushFailed, detail: { what: "push of main failed", remote, error } };
}

/**
 * Replays local main on top of `upstream`. A conflict only inside intent/ (Loopstra's own
 * artifacts, which a merged pull request also carries, and owners' status lines) is settled with
 * the remote's version: an owner's edit on GitHub wins over the local record, and the next steps
 * write on top of it. Any other conflict aborts the rebase and leaves main exactly as it was.
 */
async function rebaseMain(git: Git, upstream: string): Promise<{ ok: true; tookRemote: string[] } | { ok: false; error: string }> {
  try {
    return await replayMain(git, upstream);
  } catch (e) {
    // A stop or a hung command part-way: never leave the checkout in the middle of a rebase.
    await git.run(["rebase", "--abort"], { allowFail: true, cleanup: true });
    throw e;
  }
}

async function replayMain(git: Git, upstream: string): Promise<{ ok: true; tookRemote: string[] } | { ok: false; error: string }> {
  const tookRemote = new Set<string>();
  let r = await git.runtime("rebase", ["-q", upstream], true);
  for (let step = 0; r.code !== 0 && step < 500; step++) {
    const conflicted = (await git.run(["diff", "--name-only", "--diff-filter=U"], true)).out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!conflicted.length || conflicted.some((p) => !p.startsWith("intent/"))) break;
    for (const p of conflicted) {
      // During a rebase HEAD is the remote side plus what has been replayed so far.
      const there = (await git.run(["cat-file", "-e", `HEAD:${p}`], true)).code === 0;
      await git.run(there ? ["checkout", "HEAD", "--", p] : ["rm", "-q", "-f", "--", p], true);
      tookRemote.add(p);
    }
    r = await git.run([...RUNTIME_COMMIT_CONFIG, "-c", "core.editor=true", "rebase", "--continue"], true);
    // A commit left with nothing of its own (the remote already had it all) is skipped.
    const unmerged = (await git.run(["diff", "--name-only", "--diff-filter=U"], true)).out.trim();
    const empty = (await git.run(["diff", "--cached", "--quiet"], true)).code === 0;
    if (r.code !== 0 && !unmerged && empty) r = await git.run([...RUNTIME_COMMIT_CONFIG, "rebase", "--skip"], true);
  }
  if (r.code === 0) return { ok: true, tookRemote: [...tookRemote] };
  await git.run(["rebase", "--abort"], { allowFail: true, cleanup: true });
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
  const r = await git.run(["push", "--quiet", "--force-with-lease", "-u", remote, `${branch}:${branch}`], true);
  return r.code === 0 ? { ok: true } : { ok: false, detail: `push of ${branch} to ${remote} failed: ${lastLine(r.err) || `exit ${r.code}`}` };
}
