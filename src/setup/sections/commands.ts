import { join } from "node:path";
import { resolveClaude } from "../../claude";
import type { Config } from "../../config";
import { Git, withDetachedWorktree } from "../../git";
import { detectCommands } from "../../init";
import { errorText, runCommand } from "../../shell";
import type { Check, Section } from "../types";

const NAMES = ["test", "install", "lint", "build", "run"] as const;

const ABOUT: Record<(typeof NAMES)[number], string> = {
  test: "The one command that runs the tests and exits non-zero when one fails",
  install: "Installs dependencies in a fresh checkout",
  lint: "Runs the linter",
  build: "Builds the project",
  run: "Runs the app",
};

export const commands: Section = {
  name: "commands",
  title: "Commands",
  covers: ["commands"],

  async ask(ctx) {
    const detected = await detectCommands(ctx.root);
    ctx.ask.say("Build sessions may always run these. Type - to leave out an optional one.");
    for (const n of NAMES) {
      const at = ["commands", n];
      const current = ctx.doc.get(at);
      // A `# install:` line means it was left out (by the person, or init found none): suggest nothing.
      const suggestion = typeof current === "string" && current ? current : ctx.doc.hasPlaceholder(at) ? undefined : detected[n];
      const answer = await ctx.ask.text(`${ABOUT[n]} (commands.${n})`, { suggestion, optional: n !== "test" });
      if (answer) ctx.doc.set(at, answer, { quote: true });
      else ctx.doc.clear(at, { placeholder: true });
    }
  },

  async check(ctx, cfg) {
    const claude = resolveClaude();
    return [
      claude ? { level: "ok", text: `claude is found (${claude}).` } : { level: "fail", text: "claude is not found on PATH: install Claude Code, or set LOOPSTRA_CLAUDE_EXECUTABLE." },
      await testOnMain(ctx.root, cfg),
    ];
  },
};

/**
 * commands.test (after commands.install) once, in a throwaway checkout of main: the working tree is
 * never touched. Both share one claude.timeout_minutes, the time the setup runner gives a section's checks.
 */
async function testOnMain(root: string, cfg: Config): Promise<Check> {
  const deadline = Date.now() + cfg.claude.timeout_minutes * 60_000;
  const left = () => Math.max(1000, deadline - Date.now());
  const main = cfg.main_branch;
  try {
    const r = await withDetachedWorktree(new Git(root), join(root, ".loopstra", "setup-main"), main, async (cwd) => {
      if (cfg.commands.install) {
        const i = await runCommand(cfg.commands.install, cwd, { timeoutMs: left() });
        if (i.code !== 0) return { ...i, what: "commands.install" };
      }
      return { ...(await runCommand(cfg.commands.test, cwd, { timeoutMs: left() })), what: "commands.test" };
    });
    if (r.code === 0) return { level: "ok", text: `commands.test passes on ${main}.` };
    const why = r.timedOut ? "timed out" : `exit ${r.code}`;
    return { level: "warn", text: `${r.what} fails on ${main} (${why})${r.lastLine ? `: ${r.lastLine}` : ""}. Main may be red today; the loop needs it to pass.` };
  } catch (e) {
    return { level: "warn", text: `commands.test could not run on ${main}: ${errorText(e)}` };
  }
}
