import { Git } from "../../git";
import { GitHub } from "../../github";
import type { Check, Section } from "../types";

export const github: Section = {
  name: "github",
  title: "GitHub and merging",

  async ask(ctx) {
    const remote = await new Git(ctx.root).remoteName();
    ctx.ask.say(remote
      ? `This repository pushes to ${remote}: each change goes up as a pull request, and its checks must pass before it merges.`
      : "This repository has no git remote, so changes merge locally after the same checks.");
    ctx.ask.say("Once its checks pass, a change can merge:");
    ctx.ask.say("  none: on its own;");
    ctx.ask.say("  status: after a person sets its status to merge-approved in intent/<change>/intent.md;");
    ctx.ask.say("  pr: after a person approves its pull request on GitHub (needs a remote).");
    const current = ctx.doc.get(["gates", "merge", "human"]);
    const human = await ctx.ask.pick("Who approves a merge?", ["none", "status", "pr"] as const, current === "pr" || current === "status" ? current : "none");
    if (human === "pr" && !remote) ctx.ask.say("  Pull requests need a git remote on GitHub: add one before starting the loop.");
    ctx.doc.put(["gates", "merge", "human"], human, "none");
    ctx.ask.say("squash: each change lands on the main branch as one commit; merge: its commits are kept, with a merge commit.");
    const method = await ctx.ask.pick("Merge method", ["squash", "merge"] as const, ctx.doc.get(["gates", "merge", "method"]) === "merge" ? "merge" : "squash");
    ctx.doc.put(["gates", "merge", "method"], method, "squash");
  },

  async check(ctx, cfg) {
    const git = new Git(ctx.root);
    const remote = await git.remoteName();
    if (!remote) {
      return [cfg.gates.merge.human === "pr"
        ? { level: "fail", text: "gates.merge.human is pr, but there is no git remote." }
        : { level: "ok", text: "No git remote: changes merge locally." }];
    }
    const checks: Check[] = [];
    const reach = await git.run(["ls-remote", "--heads", remote], true);
    const why = reach.err.trim().split(/\r?\n/).at(-1) ?? "";
    checks.push(reach.code === 0
      ? { level: "ok", text: `git remote ${remote} answers.` }
      : { level: "fail", text: `git remote ${remote} could not be reached${why ? `: ${why}` : ""}.` });
    checks.push(await new GitHub(ctx.root, { executable: ctx.env.LOOPSTRA_GH_EXECUTABLE || undefined }).signedIn()
      ? { level: "ok", text: "gh is signed in." }
      : { level: "fail", text: "gh is not signed in (or not installed): run gh auth login. With a remote, Loopstra merges through pull requests." });
    return checks;
  },
};
