import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import { Git, GitError, literalPathspecs, pathChunks, RUNTIME_COMMIT_CONFIG, RUNTIME_EMAIL, withDetachedWorktree } from "./git";
import { onCheckout, oneSync } from "./lanes";
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

/**
 * What a sync came to. `behind`: it stopped before main here could take main on GitHub, so main may
 * lack what GitHub has (`text` says why); a sync that got that far and then could not share main does not set it.
 */
export type SyncOutcome = { result: "pass" | "waiting" | "fail"; text: string; detail?: Record<string, unknown>; behind?: true };

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
 * Brings the main checkout's main in step with the remote, so an owner's status edits made on
 * GitHub or pushed from another clone, and merges done on GitHub, arrive here; then shares
 * Loopstra's own records (see shareMain). Fetch, then main moves once (see bringIn) to the remote's
 * main with the commits only main here has replayed on top. Only while the checkout is on main with
 * no staged or unstaged changes to tracked files (the generated queue.md aside), so a person's work
 * there is never touched. Safe at any time, beside running steps: main only ever moves from one
 * whole commit to the next. Never throws (except for a stop request) and never stops the tick: the
 * outcome is the `main_sync` signal. Returns the outcome (null without a remote, or when a newer main on
 * GitHub beat the push, which the next sync shares).
 */
export function syncMain(root: string, cfg: Config, trace: Trace): Promise<SyncOutcome | null> {
  return oneSync.run(async () => {
    const git = new Git(root);
    let outcome: SyncOutcome | null;
    try {
      outcome = await sync(git, cfg.main_branch, trace);
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      outcome = { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "unexpected problem", error: errorText(e) }, behind: true };
    }
    recordSync(trace, outcome);
    return outcome;
  });
}

async function sync(git: Git, main: string, trace: Trace): Promise<SyncOutcome | null> {
  const remote = await git.remoteName();
  if (!remote) return null;
  const notReady = await checkoutReady(git, main);
  if (notReady) return { ...notReady, behind: true };

  const fetched = await git.fetch(["--quiet", remote], true);
  if (fetched.code !== 0) return { result: "fail", text: SYNC_TEXT.unreachable, detail: { what: "fetch failed", remote, error: lastLine(fetched.err) || `exit ${fetched.code}` }, behind: true };

  const upstream = `${remote}/${main}`;
  if ((await git.commitOf(`refs/remotes/${upstream}`)) === null) {
    return { result: "fail", text: SYNC_TEXT.noMain, detail: { what: "remote has no main", upstream }, behind: true };
  }
  const brought = await bringIn(git, main, upstream);
  if (!brought.ok) return { ...brought.outcome, behind: true };
  if (brought.pulled) trace.event("_loop", "command", { command: "sync main", pulled: brought.pulled, ...(brought.tookRemote.length ? { tookRemote: brought.tookRemote } : {}) });
  return push(git, remote, main, trace);
}

/**
 * Null when the main checkout may be moved: it is on main, with no changes to tracked files but the
 * generated queue.md (put back; it is rewritten later in the tick). Otherwise the waiting outcome
 * that says why.
 */
async function checkoutReady(git: Git, main: string): Promise<SyncOutcome | null> {
  const branch = await git.currentBranch();
  if (branch !== main) return { result: "waiting", text: SYNC_TEXT.offMain, detail: { what: "skipped: the main checkout is not on main", branch } };
  const status = await git.run(["status", "--porcelain", "--untracked-files=no"], true);
  if (status.code !== 0) return { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "skipped: git status failed", error: lastLine(status.err) || `exit ${status.code}` } };
  const changed = status.out.split(/\r?\n/).filter((l) => l.trim());
  if (changed.some((l) => l.slice(3) !== QUEUE)) return { result: "waiting", text: SYNC_TEXT.unsaved, detail: { what: "skipped: the main checkout has changes to tracked files" } };
  if (changed.length) await git.run(["checkout", "--", QUEUE], true);
  return null;
}

/** What bringIn did: how many of the remote's commits came in, and the intent/ files where the remote's side was taken. */
type Brought = { ok: true; pulled: number; tookRemote: string[] } | { ok: false; outcome: SyncOutcome };

/** Main gained a commit (a record) between the look and the move: look again. */
const MOVED_ON = "moved on";

