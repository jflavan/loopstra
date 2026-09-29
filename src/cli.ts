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
    case "init": {
      const { init } = await import("./init");
      const r = await init(root);
      for (const f of r.written) console.log(`wrote  ${f}`);
      for (const f of r.kept) console.log(`kept   ${f}`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      console.log(["", "Next:", ...r.next.map((n) => `  - ${n}`)].join("\n"));
      return 0;
    }
    case "status":
      process.stdout.write(await renderStatus(root)); return 0;
    case "start": {
      const { preflight, start } = await import("./scheduler");
      const refusal = await preflight(root);
      if (refusal) { console.error(refusal); return 1; }
      await start(root, { once: rest.includes("--once") });
      return 0;
    }
    default:
      console.error(`Unknown or not yet implemented command: ${command}`);
      console.log(HELP); return 1;
  }
}

process.exit(await main());
