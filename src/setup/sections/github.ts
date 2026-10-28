import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../../git";
import { GitHub } from "../../github";
import { errorText } from "../../shell";
import { DEFAULTS } from "../defaults";
import type { Check, Section, SetupContext } from "../types";

/** Risky in any repository: CI workflows and database migrations. */
const RISKY_ANYWHERE = [".github/**", "**/migrations/**"];
/** Dependency and build files, suggested as risky when the repository has them at the top. */
const RISKY_AT_TOP = ["package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements.txt", "Gemfile", "Gemfile.lock", "Dockerfile"];

/**
 * Asks which files make a change wait for a person before it merges (gates.merge.risky.paths), when
 * nobody is on the merge gate. The file's own list is the suggestion; without one, in a terminal,
 * the usual risky files this repository has. --defaults never adds a list: nothing is risky until
 * a person says so.
 */
async function askRisky(ctx: SetupContext): Promise<void> {
  const at = ["gates", "merge", "risky", "paths"];
  const written = ctx.doc.get(at);
  const own = Array.isArray(written) ? written.filter((p): p is string => typeof p === "string") : [];
  const suggested = own.length ? own : ctx.ask.interactive ? [...RISKY_ANYWHERE, ...RISKY_AT_TOP.filter((f) => existsSync(join(ctx.root, f)))] : [];
  ctx.ask.say("A change that touches some files (workflows, dependencies, migrations) can wait for a person before it merges, though other changes merge on their own.");
  const answer = await ctx.ask.text("Files whose change needs a person before merging (comma-separated globs; - for none)", { suggestion: suggested.join(", ") || undefined, optional: true });
  const paths = answer.split(",").map((p) => p.trim()).filter(Boolean);
  if (paths.length) ctx.doc.set(at, paths, { flow: true });
  else ctx.doc.clear(at);
}

/** How long the remote and gh each get to answer during a check. */
export const REMOTE_CHECK_MS = 20_000;

export const github: Section = {
  name: "github",
  title: "GitHub and merging",
  covers: ["gates.merge"],

  async ask(ctx) {
    const remote = await new Git(ctx.root).remoteName();
    ctx.ask.say(remote
      ? `This repository pushes to ${remote}: each change goes up as a pull request, and its checks must pass before it merges.`
      : "This repository has no git remote, so changes merge locally after the same checks.");
    ctx.ask.say("Once its checks pass, a change can merge:");
    ctx.ask.say("  none: on its own;");
    ctx.ask.say("  status: after a person sets its status to merge-approved in intent/<change>/intent.md;");
    ctx.ask.say("  pr: after a person approves its pull request on GitHub, or sets merge-approved (needs a remote).");
    const current = ctx.doc.get(["gates", "merge", "human"]);
    let suggestion = current === "pr" || current === "status" || current === "none" ? current : DEFAULTS.gates.merge.human;
    const needsRemote = "  Pull requests need a git remote on GitHub: add one, or choose none or status.";
    // Without a remote, pr is not saved; status keeps a person approving.
    if (suggestion === "pr" && !remote) { ctx.ask.say(needsRemote); suggestion = "status"; }
    let human = await ctx.ask.pick("Who approves a merge?", ["none", "status", "pr"] as const, suggestion);
    while (human === "pr" && !remote) {
      ctx.ask.say(needsRemote);
      human = await ctx.ask.pick("Who approves a merge?", ["none", "status", "pr"] as const, suggestion);
    }
    ctx.doc.put(["gates", "merge", "human"], human, DEFAULTS.gates.merge.human);
    if (human === "none") await askRisky(ctx);
    ctx.ask.say("squash: each change lands on the main branch as one commit; merge: its commits are kept, with a merge commit.");
    const currentMethod = ctx.doc.get(["gates", "merge", "method"]);
    const method = await ctx.ask.pick("Merge method", ["squash", "merge"] as const, currentMethod === "merge" || currentMethod === "squash" ? currentMethod : DEFAULTS.gates.merge.method);
    ctx.doc.put(["gates", "merge", "method"], method, DEFAULTS.gates.merge.method);
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
    // A timeout throws even with allowFail: one more way of not answering.
    const reach = await git.run(["ls-remote", "--heads", remote], { allowFail: true, timeoutMs: REMOTE_CHECK_MS })
      .catch((e: unknown) => ({ code: 1, out: "", err: errorText(e) }));
    const why = (reach.err.trim().split(/\r?\n/).at(-1) ?? "").replace(/\.$/, "");
    checks.push(reach.code === 0
      ? { level: "ok", text: `git remote ${remote} answers.` }
      : { level: "fail", text: `git remote ${remote} could not be reached${why ? `: ${why}` : ""}.` });
    const gh = new GitHub(ctx.root, { executable: ctx.env.LOOPSTRA_GH_EXECUTABLE || undefined, timeoutMs: REMOTE_CHECK_MS });
    checks.push(await gh.signedIn().catch(() => false)
      ? { level: "ok", text: "gh is signed in." }
      : { level: "fail", text: "gh is not signed in (or not installed): run gh auth login. With a remote, Loopstra merges through pull requests." });
    return checks;
  },
};
