#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderStatus } from "./commands/status";
import { configPath, NOT_SET_UP } from "./config";
import { errorText } from "./shell";

const [command = "help", ...rest] = Bun.argv.slice(2);
const root = process.cwd();

const HELP = `loopstra <command>

  init      stamp Loopstra into this repo
  setup     walk through the settings (setup <section> for one: budgets, commands,
            gates, github, chat, models; --defaults takes every suggestion;
            --check only checks)
  start     run the loop (--once for a single tick, e.g. from cron);
            Ctrl-C once finishes gracefully, twice exits at once
  status    show intents, phases, and blocks
  tail      stream events (tail <slug> for one change)
  judges    how often the cheaper judges agreed with the strong ones
  ui        the console: live agents, inbox, changes and chat (--port <n>, default 4646; --no-chat)
  chat      talk to the orchestrator: updates, and new changes written up
            as intents (--no-terminal to run only the Slack/Discord bots)
  apply-lessons <slug>  add a change's proposed lessons to CLAUDE.md
  upgrade   install the latest Loopstra and bring this repo up to it, in one commit
            (--check shows what would change; --repo skips the install)
  customize [prompt]  copy a shipped prompt into loopstra/prompts/ to edit
            (no name: list them)
  --version print the installed version
`;

/** status, tail, judges, ui, chat, upgrade, and customize read a set-up repo; elsewhere they say so and create nothing. */
function setUp(): boolean {
  if (existsSync(configPath(root))) return true;
  console.error(NOT_SET_UP);
  return false;
}

/**
 * The line to print when a newer Loopstra is out, the repository's stamp names another version, or
 * the repository was set up before the stamp; null otherwise, and outside a set-up folder. Started
 * before a command's own work, so the registry check overlaps it. Never throws.
 */
async function notice(): Promise<string | null> {
  try {
    if (!existsSync(configPath(root))) return null;
    const { packageVersion } = await import("./package");
    const { readStamp, STAMP_FILE } = await import("./stamp");
    const { updateNotice } = await import("./upgrade/tool");
    // "": set up, with no stamp (an older setup). null: a stamp that cannot be read, not compared.
    const stamp = existsSync(join(root, STAMP_FILE)) ? (readStamp(root)?.loopstra ?? null) : "";
    return await updateNotice(root, { installed: packageVersion(), stamp });
  } catch {
    return null; // a convenience: never stops a command
  }
}

/** Prints the notice (through `print`) once it is ready. */
async function printNotice(pending: Promise<string | null>, print: (line: string) => void = console.log): Promise<void> {
  const line = await pending;
  if (line) print(line);
}

async function main(): Promise<number> {
  switch (command) {
    case "help": case "--help": case "-h":
      console.log(HELP); return 0;
    case "--version": case "-v": case "version": {
      const { packageVersion } = await import("./package");
      console.log(packageVersion()); return 0;
    }
    case "init": {
      const { init } = await import("./init");
      const r = await init(root);
      if (r.stopped) { for (const w of r.warnings) console.error(`warning: ${w}`); return 1; }
      for (const f of r.written) console.log(`wrote  ${f}`);
      for (const f of r.kept) console.log(`kept   ${f}`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      console.log(["", "Next:", ...r.next.map((n) => `  - ${n}`)].join("\n"));
      // In a terminal, offer the walkthrough now; elsewhere the next steps name it. Init has
      // succeeded either way: a walkthrough that saves nothing says why.
      const { offerSetup } = await import("./setup/offer");
      await offerSetup(root);
      return 0;
    }
    case "setup": {
      const { parseSetupArgs, setup, SETUP_USAGE, setupHelp } = await import("./setup");
      const args = parseSetupArgs(rest);
      // The help reads no config, so it works before init too.
      if (args?.help) { process.stdout.write(setupHelp()); return 0; }
      if (!setUp()) return 1;
      if (!args) { console.error(SETUP_USAGE); return 1; }
      return setup(root, args);
    }
    case "status": {
      if (!setUp()) return 1;
      const pending = notice();
      process.stdout.write(await renderStatus(root));
      await printNotice(pending);
      return 0;
    }
    case "start": {
      const { log, preflight, start } = await import("./scheduler");
      const pending = notice();
      const refusal = await preflight(root);
      if (refusal) { console.error(refusal); return 1; }
      // Printed whenever it arrives, as a line of the loop's output: a slow registry never holds up the loop.
      printNotice(pending, log).catch(() => {});
      await start(root, { once: rest.includes("--once") });
      return 0;
    }
    case "tail": {
      if (!setUp()) return 1;
      const { tail } = await import("./commands/tail");
      await tail(root, rest[0]);
      return 0;
    }
    case "judges": {
      if (!setUp()) return 1;
      const { renderJudges } = await import("./commands/judges");
      try {
        process.stdout.write(await renderJudges(root));
        return 0;
      } catch (e) { console.error(errorText(e)); return 1; }
    }
    case "ui": {
      if (!setUp()) return 1;
      const flag = rest.indexOf("--port");
      const port = flag >= 0 ? Number(rest[flag + 1]) : 4646;
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("Usage: loopstra ui [--port <number>]"); return 1; }
      const { ui } = await import("./commands/ui");
      return ui(root, port, !rest.includes("--no-chat"));
    }
    case "chat": {
      if (!setUp()) return 1;
      const { chat } = await import("./commands/chat");
      return chat(root, { terminal: !rest.includes("--no-terminal") });
    }
    case "apply-lessons": {
      const { applyLessons } = await import("./commands/apply-lessons");
      if (!rest[0]) { console.error("Usage: loopstra apply-lessons <slug>"); return 1; }
      try {
        const r = await applyLessons(root, rest[0]);
        console.log(r.added.length ? `Added to CLAUDE.md:\n${r.added.join("\n")}` : "Nothing new to add.");
        return 0;
      } catch (e) { console.error(errorText(e)); return 1; }
    }
    case "upgrade": {
      if (!setUp()) return 1;
      const { realIo, upgradeCommand } = await import("./commands/upgrade");
      return upgradeCommand(root, rest, realIo(root));
    }
    case "customize": {
      if (!setUp()) return 1;
      const { customize } = await import("./commands/customize");
      const r = await customize(root, rest[0]);
      (r.ok ? console.log : console.error)(r.text);
      return r.ok ? 0 : 1;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP); return 1;
  }
}

process.exit(await main());