/** What one try at moving main gave: moved (with the intent/ files where the remote's side was taken), the outcome to stop with, or MOVED_ON. */
type Move = { ok: true; tookRemote: string[] } | Extract<Brought, { ok: false }> | typeof MOVED_ON;

/**
 * Moves main to the remote's main with main's own commits on top. With none of its own, that is the
 * remote's main itself (a fast-forward); otherwise they are replayed onto it first (see replayOnto).
 * Either way the move is one step under the checkout lock (see moveMain).
 */
async function bringIn(git: Git, main: string, upstream: string): Promise<Brought> {
  for (let look = 0; look < 3; look++) {
    const old = (await git.commitOf(main))!;
    const pulled = await git.countAhead(upstream, old);
    if (!pulled) return { ok: true, pulled: 0, tookRemote: [] };
    const r = (await git.isAncestor(old, upstream))
      ? await moveTo(git, main, old, (await git.commitOf(upstream))!, [])
      : await replayOnto(git, main, old, upstream);
    if (r === MOVED_ON) continue;
    return r.ok ? { ...r, pulled } : r;
  }
  return { ok: false, outcome: { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "main kept moving while it was being brought up to date; the next sync tries again" } } };
}

/**
 * Replays main's own commits (`old`, minus what `upstream` has) onto `upstream` in a throwaway
 * detached worktree (`.loopstra/sync`), so the main checkout is never in the middle of a rebase.
 * Then, under the checkout lock, commits main gained meanwhile (records) are replayed onto the
 * result in the same worktree, and main moves to it.
 */
async function replayOnto(git: Git, main: string, old: string, upstream: string): Promise<Move> {
  const clash = (error: string): Extract<Brought, { ok: false }> =>
    ({ ok: false, outcome: { result: "fail", text: SYNC_TEXT.clash, detail: { what: "replaying main onto the remote's main hit a conflict; main is not synced", upstream, error } } });
  return withDetachedWorktree(git, join(git.cwd, ".loopstra", "sync"), old, async (dir) => {
    const wt = new Git(dir);
    const first = await replay(wt, [upstream]);
    if (!first.ok) return clash(first.error);
    return onCheckout(git.cwd, async () => {
      const now = (await git.commitOf(main))!;
      const took = new Set(first.tookRemote);
      if (now !== old) {
        // Only records land on main beside a sync; anything else (main reset by hand) is looked at again.
        if (!(await git.isAncestor(old, now))) return MOVED_ON;
        const more = await replay(wt, ["--onto", await wt.headSha(), old, now]);
        if (!more.ok) return clash(more.error);
        for (const p of more.tookRemote) took.add(p);
      }
      return moveTo(git, main, now, await wt.headSha(), [...took]);
    });
  });
}

/**
 * Under the checkout lock: moves main from `from` to `to` when it is still at `from` and the checkout
 * is ready (see checkoutReady); MOVED_ON when main moved meanwhile.
 */
function moveTo(git: Git, main: string, from: string, to: string, tookRemote: string[]): Promise<Move> {
  return onCheckout(git.cwd, async () => {
    const notReady = await checkoutReady(git, main);
    if (notReady) return { ok: false, outcome: notReady };
    if ((await git.commitOf(main)) !== from) return MOVED_ON;
    const moved = await moveMain(git, from, to);
    if (!moved.ok) return { ok: false, outcome: { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "moving main to the synced commit failed; main was put back", error: moved.error } } };
    return { ok: true, tookRemote };
  });
}

/**
 * Runs `git rebase <args>` in the sync worktree. A conflict only inside intent/ (Loopstra's own
 * artifacts, which a merged pull request also carries, and owners' status lines) is settled with
 * the remote's version: an owner's edit on GitHub wins over the local record, and the next steps
 * write on top of it. Any other conflict fails (the worktree is thrown away; main never moved).
 */
