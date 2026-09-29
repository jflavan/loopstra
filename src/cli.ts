#!/usr/bin/env bun
import { renderStatus } from "./commands/status";

const [command = "help", ...rest] = Bun.argv.slice(2);
const root = process.cwd();

const HELP = `loopstra <command>

  init      stamp Loopstra into this repo
  start     run the loop (--once for a single tick)
  status    show intents, phases, and blocks
  tail      stream events
  ui        local dashboard
`;

async function main(): Promise<number> {
  switch (command) {
    case "help": case "--help": case "-h":
      console.log(HELP); return 0;
    case "status":
      process.stdout.write(await renderStatus(root)); return 0;
    case "start": {
      const { start } = await import("./scheduler");
      const { resolveClaude } = await import("./claude");
      if (!resolveClaude()) { console.error("claude was not found on PATH. Install Claude Code first."); return 1; }
      await start(root, { once: rest.includes("--once") });
      return 0;
    }
    default:
      console.error(`Unknown or not yet implemented command: ${command}`);
      console.log(HELP); return 1;
  }
}

process.exit(await main());
