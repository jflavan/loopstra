#!/usr/bin/env bun
const [command = "help"] = Bun.argv.slice(2);

const HELP = `loopstra <command>

  init      stamp Loopstra into this repo
  start     run the loop (--once for a single tick)
  status    show intents, phases, and blocks
  tail      stream events
  ui        local dashboard
`;

if (command === "help" || command === "--help" || command === "-h") {
  console.log(HELP);
} else {
  console.error(`Unknown or not yet implemented command: ${command}`);
  console.log(HELP);
  process.exit(1);
}
