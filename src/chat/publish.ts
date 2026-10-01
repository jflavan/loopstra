import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import { Git, withDetachedWorktree } from "../git";
import { GitHub } from "../github";
import { errorText } from "../shell";
import { StopRequested } from "../stop";
import type { Trace } from "../trace";
import { CHAT_SLUG } from "./agents";
import { submitRequest } from "./requests";
import type { Handoff } from "./schemas";
import { chatDir, oneLine } from "./threads";
import { writeIntents, type WrittenIntent } from "./writer";

export type HandoffOutcome =
  | { kind: "pr"; number: number; url: string; branch: string; intents: WrittenIntent[] }
  | { kind: "local"; intents: WrittenIntent[] }
  /** `pushed`: a branch that went up although its pull request could not be opened. */
  | { kind: "failed"; problem: string; pushed?: string };

export interface HandoffInput {
  root: string; cfg: Config; trace: Trace; handoff: Handoff;
  /** Who agreed it, by name and by platform id, and where. */
  author: string; authorId: string; transport: string; thread: string; via: string;
  maxBudgetUsd: number;
}

/** The branch a proposal goes on: `intent-proposal/<first slug>`, with -2, -3, ... when that is taken. */
async function freeBranch(git: Git, remote: string, slug: string): Promise<string> {
  for (let n = 1; n < 50; n++) {
    const name = `intent-proposal/${slug}${n > 1 ? `-${n}` : ""}`;
    const r = await git.run(["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${name}`], true);
    if (r.code === 2) return name;
    if (r.code !== 0) throw new Error(`could not list the remote's branches: ${r.err.trim()}`);
  }
  throw new Error(`every intent-proposal/${slug} branch name is taken`);
}

export function prBody(h: Handoff, intents: WrittenIntent[], summary: string, author: string, via: string): string {
  return [
    summary.trim(),
    "",
    "## Intents",
    ...intents.map((i) => `- \`${i.slug}\`: ${i.title}${i.update ? " (updated draft)" : ""}`),
    "",
    "## Agreed brief",
    "",
    h.brief.trim(),
    "",
    "---",
    `Written from a chat with ${author} (${via}). Merging adds these to the queue as drafts; nothing starts until someone accepts them, in intent.md or by asking in chat.`,
  ].join("\n");
}

/**
 * Turns an agreed hand-off into intents. With a remote: the writer checks its work against the
 * remote's main, in a throwaway checkout, and the intents go up as a pull request (the main checkout
 * is never touched). Without one: the intents are left as a request the loop adds on its next tick.
 */
export async function handOff(o: HandoffInput): Promise<HandoffOutcome> {
  const git = new Git(o.root);
  const remote = await git.remoteName();
  // Once the request is left or the pull request exists, the hand-off has happened: a later problem
  // (tracing, removing the throwaway checkout) is recorded, never reported as nothing being opened,
  // which would invite a second, duplicate hand-off.
  let done: HandoffOutcome | null = null;
  // A branch pushed without its pull request: said, so nobody is told nothing happened.
  let pushed: string | null = null;
  const note = (what: Record<string, unknown>) => {
    try { o.trace.event(CHAT_SLUG, what.error ? "error" : what.kind === "new" ? "chat-request" : "chat-pr", what); } catch { /* the outcome stands without its trace line */ }
  };
  try {
    if (!remote) {
      const w = await writeIntents({ ...o, source: o.root });
      if (!w.ok) return { kind: "failed", problem: w.problem };
      submitRequest(o.root, {
        kind: "new", title: o.handoff.title, intents: w.intents.map((i) => ({ slug: i.slug, text: i.text, update: i.update })),
        by: o.authorId, byName: o.author, transport: o.transport, thread: o.thread,
      });
      done = { kind: "local", intents: w.intents };
      note({ kind: "new", slugs: w.intents.map((i) => i.slug), by: o.author });
      return done;
    }
    const main = o.cfg.main_branch;
    await git.run(["fetch", "-q", remote, main]);
    const dir = join(chatDir(o.root), "worktrees", `handoff-${Date.now()}-${process.pid}`);
    mkdirSync(join(chatDir(o.root), "worktrees"), { recursive: true });
    return await withDetachedWorktree(git, dir, `${remote}/${main}`, async (wt): Promise<HandoffOutcome> => {
      const w = await writeIntents({ ...o, source: wt });
      if (!w.ok) return { kind: "failed", problem: w.problem };
      for (const i of w.intents) {
        mkdirSync(join(wt, "intent", i.slug), { recursive: true });
        await Bun.write(join(wt, "intent", i.slug, "intent.md"), i.text);
      }
      const there = new Git(wt);
      const first = w.intents[0]!.slug;
      const subject = w.intents.length === 1 ? `intent(${first}): propose ${oneLine(w.intents[0]!.title, 100)}` : `intent: propose ${oneLine(o.handoff.title, 100)} (${w.intents.map((i) => i.slug).join(", ")})`;
      await there.run(["add", "-A", "--", ...w.intents.map((i) => `intent/${i.slug}`)]);
      await there.runtime("commit", ["-q", "-m", subject]);
      const branch = await freeBranch(git, remote, first);
      await there.run(["push", "-q", remote, `HEAD:refs/heads/${branch}`]);
      pushed = branch;
      const pr = await new GitHub(wt).createPr({ head: branch, base: main, title: oneLine(o.handoff.title, 100) || subject, body: prBody(o.handoff, w.intents, w.summary, o.author, o.via) });
      done = { kind: "pr", number: pr.number, url: pr.url, branch, intents: w.intents };
      note({ kind: "pr", number: pr.number, url: pr.url, branch, slugs: w.intents.map((i) => i.slug), by: o.author });
      return done;
    });
  } catch (e) {
    if (e instanceof StopRequested && !done) throw e;
    note({ where: "handoff", error: errorText(e), afterPublishing: done !== null, pushed });
    if (done) return done;
    if (pushed) return { kind: "failed", pushed, problem: `The intents were pushed to the branch ${pushed}, but the pull request could not be opened (${errorText(e).split("\n")[0]}). An engineer can open it from that branch, or delete the branch.` };
    return { kind: "failed", problem: `Something went wrong while opening the pull request (${errorText(e).split("\n")[0]}). An engineer can find the details in the trace.` };
  }
}
