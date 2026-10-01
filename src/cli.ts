#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { renderStatus } from "./commands/status";
import { configPath, NOT_SET_UP } from "./config";
import { errorText } from "./shell";

const [command = "help", ...rest] = Bun.argv.slice(2);
const root = process.cwd();

const HELP = `loopstra <command>

  init      stamp Loopstra into this repo
  start     run the loop (--once for a single tick, e.g. from cron);
            Ctrl-C once finishes gracefully, twice exits at once
  status    show intents, phases, and blocks
  tail      stream events (tail <slug> for one change)
  ui        local dashboard with a chat panel (--port <n>, default 4646; --no-chat)
  chat      talk to the orchestrator: updates, and new changes written up
            as intents (--no-terminal to run only the Slack/Discord bots)
  apply-lessons <slug>  add a change's proposed lessons to CLAUDE.md
`;

/** status, tail, ui, and chat read a set-up repo; elsewhere they say so and create nothing. */
function setUp(): boolean {
  if (existsSync(configPath(root))) return true;
  console.error(NOT_SET_UP);
  return false;
}

async function main(): Promise<number> {
  switch (command) {
    case "help": case "--help": case "-h":
      console.log(HELP); return 0;
    case "init": {
      const { init } = await import("./init");
      const r = await init(root);
      if (r.stopped) { for (const w of r.warnings) console.error(`warning: ${w}`); return 1; }
      for (const f of r.written) console.log(`wrote  ${f}`);
      for (const f of r.kept) console.log(`kept   ${f}`);
      for (const w of r.warnings) console.log(`warning: ${w}`);
      console.log(["", "Next:", ...r.next.map((n) => `  - ${n}`)].join("\n"));
      return 0;
    }
    case "status":
      if (!setUp()) return 1;
      process.stdout.write(await renderStatus(root)); return 0;
    case "start": {
      const { preflight, start } = await import("./scheduler");
      const refusal = await preflight(root);
      if (refusal) { console.error(refusal); return 1; }
      await start(root, { once: rest.includes("--once") });
      return 0;
    }
    case "tail": {
      if (!setUp()) return 1;
      const { tail } = await import("./commands/tail");
      await tail(root, rest[0]);
      return 0;
    }
    case "ui": {
      if (!setUp()) return 1;
      const { serveUi } = await import("./commands/ui");
      const flag = rest.indexOf("--port");
      const port = flag >= 0 ? Number(rest[flag + 1]) : 4646;
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("Usage: loopstra ui [--port <number>]"); return 1; }
      let dashboard: import("./chat/transports/dashboard").DashboardTransport | undefined;
      if (!rest.includes("--no-chat")) {
        const { DashboardTransport } = await import("./chat/transports/dashboard");
        const { ChatService } = await import("./chat/service");
        dashboard = new DashboardTransport(root);
        await new ChatService(root, [dashboard]).start();
      }
      const server = serveUi(root, port, { chat: dashboard });
      console.log(`Loopstra dashboard: http://127.0.0.1:${server.port}  (Ctrl-C to stop)`);
      await new Promise(() => {});
      return 0;
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
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP); return 1;
  }
}

process.exit(await main());