async function replay(wt: Git, args: string[]): Promise<{ ok: true; tookRemote: string[] } | { ok: false; error: string }> {
  const tookRemote = new Set<string>();
  let r = await wt.runtime("rebase", ["-q", ...args], true);
  for (let step = 0; r.code !== 0 && step < 500; step++) {
    const conflicted = (await wt.run(["diff", "--name-only", "-z", "--diff-filter=U"], true)).out.split("\0").filter(Boolean);
    if (!conflicted.length || conflicted.some((p) => !p.startsWith("intent/"))) break;
    for (const p of conflicted) {
      // During a rebase HEAD is the remote side plus what has been replayed so far.
      const there = (await wt.run(["cat-file", "-e", `HEAD:${p}`], true)).code === 0;
      await wt.run(there ? ["checkout", "HEAD", "--", p] : ["rm", "-q", "-f", "--", p], true);
      tookRemote.add(p);
    }
    r = await wt.run([...RUNTIME_COMMIT_CONFIG, "-c", "core.editor=true", "rebase", "--continue"], true);
    // A commit left with nothing of its own (the remote already had it all) is skipped.
    const unmerged = (await wt.run(["diff", "--name-only", "--diff-filter=U"], true)).out.trim();
    const empty = (await wt.run(["diff", "--cached", "--quiet"], true)).code === 0;
    if (r.code !== 0 && !unmerged && empty) r = await wt.run([...RUNTIME_COMMIT_CONFIG, "rebase", "--skip"], true);
  }
  return r.code === 0 ? { ok: true, tookRemote: [...tookRemote] } : { ok: false, error: lastLine(r.err) || lastLine(r.out) || `exit ${r.code}` };
}

/** The marker a move of main leaves while it runs: `from` and `to`, one per line. */
function movingMarker(root: string): string {
  return join(root, ".loopstra", "moving-main");
}

/**
 * Moves the main checkout's branch from `from` to `to`, with its files and index (`git reset
 * --keep`), as one step that lands whole or not at all. The caller holds the checkout lock and has
 * checked that the checkout is on main and clean. Once begun, a stop request does not stop it. A
 * move that fails part way (a file another program holds open on Windows) is put back (see
 * putBack). One that a kill cuts short leaves its marker behind, and the next tick puts it back
 * before anything else (see settleCutShortMove).
 */
