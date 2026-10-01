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
import { chatDir } from "./threads";
import { writeIntents, type WrittenIntent } from "./writer";

export type HandoffOutcome =
  | { kind: "pr"; number: number; url: string; branch: string; intents: WrittenIntent[] }
  | { kind: "local"; intents: WrittenIntent[] }
  | { kind: "failed"; problem: string };

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
  try {
    if (!remote) {
      const w = await writeIntents({ ...o, source: o.root });
      if (!w.ok) return { kind: "failed", problem: w.problem };
      submitRequest(o.root, {
        kind: "new", title: o.handoff.title, intents: w.intents.map((i) => ({ slug: i.slug, text: i.text, update: i.update })),
        by: o.authorId, byName: o.author, transport: o.transport, thread: o.thread,
      });
      o.trace.event(CHAT_SLUG, "chat-request", { kind: "new", slugs: w.intents.map((i) => i.slug), by: o.author });
      return { kind: "local", intents: w.intents };
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
      const subject = w.intents.length === 1 ? `intent(${first}): propose ${oneLine(w.intents[0]!.title)}` : `intent: propose ${oneLine(o.handoff.title)} (${w.intents.map((i) => i.slug).join(", ")})`;
      await there.run(["add", "-A", "--", ...w.intents.map((i) => `intent/${i.slug}`)]);
      await there.runtime("commit", ["-q", "-m", subject]);
      const branch = await freeBranch(git, remote, first);
      await there.run(["push", "-q", remote, `HEAD:refs/heads/${branch}`]);
      const pr = await new GitHub(wt).createPr({ head: branch, base: main, title: oneLine(o.handoff.title) || subject, body: prBody(o.handoff, w.intents, w.summary, o.author, o.via) });
      o.trace.event(CHAT_SLUG, "chat-pr", { number: pr.number, url: pr.url, branch, slugs: w.intents.map((i) => i.slug), by: o.author });
      return { kind: "pr", number: pr.number, url: pr.url, branch, intents: w.intents };
    });
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    o.trace.event(CHAT_SLUG, "error", { where: "handoff", error: errorText(e) });
    return { kind: "failed", problem: `Something went wrong while opening the pull request (${errorText(e).split("\n")[0]}). An engineer can find the details in the trace.` };
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 100);
}
