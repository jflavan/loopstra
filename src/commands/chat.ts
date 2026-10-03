import { resolveClaude } from "../claude";
import { loadConfig } from "../config";
import { errorText } from "../shell";
import { installStopSignals, resetStop, stopPromise, stopRequested } from "../stop";
import { ChatService, type Transport } from "../chat/service";
import { DiscordTransport } from "../chat/transports/discord";
import { SlackTransport } from "../chat/transports/slack";
import { TerminalTransport } from "../chat/transports/terminal";

export interface ChatOptions {
  /** Leave the terminal out (only the bots run; for a server or a service manager). */
  terminal: boolean;
}

/**
 * `loopstra chat`: the orchestrator, on the terminal and on each bot the config sets up. Runs until
 * Ctrl-C, or, with only the terminal, until its input ends. Returns the exit code.
 */
export async function chat(root: string, opts: ChatOptions): Promise<number> {
  let cfg;
  try { cfg = await loadConfig(root); } catch (e) { console.error(errorText(e)); return 1; }
  const terminal = opts.terminal ? new TerminalTransport() : null;
  const transports: Transport[] = [];
  if (terminal) transports.push(terminal);
  if (cfg.chat.transports.slack) transports.push(new SlackTransport(cfg.chat.transports.slack));
  if (cfg.chat.transports.discord) transports.push(new DiscordTransport(cfg.chat.transports.discord, { root }));
  if (!transports.length) {
    console.error("There is nowhere to chat: --no-terminal was given and no Slack or Discord bot is set up under chat.transports in loopstra/config.yaml.");
    return 1;
  }
  // After the settings: a config with nowhere to chat is the problem to fix first, Claude Code or not.
  if (!resolveClaude()) {
    console.error("Claude Code is not installed (claude is not on PATH). Install it and sign in, then try again.");
    return 1;
  }
  resetStop();
  const uninstall = installStopSignals();
  const service = new ChatService(root, transports);
  try {
    try {
      await service.start();
    } catch (e) {
      console.error(errorText(e));
      return 1;
    }
    const bots = transports.filter((t) => t !== terminal).map((t) => t.via);
    if (bots.length) console.error(`Listening on ${bots.join(" and ")}. Ctrl-C to stop.`);
    // Leaving the terminal chat does not stop the bots; say so, rather than seem to hang.
    if (terminal && bots.length) void terminal.closed.then(() => { if (!stopRequested()) console.error(`Left the terminal chat; ${bots.join(" and ")} keep running. Ctrl-C to stop.`); });
    await Promise.race([stopPromise(), ...(terminal && !bots.length ? [terminal.closed] : [])]);
    return 0;
  } finally {
    await service.stop();
    uninstall();
  }
}