export async function moveMain(git: Git, from: string, to: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const marker = movingMarker(git.cwd);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${from}\n${to}\n`);
  const r = await git.run(["reset", "-q", "--keep", to], { allowFail: true, cleanup: true });
  // git moves the branch last: once it is at `to`, the files and the index are too.
  if (r.code === 0 || (await git.commitOf("HEAD")) === to) {
    rmSync(marker, { force: true });
    return { ok: true };
  }
  await putBack(git, from, to);
  rmSync(marker, { force: true });
  return { ok: false, error: lastLine(r.err) || lastLine(r.out) || `exit ${r.code}` };
}

/**
 * Puts the main checkout back at `from` after a move to `to` that did not land. Of the files the
 * two commits differ in, each the move wrote (it has `to`'s content) or removed gets `from`'s again,
 * and each index entry the move wrote is put back too. Anything else is left as it is: a file that
 * is neither commit's is a person's (an untracked file git refused to overwrite, say), and so is one
 * that cannot be read (another program holds it open with no sharing), rather than failing every try. False when
 * main is not at `from` (it moved after all, or a person moved it).
 */
async function putBack(git: Git, from: string, to: string): Promise<boolean> {
  if ((await git.commitOf("HEAD")) !== from) return false;
  const paths = (await git.run(["diff", "--name-only", "-z", "--no-renames", from, to])).out.split("\0").filter(Boolean);
  const restore: string[] = [];
  const remove: string[] = [];
  const unstage: string[] = [];
  for (const chunk of pathChunks(paths)) {
    const [was, would, here, staged] = [await blobs(git, from, chunk), await blobs(git, to, chunk), await fileBlobs(git, chunk), await indexBlobs(git, chunk)];
    for (const p of chunk) {
      const [w, t, h, s] = [was.get(p) ?? null, would.get(p) ?? null, here.get(p) ?? null, staged.get(p) ?? null];
      if ((h === t && h !== w) || (h === null && w !== null)) (w !== null ? restore : remove).push(p);
      if (s === t && s !== w) unstage.push(p);
    }
  }
  // Each name literal (see literalPathspecs): one with * or [ in it names only itself, never a sibling a
  // person may be editing.
  for (const chunk of pathChunks(restore)) await git.run(["checkout", from, "--", ...literalPathspecs(chunk)], { cleanup: true });
  for (const p of remove) rmSync(join(git.cwd, p), { force: true });
  for (const chunk of pathChunks(unstage)) await git.run(["reset", "-q", from, "--", ...literalPathspecs(chunk)], { cleanup: true });
  return true;
}


/** Path → blob, from `git ls-tree -z` or `git ls-files -s -z` output (the blob is the field before the tab's). */
function blobMap(out: string, field: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of out.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    map.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[field]!);
  }
  return map;
}

/** The blob of each of `paths` in `commit` (paths it does not have are left out). */
async function blobs(git: Git, commit: string, paths: string[]): Promise<Map<string, string>> {
  return blobMap((await git.run(["ls-tree", "-r", "-z", commit, "--", ...literalPathspecs(paths)])).out, 2);
}

/** The blob the index holds for each of `paths` (paths it does not have are left out). */
async function indexBlobs(git: Git, paths: string[]): Promise<Map<string, string>> {
  return blobMap((await git.run(["ls-files", "-s", "-z", "--", ...literalPathspecs(paths)])).out, 1);
}

/** Stands for a file that cannot be read (another program holds it open, on Windows): it is neither commit's blob, so putBack leaves the file alone. */
const UNREADABLE = "unreadable";

/** The blob each existing file of `paths` would be, as git would store it (its filters applied), or UNREADABLE. */
async function fileBlobs(git: Git, paths: string[]): Promise<Map<string, string>> {
  const existing = paths.filter((p) => existsSync(join(git.cwd, p)));
  if (!existing.length) return new Map();
  const all = await git.run(["hash-object", "--", ...existing], true);
  if (all.code === 0) {
    const hashes = all.out.split(/\r?\n/).filter(Boolean);
    return new Map(existing.map((p, i) => [p, hashes[i]!]));
  }
  // One file git cannot read fails the whole call: hash them one at a time.
  const map = new Map<string, string>();
  for (const p of existing) {
    const one = await git.run(["hash-object", "--", p], true);
    map.set(p, one.code === 0 ? one.out.trim() : UNREADABLE);
  }
  return map;
}

/** The note the tick pauses with while a move of main that a kill cut short cannot be put back yet. */
export const MOVE_CUT_SHORT_NOTE = "Loopstra was stopped while it moved main forward, and it could not put main's files back as they were yet (the trace says why). If this lasts more than a few minutes, an engineer should look at the main checkout (git status), then delete .loopstra/moving-main.";

/**
 * A move of main that a kill cut short (its marker left): when main is still where it was, its
 * files are put back (see putBack); when it is anywhere else, the move landed (or a person moved
 * main since), and there is nothing to put back. Null when there is nothing to settle (or it is
 * settled now); otherwise MOVE_CUT_SHORT_NOTE, for the tick to pause with. A git lock the kill left
 * behind is removed once it is old (see removeStaleLocks), so the move settles then.
 */
export async function settleCutShortMove(root: string, trace: Trace): Promise<string | null> {
  const marker = movingMarker(root);
  if (!existsSync(marker)) return null;
  const [from = "", to = ""] = readFileSync(marker, "utf8").split(/\r?\n/);
  const git = new Git(root);
  const head = await git.commitOf("HEAD");
  if (head === from) {
    try {
      await onCheckout(root, () => putBack(git, from, to));
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      trace.event("_loop", "error", { where: "move main", note: "putting back a move of main that was cut short failed; it is tried again on the next tick", error: errorText(e) });
      return MOVE_CUT_SHORT_NOTE;
    }
  }
  rmSync(marker, { force: true });
  trace.event("_loop", "command", { command: "move main", note: head === to ? "a move of main cut short had landed" : head === from ? "a move of main cut short was put back" : "main was moved by hand since a move of it was cut short", from, to, head });
  return null;
}

/**
 * Shares Loopstra's own records (status changes and artifacts committed on main) with the remote:
 * once at the end of each tick, and before a pull request's branch is pushed. Main is pushed only
 * when every commit the remote does not have is Loopstra's own: a person's unpushed commits are
 * theirs to share, so then nothing is pushed and the signal waits. A push the remote refuses (a
 * protected branch) is a `main_sync` failure; the loop carries on. Never throws, except for a stop request.
 */
export async function shareMain(root: string, cfg: Config, trace: Trace): Promise<void> {
  const git = new Git(root);
  let outcome: SyncOutcome | null;
  try {
    const remote = await git.remoteName();
    if (!remote) return;
    // Without the remote's main, the tick's sync reports it; nothing to compare with here.
    if ((await git.commitOf(`refs/remotes/${remote}/${cfg.main_branch}`)) === null) return;
    outcome = await push(git, remote, cfg.main_branch, trace);
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    outcome = { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "unexpected problem", error: errorText(e) } };
  }
  recordSync(trace, outcome);
}

/**
 * Pushes main when only Loopstra's commits are ahead of the remote's main. The commit looked at is
 * the one pushed, so a commit landing meanwhile is never pushed unseen. Null: nothing new to record.
 */
async function push(git: Git, remote: string, main: string, trace: Trace): Promise<SyncOutcome | null> {
  const upstream = `${remote}/${main}`;
  const head = await git.commitOf(main);
  if (head === null) return { result: "fail", text: SYNC_TEXT.unexpected, detail: { what: "main cannot be read" } };
  const ahead = (await git.run(["log", "--format=%ae %h %s", `${upstream}..${head}`])).out.split(/\r?\n/).filter(Boolean);
  if (!ahead.length) return { result: "pass", text: SYNC_TEXT.inStep };
  const theirs = ahead.filter((l) => l.split(" ")[0] !== RUNTIME_EMAIL);
  if (theirs.length) return { result: "waiting", text: SYNC_TEXT.ownCommits, detail: { what: "not pushed: main has commits that are not Loopstra's", commits: theirs.map((l) => l.split(" ").slice(1).join(" ")) } };
  const r = await git.run(["push", "--quiet", remote, `${head}:refs/heads/${main}`], true);
  if (r.code === 0) {
    trace.event("_loop", "command", { command: "share main", pushed: ahead.length });
    return { result: "pass", text: SYNC_TEXT.inStep };
  }
  const error = lastLine(r.err) || `exit ${r.code}`;
  // The remote moved on since the last fetch: the next sync brings it in, then pushes again.
  if (/non-fast-forward|fetch first|\(stale info\)/i.test(r.err)) {
    trace.event("_loop", "command", { command: "share main", pushed: 0, note: "the remote has newer commits; the next sync brings them in first", error });
    return null;
  }
  return { result: "fail", text: SYNC_TEXT.pushFailed, detail: { what: "push of main failed", remote, error } };
}

/**
 * Pushes an intent branch to the remote for its pull request. The branch is Loopstra's own and the
 * merge checks may have rebased it, so it is force-pushed, but only when the remote's branch is still
 * `lease` (the commit Loopstra last pushed there, or took from there): work a person added on GitHub
 * is never overwritten, even when a fetch has seen it since. An empty lease: the remote must have no
 * such branch. Without a lease (the first push of a build) the remote's branch must be what the last
 * fetch saw. `moved`: refused because the remote's branch has changed. No upstream is set (no `-u`):
 * nothing reads it, and writing .git/config can fail another lane's git reading it at that moment.
 */
export async function pushBranch(git: Git, branch: string, lease?: string): Promise<{ ok: true } | { ok: false; detail: string; moved?: true }> {
  const remote = await git.remoteName();
  if (!remote) return { ok: false, detail: "no remote" };
  const r = await git.run(["push", "--quiet", lease !== undefined ? `--force-with-lease=${branch}:${lease}` : "--force-with-lease", remote, `${branch}:${branch}`], true);
  if (r.code === 0) return { ok: true };
  const detail = `push of ${branch} to ${remote} failed: ${lastLine(r.err) || `exit ${r.code}`}`;
  return /\(stale info\)/i.test(r.err) ? { ok: false, detail, moved: true } : { ok: false, detail };
}

/**
 * Deletes an intent branch on the remote once its pull request is merged. Best effort: the remote
 * may have deleted it already (GitHub's "automatically delete head branches"), and a branch left
 * there does no harm. The local branch is cleanup's to delete.
 */
export async function deleteRemoteBranch(git: Git, branch: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const remote = await git.remoteName();
  if (!remote) return { ok: false, detail: "no remote" };
  const r = await git.run(["push", "--quiet", remote, "--delete", branch], true);
  return r.code === 0 ? { ok: true } : { ok: false, detail: `delete of ${branch} on ${remote} failed: ${lastLine(r.err) || `exit ${r.code}`}` };
}
